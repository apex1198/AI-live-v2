'use strict';

(function initFasterLivePortraitTester() {
  const workerOrigin = `${window.location.protocol}//${window.location.hostname || '127.0.0.1'}:8011`;
  const $ = (id) => document.getElementById(id);
  const elements = {
    form: $('flp-form'),
    source: $('source-file'),
    audio: $('audio-file'),
    text: $('driving-text'),
    sourceName: $('source-file-name'),
    audioName: $('audio-file-name'),
    audioField: $('audio-field'),
    textField: $('text-field'),
    voiceField: $('voice-field'),
    voiceName: $('voice-name'),
    profile: $('mlx-profile'),
    run: $('submit-job'),
    status: $('job-status'),
    workerDot: $('worker-dot'),
    workerState: $('worker-state'),
    workerDetail: $('worker-detail'),
    video: $('result-video'),
    empty: $('result-empty'),
    meta: $('result-meta'),
    download: $('download-result'),
  };
  let mode = 'audio';
  let pollTimer = null;
  let textModeAvailable = true;

  const setStatus = (message, state = '') => {
    elements.status.textContent = message;
    if (state) elements.status.dataset.state = state;
    else delete elements.status.dataset.state;
  };

  const updateMode = (nextMode) => {
    if (nextMode === 'text' && !textModeAvailable) nextMode = 'audio';
    mode = nextMode;
    document.querySelectorAll('.flp-mode').forEach((button) => {
      const active = button.dataset.mode === mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    const isAudio = mode === 'audio';
    elements.audioField.hidden = !isAudio;
    elements.textField.hidden = isAudio;
    elements.voiceField.hidden = isAudio;
    elements.audio.required = isAudio;
    elements.text.required = !isAudio;
    setStatus(isAudio ? 'Add source and driving audio.' : 'Add source and driving text.');
  };

  const readHealth = async () => {
    try {
      const response = await fetch(`${workerOrigin}/health`, { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || `HTTP ${response.status}`);
      const ready = payload.status === 'ready';
      textModeAvailable = Array.isArray(payload.modes) && payload.modes.includes('text');
      const textButton = document.querySelector('.flp-mode[data-mode="text"]');
      if (textButton) textButton.hidden = !textModeAvailable;
      document.querySelector('.flp-mode-group')?.classList.toggle('flp-single-mode', !textModeAvailable);
      if (!textModeAvailable && mode === 'text') updateMode('audio');
      elements.workerDot.dataset.state = ready ? 'ready' : 'checking';
      elements.workerState.textContent = ready ? 'Worker ready' : payload.status || 'Worker starting';
      elements.workerDetail.textContent = payload.text_to_speech?.message || payload.message || 'Waiting for the local MLX worker.';
      return ready;
    } catch (error) {
      elements.workerDot.dataset.state = 'error';
      elements.workerState.textContent = 'Worker offline';
      elements.workerDetail.textContent = `Run pnpm faster-liveportrait:start. ${error.message}`;
      return false;
    }
  };

  const showResult = (job) => {
    const url = `${workerOrigin}${job.output_url}?v=${encodeURIComponent(job.updated_at)}`;
    elements.video.src = url;
    elements.video.hidden = false;
    elements.empty.hidden = true;
    elements.meta.textContent = `${job.output_width} x ${job.output_height} · ${job.output_fps} FPS · ${job.duration_seconds || 'n/a'}s`;
    elements.download.href = url;
    elements.download.hidden = false;
    elements.download.textContent = 'Download MP4';
  };

  const stopPolling = () => {
    if (pollTimer) window.clearTimeout(pollTimer);
    pollTimer = null;
  };

  const pollJob = async (jobId) => {
    try {
      const response = await fetch(`${workerOrigin}/api/jobs/${encodeURIComponent(jobId)}`, { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || `HTTP ${response.status}`);
      const job = payload.job;
      if (job.status === 'completed') {
        showResult(job);
        setStatus('Render completed.');
        elements.run.disabled = false;
        stopPolling();
        return;
      }
      if (job.status === 'failed') {
        setStatus(job.error || job.message || 'Render failed.', 'error');
        elements.run.disabled = false;
        stopPolling();
        return;
      }
      setStatus(job.message || `${job.status}…`);
      pollTimer = window.setTimeout(() => pollJob(jobId), 1400);
    } catch (error) {
      setStatus(`Could not read job status: ${error.message}`, 'error');
      elements.run.disabled = false;
      stopPolling();
    }
  };

  elements.source.addEventListener('change', () => {
    elements.sourceName.textContent = elements.source.files?.[0]?.name || 'Choose source';
  });
  elements.audio.addEventListener('change', () => {
    elements.audioName.textContent = elements.audio.files?.[0]?.name || 'Choose audio';
  });
  document.querySelectorAll('.flp-mode').forEach((button) => button.addEventListener('click', () => updateMode(button.dataset.mode)));

  elements.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!await readHealth()) {
      setStatus('The local FasterLivePortrait worker is offline.', 'error');
      return;
    }
    const source = elements.source.files?.[0];
    const audio = elements.audio.files?.[0];
    const text = elements.text.value.trim();
    if (!source || (mode === 'audio' && !audio) || (mode === 'text' && !text)) {
      setStatus('Provide the required portrait and driving input.', 'error');
      return;
    }
    stopPolling();
    elements.run.disabled = true;
    setStatus('Submitting lipsync job…');
    const formData = new FormData();
    formData.append('source', source);
    formData.append('profile', elements.profile.value);
    if (mode === 'audio') formData.append('audio', audio);
    else {
      formData.append('text', text);
      formData.append('voice_name', elements.voiceName.value.trim() || 'qwen-default');
    }
    try {
      const response = await fetch(`${workerOrigin}/api/jobs`, { method: 'POST', body: formData });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || `HTTP ${response.status}`);
      setStatus(payload.job.message || 'Queued');
      pollJob(payload.job.id);
    } catch (error) {
      setStatus(`Could not submit render: ${error.message}`, 'error');
      elements.run.disabled = false;
    }
  });

  updateMode(mode);
  readHealth();
  window.setInterval(readHealth, 10000);
})();
