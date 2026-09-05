"""Synthetic geometry/mask benchmark for the adaptive MuseTalk policy.

This does not run neural inference. It measures mask construction and emits
debug PNGs so real avatar/video benchmarks can use the same policy output.
"""

import argparse
import json
import time
from pathlib import Path

import cv2
import numpy as np

from avatars.musetalk.myutil import build_adaptive_mediapipe_mask
from avatars.musetalk.utils.face_geometry import FACE_OVAL_INDICES


def fixture(yaw: float) -> dict:
    points = np.zeros((478, 2), dtype=np.float32)
    angles = np.linspace(-np.pi / 2, 3 * np.pi / 2, len(FACE_OVAL_INDICES), endpoint=False)
    points[FACE_OVAL_INDICES] = np.column_stack((128 + 78 * np.cos(angles), 132 + 96 * np.sin(angles)))
    points[[61, 291, 0, 17]] = [[104, 174], [152, 174], [128, 165], [128, 183]]
    points[[2, 4, 5, 98, 327]] = [128, 126]
    points[[33, 133, 160, 159, 158, 157, 173]] = [94, 82]
    points[[362, 263, 387, 386, 385, 384, 398]] = [162, 82]
    points[1] = [128 + yaw * 0.45, 118]
    return {
        "landmarks": points,
        "source_to_aligned": np.eye(3, dtype=np.float32),
        "geometry_quality": {
            "finite": True, "mouth_visible": True, "confidence": max(0.35, 1 - abs(yaw) / 100),
            "yaw_proxy_degrees": yaw, "pitch_proxy_degrees": 0.0, "reprojection_error_px": 2.0,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path("runtime-data/adaptive-mask-benchmark"))
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    records = []
    for yaw in (0, 15, 30, 45, 60):
        alignment = fixture(yaw)
        started = time.perf_counter()
        mask, decision = build_adaptive_mediapipe_mask(alignment, width=256, height=256)
        elapsed_ms = (time.perf_counter() - started) * 1000
        if mask is None:
            mask = np.zeros((256, 256), dtype=np.uint8)
        cv2.imwrite(str(args.output / f"yaw_{yaw:03d}_{decision['strategy']}.png"), mask)
        records.append({"yaw_proxy_degrees": yaw, "strategy": decision["strategy"], "mask_area": int(np.count_nonzero(mask)), "build_ms": round(elapsed_ms, 3)})
    (args.output / "summary.json").write_text(json.dumps(records, indent=2), encoding="utf-8")
    print(json.dumps(records, indent=2))


if __name__ == "__main__":
    main()
