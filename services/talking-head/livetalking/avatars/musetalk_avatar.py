###############################################################################
#  Copyright (C) 2024 LiveTalking@lipku https://github.com/lipku/LiveTalking
#  email: lipku@foxmail.com
# 
#  Licensed under the Apache License, Version 2.0 (the "License");
#  you may not use this file except in compliance with the License.
#  You may obtain a copy of the License at
#  
#       http://www.apache.org/licenses/LICENSE-2.0
# 
#  Unless required by applicable law or agreed to in writing, software
#  distributed under the License is distributed on an "AS IS" BASIS,
#  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
#  See the License for the specific language governing permissions and
#  limitations under the License.
###############################################################################
#
#  MuseTalk 数字人 — 迁移自 musereal.py + museasr.py
#

import math
import torch
import numpy as np

import subprocess
import os
import json
import time
import torch.nn.functional as F
import cv2
import glob
import pickle

import queue
import threading
from queue import Queue
from threading import Thread, Event
import torch.multiprocessing as mp

from avatars.musetalk.utils.utils import get_file_type,get_video_fps,datagen
from avatars.musetalk.myutil import (
    build_mediapipe_mouth_mask,
    get_image_blending,
    get_image_blending_perspective,
    limit_blend_mask_to_lower_face,
    should_paste_generated_face,
)
from avatars.musetalk.utils.utils import load_all_model
from avatars.musetalk.model_resources import bounded_preprocess_size, scale_box, set_shared_vae, vae_lock
from avatars.musetalk.utils.face_geometry import ALIGNMENT_FORMAT, scale_alignment_for_frame
from avatars.musetalk.whisper.audio2feature import Audio2Feature

from avatars.audio_features.whisper import WhisperASR
import asyncio
from av import AudioFrame, VideoFrame
from avatars.base_avatar import BaseAvatar

from tqdm import tqdm
from utils.logger import logger
from utils.image import mirror_index
from utils.device import initialize_device
from registry import register

MUSETALK_MASK_MODES = {"none", "repo", "mediapipe_478", "adaptive"}
_musetalk_mask_mode = os.getenv("MUSETALK_MASK_MODE", "adaptive")
if _musetalk_mask_mode not in MUSETALK_MASK_MODES:
    _musetalk_mask_mode = "adaptive"


def get_musetalk_mask_mode():
    return _musetalk_mask_mode


def set_musetalk_mask_mode(mode):
    global _musetalk_mask_mode
    normalized = str(mode or "").strip().lower()
    if normalized not in MUSETALK_MASK_MODES:
        raise ValueError(f"Unsupported MuseTalk mask mode: {mode}")
    _musetalk_mask_mode = normalized
    logger.info("MuseTalk mask mode changed to %s", normalized)
    return normalized


def loop_safe_frame_index(length, index, source_fps, model_fps):
    """Traverse forward then backward so a loop never jumps last -> first."""
    length = max(1, int(length))
    if length == 1:
        return 0
    source_step = float(source_fps) / max(1.0, float(model_fps))
    cycle_length = 2 * (length - 1)
    position = int(round(index * source_step)) % cycle_length
    return position if position < length else cycle_length - position

device = initialize_device()
logger.info('Using {} for inference.'.format(device))

def load_model():
    # load model weights
    vae, unet, pe = load_all_model(device=device)
    #device = torch.device("cuda" if torch.cuda.is_available() else ("mps" if (hasattr(torch.backends, "mps") and torch.backends.mps.is_available()) else "cpu"))
    timesteps = torch.tensor([0], device=device)
    pe = pe.half().to(device)
    vae.vae = vae.vae.half().to(device)
    unet.model = unet.model.half().to(device)
    # Initialize audio processor and Whisper model
    audio_processor = Audio2Feature(model_path="./models/whisper")
    set_shared_vae(vae)
    return vae, unet, pe, timesteps, audio_processor

def load_avatar(avatar_id):
    avatar_path = f"./data/avatars/{avatar_id}"
    full_imgs_path = f"{avatar_path}/full_imgs" 
    coords_path = f"{avatar_path}/coords.pkl"
    latents_out_path= f"{avatar_path}/latents.pt"
    video_out_path = f"{avatar_path}/vid_output/"
    mask_out_path =f"{avatar_path}/mask"
    mask_coords_path =f"{avatar_path}/mask_coords.pkl"
    alignment_path = f"{avatar_path}/alignment.pkl"
    avatar_info_path = f"{avatar_path}/avator_info.json"

    avatar_info = {}
    try:
        with open(avatar_info_path, 'r', encoding='utf-8') as info_file:
            avatar_info = json.load(info_file)
    except (OSError, TypeError, ValueError, json.JSONDecodeError):
        pass
    has_geometry_alignment = avatar_info.get("alignment_format") == ALIGNMENT_FORMAT
    has_compact_landmark_masks = has_geometry_alignment and avatar_info.get('mask_format') in {
        'mouth_landmarks_inward15_v1',
        'mouth_landmarks_adaptive_inward_v2',
        'mouth_landmarks_adaptive_inward_expanded130_v3',
        'mouth_landmarks_expanded130_plus10_feather5_v4',
        'parsed_lower_face_under_nose_feather5_v5',
        'parsed_lower_face_under_nose_expand10_feather5_v6',
        'mediapipe_478_mouth_pad10x8_feather5_v7',
        'mediapipe_478_lower_face_inset5pct_feather5_v8',
        'mediapipe_478_lower_face_inset5pct_scale80_feather5_v9',
        'mediapipe_478_lower_face_mouth_inset20pct_feather5_v10',
        'hybrid_adaptive_v11',
    }
    uses_current_geometry_mask = has_geometry_alignment and avatar_info.get('mask_format') in {
        'mediapipe_478_lower_face_mouth_inset20pct_feather5_v10',
        'hybrid_adaptive_v11',
    }
    input_latent_list_cycle = torch.load(latents_out_path, map_location=device)
    with open(coords_path, 'rb') as f:
        coord_list_cycle = pickle.load(f)
    input_img_list = glob.glob(os.path.join(full_imgs_path, '*.[jpJP][pnPN]*[gG]'))
    input_img_list = [p for p in input_img_list if os.path.splitext(os.path.basename(p))[0].isdigit()]
    input_img_list = sorted(input_img_list, key=lambda x: int(os.path.splitext(os.path.basename(x))[0]))
    with open(mask_coords_path, 'rb') as f:
        mask_coords_list_cycle = pickle.load(f)
    input_mask_list = glob.glob(os.path.join(mask_out_path, '*.[jpJP][pnPN]*[gG]'))
    input_mask_list = sorted(input_mask_list, key=lambda x: int(os.path.splitext(os.path.basename(x))[0]))

    declared_alignment_format = avatar_info.get("alignment_format")
    if declared_alignment_format and declared_alignment_format != ALIGNMENT_FORMAT:
        raise RuntimeError(
            f"Avatar {avatar_id} declares unsupported alignment format "
            f"{declared_alignment_format!r}; regenerate it with {ALIGNMENT_FORMAT!r}"
        )

    alignment_list_cycle = None
    if declared_alignment_format == ALIGNMENT_FORMAT:
        if not os.path.isfile(alignment_path):
            raise RuntimeError(
                f"Avatar {avatar_id} declares {ALIGNMENT_FORMAT} but alignment.pkl is missing"
            )
        try:
            with open(alignment_path, 'rb') as f:
                loaded_alignment = pickle.load(f)
        except (OSError, EOFError, ValueError, pickle.PickleError) as exc:
            raise RuntimeError(f"Could not read {alignment_path}: {exc}") from exc
        if not isinstance(loaded_alignment, list) or len(loaded_alignment) != len(input_img_list):
            raise RuntimeError(
                f"Avatar {avatar_id} alignment/frame count mismatch: "
                f"{len(loaded_alignment) if isinstance(loaded_alignment, list) else 'invalid'} "
                f"vs {len(input_img_list)}"
            )
        if any(item is None for item in loaded_alignment):
            raise RuntimeError(f"Avatar {avatar_id} contains a missing per-frame alignment")
        alignment_list_cycle = loaded_alignment

    first_frame = cv2.imread(input_img_list[0]) if input_img_list else None
    if first_frame is None:
        raise RuntimeError(f"Avatar {avatar_id} contains no readable source frames")
    source_height, source_width = first_frame.shape[:2]
    target_width, target_height = bounded_preprocess_size(source_width, source_height)
    scale_x = target_width / source_width
    scale_y = target_height / source_height

    def load_frame(path):
        frame = cv2.imread(path)
        if frame is None:
            raise RuntimeError(f"Could not read avatar frame: {path}")
        if frame.shape[1] != target_width or frame.shape[0] != target_height:
            frame = cv2.resize(frame, (target_width, target_height), interpolation=cv2.INTER_AREA)
        return frame

    frame_list_cycle = [load_frame(path) for path in input_img_list]
    if (target_width, target_height) != (source_width, source_height):
        coord_list_cycle = [scale_box(box, scale_x, scale_y) for box in coord_list_cycle]
        if alignment_list_cycle is not None:
            alignment_list_cycle = [
                scale_alignment_for_frame(alignment, scale_x, scale_y)
                for alignment in alignment_list_cycle
            ]
        else:
            mask_coords_list_cycle = [scale_box(box, scale_x, scale_y) for box in mask_coords_list_cycle]

    # Perspective masks are authored in the fixed 256x256 aligned space.  They
    # must not inherit source-frame scaling, otherwise the loader stretches the
    # mask back to 256x256 and changes its physical coverage.
    if alignment_list_cycle is not None:
        alignment_size = int(avatar_info.get("alignment_size", 256) or 256)
        mask_coords_list_cycle = [[0, 0, alignment_size, alignment_size] for _ in input_mask_list]

    mask_list_cycle = []
    repo_mask_list_cycle = []
    mediapipe_mask_list_cycle = []
    for index, path in enumerate(input_mask_list):
        mask = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
        if mask is None:
            raise RuntimeError(f"Could not read avatar mask: {path}")
        x_s, y_s, x_e, y_e = mask_coords_list_cycle[index]
        mask_width = max(1, x_e - x_s)
        mask_height = max(1, y_e - y_s)
        if mask.shape[1] != mask_width or mask.shape[0] != mask_height:
            mask = cv2.resize(mask, (mask_width, mask_height), interpolation=cv2.INTER_LINEAR)
        repo_mask = mask.astype(np.float32) / 255.0
        repo_mask_list_cycle.append(repo_mask)
        mediapipe_mask = (
            build_mediapipe_mouth_mask(
                alignment_list_cycle[index], mask_width, mask_height,
            ).astype(np.float32) / 255.0
            if alignment_list_cycle is not None
            else repo_mask.copy()
        )
        mediapipe_mask_list_cycle.append(mediapipe_mask)
        # Upgrade existing aligned avatars in memory. Their old mask artifacts
        # used broader support, but the stored 478 landmarks are sufficient to
        # rebuild the new mouth-relative 20% inset without re-training.
        if alignment_list_cycle is not None and not uses_current_geometry_mask:
            normalized_mask = mediapipe_mask.copy()
        else:
            normalized_mask = mask.astype(np.float32) / 255.0
        if not has_compact_landmark_masks:
            normalized_mask = limit_blend_mask_to_lower_face(
                normalized_mask,
                coord_list_cycle[index],
                mask_coords_list_cycle[index],
            )
        mask_list_cycle.append(normalized_mask)
    source_fps = 25.0
    try:
        source_fps = max(1.0, float(avatar_info.get('source_fps', source_fps)))
    except (TypeError, ValueError):
        pass
    return (
        frame_list_cycle,
        mask_list_cycle,
        coord_list_cycle,
        mask_coords_list_cycle,
        input_latent_list_cycle,
        source_fps,
        alignment_list_cycle,
        repo_mask_list_cycle,
        mediapipe_mask_list_cycle,
    )


def _unpack_avatar_data(avatar):
    """Accept legacy six-item avatar payloads while loading aligned avatars."""
    if avatar is None:
        raise RuntimeError("MuseTalk avatar dataset was not loaded")
    if not isinstance(avatar, (tuple, list)) or len(avatar) < 6:
        raise RuntimeError("MuseTalk avatar dataset is incomplete")
    if len(avatar) >= 9:
        return avatar[:9]
    if len(avatar) >= 7:
        return (*avatar[:7], avatar[1], avatar[1])
    return (*avatar[:6], None, avatar[1], avatar[1])

@torch.no_grad()
def warm_up(batch_size,model):
    # 预热函数
    print('warmup model...')
    vae, unet, pe, timesteps, audio_processor = model
    whisper_batch = np.ones((batch_size, 50, 384), dtype=np.uint8)
    latent_batch = torch.ones(batch_size, 8, 32, 32).to(unet.device)

    audio_feature_batch = torch.from_numpy(whisper_batch)
    audio_feature_batch = audio_feature_batch.to(device=unet.device, dtype=unet.model.dtype)
    audio_feature_batch = pe(audio_feature_batch)
    latent_batch = latent_batch.to(dtype=unet.model.dtype)
    pred_latents = unet.model(latent_batch,
                              timesteps,
                              encoder_hidden_states=audio_feature_batch).sample
    vae.decode_latents(pred_latents)    

@register("avatar", "musetalk")
class MuseReal(BaseAvatar):
    @torch.no_grad()
    def __init__(self, opt, model, avatar):
        super().__init__(opt)

        #self.fps = opt.fps # 20 ms per frame

        # self.batch_size = opt.batch_size
        # self.idx = 0
        # self.res_frame_queue = mp.Queue(self.batch_size*2)

        self.vae, self.unet, self.pe, self.timesteps, self.audio_processor = model

        (
            self.frame_list_cycle,
            self.mask_list_cycle,
            self.coord_list_cycle,
            self.mask_coords_list_cycle,
            self.input_latent_list_cycle,
            self.source_fps,
            self.alignment_list_cycle,
            self.repo_mask_list_cycle,
            self.mediapipe_mask_list_cycle,
        ) = _unpack_avatar_data(avatar)
        self._avatar_data_lock = threading.RLock()
        self._lip_color_state = {}

        self.asr = WhisperASR(opt,self,self.audio_processor)
        self.asr.warm_up()

    def map_frame_index(self, length, index):
        lock = getattr(self, '_avatar_data_lock', None)
        if lock is None:
            source_fps = self.source_fps
        else:
            with lock:
                source_fps = self.source_fps
        return loop_safe_frame_index(length, index, source_fps, self.opt.fps)

    def get_avatar_length(self):
        with self._avatar_data_lock:
            return max(1, len(self.frame_list_cycle))

    def get_idle_frame(self, idx):
        with self._avatar_data_lock:
            length = max(1, len(self.frame_list_cycle))
            safe_idx = int(idx) % length
            return self.frame_list_cycle[safe_idx]

    def switch_avatar(self, avatar_id, avatar):
        # Drop every queued frame from the previous dataset before the atomic
        # swap. The epoch check prevents an in-flight inference result from
        # being pasted onto the new Avatar.
        self.flush_talk()
        with self._avatar_data_lock:
            (
                self.frame_list_cycle,
                self.mask_list_cycle,
                self.coord_list_cycle,
                self.mask_coords_list_cycle,
                self.input_latent_list_cycle,
                self.source_fps,
                self.alignment_list_cycle,
                self.repo_mask_list_cycle,
                self.mediapipe_mask_list_cycle,
            ) = _unpack_avatar_data(avatar)
            self.opt.avatar_id = avatar_id
            self.current_frame_index = 0
            self._lip_color_state = {}
    

    @torch.no_grad()
    def inference_batch(self, index, audiofeat_batch):
        with self._avatar_data_lock:
            length = max(1, len(self.input_latent_list_cycle))
        frame_indices = [self.map_frame_index(length, index + i) for i in range(self.batch_size)]
        return self.inference_batch_for_indices(index, audiofeat_batch, frame_indices)

    @torch.no_grad()
    def inference_batch_for_indices(self, index, audiofeat_batch, frame_indices):
        # frame_indices is the single source of truth for latent, source frame,
        # bbox and mask selection throughout this batch.
        with self._avatar_data_lock:
            latent_cycle = self.input_latent_list_cycle
            length = max(1, len(latent_cycle))
            resolved_indices = [int(idx) % length for idx in frame_indices]
        whisper_batch = np.stack(audiofeat_batch)
        latent_batch = [latent_cycle[idx] for idx in resolved_indices]
        latent_batch = torch.cat(latent_batch, dim=0)
        
        audio_feature_batch = torch.from_numpy(whisper_batch)
        audio_feature_batch = audio_feature_batch.to(device=self.unet.device,
                                                        dtype=self.unet.model.dtype)
        audio_feature_batch = self.pe(audio_feature_batch)
        latent_batch = latent_batch.to(device=self.unet.device, dtype=self.unet.model.dtype)

        pred_latents = self.unet.model(latent_batch, 
                                    self.timesteps, 
                                    encoder_hidden_states=audio_feature_batch).sample
        with vae_lock():
            pred = self.vae.decode_latents(pred_latents)
        return pred

    def paste_back_frame(self,pred_frame,idx:int):
        with self._avatar_data_lock:
            length = max(1, len(self.frame_list_cycle))
            safe_idx = int(idx) % length
            bbox = self.coord_list_cycle[safe_idx]
            ori_frame = self.frame_list_cycle[safe_idx].copy()
            mask_mode = get_musetalk_mask_mode()
            if mask_mode == "repo":
                mask = self.repo_mask_list_cycle[safe_idx]
            elif mask_mode == "mediapipe_478":
                mask = self.mediapipe_mask_list_cycle[safe_idx]
            elif mask_mode == "none":
                mask = np.ones_like(self.mask_list_cycle[safe_idx], dtype=np.float32)
            else:
                mask = self.mask_list_cycle[safe_idx]
            mask_crop_box = self.mask_coords_list_cycle[safe_idx]
            color_state = self._lip_color_state
            alignment_list = getattr(self, "alignment_list_cycle", None)
        x1, y1, x2, y2 = bbox

        if alignment_list is not None and alignment_list[safe_idx] is not None:
            if not should_paste_generated_face(alignment_list[safe_idx]):
                return ori_frame
            return get_image_blending_perspective(
                ori_frame,
                pred_frame.astype(np.uint8),
                mask,
                alignment_list[safe_idx],
                color_state,
            )

        res_frame = cv2.resize(pred_frame.astype(np.uint8),(x2-x1,y2-y1))

        combine_frame = get_image_blending(
            ori_frame,
            res_frame,
            bbox,
            mask,
            mask_crop_box,
            color_state,
        )
        return combine_frame

    def paste_back_frame_for_epoch(self, pred_frame, idx, batch_epoch):
        with self._avatar_data_lock:
            if batch_epoch != self._flush_epoch:
                return None
            return self.paste_back_frame(pred_frame, idx)
            
