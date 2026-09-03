'use strict';

(function installLiveTalkingClient(global) {
  const runtime = global.RuntimeApi;
  if (!runtime) throw new Error('RuntimeApi must load before LiveTalkingApi');

  function requireWorkerOk(payload) {
    if (typeof payload?.code === 'number' && payload.code !== 0) {
      const taskErrors = Array.isArray(payload?.data?.tasks)
        ? payload.data.tasks
          .map(task => task?.error_msg)
          .filter(Boolean)
        : [];
      throw new Error(taskErrors.join('; ') || payload.msg || 'LiveTalking worker request failed');
    }
    return payload;
  }

  global.LiveTalkingApi = Object.freeze({
    health: () => runtime.get('/api/talking-head/livetalking/status'),
    workerStatus: () => runtime.get('/api/talking-head/livetalking/worker'),
    startWorker: () => runtime.post('/api/talking-head/livetalking/worker/start', {}),
    stopWorker: () => runtime.post('/api/talking-head/livetalking/worker/stop', {}),
    offer: (sdp, type, avatarId, clientId) => runtime.post('/api/talking-head/offer', { sdp, type, avatarId, clientId }),
    sessionStatus: () => runtime.get('/api/talking-head/is-speaking'),
    mediaStatus: () => runtime.get('/api/talking-head/media/status'),
    closeSession: (sessionId) => runtime.delete(`/api/talking-head/session/${encodeURIComponent(sessionId)}`),
    listTasks: async () => requireWorkerOk(await runtime.get('/api/avatar/tasks')),
    createTask: async (input) => requireWorkerOk(await runtime.post('/api/avatar/task', input)),
    createBatch: async (items) => requireWorkerOk(await runtime.post('/api/avatar/batch', { items })),
    getTask: async (taskId) => requireWorkerOk(await runtime.get(`/api/avatar/task/${encodeURIComponent(taskId)}`)),
    deleteTask: async (taskId) => requireWorkerOk(await runtime.delete(`/api/avatar/task/${encodeURIComponent(taskId)}`)),
    listAvatars: () => runtime.get('/api/avatars/library'),
    registerAvatar: (avatar) => runtime.post('/api/avatars/library', { avatar }),
    deleteAvatar: (avatarId) => runtime.delete(`/api/avatars/library/${encodeURIComponent(avatarId)}`),
    getAvatarSession: () => runtime.get('/api/avatars/session'),
    activateAvatar: (avatarId) => runtime.post('/api/avatars/session/activate', { avatarId }),
    saveActiveAvatarSession: (activeAvatarId, selectedAvatarIds = [], excludedAvatarIds = []) => runtime.post('/api/avatars/session', {
      activeAvatarId: activeAvatarId || null,
      selectedAvatarIds,
      excludedAvatarIds,
    }),
    setVoice: (settings) => runtime.post('/api/settings/voice', settings),
    setVideoQuality: (quality) => runtime.post('/api/settings/live-video', { quality }),
    speak: (command) => runtime.post('/api/speech/commands', command),
    speechStatus: () => runtime.get('/api/speech/status'),
    synthesize: (input) => runtime.post('/api/speech/synthesize', input),
    interrupt: () => runtime.post('/api/speech/interrupt', {}),
  });
})(window);
