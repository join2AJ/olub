'use strict';
/* In-app voice call over WebRTC. The server only relays signalling; phone numbers are never shared. */
const Call = {
  pc: null, tripId: null, pendingOffer: null, queuedIce: [], stream: null,
  ui(name, state, incoming) {
    $('#call').hidden = false; $('#call-icon').innerHTML = ic('phone');
    $('#call-name').textContent = name || ''; $('#call-state').textContent = state;
    $('#call-accept').hidden = !incoming;
    $('#call-end').onclick = () => this.hangup(true);
    $('#call-accept').onclick = run(() => this.answer());
  },
  signal(type, data) { return api('POST', `/api/trips/${this.tripId}/call`, { type, data }); },
  async setup() {
    // TODO(prod): add a TURN server so calls connect on every mobile network.
    this.pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    try { this.stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { this.hangup(true); throw new Error('Allow microphone access to make calls'); }
    this.stream.getTracks().forEach((tr) => this.pc.addTrack(tr, this.stream));
    this.pc.onicecandidate = (e) => { if (e.candidate) this.signal('ice', e.candidate); };
    this.pc.ontrack = (e) => { $('#call-audio').srcObject = e.streams[0]; this.live = true; $('#call-state').textContent = 'Connected'; };
    this.pc.onconnectionstatechange = () => {
      if (!this.pc) return;
      if (this.pc.connectionState === 'connected') { this.live = true; $('#call-state').textContent = 'Connected'; }
      if (['failed', 'closed'].includes(this.pc.connectionState)) { this.hangup(false); toast('Call ended', true); }
    };
  },
  async start(tripId, name) {
    if (this.pc) return;
    this.tripId = tripId;
    this.ui(name, 'Calling…', false);
    await this.setup();
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this.signal('offer', offer);
  },
  async answer() {
    $('#call-accept').hidden = true; $('#call-state').textContent = 'Connecting…';
    await this.setup();
    await this.pc.setRemoteDescription(this.pendingOffer);
    for (const c of this.queuedIce.splice(0)) await this.pc.addIceCandidate(c);
    const ans = await this.pc.createAnswer();
    await this.pc.setLocalDescription(ans);
    await this.signal('answer', ans);
    if (this.live) $('#call-state').textContent = 'Connected';
  },
  async onSignal(s) {
    if (s.type === 'offer') {
      if (this.pc) return api('POST', `/api/trips/${s.tripId}/call`, { type: 'decline' }); // busy
      this.tripId = s.tripId; this.pendingOffer = s.data; this.queuedIce = [];
      this.ui(s.fromName, 'Incoming Olub call', true);
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    } else if (s.type === 'answer' && this.pc) {
      await this.pc.setRemoteDescription(s.data);
    } else if (s.type === 'ice') {
      if (this.pc && this.pc.remoteDescription) await this.pc.addIceCandidate(s.data).catch(() => {});
      else this.queuedIce.push(s.data);
    } else if (s.type === 'hangup' || s.type === 'decline') {
      this.hangup(false);
      if (s.type === 'decline') toast('Call declined');
    }
  },
  hangup(notify) {
    if (notify && this.tripId) this.signal(this.pc ? 'hangup' : 'decline').catch(() => {});
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.pc) this.pc.close();
    Object.assign(this, { pc: null, pendingOffer: null, queuedIce: [], stream: null, live: false });
    $('#call').hidden = true;
  },
};
