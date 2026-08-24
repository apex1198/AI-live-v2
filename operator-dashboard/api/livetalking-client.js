'use strict';

(function installLiveTalkingClient(global) {
  const runtime = global.RuntimeApi;
  if (!runtime) throw new Error('RuntimeApi must load before LiveTalkingApi');

  function requireWorkerOk(payload) {
    if (typeof payload?.code === 'number' && payload.code !== 0) {
      throw new Error(payload.msg || 'LiveTalking worker request failed');
    }
    return payload;
  }

  global.LiveTalkingApi = Object.freeze({
    health: () => runtime.get('/api/talking-head/livetalking/status'),
    offer: (sdp, type, avatarId) => runtime.post('/api/talking-head/offer', { sdp, type, avatarId }),
    listTasks: async () => requireWorkerOk(await runtime.get('/api/avatar/tasks')),
    createTask: async (input) => requireWorkerOk(await runtime.post('/api/avatar/task', input)),
    getTask: async (taskId) => requireWorkerOk(await runtime.get(`/api/avatar/task/${encodeURIComponent(taskId)}`)),
    deleteTask: async (taskId) => requireWorkerOk(await runtime.delete(`/api/avatar/task/${encodeURIComponent(taskId)}`)),
    listAvatars: () => runtime.get('/api/avatars/library'),
    registerAvatar: (avatar) => runtime.post('/api/avatars/library', { avatar }),
    deleteAvatar: (avatarId) => runtime.delete(`/api/avatars/library/${encodeURIComponent(avatarId)}`),
    getAvatarSession: () => runtime.get('/api/avatars/session'),
    saveAvatarSession: (selected, random) => runtime.post('/api/avatars/session', { selected, random }),
    setVoice: (settings) => runtime.post('/api/settings/voice', settings),
    speak: (command) => runtime.post('/api/speech/commands', command),
    speechStatus: () => runtime.get('/api/speech/status'),
    synthesize: (input) => runtime.post('/api/speech/synthesize', input),
    interrupt: () => runtime.post('/api/speech/interrupt', {}),
  });
})(window);
