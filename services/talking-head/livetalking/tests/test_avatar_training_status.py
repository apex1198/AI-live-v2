import sys
import tempfile
import types
import unittest
from unittest.mock import patch

from server.task_manager import AvatarTask, TaskManager


class AvatarTrainingStatusTestCase(unittest.TestCase):
    def test_pending_task_has_a_human_readable_queue_state(self):
        task = AvatarTask("task-1", "musetalk", "avatar-1", {})
        payload = task.to_dict()
        self.assertEqual(payload["stage"], "queued")
        self.assertEqual(payload["stage_message"], "Waiting for training worker")

    def test_running_task_reports_face_detector_before_model_import_finishes(self):
        manager = TaskManager(max_workers=1)
        observed = []

        def generate_avatar(**kwargs):
            task = manager.get_task("task-2")
            observed.append((task.progress, task.stage, task.stage_message))
            kwargs["progress_callback"](20)

        fake_module = types.ModuleType("avatars.musetalk.genavatar")
        fake_module.generate_avatar = generate_avatar

        with tempfile.TemporaryDirectory() as directory:
            task = AvatarTask(
                "task-2",
                "musetalk",
                "avatar-2",
                {"video_path": "source.mp4", "save_path": directory},
            )
            manager.tasks[task.task_id] = task
            with patch.dict(sys.modules, {"avatars.musetalk.genavatar": fake_module}):
                manager._run_task(task.task_id)

        self.assertEqual(observed, [(1, "preparing_face_detector", "Preparing face detector")])
        self.assertEqual(task.status, "completed")
        self.assertEqual(task.progress, 100)
        self.assertEqual(task.stage_message, "Avatar ready")


if __name__ == "__main__":
    unittest.main()
