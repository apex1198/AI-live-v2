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
from avatars.musetalk.myutil import get_image_blending, limit_blend_mask_to_lower_face
from avatars.musetalk.utils.utils import load_all_model
from avatars.musetalk.model_resources import bounded_preprocess_size, scale_box, set_shared_vae, vae_lock
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
    avatar_info_path = f"{avatar_path}/avator_info.json"

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
        mask_coords_list_cycle = [scale_box(box, scale_x, scale_y) for box in mask_coords_list_cycle]

    mask_list_cycle = []
    for index, path in enumerate(input_mask_list):
        mask = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
        if mask is None:
            raise RuntimeError(f"Could not read avatar mask: {path}")
        x_s, y_s, x_e, y_e = mask_coords_list_cycle[index]
        mask_width = max(1, x_e - x_s)
        mask_height = max(1, y_e - y_s)
        if mask.shape[1] != mask_width or mask.shape[0] != mask_height:
            mask = cv2.resize(mask, (mask_width, mask_height), interpolation=cv2.INTER_LINEAR)
        mask_list_cycle.append(limit_blend_mask_to_lower_face(
            mask.astype(np.float32) / 255.0,
            coord_list_cycle[index],
            mask_coords_list_cycle[index],
        ))
    source_fps = 25.0
    try:
        with open(avatar_info_path, 'r', encoding='utf-8') as info_file:
            source_fps = max(1.0, float(json.load(info_file).get('source_fps', source_fps)))
    except (OSError, TypeError, ValueError, json.JSONDecodeError):
        pass
    return frame_list_cycle,mask_list_cycle,coord_list_cycle,mask_coords_list_cycle,input_latent_list_cycle,source_fps

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

        self.frame_list_cycle,self.mask_list_cycle,self.coord_list_cycle,self.mask_coords_list_cycle, self.input_latent_list_cycle,self.source_fps = avatar
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
            safe_idx = loop_safe_frame_index(length, idx, self.source_fps, self.opt.fps)
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
            ) = avatar
            self.opt.avatar_id = avatar_id
            self.current_frame_index = 0
            self._lip_color_state = {}
    

    @torch.no_grad()
    def inference_batch(self, index, audiofeat_batch):
        # 这里的 index 是针对当前 avatar 的索引
        # 返回一个 batch 的推理结果，batch 大小由 self.batch_size 决定
        with self._avatar_data_lock:
            latent_cycle = self.input_latent_list_cycle
            source_fps = self.source_fps
        length = len(latent_cycle)
        whisper_batch = np.stack(audiofeat_batch)
        latent_batch = []
        for i in range(self.batch_size):
            idx = loop_safe_frame_index(length, index + i, source_fps, self.opt.fps)
            latent = latent_cycle[idx]
            latent_batch.append(latent)
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
            safe_idx = loop_safe_frame_index(length, idx, self.source_fps, self.opt.fps)
            bbox = self.coord_list_cycle[safe_idx]
            ori_frame = self.frame_list_cycle[safe_idx].copy()
            mask = self.mask_list_cycle[safe_idx]
            mask_crop_box = self.mask_coords_list_cycle[safe_idx]
            color_state = self._lip_color_state
        x1, y1, x2, y2 = bbox

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
            
