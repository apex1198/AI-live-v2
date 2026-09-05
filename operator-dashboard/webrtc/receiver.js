'use strict';

(function installWebRtcReceiver(global) {
  global.createLiveTalkingWebRTCClient = function createLiveTalkingWebRTCClient(options) {
    const getApp = options.getApp;
    const getStudio = options.getStudio;
    const getClientId = options.getClientId || (() => '');
    const onOutputStreamChanged = options.onOutputStreamChanged || (() => {});
    const onMediaStateChanged = options.onMediaStateChanged || (() => {});
    const client = {
      pc: null,
      sessionId: null,
      videoEl: null,
      audioEl: null,
      endpoint: null,
      connectionId: null,
      outputStream: new MediaStream(),
      operation: Promise.resolve(),
      connectionStartedAt: 0,
      heartbeatTimer: null,
      mediaStateInFlight: false,
      audioPlayable: false,

      isConnected() {
        if (!this.sessionId || !this.pc) return false;
        return this.pc.connectionState === 'connected'
          || ['connected', 'completed'].includes(this.pc.iceConnectionState);
      },

      isViable() {
        if (!this.sessionId || !this.pc) return false;
        return !['failed', 'closed'].includes(this.pc.connectionState)
          && !['failed', 'closed'].includes(this.pc.iceConnectionState);
      },

      isNegotiating(maxAgeMs = 20_000) {
        if (!this.pc || !this.connectionStartedAt) return false;
        if (Date.now() - this.connectionStartedAt > maxAgeMs) return false;
        return ['new', 'connecting'].includes(this.pc.connectionState)
          || ['new', 'checking'].includes(this.pc.iceConnectionState);
      },

      needsServerProbe() {
        if (!this.sessionId || !this.pc) return false;
        return this.pc.connectionState === 'disconnected'
          || this.pc.iceConnectionState === 'disconnected';
      },

      getOutputStream() {
        return this.outputStream;
      },

      async ensureAudioPlayback() {
        const audio = this.audioEl;
        if (!audio) {
          this.audioPlayable = false;
          void this.emitMediaState('audio-element-missing');
          return false;
        }
        if (getApp().isMuted) {
          this.audioPlayable = true;
          void this.emitMediaState('audio-muted-by-operator');
          return false;
        }
        try {
          // Prime playback while muted first. Browsers allow muted autoplay,
          // then the dedicated Web App profile can immediately enable sound.
          if (audio.paused) {
            audio.muted = true;
            await audio.play();
          }
          audio.muted = false;
          audio.defaultMuted = false;
          audio.volume = 1;
          await audio.play();
          this.audioPlayable = true;
          void this.emitMediaState('audio-playable');
          return true;
        } catch (error) {
          this.audioPlayable = false;
          void this.emitMediaState('audio-blocked');
          console.warn('[LiveTalking] WebRTC audio play blocked:', error.message);
          return false;
        }
      },

      async mediaState(reason = 'heartbeat') {
        const pc = this.pc;
        const audioTrack = this.outputStream.getAudioTracks().find(track => track.readyState === 'live');
        const videoTrack = this.outputStream.getVideoTracks().find(track => track.readyState === 'live');
        let audioPackets = 0;
        let videoFrames = 0;
        if (pc && !['closed', 'failed'].includes(pc.connectionState)) {
          try {
            const stats = await pc.getStats();
            stats.forEach(report => {
              if (report.type !== 'inbound-rtp') return;
              if ((report.kind || report.mediaType) === 'audio') audioPackets += Number(report.packetsReceived || 0);
              if ((report.kind || report.mediaType) === 'video') {
                videoFrames += Number(report.framesDecoded ?? report.framesReceived ?? 0);
              }
            });
          } catch { /* The connection may have closed while stats were collected. */ }
        }
        const rawState = pc?.connectionState || (this.sessionId ? 'connecting' : 'closed');
        const connectionState = ['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed'].includes(rawState)
          ? rawState.toUpperCase()
          : 'DISCONNECTED';
        return {
          type: 'LIVETALKING_MEDIA_STATE',
          clientId: getClientId(),
          connectionId: this.connectionId,
          sessionId: this.sessionId,
          connectionState,
          audioTrack: Boolean(audioTrack),
          videoTrack: Boolean(videoTrack),
          audioPlayable: Boolean(audioTrack && this.audioPlayable),
          audioPackets: Math.max(0, Math.round(audioPackets)),
          videoFrames: Math.max(0, Math.round(videoFrames)),
          reason,
        };
      },

      async emitMediaState(reason = 'heartbeat') {
        if (this.mediaStateInFlight || !getClientId()) return;
        this.mediaStateInFlight = true;
        try {
          onMediaStateChanged(await this.mediaState(reason));
        } finally {
          this.mediaStateInFlight = false;
        }
      },

      startHeartbeat() {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => void this.emitMediaState('heartbeat'), 2000);
        void this.emitMediaState('heartbeat-started');
      },

      hasLiveTracks() {
        return this.outputStream.getAudioTracks().some(track => track.readyState === 'live')
          && this.outputStream.getVideoTracks().some(track => track.readyState === 'live');
      },

      connect(endpoint, avatarId = 'avatar_main') {
        const operation = this.operation.then(async () => {
          try {
            return await this._connect(endpoint, avatarId);
          } catch (error) {
            await this._disconnect();
            throw error;
          }
        });
        this.operation = operation.catch(() => {});
        return operation;
      },

      async _connect(endpoint, avatarId) {
        await this._disconnect();
        this.connectionStartedAt = Date.now();
        this.endpoint = String(endpoint || 'http://localhost:2222').replace(/\/$/, '');
        this.connectionId = global.crypto?.randomUUID?.().replace(/-/g, '')
          || `rtc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
        if (global.location.protocol === 'file:') throw new Error('Open the dashboard through the runtime server');
        const health = await global.LiveTalkingApi.health();
        if (!health.health?.healthy) throw new Error(health.error || 'LiveTalking worker is not ready');

        const pc = new RTCPeerConnection({ sdpSemantics: 'unified-plan' });
        this.pc = pc;
        const connectionId = this.connectionId;
        pc.addTransceiver('video', { direction: 'recvonly' });
        pc.addTransceiver('audio', { direction: 'recvonly' });

        const video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        video.muted = true;
        const audio = document.createElement('audio');
        audio.autoplay = true;
        audio.playsInline = true;
        audio.muted = true;
        audio.defaultMuted = true;
        audio.volume = 1;
        audio.setAttribute('aria-hidden', 'true');
        audio.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;';
        document.body.appendChild(audio);
        this.videoEl = video;
        this.audioEl = audio;
        this.audioPlayable = false;

        const reportConnectionState = () => void this.emitMediaState(`peer-${pc.connectionState || pc.iceConnectionState}`);
        pc.addEventListener('connectionstatechange', reportConnectionState);
        pc.addEventListener('iceconnectionstatechange', reportConnectionState);

        pc.addEventListener('track', event => {
          if (this.pc !== pc || this.connectionId !== connectionId) return;
          const stream = event.streams?.[0] || new MediaStream([event.track]);
          for (const existingTrack of this.outputStream.getTracks()) {
            if (existingTrack.kind === event.track.kind) this.outputStream.removeTrack(existingTrack);
          }
          this.outputStream.addTrack(event.track);
          event.track.addEventListener('mute', () => void this.emitMediaState(`${event.track.kind}-muted`));
          event.track.addEventListener('unmute', () => void this.emitMediaState(`${event.track.kind}-unmuted`));
          event.track.addEventListener('ended', () => void this.emitMediaState(`${event.track.kind}-ended`));
          onOutputStreamChanged(this.outputStream);
          if (event.track.kind === 'video') {
            video.srcObject = stream;
            video.play().catch(() => {});
            getStudio().videoEl = video;
            getApp().avatar.videoEl = video;
          } else {
            event.track.enabled = true;
            audio.srcObject = new MediaStream([event.track]);
            this.ensureAudioPlayback();
          }
        });

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        if (pc.iceGatheringState !== 'complete') {
          await new Promise(resolve => {
            const done = () => {
              if (pc.iceGatheringState === 'complete') {
                pc.removeEventListener('icegatheringstatechange', done);
                resolve();
              }
            };
            pc.addEventListener('icegatheringstatechange', done);
            setTimeout(resolve, 3000);
          });
        }
        const answer = await global.LiveTalkingApi.offer(
          pc.localDescription.sdp,
          'offer',
          avatarId,
          getClientId(),
          connectionId,
        );
        if (!answer.sdp) throw new Error(answer.error || 'Worker returned no WebRTC SDP');
        this.sessionId = answer.sessionid || null;
        let remoteDescriptionTimer;
        try {
          await Promise.race([
            pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp }),
            new Promise((_, reject) => {
              remoteDescriptionTimer = setTimeout(
                () => reject(new Error('LiveTalking WebRTC answer timed out')),
                10_000,
              );
            }),
          ]);
        } finally {
          clearTimeout(remoteDescriptionTimer);
        }
        const mediaDeadline = Date.now() + 12_000;
        while (Date.now() < mediaDeadline && !this.hasLiveTracks()) {
          if (['failed', 'closed'].includes(pc.connectionState)) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!this.hasLiveTracks()) throw new Error('LiveTalking connected without both audio and video tracks');
        await this.ensureAudioPlayback();
        this.startHeartbeat();
        await this.emitMediaState('media-connected');
        return { sessionId: this.sessionId, health: health.health };
      },

      disconnect() {
        const operation = this.operation.then(() => this._disconnect());
        this.operation = operation.catch(() => {});
        return operation;
      },

      async _disconnect() {
        const sessionId = this.sessionId;
        this.sessionId = null;
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
        if (this.pc) this.pc.close();
        this.pc = null;
        if (this.videoEl) this.videoEl.srcObject = null;
        if (this.audioEl) {
          this.audioEl.pause();
          this.audioEl.srcObject = null;
          this.audioEl.remove();
        }
        this.videoEl = null;
        this.audioEl = null;
        this.audioPlayable = false;
        this.outputStream = new MediaStream();
        onOutputStreamChanged(null);
        this.connectionStartedAt = 0;
        await this.emitMediaState('disconnected');
        this.connectionId = null;
        if (sessionId) {
          try {
            await global.LiveTalkingApi.closeSession(sessionId);
          } catch (error) {
            console.warn('[LiveTalking] Could not release worker session:', error.message);
          }
        }
      },
    };
    global.addEventListener('pagehide', () => client.disconnect());
    return client;
  };
})(window);
