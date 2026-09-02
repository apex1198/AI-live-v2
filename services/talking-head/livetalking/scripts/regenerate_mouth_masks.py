"""Regenerate landmark-aligned lower-face masks without retraining MuseTalk latents."""

import argparse
import json
import pickle
from pathlib import Path

import cv2

from avatars.musetalk.myutil import build_mediapipe_mouth_mask


MASK_FORMAT = "mediapipe_478_lower_face_mouth_inset20pct_feather5_v10"


def regenerate(avatar_dir: Path) -> None:
    with (avatar_dir / "alignment.pkl").open("rb") as handle:
        alignments = pickle.load(handle)
    mask_dir = avatar_dir / "mask"
    mask_dir.mkdir(parents=True, exist_ok=True)
    for stale in mask_dir.glob("*.png"):
        stale.unlink()
    for index, alignment in enumerate(alignments):
        mask = build_mediapipe_mouth_mask(alignment)
        if not cv2.imwrite(str(mask_dir / f"{index:08d}.png"), mask):
            raise RuntimeError(f"Could not write mask frame {index}")

    info_path = avatar_dir / "avator_info.json"
    info = json.loads(info_path.read_text(encoding="utf-8"))
    info.update({
        "mask_format": MASK_FORMAT,
        "mask_parsing_mode": "lower_face",
        "mask_edge_padding_ratio": 0.05,
        "mask_outer_inset_ratio": 0.20,
        "mask_feather_px": 5,
    })
    info_path.write_text(json.dumps(info, ensure_ascii=False), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("avatar_dir", type=Path)
    args = parser.parse_args()
    regenerate(args.avatar_dir.expanduser().resolve())


if __name__ == "__main__":
    main()
