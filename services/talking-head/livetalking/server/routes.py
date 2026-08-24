###############################################################################
#  服务器路由 — 统一异常处理的 API 路由
###############################################################################

import json
import asyncio
from aiohttp import web

from utils.logger import logger


# ─── 路由工具函数 ──────────────────────────────────────────────────────────

def json_ok(data=None):
    """返回成功 JSON 响应"""
    body = {"code": 0, "msg": "ok"}
    if data is not None:
        body["data"] = data
    return web.Response(
        content_type="application/json",
        text=json.dumps(body),
    )


def json_error(msg: str, code: int = -1):
    """返回错误 JSON 响应"""
    return web.Response(
        content_type="application/json",
        text=json.dumps({"code": code, "msg": str(msg)}),
    )


from server.session_manager import session_manager
from server.avatar_routes import setup_avatar_routes
from server.security import require_safe_id


def validated_session_id(value):
    return require_safe_id(value, "sessionid")


def validated_text(value):
    text = str(value or "").strip()
    if not text or len(text) > 1000:
        raise ValueError("text must contain 1 to 1000 characters")
    return text

def get_session(request, sessionid: str):
    """从 app 中获取 session 实例"""
    return session_manager.get_session(sessionid)


def get_requested_or_first_session(request, sessionid: str = ''):
    """Dashboard compatibility: use explicit WebRTC session, or the first live one."""
    if sessionid:
        return session_manager.get_session(str(sessionid)), str(sessionid)
    for sid, avatar_session in session_manager.sessions.items():
        if avatar_session is not None:
            return avatar_session, sid
    return None, ''


def worker_metrics():
    active = sum(1 for session in session_manager.sessions.values() if session is not None)
    metrics = {
        "active_sessions": active,
        "max_sessions": session_manager.max_session,
        "gpu_allocated_bytes": 0,
        "gpu_reserved_bytes": 0,
        "accelerator": "cpu",
    }
    try:
        import torch
        if torch.cuda.is_available():
            metrics.update({
                "gpu_allocated_bytes": int(torch.cuda.memory_allocated()),
                "gpu_reserved_bytes": int(torch.cuda.memory_reserved()),
                "accelerator": str(torch.cuda.get_device_name(0)),
            })
        elif hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
            metrics["accelerator"] = "mps"
            if hasattr(torch, 'mps') and hasattr(torch.mps, 'current_allocated_memory'):
                metrics["gpu_allocated_bytes"] = int(torch.mps.current_allocated_memory())
    except Exception:
        pass
    return metrics


# ─── 路由处理函数 ──────────────────────────────────────────────────────────

async def human(request):
    """文本输入（echo/chat 模式），支持 voice/emotion 参数"""
    try:
        params: dict = await request.json()

        sessionid: str = validated_session_id(params.get('sessionid', ''))
        avatar_session = get_session(request, sessionid)
        if avatar_session is None:
            return json_error("session not found")

        if params.get('interrupt'):
            avatar_session.flush_talk()

        datainfo = {}
        if params.get('tts'):  # tts 参数透传（voice, emotion 等）
            datainfo['tts'] = params.get('tts')

        if params['type'] == 'echo':
            avatar_session.put_msg_txt(validated_text(params.get('text')), datainfo)
        elif params['type'] == 'chat':
            llm_response = request.app.get("llm_response")
            if llm_response:
                asyncio.get_event_loop().run_in_executor(
                    None, llm_response, params['text'], avatar_session, datainfo
                )

        return json_ok()
    except Exception as e:
        logger.exception('human route exception:')
        return json_error(str(e))


async def health(request):
    """Lightweight readiness endpoint used by the TypeScript runtime/dashboard."""
    metrics = worker_metrics()
    opt = request.app.get("opt")
    return json_ok(data={
        "status": "healthy",
        "engine": "lipku/LiveTalking",
        "model": getattr(opt, "model", None),
        "avatar_id": getattr(opt, "avatar_id", None),
        "device": str(request.app.get("device", "auto")),
        "active_sessions": metrics["active_sessions"],
        "max_sessions": metrics["max_sessions"],
        "session_capacity": max(0, metrics["max_sessions"] - metrics["active_sessions"]),
        "accelerator": metrics["accelerator"],
        "gpu_allocated_bytes": metrics["gpu_allocated_bytes"],
        "gpu_reserved_bytes": metrics["gpu_reserved_bytes"],
        "webrtc": True,
    })


async def readiness(request):
    """The route exists only after model weights and the default avatar load."""
    return json_ok(data={"status": "ready", **worker_metrics()})


async def prometheus_metrics(request):
    values = worker_metrics()
    body = "\n".join([
        "# HELP livetalking_active_sessions Active WebRTC avatar sessions.",
        "# TYPE livetalking_active_sessions gauge",
        f"livetalking_active_sessions {values['active_sessions']}",
        "# HELP livetalking_max_sessions Configured WebRTC session limit.",
        "# TYPE livetalking_max_sessions gauge",
        f"livetalking_max_sessions {values['max_sessions']}",
        "# HELP livetalking_gpu_allocated_bytes Accelerator memory allocated by PyTorch.",
        "# TYPE livetalking_gpu_allocated_bytes gauge",
        f"livetalking_gpu_allocated_bytes {values['gpu_allocated_bytes']}",
        "# HELP livetalking_gpu_reserved_bytes CUDA memory reserved by PyTorch.",
        "# TYPE livetalking_gpu_reserved_bytes gauge",
        f"livetalking_gpu_reserved_bytes {values['gpu_reserved_bytes']}",
        "",
    ])
    return web.Response(text=body, content_type="text/plain")


async def speak_compat(request):
    """Accept the existing dashboard /speak payload and drive a real RTC session."""
    try:
        params = await request.json()
        requested_session = params.get('sessionid', '')
        if requested_session:
            requested_session = validated_session_id(requested_session)
        avatar_session, sessionid = get_requested_or_first_session(request, requested_session)
        if avatar_session is None:
            return json_error("no active WebRTC session; connect the LiveTalking video first")
        if params.get('interrupt', True):
            avatar_session.flush_talk()
        emotion = params.get("emotion", "happy")
        if emotion not in ("neutral", "happy", "excited", "surprised", "grateful"):
            emotion = "neutral"
        tts_options = {"emotion": emotion}
        if params.get("voice"):
            tts_options["ref_file"] = params["voice"]
        if params.get("speed") is not None:
            tts_options["speed"] = max(0.5, min(2.0, float(params["speed"])))
        datainfo = {"tts": tts_options}
        avatar_session.put_msg_txt(validated_text(params.get('text')), datainfo)
        return json_ok(data={"sessionid": sessionid, "engine": "livetalking-neural"})
    except Exception as e:
        logger.exception('speak compatibility route exception:')
        return json_error(str(e))


async def interrupt_compat(request):
    try:
        params = await request.json() if request.can_read_body else {}
        requested_session = params.get('sessionid', '')
        if requested_session:
            requested_session = validated_session_id(requested_session)
        avatar_session, sessionid = get_requested_or_first_session(request, requested_session)
        if avatar_session is None:
            return json_error("no active WebRTC session")
        avatar_session.flush_talk()
        return json_ok(data={"sessionid": sessionid})
    except Exception as e:
        logger.exception('interrupt compatibility route exception:')
        return json_error(str(e))


async def interrupt_talk(request):
    """打断当前说话"""
    try:
        params = await request.json()
        sessionid = validated_session_id(params.get('sessionid', ''))
        avatar_session = get_session(request, sessionid)
        if avatar_session is None:
            return json_error("session not found")
        avatar_session.flush_talk()
        return json_ok()
    except Exception as e:
        logger.exception('interrupt_talk exception:')
        return json_error(str(e))


async def humanaudio(request):
    """上传音频文件"""
    try:
        form = await request.post()
        sessionid = validated_session_id(form.get('sessionid', ''))
        fileobj = form["file"]
        filebytes = fileobj.file.read()

        datainfo = {}

        avatar_session = get_session(request, sessionid)
        if avatar_session is None:
            return json_error("session not found")
        avatar_session.put_audio_file(filebytes, datainfo)
        return json_ok()
    except Exception as e:
        logger.exception('humanaudio exception:')
        return json_error(str(e))


async def set_audiotype(request):
    """设置自定义状态（动作编排）"""
    try:
        params = await request.json()
        sessionid = validated_session_id(params.get('sessionid', ''))
        avatar_session = get_session(request, sessionid)
        if avatar_session is None:
            return json_error("session not found")
        avatar_session.set_custom_state(params['audiotype'])
        return json_ok()
    except Exception as e:
        logger.exception('set_audiotype exception:')
        return json_error(str(e))


async def record(request):
    """录制控制"""
    try:
        params = await request.json()
        sessionid = validated_session_id(params.get('sessionid', ''))
        avatar_session = get_session(request, sessionid)
        if avatar_session is None:
            return json_error("session not found")
        if params['type'] == 'start_record':
            avatar_session.start_recording()
        elif params['type'] == 'end_record':
            avatar_session.stop_recording()
        return json_ok()
    except Exception as e:
        logger.exception('record exception:')
        return json_error(str(e))


async def is_speaking(request):
    """查询是否正在说话"""
    params = await request.json()
    sessionid = validated_session_id(params.get('sessionid', ''))
    avatar_session = get_session(request, sessionid)
    if avatar_session is None:
        return json_error("session not found")
    return json_ok(data=avatar_session.is_speaking())

async def session_status(request):
    """Return the worker-owned state for one active WebRTC session."""
    try:
        sessionid = validated_session_id(request.match_info.get('sessionid', ''))
        avatar_session = get_session(request, sessionid)
        if avatar_session is None:
            return json_error("session not found", code=404)
        if hasattr(avatar_session, 'get_pipeline_status'):
            return json_ok(data=avatar_session.get_pipeline_status())
        speaking = bool(avatar_session.is_speaking())
        return json_ok(data={
            "sessionid": sessionid,
            "state": "SPEAKING" if speaking else "IDLE",
            "speaking": speaking,
        })
    except Exception as e:
        logger.exception('session_status exception:')
        return json_error(str(e), code=400)

async def sse_handler(request):
    """Cancelable speech-state stream with heartbeat and legacy media events."""
    sessionid = validated_session_id(
        request.match_info.get('sessionid') or request.query.get('sessionid', '')
    )
    avatar_session = session_manager.get_session(sessionid)
    if avatar_session is None:
        return json_error("session not found")

    response = web.StreamResponse(
        status=200,
        reason='OK',
        headers={
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        }
    )
    await response.prepare(request)

    import queue
    msgqueue = queue.Queue()
    avatar_session.add_msgqueue(msgqueue)

    try:
        initial_status = avatar_session.get_pipeline_status() if hasattr(avatar_session, 'get_pipeline_status') else {
            "sessionid": sessionid,
            "state": "SPEAKING" if avatar_session.is_speaking() else "IDLE",
            "speaking": bool(avatar_session.is_speaking()),
        }
        await response.write(
            f"event: speech_state\ndata: {json.dumps(initial_status)}\n\n".encode('utf-8')
        )
        heartbeat_at = asyncio.get_running_loop().time()
        while True:
            try:
                msg = msgqueue.get_nowait()
                event_name = 'media'
                try:
                    parsed = json.loads(msg)
                    if parsed.get('type') == 'speech_state':
                        event_name = 'speech_state'
                except (TypeError, ValueError, AttributeError):
                    pass
                await response.write(f"event: {event_name}\ndata: {msg}\n\n".encode('utf-8'))
            except queue.Empty:
                now = asyncio.get_running_loop().time()
                if now - heartbeat_at >= 10:
                    await response.write(b': heartbeat\n\n')
                    heartbeat_at = now
                await asyncio.sleep(0.1)
    except (asyncio.CancelledError, ConnectionResetError, BrokenPipeError):
        logger.info('SSE connection closed for session: %s', sessionid)
    finally:
        if msgqueue in avatar_session.msgqueues:
            avatar_session.msgqueues.remove(msgqueue)

    return response


async def admin_config(request):
    """Admin: 获取全局配置参数"""
    try:
        opt = request.app.get("opt")
        if opt:
            config = {
                key: value for key, value in vars(opt).items()
                if not any(secret in key.lower() for secret in ("key", "token", "secret", "password"))
            }
            return json_ok(data={"config": config})
        return json_error("Config not found")
    except Exception as e:
        logger.exception('admin_config exception:')
        return json_error(str(e))


async def admin_sessions(request):
    """Admin: 获取活跃的会话及其配置"""
    try:
        sessions_info = []
        for sid, avatar_session in session_manager.sessions.items():
            if avatar_session:
                s_opt = getattr(avatar_session, 'opt', None)
                s_data = {
                    "sessionid": sid,
                    "speaking": avatar_session.is_speaking() if hasattr(avatar_session, 'is_speaking') else False,
                    "recording": getattr(avatar_session, 'recording', False),
                }
                if s_opt:
                    s_data.update({
                        "model": getattr(s_opt, "model", ""),
                        "avatar_id": getattr(s_opt, "avatar_id", ""),
                        "REF_FILE": getattr(s_opt, "REF_FILE", ""),
                        "transport": getattr(s_opt, "transport", ""),
                        "batch_size": getattr(s_opt, "batch_size", 0),
                        "customopt": getattr(s_opt, "customopt", []),
                    })
                sessions_info.append(s_data)
        return json_ok(data={"sessions": sessions_info})
    except Exception as e:
        logger.exception('admin_sessions exception:')
        return json_error(str(e))


# ─── 路由注册 ──────────────────────────────────────────────────────────────

async def index(request):
    """默认首页重定向"""
    opt = request.app.get("opt")
    pagename = 'index.html'
    if opt and opt.transport == 'rtmp':
        pagename = 'rtmpapi.html'
    elif opt and opt.transport == 'rtcpush':
        pagename = 'rtcpushapi.html'
    raise web.HTTPFound(f'/{pagename}')


def setup_routes(app):
    """注册所有路由到 aiohttp app"""
    app.router.add_get("/", index)
    app.router.add_get("/health", health)
    app.router.add_get("/ready", readiness)
    app.router.add_get("/metrics", prometheus_metrics)
    app.router.add_post("/speak", speak_compat)
    app.router.add_post("/interrupt", interrupt_compat)
    app.router.add_post("/human", human)
    app.router.add_post("/humanaudio", humanaudio)
    app.router.add_post("/set_audiotype", set_audiotype)
    app.router.add_post("/record", record)
    app.router.add_post("/interrupt_talk", interrupt_talk)
    app.router.add_post("/is_speaking", is_speaking)
    app.router.add_get("/api/session/{sessionid}/status", session_status)
    app.router.add_get("/api/session/{sessionid}/events", sse_handler)
    app.router.add_get("/api/admin/config", admin_config)
    app.router.add_get("/api/admin/sessions", admin_sessions)
    app.router.add_get('/sse', sse_handler)

    # ── Local ASR endpoint (SenseVoice/FunASR) ── Issue #604 ──
    try:
        from server.asr_server import asr_websocket_handler, is_funasr_available
        if is_funasr_available():
            app.router.add_get("/api/asr", asr_websocket_handler)
            logger.info("[ASR] Local SenseVoice ASR endpoint enabled at /api/asr")
        else:
            logger.info("[ASR] funasr not installed — local ASR endpoint disabled "
                        "(pip install funasr modelscope)")
    except Exception as e:
        logger.warning(f"[ASR] Failed to register ASR endpoint: {e}")

    # 注册 avatar 生成相关的路由
    setup_avatar_routes(app)

    app.router.add_static('/', path='web')
