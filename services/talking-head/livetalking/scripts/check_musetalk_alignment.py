"""Check per-frame MuseTalk perspective alignment on a deterministic sample."""

from __future__ import annotations

import argparse
import json
import os
import pickle
import random
import sys
from pathlib import Path

import cv2
import numpy as np

from avatars.musetalk.myutil import get_image_blending_perspective
from avatars.musetalk.utils.face_geometry import (
    CANONICAL_EYE_DISTANCE,
    face_geometry_summary,
)


def _transform_points(points, matrix):
    points = np.asarray(points, dtype=np.float32).reshape(-1, 1, 2)
    return cv2.perspectiveTransform(points, np.asarray(matrix, dtype=np.float32)).reshape(-1, 2)


def _draw_label(image, text, origin, color=(255, 255, 255)):
    cv2.putText(image, text, origin, cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 0), 3, cv2.LINE_AA)
    cv2.putText(image, text, origin, cv2.FONT_HERSHEY_SIMPLEX, 0.45, color, 1, cv2.LINE_AA)


def _safe_point(point, image):
    values = np.asarray(point, dtype=np.float64).reshape(-1)
    if values.size < 2 or not np.isfinite(values[:2]).all():
        return None
    height, width = image.shape[:2]
    return (
        int(np.clip(np.rint(values[0]), 0, max(0, width - 1))),
        int(np.clip(np.rint(values[1]), 0, max(0, height - 1))),
    )


def _point_label(point):
    values = np.asarray(point, dtype=np.float64).reshape(-1)
    if values.size < 2 or not np.isfinite(values[:2]).all():
        return "invalid"
    return f"({values[0]:.1f},{values[1]:.1f})"


def _loop_safe_frame_index(length, playback_index, source_fps=30.0, model_fps=15.0):
    """Match MuseReal's model-clock to source-frame ping-pong mapping."""
    length = max(1, int(length))
    if length == 1:
        return 0
    source_step = float(source_fps) / max(1.0, float(model_fps))
    cycle_length = 2 * (length - 1)
    position = int(round(int(playback_index) * source_step)) % cycle_length
    return position if position < length else cycle_length - position


def _runtime_marker_probe(frame, alignment, mask):
    """Probe the real paste-back path with a marker at the target mouth."""
    target = np.asarray(
        alignment.get("mouth_center_target", alignment["mouth_center_aligned"]),
        dtype=np.float32,
    )
    marker = np.zeros((256, 256, 3), dtype=np.uint8)
    target_point = tuple(np.round(target).astype(int))
    cv2.circle(marker, target_point, 6, (255, 255, 255), -1, cv2.LINE_AA)
    output = get_image_blending_perspective(
        np.zeros_like(frame),
        marker,
        mask,
        alignment,
        apply_color_match=False,
    )
    weights = output.max(axis=2).astype(np.float32)
    positive = weights > 12.0
    if not np.any(positive):
        return float("inf"), None
    ys, xs = np.where(positive)
    marker_weights = weights[positive]
    observed = np.array(
        [
            float(np.average(xs, weights=marker_weights)),
            float(np.average(ys, weights=marker_weights)),
        ],
        dtype=np.float32,
    )
    source_mouth = np.asarray(alignment["mouth_center_source"], dtype=np.float32)
    return float(np.linalg.norm(observed - source_mouth)), observed


def check_alignment(
    avatar_dir: str,
    sample_count: int = 10,
    duration_seconds: float = 20.0,
    seed: int = 477706,
    output_dir: str | None = None,
    model_fps: float | None = None,
):
    root = Path(avatar_dir).expanduser().resolve()
    info = json.loads((root / "avator_info.json").read_text(encoding="utf-8"))
    with (root / "alignment.pkl").open("rb") as handle:
        alignments = pickle.load(handle)

    frame_paths = sorted(
        [path for path in (root / "full_imgs").iterdir() if path.stem.isdigit()],
        key=lambda path: int(path.stem),
    )
    if len(frame_paths) != len(alignments):
        raise RuntimeError(f"alignment/frame count mismatch: {len(alignments)} vs {len(frame_paths)}")

    source_fps = float(info.get("source_fps", 30.0) or 30.0)
    # Sample playback positions, not only physical source frames. This checks
    # the full requested 20-second window even when the source clip is shorter
    # and the avatar is traversed in ping-pong mode.
    model_fps = max(1.0, float(model_fps if model_fps is not None else info.get("model_fps", 15.0) or 15.0))
    window_count = max(1, int(np.ceil(duration_seconds * model_fps)))
    rng = random.Random(seed)
    playback_indices = sorted(rng.sample(range(window_count), min(sample_count, window_count)))
    mask_paths = sorted(
        [path for path in (root / "mask").iterdir() if path.stem.isdigit()],
        key=lambda path: int(path.stem),
    )
    if len(mask_paths) != len(frame_paths):
        raise RuntimeError(f"mask/frame count mismatch: {len(mask_paths)} vs {len(frame_paths)}")
    if info.get("mask_format") != "mediapipe_478_lower_face_mouth_inset20pct_feather5_v10":
        raise RuntimeError(
            "alignment check requires the landmark-aligned lower-face mask artifact "
            "mediapipe_478_lower_face_mouth_inset20pct_feather5_v10"
        )
    if float(info.get("mask_feather_px", 0.0) or 0.0) != 5.0:
        raise RuntimeError("alignment check requires mask_feather_px=5")
    samples = []
    aligned_mouth_centers = []
    roundtrip_errors = []
    matrix_errors = []
    runtime_errors = []
    mouth_tracking_errors = []
    roll_errors = []
    scale_errors = []
    contact_rows = []

    for playback_index in playback_indices:
        index = _loop_safe_frame_index(
            len(frame_paths),
            playback_index,
            source_fps=source_fps,
            model_fps=model_fps,
        )
        alignment = alignments[index]
        frame = cv2.imread(str(frame_paths[index]))
        if frame is None or alignment is None:
            raise RuntimeError(f"missing frame/alignment at index {index}")
        mask = cv2.imread(str(mask_paths[index]), cv2.IMREAD_GRAYSCALE)
        if mask is None:
            raise RuntimeError(f"missing mask at index {index}")
        if mask.shape != (256, 256):
            raise RuntimeError(f"aligned mask must be 256x256 at index {index}, got {mask.shape}")
        mask = mask.astype(np.float32) / 255.0
        source_mouth = np.asarray(alignment["mouth_center_source"], dtype=np.float32)
        expected_aligned_mouth = np.asarray(alignment["mouth_center_aligned"], dtype=np.float32)
        landmark_summary = face_geometry_summary(np.asarray(alignment["landmarks"], dtype=np.float32))
        mouth_tracking_error = float(
            np.linalg.norm(source_mouth - np.asarray(landmark_summary["mouth_center"], dtype=np.float32))
        )
        roll_error = abs(float(alignment["roll_degrees"]) - float(landmark_summary["roll_degrees"]))
        expected_scale = CANONICAL_EYE_DISTANCE / max(1e-3, float(landmark_summary["eye_distance"]))
        scale_error = abs(float(alignment["scale"]) - expected_scale)
        mapped_mouth = _transform_points(source_mouth, alignment["source_to_aligned"])[0]
        roundtrip_mouth = _transform_points(expected_aligned_mouth, alignment["aligned_to_source"])[0]
        matrix_error = float(np.linalg.norm(mapped_mouth - expected_aligned_mouth))
        roundtrip_error = float(np.linalg.norm(roundtrip_mouth - source_mouth))
        runtime_error, runtime_mouth = _runtime_marker_probe(frame, alignment, mask)
        aligned_mouth_centers.append(expected_aligned_mouth)
        roundtrip_errors.append(roundtrip_error)
        matrix_errors.append(matrix_error)
        runtime_errors.append(runtime_error)
        mouth_tracking_errors.append(mouth_tracking_error)
        roll_errors.append(roll_error)
        scale_errors.append(scale_error)

        aligned = cv2.warpPerspective(
            frame,
            np.asarray(alignment["source_to_aligned"], dtype=np.float32),
            (256, 256),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_REPLICATE,
        )
        source_view = frame.copy()
        source_marker = _safe_point(source_mouth, source_view)
        if source_marker is not None:
            cv2.circle(source_view, source_marker, 7, (0, 0, 255), 2, cv2.LINE_AA)
        x1, y1, x2, y2 = np.round(alignment["face_box"]).astype(int)
        cv2.rectangle(source_view, (x1, y1), (x2, y2), (255, 180, 0), 2)
        _draw_label(source_view, f"frame {index:04d} source mouth {_point_label(source_mouth)}", (12, 24))

        aligned_marker = _safe_point(expected_aligned_mouth, aligned)
        if aligned_marker is not None:
            cv2.circle(aligned, aligned_marker, 7, (0, 255, 0), 2, cv2.LINE_AA)
        _draw_label(aligned, f"aligned mouth {_point_label(expected_aligned_mouth)}", (8, 22))
        source_view = cv2.resize(source_view, (256, 256), interpolation=cv2.INTER_AREA)
        contact_rows.append(np.concatenate([source_view, aligned], axis=1))
        samples.append({
            "frame": index,
            "playback_frame": playback_index,
            "time_ms": round(playback_index / model_fps * 1000.0, 2),
            "mouth_center_source": np.round(source_mouth, 3).tolist(),
            "mouth_center_aligned": np.round(expected_aligned_mouth, 3).tolist(),
            "roll_degrees": round(float(alignment["roll_degrees"]), 4),
            "eye_distance_px": round(float(alignment["eye_distance"]), 4),
            "reprojection_error_px": round(float(alignment["reprojection_error_px"]), 4),
            "matrix_mouth_error_px": round(matrix_error, 4),
            "roundtrip_mouth_error_px": round(roundtrip_error, 4),
            "runtime_paste_back_mouth": (
                np.round(runtime_mouth, 3).tolist() if runtime_mouth is not None else None
            ),
            "runtime_paste_back_mouth_error_px": round(runtime_error, 4),
            "mouth_tracking_error_px": round(mouth_tracking_error, 4),
            "roll_error_degrees": round(roll_error, 4),
            "scale_error": round(scale_error, 6),
        })

    centers = np.asarray(aligned_mouth_centers, dtype=np.float32)
    center_median = np.median(centers, axis=0)
    center_distances = np.linalg.norm(centers - center_median, axis=1)
    max_center_drift = float(np.max(center_distances))
    p95_center_drift = float(np.percentile(center_distances, 95))
    max_reprojection = float(np.max(roundtrip_errors))
    max_matrix_error = float(np.max(matrix_errors))
    max_runtime_error = float(np.max(runtime_errors))
    max_mouth_tracking_error = float(np.max(mouth_tracking_errors))
    max_roll_error = float(np.max(roll_errors))
    max_scale_error = float(np.max(scale_errors))
    max_anchor_error = max(float(sample["reprojection_error_px"]) for sample in samples)

    # 12px at 256x256 is deliberately conservative: it catches a displaced
    # mouth without failing on normal landmark jitter in a compressed source.
    passed = (
        len(playback_indices) == min(sample_count, window_count)
        and max_center_drift <= 12.0
        and max_reprojection <= 2.0
        and max_matrix_error <= 2.0
        and max_anchor_error <= 8.0
        and max_runtime_error <= 2.0
        and max_mouth_tracking_error <= 0.5
        and max_roll_error <= 0.5
        and max_scale_error <= 0.01
    )
    result = {
        "status": "pass" if passed else "fail",
        "avatar_id": info.get("avatar_id"),
        "alignment_format": info.get("alignment_format"),
        "sample_count": len(playback_indices),
        "window_seconds": duration_seconds,
        "source_fps": source_fps,
        "model_fps": model_fps,
        "seed": seed,
        "alignment_size": int(info.get("alignment_size", 256)),
        "mask_format": info.get("mask_format"),
        "mask_feather_px": float(info.get("mask_feather_px", 0.0) or 0.0),
        "thresholds": {
            "max_aligned_mouth_drift_px": 12.0,
            "max_roundtrip_mouth_error_px": 2.0,
            "max_matrix_mouth_error_px": 2.0,
            "max_anchor_reprojection_error_px": 8.0,
            "max_runtime_paste_back_mouth_error_px": 2.0,
            "max_mouth_tracking_error_px": 0.5,
            "max_roll_error_degrees": 0.5,
            "max_scale_error": 0.01,
        },
        "metrics": {
            "median_aligned_mouth_center": np.round(center_median, 3).tolist(),
            "max_aligned_mouth_drift_px": round(max_center_drift, 4),
            "p95_aligned_mouth_drift_px": round(p95_center_drift, 4),
            "max_roundtrip_mouth_error_px": round(max_reprojection, 4),
            "max_matrix_mouth_error_px": round(max_matrix_error, 4),
            "max_anchor_reprojection_error_px": round(max_anchor_error, 4),
            "max_runtime_paste_back_mouth_error_px": round(max_runtime_error, 4),
            "max_mouth_tracking_error_px": round(max_mouth_tracking_error, 4),
            "max_roll_error_degrees": round(max_roll_error, 4),
            "max_scale_error": round(max_scale_error, 6),
        },
        "samples": samples,
    }

    destination = Path(output_dir).expanduser().resolve() if output_dir else root / "diagnostics"
    destination.mkdir(parents=True, exist_ok=True)
    (destination / "alignment-check.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    contact_sheet = np.concatenate(contact_rows, axis=0)
    cv2.imwrite(str(destination / "alignment-contact-sheet.png"), contact_sheet)
    result["json_path"] = str(destination / "alignment-check.json")
    result["contact_sheet_path"] = str(destination / "alignment-contact-sheet.png")
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--avatar-dir", required=True)
    parser.add_argument("--sample-count", type=int, default=10)
    parser.add_argument("--duration-seconds", type=float, default=20.0)
    parser.add_argument("--seed", type=int, default=477706)
    parser.add_argument("--model-fps", type=float)
    parser.add_argument("--output-dir")
    args = parser.parse_args()
    result = check_alignment(
        args.avatar_dir,
        sample_count=max(1, args.sample_count),
        duration_seconds=max(0.1, args.duration_seconds),
        seed=args.seed,
        output_dir=args.output_dir,
        model_fps=(max(1.0, args.model_fps) if args.model_fps is not None else None),
    )
    print(json.dumps(result, indent=2))
    return 0 if result["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
