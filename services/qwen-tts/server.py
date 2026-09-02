import argparse
import io
import json
import logging
import shutil
import threading
import time
import uuid
from pathlib import Path

import mlx.core as mx
import numpy as np
import soundfile as sf
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from mlx_audio.tts.utils import load_model
from mlx_audio.utils import load_audio
from pydantic import BaseModel, Field


LOGGER = logging.getLogger("qwen-tts-vi")
ALLOWED_AUDIO = {".wav", ".mp3", ".m4a"}
DEFAULT_VOICE_ID = "qwen-default"


class SynthesisInput(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    voice_id: str = DEFAULT_VOICE_ID
    speed: float = Field(default=1.0, ge=0.5, le=2.0)


class Engine:
    def __init__(self, model_path: str, data_dir: str):
        self.model_path = Path(model_path).resolve()
        self.data_dir = Path(data_dir).resolve()
        self.voices_dir = self.data_dir / "voices"
        self.voices_dir.mkdir(parents=True, exist_ok=True)
        self.model = None
        self.model_lock = threading.RLock()
        self.load_lock = threading.Lock()
        self.loaded_at = 0.0

    def load(self):
        if self.model is not None:
            return self.model
        with self.load_lock:
            if self.model is not None:
                return self.model
            self._load_model()
        return self.model

    def _load_model(self):
        LOGGER.info("Loading Vietnamese Qwen TTS from %s", self.model_path)
        self.model = load_model(self.model_path)
        self.loaded_at = time.time()
        self.warm_voice(DEFAULT_VOICE_ID)
        LOGGER.info("Vietnamese Qwen TTS is ready")

    def _builtin_profiles(self):
        info_path = self.model_path / "data" / "ref_info.json"
        if not info_path.is_file():
            raise RuntimeError("Qwen Vietnamese reference voices are missing")
        info = json.loads(info_path.read_text(encoding="utf-8"))
        profiles = []
        for key, voice in info.items():
            profiles.append({
                "id": DEFAULT_VOICE_ID if key == "yen_nhi" else f"qwen-{key}",
                "voice_id": DEFAULT_VOICE_ID if key == "yen_nhi" else f"qwen-{key}",
                "name": voice["name"],
                "kind": "preset",
                "provider": "qwentts",
                "ref_audio": str((self.model_path / voice["audio_path"]).resolve()),
                "ref_text": voice["text"],
                "builtin": True,
            })
        return profiles

    def profiles(self):
        profiles = self._builtin_profiles()
        for metadata_path in sorted(self.voices_dir.glob("*.json")):
            try:
                profile = json.loads(metadata_path.read_text(encoding="utf-8"))
                source = Path(profile.get("ref_audio", ""))
                if source.is_file():
                    profiles.append(profile)
            except (OSError, ValueError, TypeError):
                LOGGER.warning("Ignoring invalid voice profile %s", metadata_path)
        return profiles

    def profile(self, voice_id: str):
        return next((profile for profile in self.profiles() if profile["voice_id"] == voice_id), None)

    def warm_voice(self, voice_id: str):
        self.load()
        profile = self.profile(voice_id)
        if not profile:
            raise ValueError("Voice profile not found")
        reference = load_audio(profile["ref_audio"], sample_rate=self.model.sample_rate)
        with self.model_lock:
            prepared = self.model._prepare_icl_generation_inputs(
                text="Xin chao.",
                ref_audio=reference,
                ref_text=profile["ref_text"],
                language="Vietnamese",
            )
            mx.eval(*prepared)
        return profile

    def clone(self, name: str, transcript: str, upload: UploadFile):
        transcript = transcript.strip()
        if not transcript:
            raise ValueError("Transcript is required to clone a Qwen voice quickly and accurately")
        suffix = Path(upload.filename or "").suffix.lower()
        if suffix not in ALLOWED_AUDIO:
            raise ValueError("Use WAV, MP3, or M4A reference audio")
        voice_id = f"qwen-voice-{uuid.uuid4().hex[:16]}"
        audio_path = self.voices_dir / f"{voice_id}{suffix}"
        metadata_path = self.voices_dir / f"{voice_id}.json"
        with audio_path.open("wb") as target:
            shutil.copyfileobj(upload.file, target)
        profile = {
            "id": voice_id,
            "voice_id": voice_id,
            "name": name.strip() or "Cloned voice",
            "kind": "clone",
            "provider": "qwentts",
            "ref_audio": str(audio_path),
            "ref_text": transcript,
            "builtin": False,
            "created_at": int(time.time() * 1000),
        }
        metadata_path.write_text(json.dumps(profile, ensure_ascii=False, indent=2), encoding="utf-8")
        try:
            self.warm_voice(voice_id)
        except Exception:
            metadata_path.unlink(missing_ok=True)
            audio_path.unlink(missing_ok=True)
            raise
        return profile

    def synthesize(self, payload: SynthesisInput):
        self.load()
        profile = self.profile(payload.voice_id)
        if not profile:
            raise ValueError("Voice profile not found")
        started = time.perf_counter()
        with self.model_lock:
            result = next(self.model.generate(
                text=payload.text.strip(),
                lang_code="Vietnamese",
                ref_audio=profile["ref_audio"],
                ref_text=profile["ref_text"],
                temperature=0.3,
                top_k=20,
                top_p=0.9,
                repetition_penalty=2.0,
                max_tokens=4096,
                verbose=False,
            ))
            audio = np.asarray(result.audio, dtype=np.float32)
        output = io.BytesIO()
        sf.write(output, audio, result.sample_rate, format="WAV", subtype="PCM_16")
        duration_ms = round(len(audio) / result.sample_rate * 1000)
        generation_ms = round((time.perf_counter() - started) * 1000)
        return output.getvalue(), duration_ms, generation_ms


def create_app(engine: Engine):
    app = FastAPI(title="Qwen Vietnamese TTS", version="1.0.0")

    @app.get("/api/health")
    def health():
        return {
            "ready": True,
            "model_loaded": engine.model is not None,
            "provider": "qwentts",
            "model": "gwen-tts-0.6B-vi-8bit",
            "backend": "mlx",
            "default_voice_id": DEFAULT_VOICE_ID,
            "loaded_at": engine.loaded_at,
        }

    @app.get("/api/voices")
    def voices():
        return [{key: value for key, value in profile.items() if key != "ref_audio"} for profile in engine.profiles()]

    @app.post("/api/voices/clone", status_code=201)
    def clone_voice(name: str = Form(...), transcript: str = Form(...), file: UploadFile = File(...)):
        try:
            profile = engine.clone(name, transcript, file)
            return {key: value for key, value in profile.items() if key != "ref_audio"}
        except ValueError as error:
            raise HTTPException(400, str(error)) from error

    @app.post("/api/synthesize")
    def synthesize(payload: SynthesisInput):
        try:
            audio, duration_ms, generation_ms = engine.synthesize(payload)
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
        return Response(
            content=audio,
            media_type="audio/wav",
            headers={
                "X-Audio-Duration-Ms": str(duration_ms),
                "X-Generation-Ms": str(generation_ms),
                "X-TTS-Provider": "qwentts",
            },
        )

    return app


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=3333)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s: %(message)s")
    engine = Engine(args.model, args.data_dir)
    uvicorn.run(create_app(engine), host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
