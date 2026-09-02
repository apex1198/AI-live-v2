# LiveTalking worker integration

This directory is a shallow checkout of `lipku/LiveTalking` plus the local
dashboard compatibility routes `/health`, `/speak`, and `/interrupt`.

The dashboard connects to `/offer` with WebRTC and renders the returned neural
video track directly. Browser retargeting remains only a disconnected-worker
fallback.

Run MuseTalk after creating an avatar:

```bash
LIVETALKING_MODEL=musetalk \
LIVETALKING_AVATAR_ID=musetalk_avatar1 \
./run_worker.sh
```

The local worker defaults to `http://localhost:2222` because port 8010 is used
by the existing Ditto service. Create an avatar through the upstream
`POST /api/avatar/task` API. MuseTalk preprocessing produces `coords.pkl`,
`latents.pt`, `mask/`, and `mask_coords.pkl` under `data/avatars/<avatar_id>`.

The worker is isolated in `.venv` and uses Apple Metal through PyTorch MPS.
`PYTORCH_ENABLE_MPS_FALLBACK=1` is enabled for unsupported individual ops.
