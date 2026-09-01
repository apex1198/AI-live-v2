import uuid
import time
import threading
import json
import os
import requests
import cv2
from concurrent.futures import ThreadPoolExecutor
from utils.logger import logger

class AvatarTask:
    def __init__(self, task_id, model_type, avatar_id, params, notify_url=None):
        self.task_id = task_id
        self.model_type = model_type
        self.avatar_id = avatar_id
        self.params = params
        self.status = "pending"  # pending, running, completed, failed
        self.progress = 0
        self.stage = "queued"
        self.stage_message = "Waiting for training worker"
        self.error_msg = ""
        self.notify_url = notify_url
        self.start_time = time.time()
        self.end_time = None

    def to_dict(self):
        return {
            "task_id": self.task_id,
            "model_type": self.model_type,
            "avatar_id": self.avatar_id,
            "status": self.status,
            "progress": self.progress,
            "stage": self.stage,
            "stage_message": self.stage_message,
            "error_msg": self.error_msg,
            "notify_url": self.notify_url,
            "start_time": self.start_time,
            "end_time": self.end_time,
            "duration": (self.end_time or time.time()) - self.start_time
        }

class TaskManager:
    def __init__(self, max_workers=None):
        if max_workers is None:
            try:
                max_workers = int(os.getenv("LIVETALKING_TRAIN_WORKERS", "1"))
            except ValueError:
                max_workers = 1
        self.max_workers = max(1, min(4, max_workers))
        self.executor = ThreadPoolExecutor(
            max_workers=self.max_workers,
            thread_name_prefix="avatar-training",
        )
        self.tasks = {}
        self.lock = threading.Lock()

    def add_task(self, model_type, avatar_id, params, task_id=None, notify_url=None):
        if task_id is None:
            task_id = str(uuid.uuid4())

        task = AvatarTask(task_id, model_type, avatar_id, params, notify_url)
        with self.lock:
            self.tasks[task_id] = task

        self._notify(task)
        self.executor.submit(self._run_task, task_id)
        return task_id

    def get_task(self, task_id):
        with self.lock:
            return self.tasks.get(task_id)

    def delete_task(self, task_id):
        with self.lock:
            task = self.tasks.get(task_id)
            if not task:
                return False, "Task not found"

            if task.status != "pending":
                return False, f"Task is in {task.status} state, cannot delete"

            del self.tasks[task_id]
            return True, "Task deleted"

    def list_tasks(self):
        with self.lock:
            return sorted([task.to_dict() for task in self.tasks.values()], key=lambda x: x['start_time'], reverse=True)

    def _run_task(self, task_id):
        task = self.get_task(task_id)
        if not task:
            return

        task.status = "running"
        task.progress = 1
        task.stage = "preparing_face_detector"
        task.stage_message = "Preparing face detector"
        self._notify(task)
        logger.info(f"Starting task {task_id} for model {task.model_type}, avatar {task.avatar_id}")

        try:
            def progress_callback(p):
                task.progress = max(1, min(100, int(p)))
                if task.progress < 20:
                    task.stage = "extracting_frames"
                    task.stage_message = "Extracting video frames"
                elif task.progress < 50:
                    task.stage = "detecting_face"
                    task.stage_message = "Detecting and tracking face"
                elif task.progress < 90:
                    task.stage = "building_avatar"
                    task.stage_message = "Building avatar data"
                elif task.progress < 100:
                    task.stage = "finalizing"
                    task.stage_message = "Finalizing avatar"

            if task.model_type == "musetalk":
                from avatars.musetalk.genavatar import generate_avatar
                generate_avatar(
                    video_path=task.params['video_path'],
                    avatar_id=task.avatar_id,
                    save_path=task.params.get('save_path', './data/avatars'),
                    bbox_shift=task.params.get('bbox_shift', 0),
                    extra_margin=task.params.get('extra_margin', 10),
                    parsing_mode=task.params.get('parsing_mode', 'jaw'),
                    version=task.params.get('version', 'v15'),
                    progress_callback=progress_callback
                )
            elif task.model_type == "wav2lip":
                from avatars.wav2lip.genavatar import generate_avatar
                generate_avatar(
                    video_path=task.params['video_path'],
                    avatar_id=task.avatar_id,
                    save_path=task.params.get('save_path', './data/avatars'),
                    img_size=task.params.get('img_size', 96),
                    pads=task.params.get('pads', [0, 10, 0, 0]),
                    nosmooth=task.params.get('nosmooth', False),
                    face_det_batch_size=task.params.get('face_det_batch_size', 16),
                    progress_callback=progress_callback
                )
            else:
                raise ValueError(f"Unsupported model type: {task.model_type}")

            save_path = os.path.abspath(task.params.get('save_path', './data/avatars'))
            native_root = os.path.abspath('./data/avatars')
            trained_avatar = os.path.join(save_path, task.avatar_id)
            native_avatar = os.path.join(native_root, task.avatar_id)
            if save_path != native_root and os.path.isdir(trained_avatar):
                os.makedirs(native_root, exist_ok=True)
                if os.path.lexists(native_avatar):
                    if os.path.islink(native_avatar):
                        os.unlink(native_avatar)
                    else:
                        raise RuntimeError(f"Native avatar path already exists: {native_avatar}")
                os.symlink(trained_avatar, native_avatar, target_is_directory=True)

            task.status = "completed"
            task.progress = 100
            task.stage = "completed"
            task.stage_message = "Avatar ready"
            self._notify(task)
            logger.info(f"Task {task_id} completed successfully")
        except Exception as e:
            task.status = "failed"
            task.stage = "failed"
            task.stage_message = "Training failed"
            task.error_msg = str(e)
            self._notify(task)
            logger.error(f"Task {task_id} failed: {e}")
        finally:
            task.end_time = time.time()
            try:
                from avatars.musetalk.model_resources import release_accelerator_cache
                release_accelerator_cache()
            except Exception:
                pass

    def _notify(self, task):
        if not task.notify_url:
            return

        try:
            payload = task.to_dict()
            logger.info(f"Sending notification for task {task.task_id} to {task.notify_url}")
            requests.post(task.notify_url, json=payload, timeout=5)
        except Exception as e:
            logger.error(f"Failed to send notification for task {task.task_id}: {e}")

task_manager = TaskManager()
