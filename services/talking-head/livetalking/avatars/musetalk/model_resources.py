import gc
import os
import threading
import time

import torch


_shared_vae = None
_vae_lock = threading.RLock()


def bounded_preprocess_size(width, height):
    """Return an aspect-preserving frame size for the active live quality."""
    width = max(1, int(width))
    height = max(1, int(height))
    quality = os.getenv("LIVETALKING_PREPROCESS_QUALITY", "hd").strip().lower()
    default_width, default_height = (1920, 1080) if quality == "fhd" else (1280, 720)
    try:
        landscape_width = max(320, int(os.getenv("LIVETALKING_MAX_WIDTH", str(default_width))))
        landscape_height = max(180, int(os.getenv("LIVETALKING_MAX_HEIGHT", str(default_height))))
    except ValueError:
        landscape_width, landscape_height = default_width, default_height
    max_width, max_height = (
        (landscape_width, landscape_height)
        if width >= height
        else (landscape_height, landscape_width)
    )
    scale = min(1.0, max_width / width, max_height / height)
    return round(width * scale), round(height * scale)


def scale_box(box, scale_x, scale_y):
    """Scale an xyxy box while preserving the integer pixel convention."""
    x1, y1, x2, y2 = box
    return [
        int(round(float(x1) * scale_x)),
        int(round(float(y1) * scale_y)),
        int(round(float(x2) * scale_x)),
        int(round(float(y2) * scale_y)),
    ]


def set_shared_vae(vae):
    global _shared_vae
    _shared_vae = vae


def get_shared_vae():
    return _shared_vae


def vae_lock():
    return _vae_lock


def throttle_training(started_at):
    try:
        resource_fraction = float(os.getenv("AVATAR_TRAIN_RESOURCE_FRACTION", "0.20"))
    except ValueError:
        resource_fraction = 0.20
    resource_fraction = max(0.05, min(1.0, resource_fraction))
    if resource_fraction >= 1.0:
        return
    elapsed = max(0.0, time.perf_counter() - started_at)
    time.sleep(elapsed * ((1.0 / resource_fraction) - 1.0))


def release_accelerator_cache():
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    if hasattr(torch, "mps") and hasattr(torch.mps, "empty_cache"):
        try:
            torch.mps.empty_cache()
        except RuntimeError:
            pass
