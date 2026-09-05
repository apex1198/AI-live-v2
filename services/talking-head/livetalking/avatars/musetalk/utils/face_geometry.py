"""Per-frame face geometry for MuseTalk avatar preprocessing.

The original MuseTalk path resized an axis-aligned detector box to 256x256.
That is not sufficient for a profile face whose visible mouth is not at the
center of the detector box.  This module tracks MediaPipe's 478 landmarks and
stores a source->aligned perspective transform for every frame.  The inverse
transform is used when the generated frame is composited back into the source.
"""

from __future__ import annotations

import os
import platform
from typing import Any, Iterable, Optional

import cv2
import numpy as np


ALIGNMENT_SIZE = 256
ALIGNMENT_FORMAT = "mediapipe_478_mouth_locked_perspective_v3"
DEFAULT_MODEL_PATH = os.path.join("models", "mediapipe", "face_landmarker.task")

# MuseTalk receives a square crop.  The eye line is the stable reference for
# roll and scale; the mouth target is derived from the neutral sequence
# reference below, rather than being allowed to drift with each homography.
CANONICAL_EYE_CENTER = np.array([128.0, 64.0], dtype=np.float32)
CANONICAL_EYE_DISTANCE = 96.0
GEOMETRY_MAX_YAW_DEG = 42.0
GEOMETRY_MAX_PITCH_DEG = 28.0
GEOMETRY_MAX_REPROJECTION_ERROR_PX = 12.0

LEFT_EYE_INDICES = np.array([33, 133, 160, 159, 158, 157, 173], dtype=np.int32)
RIGHT_EYE_INDICES = np.array([362, 263, 387, 386, 385, 384, 398], dtype=np.int32)
FACE_OVAL_INDICES = np.array([
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365,
    379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93,
    234, 127, 162, 21, 54, 103, 67, 109,
], dtype=np.int32)
MOUTH_INDICES = np.array([61, 291, 0, 17], dtype=np.int32)
ALIGNMENT_LANDMARK_INDICES = np.unique(
    np.concatenate([FACE_OVAL_INDICES, LEFT_EYE_INDICES, RIGHT_EYE_INDICES])
).astype(np.int32)


def resolve_model_path(model_path: Optional[str] = None) -> Optional[str]:
    """Find the local MediaPipe model without assuming the process cwd."""
    candidates = []
    if model_path:
        candidates.append(model_path)
    env_path = os.getenv("LIVETALKING_FACE_LANDMARKER_MODEL", "").strip()
    if env_path:
        candidates.append(env_path)
    module_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
    candidates.extend([
        DEFAULT_MODEL_PATH,
        os.path.join(module_root, DEFAULT_MODEL_PATH),
    ])
    for candidate in candidates:
        absolute = os.path.abspath(candidate)
        if os.path.isfile(absolute):
            return absolute
    return None


class MediaPipeFaceTracker:
    """Small IMAGE-mode wrapper that returns 478 pixel landmarks per frame."""

    def __init__(self, model_path: Optional[str] = None):
        # Keep an explicit opt-out for macOS installations where MediaPipe's
        # TFLite graph is known to be unstable. Geometry tracking is enabled by
        # default because silently falling back produces axis-aligned masks
        # that do not follow a moving/profile face.
        if (
            platform.system() == "Darwin"
            and os.getenv("LIVETALKING_ENABLE_MEDIAPIPE_TASKS", "1").strip().lower()
            not in {"1", "true", "yes"}
        ):
            raise RuntimeError(
                "MediaPipe Tasks was disabled by LIVETALKING_ENABLE_MEDIAPIPE_TASKS; "
                "enable it to build tracked MuseTalk masks"
            )
        resolved = resolve_model_path(model_path)
        if not resolved:
            raise FileNotFoundError(
                "MediaPipe face_landmarker.task is missing; set "
                "LIVETALKING_FACE_LANDMARKER_MODEL or place it under models/mediapipe"
            )
        try:
            from mediapipe import Image, ImageFormat
            from mediapipe.tasks.python import BaseOptions, vision
        except ImportError as exc:
            raise RuntimeError("mediapipe is required for perspective face alignment") from exc

        options = vision.FaceLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=resolved),
            running_mode=vision.RunningMode.IMAGE,
            num_faces=1,
            min_face_detection_confidence=0.45,
            min_face_presence_confidence=0.45,
            min_tracking_confidence=0.45,
            output_face_blendshapes=False,
            output_facial_transformation_matrixes=False,
        )
        self._image_type = Image
        self._image_format = ImageFormat.SRGB
        self._tracker = vision.FaceLandmarker.create_from_options(options)

    def close(self):
        close = getattr(self._tracker, "close", None)
        if callable(close):
            close()

    def __enter__(self):
        return self

    def __exit__(self, _exc_type, _exc_value, _traceback):
        self.close()

    def detect(self, frame_bgr: np.ndarray) -> Optional[np.ndarray]:
        if frame_bgr is None or frame_bgr.size == 0:
            return None
        height, width = frame_bgr.shape[:2]
        rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        result = self._tracker.detect(
            self._image_type(image_format=self._image_format, data=rgb)
        )
        if not result.face_landmarks:
            return None
        points = result.face_landmarks[0]
        if len(points) < 478:
            return None
        return np.asarray(
            [[float(point.x) * width, float(point.y) * height] for point in points],
            dtype=np.float32,
        )


def _mean_points(points: np.ndarray, indices: np.ndarray) -> np.ndarray:
    return np.mean(points[indices], axis=0).astype(np.float32)


def face_geometry_summary(points: np.ndarray) -> dict[str, Any]:
    """Return the geometry values used by both preprocessing and QA."""
    left_eye = _mean_points(points, LEFT_EYE_INDICES)
    right_eye = _mean_points(points, RIGHT_EYE_INDICES)
    mouth_center = _mean_points(points, MOUTH_INDICES)
    nose_tip = np.mean(points[[1, 4, 5]], axis=0).astype(np.float32)
    chin = points[152].astype(np.float32)
    eye_vector = right_eye - left_eye
    eye_distance = max(1e-3, float(np.linalg.norm(eye_vector)))
    roll_radians = float(np.arctan2(eye_vector[1], eye_vector[0]))
    oval = points[FACE_OVAL_INDICES]
    face_box = [
        float(np.min(oval[:, 0])),
        float(np.min(oval[:, 1])),
        float(np.max(oval[:, 0])),
        float(np.max(oval[:, 1])),
    ]
    return {
        "left_eye": left_eye,
        "right_eye": right_eye,
        "eye_mid": ((left_eye + right_eye) * 0.5).astype(np.float32),
        "mouth_center": mouth_center,
        "nose_tip": nose_tip,
        "chin": chin,
        "eye_distance": eye_distance,
        "roll_radians": roll_radians,
        "roll_degrees": float(np.degrees(roll_radians)),
        "face_box": face_box,
    }


def geometry_quality_metrics(points: np.ndarray, reprojection_error_px: float | None = None) -> dict[str, Any]:
    """Return conservative, model-facing quality signals for adaptive masking."""
    summary = face_geometry_summary(np.asarray(points, dtype=np.float32))
    left_eye = summary["left_eye"]
    right_eye = summary["right_eye"]
    mouth = summary["mouth_center"]
    eye_mid = summary["eye_mid"]
    eye_distance = max(1.0, float(summary["eye_distance"]))
    # MediaPipe does not expose a reliable 3D pose in this wrapper. These
    # normalized asymmetries are stable enough for mask selection and are
    # deliberately labelled as proxies, not calibrated camera angles.
    face_width = max(1.0, float(summary["face_box"][2] - summary["face_box"][0]))
    face_height = max(1.0, float(summary["face_box"][3] - summary["face_box"][1]))
    yaw_proxy = float(np.clip((summary["nose_tip"][0] - eye_mid[0]) / face_width * 180.0, -90.0, 90.0))
    pitch_proxy = float(np.clip((mouth[1] - eye_mid[1]) / face_height * 180.0 - 34.0, -90.0, 90.0))
    finite = bool(np.isfinite(np.asarray(points)).all())
    mouth_visible = bool(np.linalg.norm(left_eye - right_eye) > eye_distance * 0.15)
    reprojection = float(reprojection_error_px) if reprojection_error_px is not None else 0.0
    confidence = 1.0
    confidence *= float(np.clip(1.0 - abs(yaw_proxy) / 90.0, 0.0, 1.0))
    confidence *= float(np.clip(1.0 - abs(pitch_proxy) / 90.0, 0.0, 1.0))
    confidence *= float(np.clip(1.0 - reprojection / 16.0, 0.0, 1.0))
    if not finite or not mouth_visible:
        confidence = 0.0
    return {
        "yaw_proxy_degrees": yaw_proxy,
        "pitch_proxy_degrees": pitch_proxy,
        "roll_degrees": float(summary["roll_degrees"]),
        "eye_distance": eye_distance,
        "face_width": face_width,
        "face_height": face_height,
        "reprojection_error_px": reprojection,
        "mouth_visible": mouth_visible,
        "finite": finite,
        "confidence": float(np.clip(confidence, 0.0, 1.0)),
    }


class TemporalLandmarkSmoother:
    """EMA smoother that preserves landmarks while suppressing detector jitter."""

    def __init__(self, alpha: float = 0.65):
        self.alpha = float(np.clip(alpha, 0.05, 1.0))
        self.previous: Optional[np.ndarray] = None

    def update(self, points: np.ndarray) -> np.ndarray:
        current = np.asarray(points, dtype=np.float32)
        if self.previous is None or self.previous.shape != current.shape:
            self.previous = current.copy()
        else:
            self.previous = self.previous * (1.0 - self.alpha) + current * self.alpha
        return self.previous.copy()


def _normalize_points(points: np.ndarray, summary: dict[str, Any]) -> np.ndarray:
    """Normalize one frame using its tracked roll, scale, and eye midpoint."""
    points = np.asarray(points, dtype=np.float32)
    angle = -float(summary["roll_radians"])
    cosine = float(np.cos(angle))
    sine = float(np.sin(angle))
    rotation = np.array(
        [[cosine, -sine], [sine, cosine]],
        dtype=np.float32,
    )
    scale = CANONICAL_EYE_DISTANCE / max(1e-3, float(summary["eye_distance"]))
    centered = points - np.asarray(summary["eye_mid"], dtype=np.float32)
    return CANONICAL_EYE_CENTER + (centered @ rotation.T) * scale


def _build_similarity_matrix(summary: dict[str, Any]) -> np.ndarray:
    """Return the explicit per-frame roll/scale transform into target space."""
    angle = -float(summary["roll_radians"])
    cosine = float(np.cos(angle))
    sine = float(np.sin(angle))
    scale = CANONICAL_EYE_DISTANCE / max(1e-3, float(summary["eye_distance"]))
    linear = np.array(
        [[cosine * scale, -sine * scale], [sine * scale, cosine * scale]],
        dtype=np.float32,
    )
    translation = CANONICAL_EYE_CENTER - linear @ np.asarray(summary["eye_mid"], dtype=np.float32)
    return np.array(
        [
            [linear[0, 0], linear[0, 1], translation[0]],
            [linear[1, 0], linear[1, 1], translation[1]],
            [0.0, 0.0, 1.0],
        ],
        dtype=np.float32,
    )


def _identity_homography() -> np.ndarray:
    return np.eye(3, dtype=np.float32)


def _as_homography(matrix: np.ndarray) -> Optional[np.ndarray]:
    matrix = np.asarray(matrix, dtype=np.float64)
    if matrix.shape != (3, 3) or not np.isfinite(matrix).all():
        return None
    if abs(float(matrix[2, 2])) > 1e-8:
        matrix = matrix / matrix[2, 2]
    if abs(float(np.linalg.det(matrix))) < 1e-8:
        return None
    return matrix.astype(np.float32)


def _transform_points(points: np.ndarray, matrix: np.ndarray) -> np.ndarray:
    homogeneous = np.concatenate(
        [points.astype(np.float32), np.ones((len(points), 1), dtype=np.float32)],
        axis=1,
    )
    transformed = homogeneous @ matrix.T
    denominator = transformed[:, 2:3]
    safe_denominator = np.where(
        np.abs(denominator) >= 1e-8,
        denominator,
        np.where(denominator < 0.0, -1e-8, 1e-8),
    )
    return transformed[:, :2] / safe_denominator


def build_alignment(points: np.ndarray, reference_points: np.ndarray) -> Optional[dict[str, Any]]:
    """Build a mouth-locked source->aligned and inverse perspective pair.

    The transform is deliberately split into three stages:

    1. similarity: removes this frame's roll and eye-distance scale;
    2. residual perspective: matches the normalized face shape to the neutral
       reference using non-collinear face-oval/eye correspondences;
    3. mouth lock: translates the result so the tracked source mouth center is
       exactly the canonical target mouth center.

    Keeping these values separately makes the crop contract explicit and
    prevents a broad face homography from moving the lips as a side effect.
    """
    if points is None or np.asarray(points).shape != (478, 2):
        return None
    summary = face_geometry_summary(np.asarray(points, dtype=np.float32))
    reference_points = np.asarray(reference_points, dtype=np.float32)
    if reference_points.shape != (478, 2):
        return None
    reference = face_geometry_summary(reference_points)
    source_points = np.asarray(points, dtype=np.float32)
    target_points = _normalize_points(reference_points, reference)
    normalized_source = _normalize_points(source_points, summary)
    source_anchors = normalized_source[ALIGNMENT_LANDMARK_INDICES]
    target_anchors = target_points[ALIGNMENT_LANDMARK_INDICES]
    if not np.isfinite(source_anchors).all() or not np.isfinite(target_anchors).all():
        return None

    similarity = _build_similarity_matrix(summary)

    # Fit only the residual shape difference after roll/scale normalization.
    # RANSAC prevents one unstable occluded contour point from moving the full
    # face.  The mouth is intentionally absent from this fit and locked below.
    residual_result = cv2.findHomography(
        source_anchors,
        target_anchors,
        method=cv2.RANSAC,
        ransacReprojThreshold=4.0,
        maxIters=2000,
        confidence=0.995,
    )
    residual = _identity_homography()
    if residual_result is not None:
        candidate = _as_homography(residual_result[0])
        if candidate is not None:
            residual = candidate

    source_to_aligned = _as_homography(residual @ similarity)
    if source_to_aligned is None:
        return None

    target_mouth = _mean_points(target_points, MOUTH_INDICES)
    mapped_mouth_before_lock = _transform_points(
        summary["mouth_center"][None, :],
        source_to_aligned,
    )[0]
    mouth_lock_delta = target_mouth - mapped_mouth_before_lock
    mouth_lock = np.array(
        [
            [1.0, 0.0, float(mouth_lock_delta[0])],
            [0.0, 1.0, float(mouth_lock_delta[1])],
            [0.0, 0.0, 1.0],
        ],
        dtype=np.float32,
    )
    source_to_aligned = _as_homography(mouth_lock @ source_to_aligned)
    if source_to_aligned is None:
        return None
    try:
        aligned_to_source = _as_homography(np.linalg.inv(source_to_aligned))
    except np.linalg.LinAlgError:
        aligned_to_source = None
    if aligned_to_source is None:
        return None

    aligned_mouth = _transform_points(summary["mouth_center"][None, :], source_to_aligned)[0]
    projected_points = _transform_points(
        source_points[ALIGNMENT_LANDMARK_INDICES],
        source_to_aligned,
    )
    if not np.isfinite(aligned_mouth).all() or not np.isfinite(projected_points).all():
        return None
    reprojection_error = float(np.mean(np.linalg.norm(projected_points - target_anchors, axis=1)))
    if reprojection_error > GEOMETRY_MAX_REPROJECTION_ERROR_PX:
        return None
    if not (-64.0 <= float(aligned_mouth[0]) <= ALIGNMENT_SIZE + 64.0):
        return None
    if not (-64.0 <= float(aligned_mouth[1]) <= ALIGNMENT_SIZE + 64.0):
        return None

    aligned_face_box_points = _transform_points(
        np.asarray([
            [summary["face_box"][0], summary["face_box"][1]],
            [summary["face_box"][2], summary["face_box"][1]],
            [summary["face_box"][2], summary["face_box"][3]],
            [summary["face_box"][0], summary["face_box"][3]],
        ], dtype=np.float32),
        source_to_aligned,
    )
    quality = geometry_quality_metrics(source_points, reprojection_error)
    return {
        "format": ALIGNMENT_FORMAT,
        "size": ALIGNMENT_SIZE,
        "source_to_aligned": source_to_aligned,
        "aligned_to_source": aligned_to_source,
        "landmarks": np.asarray(points, dtype=np.float32),
        "alignment_landmark_count": int(len(ALIGNMENT_LANDMARK_INDICES)),
        "alignment_method": "similarity_residual_perspective_mouth_lock",
        "similarity_matrix": similarity,
        "residual_perspective_matrix": residual,
        "mouth_lock_translation": mouth_lock,
        "mouth_center_source": summary["mouth_center"].astype(np.float32),
        "mouth_center_target": target_mouth.astype(np.float32),
        "mouth_center_aligned": aligned_mouth.astype(np.float32),
        "roll_degrees": summary["roll_degrees"],
        "scale": float(CANONICAL_EYE_DISTANCE / max(1e-3, summary["eye_distance"])),
        "eye_distance": summary["eye_distance"],
        "eye_mid_source": summary["eye_mid"].astype(np.float32),
        "mouth_lock_delta_px": mouth_lock_delta.astype(np.float32),
        "face_box": summary["face_box"],
        "aligned_face_box": [
            float(np.min(aligned_face_box_points[:, 0])),
            float(np.min(aligned_face_box_points[:, 1])),
            float(np.max(aligned_face_box_points[:, 0])),
            float(np.max(aligned_face_box_points[:, 1])),
        ],
        "reprojection_error_px": reprojection_error,
        "geometry_quality": quality,
    }


def track_face_geometry(frames: Iterable[np.ndarray], model_path: Optional[str] = None) -> list[Optional[dict[str, Any]]]:
    """Track every frame, then align them against a robust sequence reference.

    A previous frame's transform is never reused.  Reusing it hides a failed
    landmark detection as a geometric shift, which is exactly the failure this
    pipeline is intended to catch.
    """
    frame_list = list(frames)
    raw_landmarks: list[Optional[np.ndarray]] = []
    smoother = TemporalLandmarkSmoother(
        alpha=float(os.getenv("LIVETALKING_LANDMARK_SMOOTHING", "0.65"))
    )
    with MediaPipeFaceTracker(model_path) as tracker:
        for frame in frame_list:
            detected = tracker.detect(frame)
            raw_landmarks.append(smoother.update(detected) if detected is not None else None)

    valid = [points for points in raw_landmarks if points is not None]
    if len(valid) < max(3, int(len(frame_list) * 0.5)):
        raise RuntimeError(
            f"MediaPipe detected too few faces ({len(valid)}/{len(frame_list)}) for alignment"
        )
    raw_landmarks = recover_missing_landmarks(raw_landmarks)
    reference_points = np.median(np.stack(valid, axis=0), axis=0).astype(np.float32)
    result: list[Optional[dict[str, Any]]] = []
    for index, points in enumerate(raw_landmarks):
        alignment = build_alignment(points, reference_points)
        if alignment is None:
            raise RuntimeError(f"Could not build a valid perspective transform for frame {index}")
        result.append(alignment)
    return result


def recover_missing_landmarks(
    landmarks: list[Optional[np.ndarray]],
) -> list[np.ndarray]:
    """Recover failed detections while preserving continuous face motion."""
    valid_indices = [index for index, points in enumerate(landmarks) if points is not None]
    if not valid_indices:
        raise RuntimeError("MediaPipe did not detect a face in any frame")

    recovered: list[np.ndarray] = []
    for index, points in enumerate(landmarks):
        if points is not None:
            recovered.append(np.asarray(points, dtype=np.float32))
            continue

        previous = next((candidate for candidate in reversed(valid_indices) if candidate < index), None)
        following = next((candidate for candidate in valid_indices if candidate > index), None)
        if previous is None:
            recovered.append(np.asarray(landmarks[following], dtype=np.float32).copy())
            continue
        if following is None:
            recovered.append(np.asarray(landmarks[previous], dtype=np.float32).copy())
            continue

        start = np.asarray(landmarks[previous], dtype=np.float32)
        end = np.asarray(landmarks[following], dtype=np.float32)
        weight = float(index - previous) / float(following - previous)
        recovered.append((start * (1.0 - weight) + end * weight).astype(np.float32))
    return recovered


def warp_to_aligned(frame: np.ndarray, alignment: dict[str, Any]) -> np.ndarray:
    return cv2.warpPerspective(
        frame,
        np.asarray(alignment["source_to_aligned"], dtype=np.float32),
        (ALIGNMENT_SIZE, ALIGNMENT_SIZE),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REPLICATE,
    )


def scale_alignment_for_frame(alignment: dict[str, Any], scale_x: float, scale_y: float) -> dict[str, Any]:
    """Adapt stored transforms when the loader changes source resolution."""
    source_to_aligned = np.asarray(alignment["source_to_aligned"], dtype=np.float32)
    aligned_to_source = np.asarray(alignment["aligned_to_source"], dtype=np.float32)
    source_to_loaded = np.array([
        [1.0 / max(scale_x, 1e-8), 0.0, 0.0],
        [0.0, 1.0 / max(scale_y, 1e-8), 0.0],
        [0.0, 0.0, 1.0],
    ], dtype=np.float32)
    loaded_to_source = np.array([
        [scale_x, 0.0, 0.0],
        [0.0, scale_y, 0.0],
        [0.0, 0.0, 1.0],
    ], dtype=np.float32)
    updated = dict(alignment)
    updated["source_to_aligned"] = source_to_aligned @ source_to_loaded
    updated["aligned_to_source"] = loaded_to_source @ aligned_to_source
    if "similarity_matrix" in updated:
        updated["similarity_matrix"] = np.asarray(updated["similarity_matrix"], dtype=np.float32) @ source_to_loaded
    if "residual_perspective_matrix" in updated:
        updated["residual_perspective_matrix"] = np.asarray(updated["residual_perspective_matrix"], dtype=np.float32)
    if "mouth_lock_translation" in updated:
        updated["mouth_lock_translation"] = np.asarray(updated["mouth_lock_translation"], dtype=np.float32)
    if "mouth_center_source" in updated:
        updated["mouth_center_source"] = np.asarray(updated["mouth_center_source"], dtype=np.float32) * np.array([scale_x, scale_y], dtype=np.float32)
    if "eye_mid_source" in updated:
        updated["eye_mid_source"] = np.asarray(updated["eye_mid_source"], dtype=np.float32) * np.array([scale_x, scale_y], dtype=np.float32)
    if "landmarks" in updated:
        updated["landmarks"] = np.asarray(updated["landmarks"], dtype=np.float32) * np.array([scale_x, scale_y], dtype=np.float32)
    if "face_box" in updated:
        x1, y1, x2, y2 = updated["face_box"]
        updated["face_box"] = [x1 * scale_x, y1 * scale_y, x2 * scale_x, y2 * scale_y]
    return updated
