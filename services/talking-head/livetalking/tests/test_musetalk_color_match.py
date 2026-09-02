import unittest

import cv2
import numpy as np

from avatars.musetalk.myutil import (
    LOWER_FACE_FEATHER_MIN_PX,
    LOWER_FACE_FEATHER_PX,
    MOUTH_MASK_EXPAND_PX,
    MOUTH_MASK_REGION_SCALE,
    scale_mask_region,
    build_landmark_lower_face_mask,
    enhance_lip_detail,
    build_parsed_lower_face_mask,
    expand_mask_region,
    limit_blend_mask_to_lower_face,
    match_generated_face_color,
    resolve_lower_face_feather_px,
)


def lab_chroma(image):
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB).astype(np.float32)
    return np.linalg.norm(lab[:, :, 1:3] - 128.0, axis=2)


class MuseTalkColorMatchTestCase(unittest.TestCase):
    def test_mask_support_can_be_reduced_twenty_percent_without_shifting_center(self):
        source = np.zeros((100, 120), dtype=np.uint8)
        source[20:80, 30:90] = 255
        reduced = scale_mask_region(source, 0.80)
        ys, xs = np.where(reduced > 0)
        self.assertEqual(int(xs.max() - xs.min() + 1), 48)
        self.assertEqual(int(ys.max() - ys.min() + 1), 48)
        self.assertAlmostEqual(float(xs.mean()), 59.5, delta=0.6)
        self.assertAlmostEqual(float(ys.mean()), 49.5, delta=0.6)

    def test_lip_detail_enhancement_preserves_pixels_outside_lips(self):
        face = np.full((64, 64, 3), 150, dtype=np.uint8)
        face[30:34, 20:44] = 190
        mask = np.zeros((64, 64), dtype=np.float32)
        cv2.ellipse(mask, (32, 32), (15, 6), 0, 0, 360, 1.0, -1)

        enhanced = enhance_lip_detail(face, mask)
        self.assertLessEqual(int(np.abs(enhanced.astype(np.int16) - face.astype(np.int16))[:15].max()), 1)
        self.assertGreater(int(np.abs(enhanced.astype(np.int16) - face.astype(np.int16))[mask > 0.9].max()), 0)

    def test_parsed_lower_face_mask_keeps_full_under_nose_region(self):
        parsed = np.zeros((120, 140), dtype=np.uint8)
        parsed[45:110, 25:115] = 255

        mask = build_parsed_lower_face_mask(parsed).astype(np.float32) / 255.0

        self.assertLess(float(mask[:45].max()), 0.01)
        self.assertGreater(float(mask[55:100, 35:105].mean()), 0.95)
        self.assertGreater(np.count_nonzero(mask), 4500)
        self.assertLess(float(mask[:, :10].max()), 0.01)
        self.assertLess(float(mask[:, 130:].max()), 0.01)

    def test_face_parsing_lower_face_starts_at_bottom_of_nose(self):
        import torch
        from PIL import Image

        from avatars.musetalk.utils.face_parsing import FaceParsing

        labels = np.array([
            [1, 1, 1, 1],
            [1, 10, 10, 1],
            [1, 10, 1, 11],
            [1, 12, 13, 1],
        ], dtype=np.int64)
        logits = torch.full((1, 19, 4, 4), -1.0)
        for row in range(labels.shape[0]):
            for column in range(labels.shape[1]):
                logits[0, labels[row, column], row, column] = 1.0

        parser = FaceParsing.__new__(FaceParsing)
        parser.preprocess = lambda image: torch.zeros((3, 4, 4), dtype=torch.float32)
        parser.net = lambda image: (logits,)

        mask = np.asarray(parser(Image.new('RGB', (4, 4)), size=(4, 4), mode='lower_face'))

        np.testing.assert_array_equal(
            mask,
            np.array([
                [0, 0, 0, 0],
                [0, 0, 0, 0],
                [255, 0, 255, 255],
                [255, 255, 255, 255],
            ], dtype=np.uint8),
        )

    def test_mouth_mask_region_keeps_its_original_size(self):
        source = np.zeros((100, 120), dtype=np.uint8)
        source[40:60, 45:75] = 255

        expanded = expand_mask_region(source)
        y_points, x_points = np.where(expanded > 0)

        self.assertEqual(MOUTH_MASK_REGION_SCALE, 1.0)
        self.assertEqual(MOUTH_MASK_EXPAND_PX, 0)
        self.assertEqual(int(x_points.max() - x_points.min() + 1), 30)
        self.assertEqual(int(y_points.max() - y_points.min() + 1), 20)
        self.assertAlmostEqual(float(x_points.mean()), 59.5, delta=0.6)
        self.assertAlmostEqual(float(y_points.mean()), 49.5, delta=0.6)

    def test_face_parsing_mouth_mode_keeps_only_lip_and_mouth_classes(self):
        import torch
        from PIL import Image

        from avatars.musetalk.utils.face_parsing import FaceParsing

        labels = np.array([
            [1, 10, 11],
            [12, 13, 14],
        ], dtype=np.int64)
        logits = torch.full((1, 19, 2, 3), -1.0)
        for row in range(labels.shape[0]):
            for column in range(labels.shape[1]):
                logits[0, labels[row, column], row, column] = 1.0

        parser = FaceParsing.__new__(FaceParsing)
        parser.preprocess = lambda image: torch.zeros((3, 2, 3), dtype=torch.float32)
        parser.net = lambda image: (logits,)

        mask = np.asarray(parser(Image.new('RGB', (3, 2)), size=(3, 2), mode='mouth'))

        np.testing.assert_array_equal(
            mask,
            np.array([
                [0, 0, 255],
                [255, 255, 0],
            ], dtype=np.uint8),
        )

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

    def test_fallback_mask_stays_below_nose_and_around_mouth(self):
        mask = np.ones((120, 120), dtype=np.float32)
        limited = limit_blend_mask_to_lower_face(
            mask,
            face_box=[20, 10, 100, 110],
            crop_box=[0, 0, 120, 120],
        )

        self.assertLess(float(limited[20:66].max()), 0.01)
        self.assertGreater(float(limited[75:89, 42:78].mean()), 0.35)
        self.assertGreater(float(limited[76:86, 48:72].mean()), 0.65)
        self.assertLess(float(limited[:, :15].max()), 0.01)
        self.assertLess(float(limited[:, 106:].max()), 0.01)
        self.assertLess(float(limited[111:].max()), 0.01)

    def test_landmarks_keep_mask_below_nose_and_follow_mouth(self):
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

        self.assertLess(float(limited[20:66].max()), 0.01)
        self.assertGreater(float(limited[71:86, 50:90].mean()), 0.80)
        self.assertGreater(float(limited[82:90, 55:85].mean()), 0.50)
        self.assertLess(float(limited[:60].max()), 0.01)
        self.assertLess(float(limited[:, :10].max()), 0.01)
        self.assertLess(float(limited[:, 130:].max()), 0.01)
        self.assertLess(float(limited[125:].max()), 0.01)

    def test_lower_face_uses_fixed_five_pixel_inward_feather(self):
        self.assertEqual(LOWER_FACE_FEATHER_MIN_PX, 5.0)
        self.assertEqual(LOWER_FACE_FEATHER_PX, 5.0)
        self.assertEqual(resolve_lower_face_feather_px(40, 40), 5.0)
        self.assertEqual(resolve_lower_face_feather_px(160, 200), 5.0)
        self.assertEqual(resolve_lower_face_feather_px(400, 500), 5.0)
        limited = limit_blend_mask_to_lower_face(
            np.ones((240, 240), dtype=np.float32),
            face_box=[40, 20, 200, 220],
            crop_box=[0, 0, 240, 240],
        )
        center_x = 120
        nonzero_rows = np.flatnonzero(limited[:, center_x] > 0)
        self.assertGreater(nonzero_rows.size, 30)
        first = int(nonzero_rows[0])
        self.assertLess(float(limited[first, center_x]), 0.30)
        self.assertGreater(float(limited[first + 2, center_x]), 0.50)
        self.assertGreater(float(limited[first + 4, center_x]), 0.95)

    def test_existing_lip_only_mask_expands_without_reaching_nose_or_face_edges(self):
        stale_lip_mask = np.zeros((160, 160), dtype=np.float32)
        cv2.ellipse(stale_lip_mask, (80, 103), (20, 8), 0, 0, 360, 1.0, -1)
        limited = limit_blend_mask_to_lower_face(
            stale_lip_mask,
            face_box=[30, 10, 130, 150],
            crop_box=[0, 0, 160, 160],
        )
        self.assertGreater(float(limited.max()), 0.30)
        self.assertLess(float(limited[20:88].max()), 0.01)
        self.assertGreater(float(limited[stale_lip_mask == 0].max(initial=0.0)), 0.30)
        self.assertLess(float(limited[:, :30].max()), 0.01)
        self.assertLess(float(limited[:, 130:].max()), 0.01)

    def test_reapplying_the_compatibility_mask_would_mutate_new_masks(self):
        landmarks = np.zeros((72, 2), dtype=np.float32)
        mouth_angles = np.linspace(0, 2 * np.pi, 24, endpoint=False)
        landmarks[-24:, 0] = 120 + np.cos(mouth_angles) * 32
        landmarks[-24:, 1] = 150 + np.sin(mouth_angles) * 12
        initial = build_landmark_lower_face_mask(
            np.ones((240, 240), dtype=np.float32),
            face_box=[40, 20, 200, 220],
            crop_box=[0, 0, 240, 240],
            landmarks=landmarks,
        )
        repeated = limit_blend_mask_to_lower_face(
            initial,
            face_box=[40, 20, 200, 220],
            crop_box=[0, 0, 240, 240],
        )

        self.assertGreater(
            abs(float(repeated.sum()) - float(initial.sum())),
            float(initial.sum()) * 0.10,
        )

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
