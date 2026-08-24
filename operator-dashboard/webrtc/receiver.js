'use strict';

(function installWebRtcReceiver(global) {
  global.createLiveTalkingWebRTCClient = function createLiveTalkingWebRTCClient(options) {
    const getApp = options.getApp;
    const getStudio = options.getStudio;
    return {
      pc: null,
      sessionId: null,
      videoEl: null,
      audioEl: null,
      endpoint: null,

      async ensureAudioPlayback() {
        const audio = this.audioEl;
        if (!audio) return false;
        audio.muted = false;
        audio.defaultMuted = false;
        audio.volume = 1;
        if (getApp().isMuted) return false;
        try {
          await audio.play();
          return true;
        } catch (error) {
          console.warn('[LiveTalking] WebRTC audio play blocked:', error.message);
          return false;
        }
      },

      async connect(endpoint, avatarId = 'avatar_main') {
        this.disconnect();
        this.endpoint = String(endpoint || 'http://localhost:8011').replace(/\/$/, '');
        if (global.location.protocol === 'file:') throw new Error('Open the dashboard through the runtime server');
        const health = await global.LiveTalkingApi.health();
        if (!health.health?.healthy) throw new Error(health.error || 'LiveTalking worker is not ready');

        const pc = new RTCPeerConnection({ sdpSemantics: 'unified-plan' });
        this.pc = pc;
        pc.addTransceiver('video', { direction: 'recvonly' });
        pc.addTransceiver('audio', { direction: 'recvonly' });

        const video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        video.muted = true;
        const audio = document.createElement('audio');
        audio.autoplay = true;
        audio.playsInline = true;
        audio.muted = false;
        audio.defaultMuted = false;
        audio.volume = 1;
        audio.setAttribute('aria-hidden', 'true');
        audio.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;';
        document.body.appendChild(audio);
        this.videoEl = video;
        this.audioEl = audio;

        pc.addEventListener('track', event => {
          const stream = event.streams?.[0] || new MediaStream([event.track]);
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
        const answer = await global.LiveTalkingApi.offer(pc.localDescription.sdp, 'offer', avatarId);
        if (!answer.sdp) throw new Error(answer.error || 'Worker returned no WebRTC SDP');
        this.sessionId = answer.sessionid || null;
        await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
        return { sessionId: this.sessionId, health: health.health };
      },

      disconnect() {
        if (this.pc) this.pc.close();
        this.pc = null;
        this.sessionId = null;
        if (this.videoEl) this.videoEl.srcObject = null;
        if (this.audioEl) {
          this.audioEl.pause();
          this.audioEl.srcObject = null;
          this.audioEl.remove();
        }
        this.videoEl = null;
        this.audioEl = null;
      },
    };
  };
})(window);
