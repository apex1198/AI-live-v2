import os
import json
import uuid
import shutil
import mimetypes
from aiohttp import web
from server.task_manager import task_manager
from server.security import require_safe_id, secure_filename, resolve_existing_media, resolve_avatar_output, resolve_avatar_entry
from server.session_manager import session_manager
from utils.logger import logger

def json_ok(data=None):
    body = {"code": 0, "msg": "ok"}
    if data is not None:
        body["data"] = data
    return web.Response(
        content_type="application/json",
        text=json.dumps(body),
    )

def json_error(msg: str, code: int = -1):
    return web.Response(
        content_type="application/json",
        text=json.dumps({"code": code, "msg": str(msg)}),
    )

async def create_avatar_task(request):
    """
    POST /api/avatar/task
    Parameters: model, avatar_id, video_file (upload), video_path (local), ...
    """
    try:
        if request.content_type == 'multipart/form-data':
            reader = await request.multipart()
            params = {}
            video_path = None

            while True:
                part = await reader.next()
                if part is None:
                    break

                if part.name == 'video_file':
                    filename = secure_filename(part.filename)
                    if not filename.lower().endswith((".mp4", ".mov", ".webm", ".mkv", ".jpg", ".jpeg", ".png")):
                        raise ValueError("unsupported avatar media type")
                    temp_dir = os.path.abspath('./data/tmp')
                    os.makedirs(temp_dir, exist_ok=True)
                    video_path = os.path.join(temp_dir, f"{uuid.uuid4()}_{filename}")
                    with open(video_path, 'wb') as f:
                        while True:
                            chunk = await part.read_chunk()
                            if not chunk:
                                break
                            f.write(chunk)
                else:
                    value = await part.text()
                    params[part.name] = value

            if video_path:
                params['video_path'] = video_path
        else:
            params = await request.json()

        model_type = str(params.get('model') or '').strip()
        avatar_id = require_safe_id(params.get('avatar_id'), "avatar_id")

        if model_type not in ("musetalk", "wav2lip"):
            return json_error("model must be musetalk or wav2lip")

        if 'video_path' not in params:
            return json_error("video_file or video_path is required")

        video_path = resolve_existing_media(params['video_path'])

        # Dashboard may provide a project-local model root. Training artifacts
        # are written there; task_manager exposes a compatibility symlink under
        # data/avatars so the native LiveTalking loader keeps working.
        save_path = resolve_avatar_output(params.get('save_path') or './data/avatars')

        task_params = {
            "video_path": video_path,
            "save_path": save_path,
            "img_size": max(64, min(512, int(params.get('img_size', 256)))),
            "nosmooth": params.get('nosmooth', 'false').lower() == 'true' if isinstance(params.get('nosmooth'), str) else params.get('nosmooth', False),
            "bbox_shift": max(-50, min(50, int(params.get('bbox_shift', 0)))),
            "extra_margin": max(0, min(100, int(params.get('extra_margin', 10)))),
            "parsing_mode": params.get('parsing_mode', 'lower_face') if params.get('parsing_mode', 'lower_face') in ('lower_face', 'mouth', 'jaw', 'raw') else 'lower_face',
            "version": params.get('version', 'v15') if params.get('version', 'v15') in ('v15', 'v1') else 'v15',
            "face_det_batch_size": max(1, min(64, int(params.get('face_det_batch_size', 16))))
        }

        pads_str = params.get('pads', "0 10 0 0")
        if isinstance(pads_str, str):
            task_params['pads'] = [int(x) for x in pads_str.split()]
        else:
            task_params['pads'] = pads_str
        if len(task_params['pads']) != 4 or any(abs(value) > 200 for value in task_params['pads']):
            raise ValueError("pads must contain four values between -200 and 200")

        task_id_input = require_safe_id(params.get('task_id'), "task_id") if params.get('task_id') else None
        notify_url = params.get('notifyurl')
        if notify_url and os.getenv('LIVETALKING_ALLOW_NOTIFY_URLS', '').lower() != 'true':
            raise ValueError("notifyurl is disabled")

        task_id = task_manager.add_task(model_type, avatar_id, task_params, task_id=task_id_input, notify_url=notify_url)
        return json_ok(data={"task_id": task_id})

    except Exception as e:
        logger.exception("create_avatar_task error:")
        return json_error(str(e))

async def get_avatar_task_status(request):
    """
    GET /api/avatar/task/{task_id}
    """
    try:
        task_id = require_safe_id(request.match_info.get('task_id'), "task_id")
    except ValueError as exc:
        return json_error(str(exc), code=400)
    task = task_manager.get_task(task_id)
    if not task:
        return json_error("Task not found", code=404)

    return json_ok(data=task.to_dict())

async def list_avatar_tasks(request):
    """
    GET /api/avatar/tasks
    """
    tasks = task_manager.list_tasks()
    return json_ok(data={"tasks": tasks})

async def list_trained_avatars(request):
    """GET /api/avatars — discover reusable avatars from native storage."""
    avatar_root = os.path.abspath('./data/avatars')
    os.makedirs(avatar_root, exist_ok=True)
    avatars = []
    for entry in sorted(os.scandir(avatar_root), key=lambda item: item.name.lower()):
        if not (entry.is_dir(follow_symlinks=True) or entry.is_symlink()):
            continue
        try:
            avatar_id = require_safe_id(entry.name, "avatar_id")
            avatar_dir = os.path.realpath(entry.path)
            required_files = ('avator_info.json', 'latents.pt', 'coords.pkl', 'mask_coords.pkl')
            required_dirs = ('full_imgs', 'mask')
            if not all(os.path.isfile(os.path.join(avatar_dir, name)) for name in required_files):
                logger.warning(f"Skipping incomplete avatar {avatar_id}: required model files are missing")
                continue
            if not all(
                os.path.isdir(os.path.join(avatar_dir, name))
                and any(os.scandir(os.path.join(avatar_dir, name)))
                for name in required_dirs
            ):
                logger.warning(f"Skipping incomplete avatar {avatar_id}: generated frame data is missing")
                continue
            info_path = os.path.join(avatar_dir, 'avator_info.json')
            info = {}
            if os.path.isfile(info_path):
                with open(info_path, 'r', encoding='utf-8') as info_file:
                    parsed = json.load(info_file)
                    if isinstance(parsed, dict):
                        info = parsed
            thumbnail_path = find_avatar_thumbnail(avatar_dir)
            avatars.append({
                "id": avatar_id,
                "avatar_id": avatar_id,
                "model_type": "musetalk",
                "status": "ready",
                "source_name": os.path.basename(str(info.get('video_path') or '')) or avatar_id,
                "thumbnail_url": f"/api/avatars/{avatar_id}/thumbnail" if thumbnail_path else None,
                "frame_count": int(info.get('frame_count') or 0),
                "source_fps": float(info.get('source_fps') or 25.0),
                "duration_ms": int(info.get('duration_ms') or 0),
            })
        except Exception as exc:
            logger.warning(f"Skipping invalid avatar entry {entry.name}: {exc}")
    return json_ok(data={"avatars": avatars})


def find_avatar_thumbnail(avatar_dir):
    frame_dir = os.path.join(avatar_dir, 'full_imgs')
    if not os.path.isdir(frame_dir):
        return None
    preferred = ('First Frame.png', '00000000.png', '00000000.jpg', '00000000.jpeg')
    for filename in preferred:
        candidate = os.path.join(frame_dir, filename)
        if os.path.isfile(candidate):
            return candidate
    for filename in sorted(os.listdir(frame_dir)):
        if filename.lower().endswith(('.png', '.jpg', '.jpeg', '.webp')):
            candidate = os.path.join(frame_dir, filename)
            if os.path.isfile(candidate):
                return candidate
    return None


async def get_avatar_thumbnail(request):
    """Serve a trained avatar's first real frame as its library thumbnail."""
    try:
        avatar_id = require_safe_id(request.match_info.get('avatar_id'), "avatar_id")
        _entry, target = resolve_avatar_entry(avatar_id)
        avatar_dir = os.path.realpath(str(target))
        thumbnail_path = find_avatar_thumbnail(avatar_dir)
        if not thumbnail_path:
            return json_error("avatar thumbnail not found", code=404)
        content_type = mimetypes.guess_type(thumbnail_path)[0] or 'image/png'
        return web.FileResponse(
            thumbnail_path,
            headers={
                'Content-Type': content_type,
                'Cache-Control': 'private, max-age=60',
                'X-Content-Type-Options': 'nosniff',
            },
        )
    except FileNotFoundError as exc:
        return json_error(str(exc), code=404)
    except ValueError as exc:
        return json_error(str(exc), code=400)
    except Exception as exc:
        logger.exception("get_avatar_thumbnail error:")
        return json_error(str(exc))

async def delete_trained_avatar(request):
    """DELETE /api/avatars/{avatar_id} — release its live session and remove it."""
    try:
        avatar_id = require_safe_id(request.match_info.get('avatar_id'), "avatar_id")
        for task in task_manager.list_tasks():
            if task.get('avatar_id') == avatar_id and task.get('status') in ('pending', 'running'):
                return json_error("avatar training is still active", code=409)

        rtc_manager = request.app.get("rtc_manager")
        if rtc_manager is not None:
            await rtc_manager.close_sessions_for_avatar(avatar_id)
        evict_avatar_cache = request.app.get("evict_avatar_cache")
        if callable(evict_avatar_cache):
            evict_avatar_cache(remove_avatar_id=avatar_id)

        entry, target = resolve_avatar_entry(avatar_id)
        if entry.is_symlink():
            entry.unlink()
            if target.is_dir():
                shutil.rmtree(target)
            elif target.exists():
                target.unlink()
        elif entry.is_dir():
            shutil.rmtree(entry)
        else:
            entry.unlink()
        return json_ok(data={"avatar_id": avatar_id, "deleted": True})
    except FileNotFoundError as exc:
        # DELETE is intentionally idempotent. The runtime also owns a local
        # manifest/project copy, so a missing worker entry is successful.
        return json_ok(data={"avatar_id": avatar_id, "deleted": True, "worker_artifact_found": False})
    except ValueError as exc:
        return json_error(str(exc), code=400)
    except Exception as exc:
        logger.exception("delete_trained_avatar error:")
        return json_error(str(exc))

async def delete_avatar_task(request):
    """
    DELETE /api/avatar/task/{task_id}
    """
    try:
        task_id = require_safe_id(request.match_info.get('task_id'), "task_id")
    except ValueError as exc:
        return json_error(str(exc), code=400)
    success, msg = task_manager.delete_task(task_id)
    if not success:
        return json_error(msg)
    return json_ok(data={"msg": msg})

async def get_musetalk_mask_mode_route(request):
    from avatars.musetalk_avatar import get_musetalk_mask_mode
    return json_ok(data={"mode": get_musetalk_mask_mode()})

async def set_musetalk_mask_mode_route(request):
    try:
        payload = await request.json()
        from avatars.musetalk_avatar import set_musetalk_mask_mode
        return json_ok(data={"mode": set_musetalk_mask_mode(payload.get("mode"))})
    except ValueError as exc:
        return json_error(str(exc), code=400)
    except Exception as exc:
        logger.exception("set_musetalk_mask_mode error:")
        return json_error(str(exc))

def setup_avatar_routes(app):
    app.router.add_post("/api/avatar/task", create_avatar_task)
    app.router.add_get("/api/avatar/task/{task_id}", get_avatar_task_status)
    app.router.add_delete("/api/avatar/task/{task_id}", delete_avatar_task)
    app.router.add_get("/api/avatar/tasks", list_avatar_tasks)
    app.router.add_get("/api/avatars", list_trained_avatars)
    app.router.add_get("/api/avatars/{avatar_id}/thumbnail", get_avatar_thumbnail)
    app.router.add_delete("/api/avatars/{avatar_id}", delete_trained_avatar)
    app.router.add_get("/api/musetalk/mask-mode", get_musetalk_mask_mode_route)
    app.router.add_post("/api/musetalk/mask-mode", set_musetalk_mask_mode_route)
