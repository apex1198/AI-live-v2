import argparse
import glob
import json
import os
import pickle
import shutil
import time

import cv2
import numpy as np
import torch
from tqdm import tqdm
from PIL import Image

from avatars.musetalk.utils.preprocessing import get_landmark_and_bbox, read_imgs
from avatars.musetalk.utils.blending import get_image_prepare_material
from avatars.musetalk.models.vae import VAE
from avatars.musetalk.model_resources import (
    bounded_preprocess_size,
    get_shared_vae,
    release_accelerator_cache,
    throttle_training,
    vae_lock,
)
from avatars.musetalk.myutil import (
    build_landmark_lower_face_mask,
    build_adaptive_mediapipe_mask,
    build_mediapipe_mouth_mask,
    build_parsed_lower_face_mask,
)
from avatars.musetalk.utils.face_geometry import (
    ALIGNMENT_FORMAT,
    ALIGNMENT_SIZE,
    track_face_geometry,
    warp_to_aligned,
)

try:
    from utils.face_parsing import FaceParsing
except ModuleNotFoundError:
    from avatars.musetalk.utils.face_parsing import FaceParsing


TRAINING_FPS = 30.0
MODEL_FPS = 15.0


def _write_training_frame(frame, save_path, index):
    height, width = frame.shape[:2]
    target_width, target_height = bounded_preprocess_size(width, height)
    if (target_width, target_height) != (width, height):
        frame = cv2.resize(frame, (target_width, target_height), interpolation=cv2.INTER_AREA)
    cv2.imwrite(f"{save_path}/{index:08d}.png", frame)


def video2imgs(vid_path, save_path, ext='.png', cut_frame=10000000, target_fps=TRAINING_FPS):
    """Decode once and resample source frames onto a stable training clock."""
    cap = cv2.VideoCapture(vid_path)
    if not cap.isOpened():
        raise RuntimeError(f"Could not open avatar video: {vid_path}")

    source_fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
    if source_fps <= 0:
        source_fps = target_fps
    ret, previous = cap.read()
    if not ret or previous is None:
        cap.release()
        raise RuntimeError(f"Avatar video contains no readable frames: {vid_path}")

    source_index = 0
    target_index = 0
    while True:
        ret, current = cap.read()
        if not ret or current is None:
            source_duration = (source_index + 1) / source_fps
            while target_index < cut_frame and target_index / target_fps < source_duration:
                _write_training_frame(previous, save_path, target_index)
                target_index += 1
            break

        current_time = (source_index + 1) / source_fps
        midpoint = (source_index + 0.5) / source_fps
        while target_index < cut_frame and target_index / target_fps < current_time:
            selected = previous if target_index / target_fps < midpoint else current
            _write_training_frame(selected, save_path, target_index)
            target_index += 1
        if target_index >= cut_frame:
            break
        previous = current
        source_index += 1

    cap.release()
    return target_index, source_fps


def is_video_file(file_path):
    video_exts = ['.mp4', '.mkv', '.flv', '.avi', '.mov']
    file_ext = os.path.splitext(file_path)[1].lower()
    return file_ext in video_exts


def create_dir(dir_path):
    if not os.path.exists(dir_path):
        os.makedirs(dir_path)


def generate_avatar(video_path, avatar_id, save_path='./data/avatars', bbox_shift=0, extra_margin=10, parsing_mode='lower_face', version='v15', progress_callback=None):
    """
    生成avatar的核心逻辑

    Args:
        video_path: 输入视频路径
        avatar_id: Avatar ID
        save_path: 保存根路径
        bbox_shift: 边界框偏移
        extra_margin: 额外边距
        parsing_mode: 解析模式
        version: 版本
        progress_callback: 进度回调函数，接收 0-100 的整数
    """
    avatar_save_path = os.path.join(save_path, avatar_id)
    save_full_path = os.path.join(avatar_save_path, 'full_imgs')
    create_dir(avatar_save_path)
    create_dir(save_full_path)
    mask_out_path = os.path.join(avatar_save_path, 'mask')
    create_dir(mask_out_path)

    mask_coords_path = os.path.join(avatar_save_path, 'mask_coords.pkl')
    coords_path = os.path.join(avatar_save_path, 'coords.pkl')
    alignment_path = os.path.join(avatar_save_path, 'alignment.pkl')
    latents_out_path = os.path.join(avatar_save_path, 'latents.pt')

    if progress_callback: progress_callback(5)

    for stale_path in glob.glob(os.path.join(save_full_path, '*.[jpJP][pnPN]*[gG]')):
        os.remove(stale_path)
    for stale_path in glob.glob(os.path.join(mask_out_path, '*.[jpJP][pnPN]*[gG]')):
        os.remove(stale_path)

    source_fps = TRAINING_FPS
    original_source_fps = TRAINING_FPS
    if os.path.isfile(video_path) and is_video_file(video_path):
        capture = cv2.VideoCapture(video_path)
        detected_fps = float(capture.get(cv2.CAP_PROP_FPS) or 0)
        capture.release()
        if detected_fps > 0:
            original_source_fps = detected_fps

    with open(os.path.join(avatar_save_path, 'avator_info.json'), "w") as f:
        json.dump({
            "avatar_id": avatar_id,
            "video_path": video_path,
            "bbox_shift": bbox_shift,
            "source_fps": source_fps,
            "original_source_fps": original_source_fps,
            "training_fps": TRAINING_FPS,
            "model_fps": MODEL_FPS,
            "loop_mode": "ping_pong",
            "mask_format": "pending",
            "mask_parsing_mode": parsing_mode,
            "mask_feather_px": 5,
            "mask_edge_padding_ratio": 0.05,
            "mask_outer_inset_ratio": 0.20,
            "alignment_format": ALIGNMENT_FORMAT,
            "alignment_size": ALIGNMENT_SIZE,
            "geometry_tracking": "mediapipe_478",
        }, f)

    if os.path.isfile(video_path):
        if is_video_file(video_path):
            video2imgs(video_path, save_full_path, ext='png', target_fps=TRAINING_FPS)
        else:
            # Keep image avatars in the same numeric frame convention used by
            # load_avatar; arbitrary source filenames otherwise break sorting.
            shutil.copyfile(video_path, f"{save_full_path}/00000000.png")
    else:
        files = os.listdir(video_path)
        files.sort()
        files = [file for file in files if file.split(".")[-1] == "png"]
        for filename in files:
            shutil.copyfile(f"{video_path}/{filename}", f"{save_full_path}/{filename}")

    if progress_callback: progress_callback(20)

    input_img_list = sorted(glob.glob(os.path.join(save_full_path, '*.[jpJP][pnPN]*[gG]')))
    info_path = os.path.join(avatar_save_path, 'avator_info.json')
    with open(info_path, "r", encoding="utf-8") as info_file:
        avatar_info = json.load(info_file)
    avatar_info.update({
        "frame_count": len(input_img_list),
        "duration_ms": round(len(input_img_list) / max(1.0, source_fps) * 1000),
        "max_preprocess_resolution": (
            "1080p"
            if os.getenv("LIVETALKING_PREPROCESS_QUALITY", "hd").strip().lower() == "fhd"
            else "720p"
        ),
    })
    with open(info_path, "w", encoding="utf-8") as info_file:
        json.dump(avatar_info, info_file)
    print("extracting landmarks...")
    def report_face_progress(processed, total):
        if progress_callback and total:
            progress_callback(20 + int(processed / total * 30))

    coord_list, frame_list, landmark_list = get_landmark_and_bbox(
        input_img_list,
        bbox_shift,
        progress_callback=report_face_progress,
        return_landmarks=True,
    )

    alignment_list_cycle = None
    geometry_enabled = False
    try:
        alignment_list_cycle = track_face_geometry(frame_list)
        geometry_enabled = alignment_list_cycle is not None
        for index, alignment in enumerate(alignment_list_cycle):
            if alignment is None:
                continue
            x1, y1, x2, y2 = alignment["face_box"]
            coord_list[index] = [
                max(0, int(np.floor(x1))),
                max(0, int(np.floor(y1))),
                min(frame_list[index].shape[1], int(np.ceil(x2))),
                min(frame_list[index].shape[0], int(np.ceil(y2))),
            ]
        print(f"MediaPipe 478 geometry tracking enabled for {len(alignment_list_cycle)} frames")
    except (FileNotFoundError, RuntimeError) as exc:
        allow_legacy_fallback = os.getenv(
            "LIVETALKING_ALLOW_LEGACY_MASK_FALLBACK", "0"
        ).strip().lower() in {"1", "true", "yes"}
        if not allow_legacy_fallback:
            raise RuntimeError(
                "MediaPipe face geometry is required for a tracked MuseTalk mask; "
                "avatar generation stopped instead of creating a misaligned legacy mask"
            ) from exc
        # The legacy path is available only as an explicit compatibility mode.
        # Its metadata remains distinct so runtime loaders cannot mistake it
        # for a geometry-tracked dataset.
        print(f"MediaPipe geometry tracking unavailable, using legacy crop: {exc}")

    with open(info_path, "r", encoding="utf-8") as info_file:
        avatar_info = json.load(info_file)
    if geometry_enabled:
        avatar_info.update({
            "alignment_format": ALIGNMENT_FORMAT,
            "alignment_size": ALIGNMENT_SIZE,
            "geometry_tracking": "mediapipe_478",
        })
    else:
        avatar_info.pop("alignment_format", None)
        avatar_info.pop("alignment_size", None)
        avatar_info.pop("geometry_tracking", None)
    with open(info_path, "w", encoding="utf-8") as info_file:
        json.dump(avatar_info, info_file)

    if progress_callback: progress_callback(50)

    input_latent_list = []
    idx = -1
    coord_placeholder = (0.0, 0.0, 0.0, 0.0)

    if torch.cuda.is_available():
        device = torch.device("cuda")
    elif torch.backends.mps.is_available():
        device = torch.device("mps")
    else:
        device = torch.device("cpu")
    vae_local = get_shared_vae()
    owns_model = vae_local is None
    if owns_model:
        vae_local = VAE(model_path=os.path.join("models", "sd-vae"))
        vae_dtype = torch.float16 if device.type == "cuda" else torch.float32
        vae_local.vae = vae_local.vae.to(device=device, dtype=vae_dtype)

    if version == "v15":
        fp_local = FaceParsing(left_cheek_width=90, right_cheek_width=90)
    else:
        fp_local = FaceParsing()

    for bbox, frame in zip(coord_list, frame_list):
        idx = idx + 1
        if bbox == coord_placeholder:
            continue
        x1, y1, x2, y2 = bbox
        if version == "v15":
            y2 = y2 + extra_margin
            y2 = min(y2, frame.shape[0])
            coord_list[idx] = [x1, y1, x2, y2]
        if alignment_list_cycle is not None:
            resized_crop_frame = warp_to_aligned(frame, alignment_list_cycle[idx])
        else:
            crop_frame = frame[y1:y2, x1:x2]
            resized_crop_frame = cv2.resize(crop_frame, (256, 256), interpolation=cv2.INTER_LANCZOS4)
        work_started = time.perf_counter()
        with vae_lock():
            latents = vae_local.get_latents_for_unet(resized_crop_frame)
        throttle_training(work_started)
        input_latent_list.append(latents)

        if progress_callback:
            progress = 50 + int((idx + 1) / len(frame_list) * 25)
            progress_callback(progress)

    mask_coords_list_cycle = []
    mask_list_cycle = []
    strategy_counts = {}
    previous_strategy = None
    for i, frame in enumerate(frame_list):
        cv2.imwrite(f"{save_full_path}/{str(i).zfill(8)}.png", frame)

        if alignment_list_cycle is not None:
            alignment = alignment_list_cycle[i]
            aligned_frame = warp_to_aligned(frame, alignment)
            mode = parsing_mode if version == "v15" else "raw"
            if parsing_mode == 'lower_face':
                adaptive_mask, decision = build_adaptive_mediapipe_mask(
                    alignment, previous_strategy, ALIGNMENT_SIZE, ALIGNMENT_SIZE
                )
                previous_strategy = decision["strategy"]
                strategy_counts[previous_strategy] = strategy_counts.get(previous_strategy, 0) + 1
                alignment["adaptive_mask_strategy"] = previous_strategy
                alignment["adaptive_mask_decision"] = decision
                if adaptive_mask is not None:
                    mask = adaptive_mask
                else:
                    parsed = np.asarray(fp_local(
                        Image.fromarray(cv2.cvtColor(aligned_frame, cv2.COLOR_BGR2RGB)),
                        size=(512, 512), mode="lower_face",
                    ))
                    mask = build_parsed_lower_face_mask(
                        cv2.resize(parsed, (ALIGNMENT_SIZE, ALIGNMENT_SIZE), interpolation=cv2.INTER_NEAREST)
                    )
            else:
                parsed = np.asarray(fp_local(
                    Image.fromarray(cv2.cvtColor(aligned_frame, cv2.COLOR_BGR2RGB)),
                    size=(512, 512),
                    mode=mode,
                ))
                parsed = cv2.resize(parsed, (ALIGNMENT_SIZE, ALIGNMENT_SIZE), interpolation=cv2.INTER_NEAREST)
                mask = parsed
            crop_box = [0, 0, ALIGNMENT_SIZE, ALIGNMENT_SIZE]
        else:
            x1, y1, x2, y2 = coord_list[i]
            mode = parsing_mode if version == "v15" else "raw"
            mask, crop_box = get_image_prepare_material(frame, [x1, y1, x2, y2], fp=fp_local, mode=mode)
            if parsing_mode == 'lower_face':
                mask = build_parsed_lower_face_mask(mask)
            else:
                mask = build_landmark_lower_face_mask(
                    mask,
                    [x1, y1, x2, y2],
                    crop_box,
                    landmark_list[i] if i < len(landmark_list) else None,
                )
        cv2.imwrite(f"{mask_out_path}/{str(i).zfill(8)}.png", mask)

        mask_coords_list_cycle += [crop_box]
        mask_list_cycle.append(mask)

        if progress_callback:
            progress = 75 + int((i + 1) / len(frame_list) * 20)
            progress_callback(progress)

    with open(mask_coords_path, 'wb') as f:
        pickle.dump(mask_coords_list_cycle, f)

    with open(info_path, "r", encoding="utf-8") as info_file:
        avatar_info = json.load(info_file)
    if geometry_enabled and parsing_mode == "lower_face":
        avatar_info.update({
            "mask_format": "hybrid_adaptive_v11",
            "mask_strategy_counts": strategy_counts,
            "mask_strategy_policy": "mediapipe_compact_or_expanded_with_face_parsing_fallback",
        })
    else:
        avatar_info.update({
            "mask_format": "legacy_face_parsing_lower_face_v1",
            "mask_strategy_counts": {},
            "mask_strategy_policy": "axis_aligned_face_parsing_fallback",
        })
    with open(info_path, "w", encoding="utf-8") as info_file:
        json.dump(avatar_info, info_file)

    with open(coords_path, 'wb') as f:
        pickle.dump(coord_list, f)
    if alignment_list_cycle is not None:
        with open(alignment_path, 'wb') as f:
            pickle.dump(alignment_list_cycle, f)
    elif os.path.isfile(alignment_path):
        os.remove(alignment_path)
    torch.save(input_latent_list, os.path.join(latents_out_path))

    if progress_callback: progress_callback(100)
    if owns_model:
        del vae_local
    release_accelerator_cache()
    print("Avatar 生成完成！")

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", type=str, default=r'D:\ok\00000000.png')
    parser.add_argument("--avatar_id", type=str, default='musetalk_avatar1')
    parser.add_argument('--save_path', default='data/avatars', type=str)
    parser.add_argument("--version", type=str, default="v15", choices=["v1", "v15"], help="Version of MuseTalk: v1 or v15")
    parser.add_argument("--gpu_id", type=int, default=0, help="GPU ID to use")
    parser.add_argument("--left_cheek_width", type=int, default=90, help="Width of left cheek region")
    parser.add_argument("--right_cheek_width", type=int, default=90, help="Width of right cheek region")
    parser.add_argument("--bbox_shift", type=int, default=0, help="Bounding box shift value")
    parser.add_argument("--extra_margin", type=int, default=10, help="Extra margin for face cropping")
    parser.add_argument("--parsing_mode", default='lower_face', choices=['lower_face', 'mouth', 'jaw', 'raw'], help="Face blending parsing mode")
    args = parser.parse_args()

    generate_avatar(
        video_path=args.file,
        avatar_id=args.avatar_id,
        save_path=args.save_path,
        bbox_shift=args.bbox_shift,
        extra_margin=args.extra_margin,
        parsing_mode=args.parsing_mode,
        version=args.version
    )
