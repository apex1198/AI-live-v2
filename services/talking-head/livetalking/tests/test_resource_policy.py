import os
import threading
import unittest
from unittest.mock import patch

from avatars.musetalk.model_resources import (
    bounded_preprocess_size,
    get_shared_vae,
    set_shared_vae,
    scale_box,
    throttle_training,
    vae_lock,
)


class ResourcePolicyTestCase(unittest.TestCase):
    def tearDown(self):
        set_shared_vae(None)

    def test_preprocess_defaults_landscape_and_portrait_to_720p(self):
        with patch.dict('os.environ', {}, clear=False):
            os.environ.pop('LIVETALKING_PREPROCESS_QUALITY', None)
            os.environ.pop('LIVETALKING_MAX_WIDTH', None)
            os.environ.pop('LIVETALKING_MAX_HEIGHT', None)
            self.assertEqual(bounded_preprocess_size(3840, 2160), (1280, 720))
            self.assertEqual(bounded_preprocess_size(2160, 3840), (720, 1280))
            self.assertEqual(bounded_preprocess_size(640, 360), (640, 360))

    def test_scales_legacy_avatar_coordinates_with_the_frame(self):
        self.assertEqual(scale_box([100, 80, 500, 600], 0.75, 0.75), [75, 60, 375, 450])

    def test_training_reuses_the_inference_vae_and_lock(self):
        shared = object()
        set_shared_vae(shared)
        self.assertIs(get_shared_vae(), shared)
        self.assertIsInstance(vae_lock(), type(threading.RLock()))

    def test_training_duty_cycle_defaults_to_twenty_percent(self):
        with patch('avatars.musetalk.model_resources.time.perf_counter', return_value=10.1), \
             patch('avatars.musetalk.model_resources.time.sleep') as sleep, \
             patch.dict('os.environ', {'AVATAR_TRAIN_RESOURCE_FRACTION': '0.20'}):
            throttle_training(10.0)
        sleep.assert_called_once()
        self.assertAlmostEqual(sleep.call_args.args[0], 0.4, places=5)


if __name__ == '__main__':
    unittest.main()
