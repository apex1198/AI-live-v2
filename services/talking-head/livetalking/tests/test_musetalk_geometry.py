import unittest

import cv2
import numpy as np

from avatars.musetalk.myutil import (
    LOWER_FACE_EDGE_PADDING_RATIO,
    LOWER_FACE_OUTER_INSET_RATIO,
    build_mediapipe_mouth_mask,
    get_image_blending_perspective,
)
from avatars.musetalk.utils.face_geometry import (
    ALIGNMENT_SIZE,
    CANONICAL_EYE_DISTANCE,
    FACE_OVAL_INDICES,
    MOUTH_INDICES,
    build_alignment,
    face_geometry_summary,
    recover_missing_landmarks,
)


def _make_reference_landmarks():
    """Create a deterministic non-degenerate 478-point face fixture."""
    points = np.zeros((478, 2), dtype=np.float32)
    for index in range(len(points)):
        angle = index * 0.371
        points[index] = [128.0 + 72.0 * np.cos(angle), 132.0 + 96.0 * np.sin(angle)]

    # Eye clusters and mouth contour need realistic, non-collinear geometry.
    left_eye = np.array([94.0, 82.0], dtype=np.float32)
    right_eye = np.array([162.0, 82.0], dtype=np.float32)
    for offset, index in enumerate([33, 133, 160, 159, 158, 157, 173]):
        points[index] = left_eye + [float((offset % 3) - 1) * 3.0, float((offset // 3) - 1) * 2.0]
    for offset, index in enumerate([362, 263, 387, 386, 385, 384, 398]):
        points[index] = right_eye + [float((offset % 3) - 1) * 3.0, float((offset // 3) - 1) * 2.0]
    mouth_angles = np.linspace(0.0, 2.0 * np.pi, 4, endpoint=False)
    for index, angle in zip(MOUTH_INDICES, mouth_angles):
        points[index] = [128.0 + 24.0 * np.cos(angle), 174.0 + 9.0 * np.sin(angle)]
    points[152] = [128.0, 230.0]
    return points


class MuseTalkGeometryTestCase(unittest.TestCase):
    def test_missing_landmarks_are_interpolated_and_edge_filled(self):
        first = _make_reference_landmarks()
        last = first + np.array([12.0, 6.0], dtype=np.float32)
        recovered = recover_missing_landmarks([None, first, None, None, last, None])

        np.testing.assert_allclose(recovered[0], first)
        np.testing.assert_allclose(recovered[2], first * (2.0 / 3.0) + last * (1.0 / 3.0))
        np.testing.assert_allclose(recovered[3], first * (1.0 / 3.0) + last * (2.0 / 3.0))
        np.testing.assert_allclose(recovered[5], last)

    def test_lower_face_mask_follows_oval_and_leaves_five_percent_edge_margin(self):
        landmarks = np.zeros((478, 2), dtype=np.float32)
        # FACE_OVAL_INDICES are ordered from the forehead, down the right side,
        # across the chin, then up the left side.
        angles = np.linspace(-np.pi / 2, 3 * np.pi / 2, len(FACE_OVAL_INDICES), endpoint=False)
        landmarks[FACE_OVAL_INDICES] = np.column_stack((
            128.0 + 78.0 * np.cos(angles),
            132.0 + 96.0 * np.sin(angles),
        ))
        landmarks[[2, 4, 5, 98, 327]] = [128.0, 126.0]
        lip_indices = [
            0, 13, 14, 17, 37, 39, 40, 61, 78, 80, 81, 82, 84, 87,
            88, 91, 95, 146, 178, 181, 185, 191, 267, 269, 270, 291,
            308, 310, 311, 312, 314, 317, 318, 321, 324, 375, 402, 405,
            409, 415,
        ]
        landmarks[lip_indices] = [128.0, 164.0]
        alignment = {"landmarks": landmarks, "source_to_aligned": np.eye(3, dtype=np.float32)}

        mask = build_mediapipe_mouth_mask(alignment)
        self.assertEqual(LOWER_FACE_EDGE_PADDING_RATIO, 0.05)
        self.assertEqual(LOWER_FACE_OUTER_INSET_RATIO, 0.20)
        self.assertLess(int(mask[:126].max()), 2)
        self.assertGreater(int(mask[170, 128]), 245)

        original_oval = np.zeros((ALIGNMENT_SIZE, ALIGNMENT_SIZE), dtype=np.uint8)
        cv2.fillPoly(original_oval, [np.round(landmarks[FACE_OVAL_INDICES]).astype(np.int32)], 255)
        edge_distance = cv2.distanceTransform(original_oval, cv2.DIST_L2, 5)
        self.assertGreater(float(edge_distance[mask > 245].min()), 15.0)

    def test_alignment_locks_mouth_and_records_roll_scale_and_warps(self):
        reference = _make_reference_landmarks()
        transform = np.array(
            [[1.08, 0.12, 37.0], [-0.06, 0.96, 28.0], [0.0002, -0.0001, 1.0]],
            dtype=np.float32,
        )
        current = cv2.perspectiveTransform(
            reference.reshape(-1, 1, 2), transform
        ).reshape(-1, 2)

        alignment = build_alignment(current, reference)
        self.assertIsNotNone(alignment)
        self.assertEqual(
            alignment["alignment_method"],
            "similarity_residual_perspective_mouth_lock",
        )
        self.assertEqual(alignment["alignment_landmark_count"] > 30, True)
        self.assertIn("mouth_center_source", alignment)
        self.assertIn("mouth_center_target", alignment)
        self.assertIn("roll_degrees", alignment)
        self.assertIn("scale", alignment)
        self.assertIn("similarity_matrix", alignment)
        self.assertIn("residual_perspective_matrix", alignment)
        self.assertIn("source_to_aligned", alignment)
        self.assertIn("aligned_to_source", alignment)

        source_mouth = alignment["mouth_center_source"].reshape(1, 1, 2)
        mapped_mouth = cv2.perspectiveTransform(
            source_mouth,
            alignment["source_to_aligned"],
        ).reshape(2)
        np.testing.assert_allclose(
            mapped_mouth,
            alignment["mouth_center_target"],
            atol=1e-3,
        )
        self.assertGreater(float(alignment["scale"]), 0.0)
        self.assertAlmostEqual(
            float(alignment["scale"]),
            CANONICAL_EYE_DISTANCE / face_geometry_summary(current)["eye_distance"],
            places=5,
        )

    def test_runtime_paste_back_maps_aligned_marker_to_source_mouth(self):
        # OpenCV warpPerspective consumes the forward mapping for an image
        # source.  This verifies the actual aligned-image -> source-image
        # compositing contract used by get_image_blending_perspective.
        source_to_aligned = np.array(
            [[1.0, 0.0, -30.0], [0.0, 1.0, -20.0], [0.0, 0.0, 1.0]],
            dtype=np.float32,
        )
        aligned_to_source = np.linalg.inv(source_to_aligned).astype(np.float32)
        source_mouth = np.array([80.0, 45.0], dtype=np.float32)
        target_mouth = np.array([50.0, 25.0], dtype=np.float32)
        aligned_face = np.zeros((ALIGNMENT_SIZE, ALIGNMENT_SIZE, 3), dtype=np.uint8)
        cv2.circle(aligned_face, tuple(target_mouth.astype(int)), 5, (255, 255, 255), -1)
        aligned_mask = np.zeros((ALIGNMENT_SIZE, ALIGNMENT_SIZE), dtype=np.float32)
        cv2.circle(aligned_mask, tuple(target_mouth.astype(int)), 8, 1.0, -1)

        output = get_image_blending_perspective(
            np.zeros((160, 160, 3), dtype=np.uint8),
            aligned_face,
            aligned_mask,
            {
                "source_to_aligned": source_to_aligned,
                "aligned_to_source": aligned_to_source,
            },
        )
        changed = output.mean(axis=2)
        ys, xs = np.where(changed > 30.0)
        self.assertGreater(len(xs), 0)
        centroid = np.array([xs.mean(), ys.mean()], dtype=np.float32)
        np.testing.assert_allclose(centroid, source_mouth, atol=1.5)


if __name__ == "__main__":
    unittest.main()
