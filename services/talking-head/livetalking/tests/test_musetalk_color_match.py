import unittest

import cv2
import numpy as np

from avatars.musetalk.myutil import build_landmark_lower_face_mask, limit_blend_mask_to_lower_face, match_generated_face_color


def lab_chroma(image):
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB).astype(np.float32)
    return np.linalg.norm(lab[:, :, 1:3] - 128.0, axis=2)


class MuseTalkColorMatchTestCase(unittest.TestCase):
    def test_reduces_generated_lip_chroma_toward_source(self):
        source = np.full((96, 96, 3), (142, 166, 194), dtype=np.uint8)
        generated = source.copy()
        cv2.ellipse(source, (48, 67), (17, 7), 0, 0, 360, (78, 92, 178), -1)
        cv2.ellipse(generated, (48, 67), (18, 8), 0, 0, 360, (34, 42, 244), -1)

        corrected = match_generated_face_color(generated, source)
        mouth = np.zeros(source.shape[:2], dtype=np.uint8)
        cv2.ellipse(mouth, (48, 67), (18, 8), 0, 0, 360, 255, -1)
        selected = mouth > 0

        source_chroma = float(lab_chroma(source)[selected].mean())
        generated_chroma = float(lab_chroma(generated)[selected].mean())
        corrected_chroma = float(lab_chroma(corrected)[selected].mean())
        self.assertLess(abs(corrected_chroma - source_chroma), abs(generated_chroma - source_chroma))

        source_lab = cv2.cvtColor(source, cv2.COLOR_BGR2LAB).astype(np.float32)
        generated_lab = cv2.cvtColor(generated, cv2.COLOR_BGR2LAB).astype(np.float32)
        corrected_lab = cv2.cvtColor(corrected, cv2.COLOR_BGR2LAB).astype(np.float32)
        source_center = np.median(source_lab[:, :, 1:3][selected], axis=0)
        generated_center = np.median(generated_lab[:, :, 1:3][selected], axis=0)
        corrected_center = np.median(corrected_lab[:, :, 1:3][selected], axis=0)
        self.assertLess(
            float(np.linalg.norm(corrected_center - source_center)),
            float(np.linalg.norm(generated_center - source_center)),
        )

        upper_face_delta = np.abs(corrected.astype(np.int16) - generated.astype(np.int16))[:34]
        self.assertLessEqual(int(upper_face_delta.max()), 2)

    def test_leaves_matching_source_color_unchanged(self):
        source = np.full((64, 64, 3), (130, 155, 188), dtype=np.uint8)
        corrected = match_generated_face_color(source.copy(), source)
        self.assertLessEqual(int(np.abs(corrected.astype(np.int16) - source.astype(np.int16)).max()), 2)

    def test_temporally_smooths_lip_color_correction(self):
        source = np.full((96, 96, 3), (142, 166, 194), dtype=np.uint8)
        cv2.ellipse(source, (48, 67), (17, 7), 0, 0, 360, (78, 92, 178), -1)
        first = source.copy()
        second = source.copy()
        cv2.ellipse(first, (48, 67), (18, 8), 0, 0, 360, (28, 35, 250), -1)
        cv2.ellipse(second, (48, 67), (18, 8), 0, 0, 360, (75, 85, 190), -1)
        state = {}

        match_generated_face_color(first, source, state)
        first_generated_center = state['generated_center'].copy()
        match_generated_face_color(second, source, state)
        fresh_second_state = {}
        match_generated_face_color(second, source, fresh_second_state)

        self.assertIn('chroma_limit', state)
        self.assertIn('source_center', state)
        self.assertIn('luma_center', state)
        self.assertIn('texture_gain', state)
        self.assertFalse(np.array_equal(first_generated_center, state['generated_center']))
        self.assertLess(
            float(np.linalg.norm(state['generated_center'] - first_generated_center)),
            float(np.linalg.norm(fresh_second_state['generated_center'] - first_generated_center)),
        )

    def test_blend_mask_is_limited_to_the_mouth_without_landmarks(self):
        mask = np.ones((120, 120), dtype=np.float32)
        limited = limit_blend_mask_to_lower_face(
            mask,
            face_box=[20, 10, 100, 110],
            crop_box=[0, 0, 120, 120],
        )

        self.assertLess(float(limited[20:45].max()), 0.05)
        self.assertGreater(float(limited[72:86, 40:80].mean()), 0.85)
        self.assertLess(float(limited[95:112, 30:90].mean()), 0.12)
        self.assertLess(float(limited[55:95, 15:28].mean()), 0.12)

    def test_landmarks_shape_mask_around_mouth_only(self):
        mask = np.ones((140, 140), dtype=np.float32)
        landmarks = np.zeros((72, 2), dtype=np.float32)
        landmarks[:17] = np.array([
            [25 + i * 5.5, 68 + (8 - abs(8 - i)) * 3] for i in range(17)
        ], dtype=np.float32)
        mouth_angles = np.linspace(0, 2 * np.pi, 24, endpoint=False)
        landmarks[-24:, 0] = 70 + np.cos(mouth_angles) * 18
        landmarks[-24:, 1] = 78 + np.sin(mouth_angles) * 7

        limited = build_landmark_lower_face_mask(
            mask,
            face_box=[20, 20, 120, 125],
            crop_box=[0, 0, 140, 140],
            landmarks=landmarks,
        )

        self.assertLess(float(limited[20:48].max()), 0.05)
        self.assertGreater(float(limited[73:86, 48:92].mean()), 0.55)
        self.assertLess(float(limited[98:120, 38:102].mean()), 0.10)
        self.assertLess(float(limited[48:62, 35:105].mean()), 0.05)
        self.assertLess(float(limited[110:130, 5:25].mean()), 0.05)

    def test_matches_lower_face_luminance_and_local_texture(self):
        yy, xx = np.indices((96, 96))
        texture = ((xx + yy) % 6 < 3).astype(np.int16) * 10 - 5
        source = np.full((96, 96, 3), 150, dtype=np.int16)
        source += texture[:, :, None]
        generated = np.full((96, 96, 3), 118, dtype=np.int16)
        generated += (texture[:, :, None] * 2)
        source = np.clip(source, 0, 255).astype(np.uint8)
        generated = np.clip(generated, 0, 255).astype(np.uint8)

        corrected = match_generated_face_color(generated, source)
        source_l = cv2.cvtColor(source, cv2.COLOR_BGR2LAB)[:, :, 0].astype(np.float32)
        generated_l = cv2.cvtColor(generated, cv2.COLOR_BGR2LAB)[:, :, 0].astype(np.float32)
        corrected_l = cv2.cvtColor(corrected, cv2.COLOR_BGR2LAB)[:, :, 0].astype(np.float32)
        lower_face = np.zeros((96, 96), dtype=bool)
        lower_face[52:88, 20:76] = True

        before_luma_error = float(np.abs(generated_l - source_l)[lower_face].mean())
        after_luma_error = float(np.abs(corrected_l - source_l)[lower_face].mean())
        self.assertLess(after_luma_error, before_luma_error * 0.55)

        source_detail = source_l - cv2.GaussianBlur(source_l, (0, 0), 5)
        generated_detail = generated_l - cv2.GaussianBlur(generated_l, (0, 0), 5)
        corrected_detail = corrected_l - cv2.GaussianBlur(corrected_l, (0, 0), 5)
        source_std = float(np.std(source_detail[lower_face]))
        generated_std = float(np.std(generated_detail[lower_face]))
        corrected_std = float(np.std(corrected_detail[lower_face]))
        self.assertLess(abs(corrected_std - source_std), abs(generated_std - source_std))


if __name__ == '__main__':
    unittest.main()
