import unittest

import cv2
import numpy as np

from avatars.musetalk.myutil import match_generated_face_color


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

        generated_luma = cv2.cvtColor(generated, cv2.COLOR_BGR2LAB)[:, :, 0].astype(np.float32)
        corrected_luma = cv2.cvtColor(corrected, cv2.COLOR_BGR2LAB)[:, :, 0].astype(np.float32)
        self.assertLess(float(np.abs(corrected_luma - generated_luma).mean()), 2.0)

    def test_leaves_matching_source_color_unchanged(self):
        source = np.full((64, 64, 3), (130, 155, 188), dtype=np.uint8)
        corrected = match_generated_face_color(source.copy(), source)
        self.assertLessEqual(int(np.abs(corrected.astype(np.int16) - source.astype(np.int16)).max()), 2)


if __name__ == '__main__':
    unittest.main()
