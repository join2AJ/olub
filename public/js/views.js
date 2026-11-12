'use strict';
/* Shared screens: sign-in, profile, safety, trip pieces, ratings, invoices, insights. */

// ---------------- session ----------------
function logout() {
  S.token = null; S.me = null; S.trip = null; S.quote = null; S.estimate = null;
  if (S.es) S.es.close();
  stopTracking(); store('olub.token', null); closeSheets(); render();
}

function connect() {
  if (S.es) S.es.close();
  S.es = new EventSource(`${S.base}/api/events?token=${encodeURIComponent(S.token)}`);
  S.es.addEventListener('trip', run(async () => { await refreshTrip(); render(); }));
  S.es.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (S.trip && m.tripId === S.trip.id) { S.messages.push(m); renderChat(); toast(`💬 ${m.body}`); }
  });
  S.es.addEventListener('call', (e) => Call.onSignal(JSON.parse(e.data)));
  S.es.addEventListener('loc', (e) => {
    const p = JSON.parse(e.data);
    if (S.trip && p.tripId === S.trip.id) { S.trip.last = { ...p, digipin: Digipin.encode(p.lat, p.lng) }; if (S.map) S.map.setCar(p); const el = $('#livepin'); if (el) el.textContent = S.trip.last.digipin || ''; }
  });
  S.es.addEventListener('safety', (e) => onSafety(JSON.parse(e.data)));
  S.es.addEventListener('duty', run(async (e) => {
    const d = JSON.parse(e.data);
    toast({ duty_limit: 'You have reached 12 hours. Time to rest for 10 hours.', wallet_low: 'Wallet below ₹100 — top up to get customers.', suspended: 'Your account has been put on hold.' }[d.reason] || 'You are offline', true);
    S.me = await api('GET', '/api/me'); render();
  }));
}

async function refreshTrip() {
  const prevId = S.trip && S.trip.id;
  const cur = await api('GET', '/api/trips/current');
  S.trip = cur.trip; S.requests = cur.requests;
  if (prevId && !S.trip) {
    const old = await api('GET', `/api/trips/${prevId}`).catch(() => null);
    if (old && old.status === 'rejected') toast('Driver declined the ride', true);
    if (old && old.status === 'cancelled') toast('Trip was cancelled', true);
    if (old && old.status === 'completed' && old.paidAt) S.trip = old; // keep the receipt until dismissed
  }
  if (S.trip && S.trip.id !== prevId) S.messages = await api('GET', `/api/trips/${S.trip.id}/messages`);
  if (S.me && S.me.role === 'driver') S.me = await api('GET', '/api/me');
  syncTracking();
}

// ---------------- live GPS during a ride ----------------
function syncTracking() {
  const live = S.trip && ['accepted', 'started'].includes(S.trip.status);
  if (!live) return stopTracking();
  if (Native && Native.startTracking && S.me.role === 'driver') Native.startTracking(S.base, S.token, String(S.trip.id)); // keeps working with the screen off
  if (S.watchId != null || !navigator.geolocation) return;
  S.watchId = navigator.geolocation.watchPosition((p) => {
    if (!S.trip || Date.now() - S.lastPing < 6000) return;
    S.lastPing = Date.now();
    api('POST', `/api/trips/${S.trip.id}/location`, { lat: p.coords.latitude, lng: p.coords.longitude, kmph: p.coords.speed != null ? p.coords.speed * 3.6 : null }).catch(() => {});
  }, () => {}, { enableHighAccuracy: true, maximumAge: 4000 });
}
function stopTracking() {
  if (S.watchId != null) { navigator.geolocation.clearWatch(S.watchId); S.watchId = null; }
  if (Native && Native.stopTracking) Native.stopTracking();
}

// ---------------- safety alarm (late ride, off route, SOS) ----------------
function onSafety(ev) {
  if (!S.trip || ev.tripId !== S.trip.id) return;
  const rider = S.trip.you === 'rider';
  let title, body;
  if (ev.sos) { title = 'SOS sent'; body = rider ? 'Your trusted contact has been alerted with your live location.' : 'SOS was pressed in this ride. Stop safely and help your customer.'; }
  else if (ev.offRoute) { title = 'Off the expected route'; body = rider ? 'This cab has moved away from the route. Your trusted contact has been told. Are you OK?' : 'You are away from the expected route. The customer and their contact can see this.'; }
  else if (ev.level === 2) { title = `${ev.lateMin} min late`; body = rider ? 'Your trusted contact has been asked to check on you. Tap below if you are safe.' : 'This ride is running very late. The customer\'s contact has been alerted.'; }
  else { title = 'Running late'; body = rider ? `Your ride is about ${ev.lateMin} min late. Your trusted contact has been informed.` : 'The ride is running late.'; }
  const a = $('#alarm');
  a.innerHTML = `${ic('alert')}<h1>${esc(title)}</h1><p>${esc(body)}</p>
    ${rider && !ev.sos ? '<button class="btn" id="al-safe">I\'m safe</button>' : ''}
    <a class="btn" href="tel:112">Call 112</a><button class="btn ghost" id="al-close" style="color:#fff;box-shadow:inset 0 0 0 1.5px #fff8">Close</button>`;
  a.hidden = false;
  if (navigator.vibrate) navigator.vibrate([400, 150, 400, 150, 400]);
  $('#al-close').onclick = () => { a.hidden = true; };
  if ($('#al-safe')) $('#al-safe').onclick = run(async () => { S.trip = await api('POST', `/api/trips/${S.trip.id}/safe`); a.hidden = true; toast('Thanks — your contact has been told you are safe'); render(); });
}

// ---------------- shell ----------------
const TABS = {
  rider: [['home', 'Ride', 'car'], ['activity', 'Activity', 'list'], ['feedback', 'Ratings', 'star'], ['profile', 'Profile', 'user']],
  driver: [['home', 'Drive', 'car'], ['money', 'Earnings', 'wallet'], ['feedback', 'Ratings', 'star'], ['profile', 'Profile', 'user']],
  admin: [['home', 'Admin', 'shield'], ['profile', 'Profile', 'user']],
};

function render() {
  const app = $('#app');
  if (S.map) { try { S.map.map.stop(); S.map.map.remove(); } catch { /* already gone */ } S.map = null; }
  const needServer = IN_APP && !S.base;
  $('#top').hidden = !S.me; $('#nav').hidden = !S.me;
  if (needServer) return renderServer(app);
  if (!S.me) return renderAuth(app);
  const chip = $('#idchip'); chip.hidden = false; chip.textContent = S.me.publicId; chip.onclick = () => { S.tab = 'profile'; render(); };
  const tabs = TABS[S.me.role];
  if (!tabs.some((t) => t[0] === S.tab)) S.tab = 'home';
  $('#nav').innerHTML = tabs.map(([k, l, i]) => `<button data-tab="${k}" class="${S.tab === k ? 'on' : ''}"><span class="pill">${ic(i)}</span>${l}
    ${k === 'home' && (S.requests.length || (S.trip && S.tab !== 'home')) ? '<span class="dot"></span>' : ''}</button>`).join('');
  $$('#nav button').forEach((b) => { b.onclick = () => { S.tab = b.dataset.tab; window.scrollTo(0, 0); render(); }; });
  if (S.tab === 'profile') return renderProfile(app);
  if (S.tab === 'feedback') return renderFeedback(app);
  if (S.tab === 'activity' || S.tab === 'money') return renderInsights(app);
  if (S.me.role === 'rider') return renderRider(app);
  if (S.me.role === 'driver') return renderDriver(app);
  return renderAdmin(app);
}

function renderServer(app) {
  app.innerHTML = `<div class="card"><h1>Connect to Olub</h1><p class="muted">Enter the address of your Olub server. You only do this once.</p>
    <label class="f">Server address</label><input id="srv" placeholder="https://olub.example.com" inputmode="url" autocapitalize="off">
    <button id="srv-go" class="btn block">Connect</button></div>`;
  $('#srv-go').onclick = run(async () => {
    let u = $('#srv').value.trim().replace(/\/$/, '');
    if (!/^https?:\/\//.test(u)) u = `https://${u}`;
    const r = await fetch(`${u}/healthz`).then((x) => x.json()).catch(() => null);
    if (!r || !r.ok) throw new Error('Could not reach an Olub server at that address');
    store('olub.server', u); location.reload();
  });
}

// ---------------- sign in ----------------
function renderAuth(app) {
  app.innerHTML = `
    <div class="card hero"><h1>Book the cab<br>in front of you</h1>
      <p class="muted">Scan its QR, see a fair fare, and go. Olub keeps only <b>${rs(S.cfg.platformFee)}</b> a trip — the rest is the driver's.</p></div>
    <div class="card">
      <label class="f">Mobile number</label>
      <input id="phone" inputmode="numeric" maxlength="14" placeholder="98765 43210" autocomplete="tel">
      <div id="otp-step" hidden>
        <label class="f">Enter the 6-digit code we sent</label>
        <input id="code" inputmode="numeric" maxlength="6" class="otp-in" autocomplete="one-time-code">
        <p id="devcode" class="muted small"></p>
        <div id="new-user" hidden>
          <label class="f">Your name</label><input id="name" placeholder="Full name" autocomplete="name">
          <label class="f">I want to</label>
          <div class="rolecards" id="rolepick">
            <button data-r="rider" class="on">${ic('user')}Book rides</button><button data-r="driver">${ic('car')}Drive my cab</button>
          </div>
          <label class="check"><input type="checkbox" id="terms"><span>I agree to Olub's <a href="#" id="see-terms">terms and privacy notice</a>. I understand Olub only connects customers and drivers.</span></label>
        </div>
      </div>
      <button id="go" class="btn block">Get code</button>
    </div>
    <p class="center muted small">${ic('lock')} Your number is never shown to drivers or customers.</p>`;
  let step = 'phone', roleSel = 'rider';
  $$('#rolepick button').forEach((b) => { b.onclick = () => { roleSel = b.dataset.r; $$('#rolepick button').forEach((x) => x.classList.toggle('on', x === b)); }; });
  $('#see-terms').onclick = (e) => { e.preventDefault(); legalSheet(S.legal.required[roleSel]); };
  $('#go').onclick = run(async () => {
    const phone = $('#phone').value;
    if (step === 'phone') {
      const r = await api('POST', '/api/auth/request-otp', { phone });
      $('#otp-step').hidden = false; $('#new-user').hidden = !r.isNewUser;
      if (r.devCode) $('#devcode').textContent = `Test mode code: ${r.devCode}`;
      $('#go').firstChild.textContent = 'Continue'; step = 'otp'; $('#code').focus();
    } else {
      const r = await api('POST', '/api/auth/verify-otp', { phone, code: $('#code').value, name: $('#name').value, role: roleSel, acceptTerms: $('#terms').checked });
      S.token = r.token; store('olub.token', r.token);
      S.me = r.user; S.tab = 'home'; connect(); await refreshTrip(); render();
    }
  });
}

function legalSheet(keys) {
  const docs = keys || Object.keys(S.legal.docs);
  sheet('Terms & privacy', `<div class="legal">${['about', ...docs.filter((k) => k !== 'about')].map((k) => `<h3>${esc(S.legal.docs[k].title)}</h3>${S.legal.docs[k].body.map((p) => `<p>${esc(p)}</p>`).join('')}`).join('')}
    <p class="muted small">Version ${esc(S.legal.version)}</p></div>`);
}

// ---------------- profile to-dos ----------------
const TODO = {
  terms: ['file', 'Accept the latest terms'], email: ['mail', 'Confirm your email'], personal: ['id', 'Add date of birth and sex'],
  trusted: ['heart', 'Add a trusted contact'], vehicle: ['car', 'Add vehicle and documents'],
};
function todoCard() {
  const t = S.me.todo;
  if (!t.length) return '';
  return `<div class="card"><h2>Finish setting up</h2><p class="muted">${S.me.role === 'driver' ? 'Needed before you can go online.' : 'Needed before your first ride.'}</p>
    ${t.map((k) => `<button class="todo" data-todo="${k}"><span class="n">${ic(TODO[k][0])}</span><span class="grow" style="flex:1">${TODO[k][1]}</span>${ic('right')}</button>`).join('')}</div>`;
}
function bindTodos(root = document) { $$('[data-todo]', root).forEach((b) => { b.onclick = () => openTodo(b.dataset.todo); }); }
function openTodo(k) {
  if (k === 'email') return emailSheet();
  if (k === 'personal') return personalSheet();
  if (k === 'trusted') return trustedSheet();
  if (k === 'terms') return termsSheet();
  if (k === 'vehicle') { S.tab = 'profile'; S.sub = 'vehicle'; closeSheets(); render(); }
}
const saved = async (me, sh, msg) => { S.me = me; sh.close(); toast(msg); render(); };

function emailSheet() {
  const sh = sheet('Confirm your email', `<p class="muted">We send invoices and privacy replies here. It is never shown to anyone.</p>
    <label class="f">Email</label><input id="em" type="email" value="${esc(S.me.email || '')}" placeholder="you@example.com" autocapitalize="off">
    <div id="em2" hidden><label class="f">6-digit code from the email</label><input id="emc" inputmode="numeric" maxlength="6" class="otp-in"><p id="emdev" class="muted small"></p></div>
    <button id="emgo" class="btn block">Send code</button>`);
  let sent = false;
  $('#emgo', sh.el).onclick = run(async () => {
    if (!sent) {
      const r = await api('POST', '/api/me/email', { email: $('#em').value });
      sent = true; $('#em2').hidden = false; $('#emgo').firstChild.textContent = 'Confirm';
      if (r.devCode) $('#emdev').textContent = `Test mode code: ${r.devCode}`;
    } else await saved(await api('POST', '/api/me/email/verify', { code: $('#emc').value }), sh, 'Email confirmed');
  });
}
function personalSheet() {
  const sh = sheet('About you', `<label class="f">Name</label><input id="pn" value="${esc(S.me.name || '')}">
    <label class="f">Date of birth</label><input id="pd" type="date" value="${esc(S.me.dob || '')}" max="${new Date().toISOString().slice(0, 10)}">
    <label class="f">Sex</label><div class="seg" id="pg">${['male', 'female', 'other'].map((g) => `<button data-g="${g}" class="${S.me.gender === g ? 'on' : ''}">${g[0].toUpperCase() + g.slice(1)}</button>`).join('')}</div>
    <p class="muted small" style="margin-top:10px">You must be ${S.cfg.minAge} or older. ${S.me.role === 'driver' ? 'Customers see your age and sex on your driver card.' : ''}</p>
    <button id="pgo" class="btn block">Save</button>`);
  let g = S.me.gender;
  $$('#pg button', sh.el).forEach((b) => { b.onclick = () => { g = b.dataset.g; $$('#pg button').forEach((x) => x.classList.toggle('on', x === b)); }; });
  $('#pgo', sh.el).onclick = run(async () => saved(await api('PATCH', '/api/me', { name: $('#pn').value, dob: $('#pd').value, gender: g }), sh, 'Saved'));
}
function trustedSheet() {
  const t = S.me.trusted || {};
  const sh = sheet('Trusted contact', `<p class="muted">This person gets your live ride location, and an alert if your ride runs ${S.cfg.overdue.warn}–${S.cfg.overdue.alert} minutes late or you press SOS.</p>
    <label class="f">Their name</label><input id="tn" value="${esc(t.name || '')}">
    <label class="f">Their mobile number</label><input id="tp" inputmode="numeric" maxlength="14" value="${esc(t.phone || '')}">
    <label class="f">Relation</label><input id="tr" value="${esc(t.relation || '')}" placeholder="Mother, friend…">
    <button id="tgo" class="btn block">Save</button>`);
  $('#tgo', sh.el).onclick = run(async () => saved(await api('PATCH', '/api/me', { trusted: { name: $('#tn').value, phone: $('#tp').value, relation: $('#tr').value } }), sh, 'Trusted contact saved'));
}
function termsSheet() {
  const keys = S.me.pendingConsents;
  const sh = sheet('Please accept', `<div class="legal">${keys.map((k) => `<h3>${esc(S.legal.docs[k].title)}</h3>${S.legal.docs[k].body.map((p) => `<p>${esc(p)}</p>`).join('')}`).join('')}</div>
    <button id="cgo" class="btn block">I agree</button>`);
  $('#cgo', sh.el).onclick = run(async () => saved(await api('POST', '/api/me/consents', { accept: true }), sh, 'Thank you'));
}

// ---------------- place picker (search, GPS, DIGIPIN, map pin) ----------------
const pinTag = (p) => (p && p.digipin ? `<span class="digipin">${esc(p.digipin)}</span>` : '');
async function myLocation() {
  const p = await here();
  return { ...p, name: 'My location', digipin: Digipin.encode(p.lat, p.lng) };
}
function placePicker(label, onPick) {
  const sh = sheet(label, `<div class="row"><div class="grow"><input id="pq" placeholder="Search a place, or type a DIGIPIN" autocapitalize="off"></div></div>
    <div class="menu" style="margin-top:6px"><button id="p-gps">${ic('target')}<span class="grow">Use my current location</span>${ic('right')}</button>
    <button id="p-map">${ic('pin')}<span class="grow">Choose on the map</span>${ic('right')}</button></div>
    <h3>Places</h3><div id="plist" class="menu"></div><div id="pmap" class="map" hidden style="margin-top:10px"></div><button id="p-ok" class="btn block" hidden>Use this spot</button>`);
  const pick = (p) => { sh.close(); onPick(p); };
  const list = (items) => {
    $('#plist', sh.el).innerHTML = items.map((p, i) => `<button data-i="${i}">${ic('pin')}<span class="grow">${esc(p.name)}</span>${ic('right')}</button>`).join('') || '<p class="muted">No matches. Try the map.</p>';
    $$('#plist button', sh.el).forEach((b) => { b.onclick = () => { const p = items[b.dataset.i]; pick(p.placeId ? { placeId: p.placeId, name: p.name, lat: p.lat, lng: p.lng, digipin: Digipin.encode(p.lat, p.lng) } : { ...p, digipin: Digipin.encode(p.lat, p.lng) }); }; });
  };
  list(S.places.map((p) => ({ placeId: p.id, name: p.name, lat: p.lat, lng: p.lng })));
  let timer;
  $('#pq', sh.el).oninput = (e) => {
    clearTimeout(timer);
    const q = e.target.value.trim();
    if (Digipin.looksLike(q)) { const c = Digipin.decode(q); return list([{ name: `DIGIPIN ${Digipin.encode(c.lat, c.lng)}`, lat: c.lat, lng: c.lng }]); }
    timer = setTimeout(async () => { try { list(await api('GET', `/api/places/search?q=${encodeURIComponent(q)}`)); } catch { /* keep the old list */ } }, 250);
  };
  $('#p-gps', sh.el).onclick = run(async () => pick(await myLocation()));
  $('#p-map', sh.el).onclick = () => {
    const el = $('#pmap', sh.el); el.hidden = false; let chosen = null; let mk = null;
    const m = makeMap(el, { onPick: (p) => {
      chosen = p; if (mk) mk.remove();
      mk = L.marker([p.lat, p.lng], { icon: L.divIcon({ className: '', html: '<div class="mk d"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }) }).addTo(m.map);
      const b = $('#p-ok', sh.el); b.hidden = false; b.firstChild.textContent = `Use this spot · ${Digipin.encode(p.lat, p.lng) || ''}`;
    } });
    const first = S.booking.src || S.places[0];
    if (m && first) m.map.setView([first.lat, first.lng], 13);
    $('#p-ok', sh.el).onclick = () => pick({ ...chosen, name: 'Pinned location', digipin: Digipin.encode(chosen.lat, chosen.lng) });
    el.scrollIntoView({ behavior: 'smooth' });
  };
}
const pointBody = (p) => (p.placeId ? { placeId: p.placeId } : { lat: p.lat, lng: p.lng, name: p.name });

// ---------------- QR: show (driver) and scan (rider) ----------------
function qrSvg(text) {
  const q = qrcode(0, 'M'); q.addData(text); q.make();
  return q.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
}
function scanSheet(onCode) {
  let stream = null, timer = null, done = false;
  const stop = () => { done = true; clearInterval(timer); if (stream) stream.getTracks().forEach((t) => t.stop()); };
  const sh = sheet('Scan the driver\'s QR', `<div class="scan"><video id="scv" playsinline muted></video><i></i></div>
    <p class="muted center" style="margin-top:10px" id="scmsg">Point at the Olub QR on the cab or the driver's phone.</p>`, { onClose: stop });
  (async () => {
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); } catch { $('#scmsg', sh.el).textContent = 'Camera not available. Close this and type the vehicle number instead.'; return; }
    const v = $('#scv', sh.el); v.srcObject = stream; await v.play().catch(() => {});
    const c = document.createElement('canvas'); const ctx = c.getContext('2d', { willReadFrequently: true });
    const det = 'BarcodeDetector' in window ? new BarcodeDetector({ formats: ['qr_code'] }) : null;
    timer = setInterval(async () => {
      if (done || !v.videoWidth) return;
      let text = null;
      try {
        if (det) { const r = await det.detect(v); text = r[0] && r[0].rawValue; }
        if (!text) { c.width = 480; c.height = Math.round(480 * v.videoHeight / v.videoWidth); ctx.drawImage(v, 0, 0, c.width, c.height); const r = jsQR(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height); text = r && r.data; }
      } catch { /* keep scanning */ }
      if (text && !done) { if (navigator.vibrate) navigator.vibrate(60); sh.close(); onCode(text); }
    }, 220);
  })();
}

// ---------------- driver card, fare, trip pieces ----------------
function driverCard(d) {
  const img = d.photos && d.photos.selfie ? `<img class="avatar" src="${d.photos.selfie}" alt="">` : `<div class="avatar">${esc((d.name || 'D')[0])}</div>`;
  const badge = d.status === 'verified' ? `<span class="chip">${ic('shield')}Verified</span>` : `<span class="chip warn">${ic('clock')}New — not yet verified</span>`;
  const person = [d.age && `${d.age} yrs`, d.gender && d.gender[0].toUpperCase() + d.gender.slice(1), d.drivingYears != null && `driving ${d.drivingYears} yrs`].filter(Boolean).join(' · ');
  return `<div class="driver">${img}<div class="grow" style="min-width:0">
      <div class="between"><b>${esc(d.name || 'Driver')}</b>${starsHtml(d.rating)}</div>
      <div style="margin:3px 0"><span class="plate">${esc(d.vehicleNumber)}</span> <span class="muted">${esc(d.vehicleLabel)} ${esc(d.vehicleModel || '')}</span></div>
      <div class="muted small">${esc(person)}</div></div></div>
    <div class="chips" style="margin-top:10px">${badge}<span class="chip grey">${ic('id')}${esc(d.publicId)}</span><span class="chip grey">${esc(d.experience)} · ${d.completedTrips} trips</span>
      ${d.rules.map((r) => `<span class="chip warn">${ic('ban')}${esc(S.cfg.driverRules[r])}</span>`).join('')}
      ${d.petsOk ? `<span class="chip">${ic('paw')}Pets OK${d.petCharge ? ` +${rs(d.petCharge)}` : ''}</span>` : `<span class="chip grey">${ic('paw')}No pets</span>`}</div>`;
}

function fareTable(f, { final = false, forDriver = false } = {}) {
  const b = f.breakdown;
  return `<table class="fare">
    <tr><td>Ride · ${f.distanceKm} km</td><td>${rs(b.rideFare)}</td></tr>
    <tr class="sub"><td colspan="2">${rs(b.base)} base + ${rs(b.perKm)}/km · vehicle ×${b.conditionMultiplier} · ${esc(b.experienceLabel)} ×${b.experienceMultiplier}${b.minFareApplied ? ' · minimum fare' : ''}</td></tr>
    ${b.waitCharge || !final ? `<tr><td>Traffic / waiting · ${b.waitMinutes} min${final ? '' : ' (live estimate)'}</td><td>${rs(b.waitCharge)}</td></tr>` : ''}
    ${b.petCharge ? `<tr><td>Pet charge</td><td>${rs(b.petCharge)}</td></tr>` : ''}
    ${b.tolls.map((t) => `<tr><td>Toll · ${esc(t.name)}${t.status === 'verified' ? '' : ' <span class="muted small">(state default)</span>'}</td><td>${rs(t.amount)}</td></tr>`).join('')}
    <tr class="to-driver"><td>${forDriver ? 'You keep' : 'Driver keeps'}</td><td>${rs(f.driverFare)}</td></tr>
    ${f.taxes.rideGst ? `<tr><td>GST ${f.taxes.rideGstRate * 100}% on ride</td><td>${rs(f.taxes.rideGst)}</td></tr>` : ''}
    <tr><td>Olub fee <span class="muted small">incl. GST</span>${f.calamity ? ' <span class="chip warn">relief rate</span>' : ''}</td><td>${rs(f.platformFee)}</td></tr>
    ${f.discount ? `<tr><td>Driver verification reward</td><td>−${rs(f.discount)}</td></tr>` : ''}
    <tr class="total"><td>${forDriver ? 'Customer pays' : (final ? 'Total' : 'You pay')}</td><td>${rs(f.riderPays)}</td></tr>
    ${forDriver ? `<tr class="sub"><td colspan="2">${rs(f.walletDeduction)} (fee + GST) is taken from your wallet when the trip ends.</td></tr>` : ''}
  </table>`;
}

const STEP_ICONS = [['requested', 'clock'], ['accepted', 'check'], ['started', 'nav'], ['completed', 'pin']];
function steps(status) {
  const i = STEP_ICONS.findIndex((s) => s[0] === status);
  return `<div class="steps">${STEP_ICONS.map(([, icon], k) => `${k ? `<div class="bar ${k <= i ? 'on' : ''}"><i></i></div>` : ''}<div class="s ${k <= i ? 'on' : ''} ${k === i && status !== 'completed' ? 'now' : ''}">${ic(icon)}</div>`).join('')}</div>`;
}

function tripMapHtml(t) {
  return `<div id="tmap" class="map"></div>
    <div class="card flat" style="margin-top:-4px"><div class="route" style="pointer-events:none">
      <button><span class="dotp"></span><span class="t">${esc(t.src.name)}</span>${pinTag(t.src)}</button>
      <button><span class="dotd"></span><span class="t">${esc(t.dst.name)}</span>${pinTag(t.dst)}</button></div>
      ${['accepted', 'started'].includes(t.status) ? `<p class="muted small" style="margin:8px 0 0">${ic('target')} Cab is at <span class="digipin" id="livepin">${esc((t.last && t.last.digipin) || 'waiting for GPS…')}</span></p>` : ''}</div>`;
}
function mountTripMap(t) { const el = $('#tmap'); if (el) S.map = makeMap(el, { src: t.src, dst: t.dst, last: t.last }); }

function commsBlock(t) {
  if (!['accepted', 'started'].includes(t.status) && !(t.status === 'completed' && !t.paidAt)) return '';
  const other = t.you === 'rider' ? 'driver' : 'customer';
  return `<div class="card"><div class="between"><h2 style="margin:0">Talk to your ${other}</h2><button id="callbtn" class="btn small">${ic('phone')}Call</button></div>
    <p class="muted small" style="margin:6px 0 0">${ic('lock')} Calls and chat stay inside Olub. Numbers are never shared.</p>
    <div class="chat" id="chat"></div>
    <div class="row"><div class="grow"><input id="msg" placeholder="Message…" maxlength="500"></div><button id="send" class="btn small">${ic('nav')}</button></div></div>`;
}
function bindComms(t) {
  if (!$('#chat')) return;
  renderChat();
  const send = run(async () => {
    const body = $('#msg').value.trim(); if (!body) return;
    S.messages.push(await api('POST', `/api/trips/${t.id}/messages`, { body }));
    $('#msg').value = ''; renderChat();
  });
  $('#send').onclick = send;
  $('#msg').onkeydown = (e) => { if (e.key === 'Enter') send(e); };
  $('#callbtn').onclick = run(() => Call.start(t.id, t.you === 'rider' ? t.driver.name : t.rider.name));
}
function renderChat() {
  const c = $('#chat'); if (!c) return;
  c.innerHTML = S.messages.map((m) => `<div class="msg${m.mine ? ' mine' : ''}">${esc(m.body)}</div>`).join('') || '<div class="muted small">No messages yet.</div>';
  c.scrollTop = c.scrollHeight;
}

function safetyRow(t) {
  if (!['accepted', 'started'].includes(t.status)) return '';
  return `<div class="card"><div class="between"><div><h2 style="margin:0">Safety</h2>
      <p class="muted small" style="margin:2px 0 0">${t.you === 'rider' && t.trusted ? `Live location is shared with ${esc(t.trusted.name)}.` : 'This ride is tracked live.'}${t.offRoute ? ' <b style="color:var(--danger)">Off route.</b>' : ''}</p></div>
      <button class="sos" id="sos">${ic('alert')}SOS</button></div>
    ${t.you === 'rider' ? `<button id="share" class="btn ghost block">${ic('share')}Share my live ride</button>` : ''}</div>`;
}
function bindSafety(t) {
  if ($('#sos')) $('#sos').onclick = () => {
    const sh = sheet('Send SOS?', `<p>This alerts ${t.you === 'rider' && t.trusted ? esc(t.trusted.name) : 'the customer\'s trusted contact'} with the cab number and live location, and records it with Olub.</p>
      <button id="sos-go" class="btn danger block">Yes, send SOS</button><a class="btn ghost block" href="tel:112">Call 112</a>`);
    $('#sos-go', sh.el).onclick = run(async () => {
      const p = await here().catch(() => ({}));
      await api('POST', `/api/trips/${t.id}/sos`, p); sh.close();
    });
  };
  if ($('#share')) $('#share').onclick = run(() => shareText(`Track my Olub ride live (${t.driver.vehicleNumber}): ${S.base || location.origin}${t.trackPath}`));
}

// ---------------- rating ----------------
function ratingSheet(t) {
  const role = t.you === 'rider' ? 'driver' : 'rider';
  const crit = S.cfg.ratingCriteria[role];
  const scores = {};
  const sh = sheet(`Rate your ${role === 'driver' ? 'driver' : 'customer'}`, `
    ${Object.entries(crit).map(([k, l]) => `<div class="rate-row"><span>${esc(l)}</span><div class="rate-stars" data-k="${k}">${[1, 2, 3, 4, 5].map((n) => `<button data-n="${n}">${ic('star', 'fill')}</button>`).join('')}</div></div>`).join('')}
    <label class="f">What was good?</label><textarea id="r-good" maxlength="300" placeholder="Optional"></textarea>
    <label class="f">What was not good?</label><textarea id="r-bad" maxlength="300" placeholder="Optional"></textarea>
    <label class="f">What could be better?</label><textarea id="r-imp" maxlength="300" placeholder="Optional"></textarea>
    <p class="muted small">${ic('lock')} They see ratings and comments monthly, without your name.</p>
    <button id="r-go" class="btn block">Submit rating</button>`);
  $$('.rate-stars', sh.el).forEach((row) => {
    $$('button', row).forEach((b) => { b.onclick = () => { scores[row.dataset.k] = Number(b.dataset.n); $$('button', row).forEach((x) => x.classList.toggle('on', Number(x.dataset.n) <= scores[row.dataset.k])); }; });
  });
  $('#r-go', sh.el).onclick = run(async () => {
    await api('POST', `/api/trips/${t.id}/rating`, { scores, good: $('#r-good').value, bad: $('#r-bad').value, improve: $('#r-imp').value });
    if (S.trip && S.trip.id === t.id) S.trip.rated = true;
    sh.close(); toast('Thanks for rating'); render();
  });
}

// ---------------- invoice ----------------
async function invoiceSheet(tripId) {
  const v = await api('GET', `/api/trips/${tripId}/invoice`);
  const row = (l) => `<tr><td>${esc(l.label)}${l.sac ? ` <span class="muted small">SAC ${esc(l.sac)}</span>` : ''}</td><td>${l.amount < 0 ? '−' : ''}${rs(Math.abs(l.amount))}</td></tr>`;
  const textOut = [`${v.title} ${v.invoiceNo}`, `${v.issuedBy.name} · GSTIN ${v.issuedBy.gstin}`, when(v.date), `${v.trip.from.name} → ${v.trip.to.name}`,
    ...v.lines.map((l) => `${l.label}: ${rs(l.amount)}`), ...v.taxes.map((l) => `${l.label}: ${rs(l.amount)}`), ...v.other.map((l) => `${l.label}: ${rs(l.amount)}`), `Total: ${rs(v.total)}`].join('\n');
  const sh = sheet('Invoice', `<div class="inv">
    <div class="between"><div><h2 style="margin:0">${esc(v.title)}</h2><div class="muted small">${esc(v.invoiceNo)} · ${when(v.date)}</div></div><span class="logo" style="background:var(--brand);color:#fff">O</span></div>
    <p class="muted small" style="margin:8px 0">${esc(v.issuedBy.name)}<br>GSTIN ${esc(v.issuedBy.gstin)} · ${esc(v.issuedBy.address)}</p>
    <dl class="kv"><dt>Billed to</dt><dd>${esc(v.billedTo.name)} · ${esc(v.billedTo.id)}</dd>
      <dt>Vehicle</dt><dd>${esc(v.vehicle.number)} · ${esc(v.vehicle.driverName)} (${esc(v.vehicle.driverId)})</dd>
      <dt>From</dt><dd>${esc(v.trip.from.name)} ${pinTag(v.trip.from)}</dd><dt>To</dt><dd>${esc(v.trip.to.name)} ${pinTag(v.trip.to)}</dd>
      <dt>Place of supply</dt><dd>${esc(v.placeOfSupply || '—')}</dd></dl>
    <table style="margin-top:10px">${v.lines.map(row).join('')}
      <tr class="sep"><td>Taxable value</td><td>${rs(v.taxable)}</td></tr>${v.taxes.map(row).join('')}
      ${v.other.length ? `<tr class="sep"><td colspan="2"></td></tr>${v.other.map(row).join('')}` : ''}
      <tr class="tot"><td>Total</td><td>${rs(v.total)}</td></tr></table>
    ${v.summary ? `<h3>Your trip summary</h3><dl class="kv"><dt>Customer paid you</dt><dd>${rs(v.summary.collectedFromRider)}</dd><dt>Ride GST (remitted by Olub)</dt><dd>−${rs(v.summary.rideGstRemitted)}</dd>
      <dt>Olub fee</dt><dd>−${rs(v.summary.platformFee)}</dd>${v.summary.verificationReward ? `<dt>Reward credited by Olub</dt><dd>+${rs(v.summary.verificationReward)}</dd>` : ''}<dt><b>You keep</b></dt><dd><b>${rs(v.summary.youKeep)}</b></dd></dl>` : ''}
    ${v.paid ? `<p class="chip" style="margin-top:10px">${ic('check')}Paid by ${esc(v.paid.method)} · ${when(v.paid.at)}</p>` : ''}
    <p class="muted small" style="margin-top:10px">${esc(v.note)}</p></div>
    <button id="inv-share" class="btn ghost block">${ic('share')}Share invoice</button>`);
  $('#inv-share', sh.el).onclick = run(() => shareText(textOut));
}

// ---------------- my ratings (monthly, anonymous) ----------------
async function renderFeedback(app) {
  app.innerHTML = '<div class="skel"></div><div class="skel"></div>';
  const f = await api('GET', '/api/feedback/mine');
  const meters = (c) => Object.entries(f.labels).map(([k, l]) => (c[k] != null ? `<div style="margin:10px 0"><div class="between small"><span>${esc(l)}</span><b>${c[k].toFixed(1)}</b></div><div class="meter"><i style="width:${c[k] * 20}%"></i></div></div>` : '')).join('');
  app.innerHTML = `<div class="card center"><h3 style="margin-top:0">Your rating</h3>
      <div class="bignum">${f.overall.average != null ? f.overall.average.toFixed(1) : '—'} <span class="stars">${ic('star', 'fill')}</span></div>
      <p class="muted">${f.overall.count} rating${f.overall.count === 1 ? '' : 's'} from ${S.me.role === 'driver' ? 'customers' : 'drivers'}</p>
      <div style="text-align:left">${meters(f.overall.criteria)}</div></div>
    ${f.months.map((m) => `<div class="card"><div class="between"><h2 style="margin:0">${new Date(`${m.month}-15`).toLocaleString('en-IN', { month: 'long', year: 'numeric' })}</h2><span class="stars">${ic('star', 'fill')} ${m.average.toFixed(1)} <span class="muted small">(${m.count})</span></span></div>
      ${m.comments ? ['good', 'bad', 'improve'].map((k) => (m.comments[k].length ? `<h3>${{ good: 'What went well', bad: 'What was not good', improve: 'What to improve' }[k]}</h3>${m.comments[k].map((c) => `<div class="quote-note ${k}">${esc(c)}</div>`).join('')}` : '')).join('') || '<p class="muted small" style="margin-top:8px">No written comments.</p>'
    : `<p class="muted small" style="margin:8px 0 0">${ic('lock')} ${esc(m.note)}</p>`}</div>`).join('') || `<div class="card empty">${ic('star')}<div>No ratings yet. They appear here month by month, without names.</div></div>`}`;
}

// ---------------- insights: trips, money, GST ----------------
async function renderInsights(app) {
  app.innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel"></div>';
  const driver = S.me.role === 'driver';
  const [x, trips, wallet] = await Promise.all([api('GET', '/api/insights'), api('GET', '/api/trips'), driver ? api('GET', '/api/driver/wallet') : null]);
  const money = (t) => (driver ? t.driverKeeps : t.riderPaid);
  const maxDay = Math.max(1, ...x.days.map((d) => d.amount)); const maxHour = Math.max(1, ...x.hours);
  const delta = x.lastWeek.trips ? Math.round(((money(x.week) - money(x.lastWeek)) / Math.max(1, money(x.lastWeek))) * 100) : null;
  const hr = (h) => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;
  app.innerHTML = `
    ${driver ? `<div class="card hero"><div class="between"><div><div class="muted">Wallet balance</div><div class="bignum">${rs(wallet.balance)}</div>
        <div class="muted small">${wallet.ok ? `Keep at least ${rs(wallet.min)} to get customers` : `Below ${rs(wallet.min)} — top up to get customers`}</div></div>
        <button id="topup" class="btn accent" style="position:relative;z-index:1">${ic('plus')}Top up</button></div></div>` : ''}
    <div class="card"><div class="between"><h2 style="margin:0">This week</h2>${delta != null ? `<span class="chip ${delta < 0 && driver ? 'warn' : ''}">${delta >= 0 ? '+' : ''}${delta}% vs last week</span>` : ''}</div>
      <div class="bignum" style="margin-top:6px">${rs(money(x.week))}</div><p class="muted">${x.week.trips} trip${x.week.trips === 1 ? '' : 's'} · ${x.week.km} km ${driver ? '· after Olub fee and GST' : ''}</p>
      <div class="bars">${x.days.map((d, i) => `<div class="${d.amount ? '' : 'z'}" style="height:${Math.max(3, d.amount / maxDay * 100)}%;animation-delay:${i * 30}ms" title="${d.date}: ${rs(d.amount)}"></div>`).join('')}</div>
      <div class="axis"><span>14 days ago</span><span>Today</span></div></div>
    <div class="grid2" style="margin-bottom:12px">
      <div class="stat good"><div class="v">${rs(money(x.all))}</div><div class="l">${driver ? 'You kept, all time' : 'Spent, all time'}</div></div>
      <div class="stat"><div class="v">${x.all.trips}</div><div class="l">Trips · ${x.all.km} km</div></div>
      <div class="stat"><div class="v">${rs(x.all.totalGst)}</div><div class="l">GST ${driver ? 'collected & remitted' : 'paid'}</div></div>
      <div class="stat"><div class="v">${rs(x.all.platformFees)}</div><div class="l">Olub fees${driver ? ` · ${x.commissionPercent}% of fares` : ''}</div></div>
      <div class="stat"><div class="v">${rs(x.averageFare)}</div><div class="l">Average per trip · ${rs(x.perKm)}/km</div></div>
      <div class="stat"><div class="v">${x.safety.average != null ? x.safety.average : '—'}</div><div class="l">Safety score${x.safety.trips ? ` · ${x.safety.harshBrakes} harsh brakes, ${x.safety.overspeed} overspeed` : ''}</div></div>
    </div>
    ${driver ? `<div class="card"><h2>Money earned vs GST</h2><table class="fare">
      <tr><td>Customers paid you</td><td>${rs(x.all.riderPaid)}</td></tr>
      <tr><td>GST on rides (Olub remits)</td><td>−${rs(x.all.rideGst)}</td></tr>
      <tr><td>Olub fees <span class="muted small">incl. ${rs(x.all.platformFeeGst)} GST</span></td><td>−${rs(x.all.platformFees)}</td></tr>
      <tr class="sub"><td colspan="2">Includes ${rs(x.all.tolls)} of tolls you paid on the way.</td></tr>
      <tr class="total"><td>You kept</td><td>${rs(x.all.driverKeeps)}</td></tr></table></div>` : ''}
    ${x.all.trips ? `<div class="card"><h2>When you ${driver ? 'drive' : 'ride'}</h2><div class="bars hours">${x.hours.map((h) => `<div class="${h ? '' : 'z'}" style="height:${Math.max(3, h / maxHour * 100)}%"></div>`).join('')}</div>
      <div class="axis"><span>12am</span><span>6am</span><span>12pm</span><span>6pm</span><span>11pm</span></div>
      ${x.busiestHour != null ? `<p class="muted small" style="margin-top:8px">Busiest around ${hr(x.busiestHour)}.</p>` : ''}
      ${x.topPlaces.length ? `<h3>Top destinations</h3>${x.topPlaces.map((p) => `<div class="between" style="padding:5px 0"><span>${ic('pin')} ${esc(p.name)}</span><b>${p.visits}×</b></div>`).join('')}` : ''}</div>` : ''}
    ${x.months.length ? `<div class="card"><h2>Month by month</h2><div class="list">${x.months.map((m) => `<div class="between"><div><b>${new Date(`${m.key}-15`).toLocaleString('en-IN', { month: 'long', year: 'numeric' })}</b><div class="muted small">${m.trips} trips · ${m.km} km · GST ${rs(m.totalGst)}</div></div><b>${rs(money(m))}</b></div>`).join('')}</div></div>` : ''}
    ${driver ? `<div class="card"><h2>Wallet activity</h2><div class="list">${wallet.txns.map((t) => `<div class="txn"><div><b>${{ topup: 'Top-up', platform_fee: 'Olub fee', ride_gst: 'Ride GST', verify_reward: 'Reward from Olub', adjustment: 'Adjustment' }[t.type] || t.type}</b>
      <div class="muted small">${when(t.ts)}${t.tripId ? ` · trip #${t.tripId}` : ''}</div></div><span class="a ${t.amount >= 0 ? 'cr' : 'dr'}">${t.amount >= 0 ? '+' : '−'}${rs(Math.abs(t.amount))}</span></div>`).join('') || '<p class="muted">No activity yet.</p>'}</div></div>` : ''}
    <div class="card"><h2>Trips</h2><div class="list">${trips.map((t) => `<div><div class="between"><b style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.dst.name)}</b>
        <span class="chip ${t.status === 'completed' ? '' : 'grey'}">${esc(t.status)}</span></div>
      <div class="muted small">${when(t.createdAt)} · ${esc(driver ? t.rider.name : t.driver.vehicleNumber)}${t.final ? ` · ${rs(driver ? t.final.driverFare : t.final.riderPays)}` : ''}${t.safety && t.safety.score != null ? ` · safety ${t.safety.score}` : ''}</div>
      ${t.status === 'completed' ? `<div class="row" style="margin-top:6px"><button class="btn small ghost" data-inv="${t.id}">${ic('file')}Invoice</button>${t.rated ? '' : `<button class="btn small ghost" data-rate="${t.id}">${ic('star')}Rate</button>`}</div>` : ''}</div>`).join('') || `<div class="empty">${ic('car')}<div>No trips yet.</div></div>`}</div></div>`;
  if ($('#topup')) $('#topup').onclick = topupSheet;
  $$('[data-inv]').forEach((b) => { b.onclick = run(() => invoiceSheet(b.dataset.inv)); });
  $$('[data-rate]').forEach((b) => { b.onclick = () => ratingSheet(trips.find((t) => String(t.id) === b.dataset.rate)); });
}

function topupSheet() {
  const sh = sheet('Top up wallet', `<p class="muted">Olub takes its ${rs(S.cfg.platformFee)} fee and the ride GST from this wallet when a trip ends. Keep at least ${rs(S.cfg.wallet.min)} to get customers.</p>
    <div class="chips" id="amts">${[100, 200, 500, 1000].map((a) => `<button class="chip" data-a="${a}" style="border:0;font-size:15px;padding:9px 16px">${rs(a)}</button>`).join('')}</div>
    <label class="f">Amount</label><input id="tu" type="number" inputmode="numeric" value="200">
    <button id="tugo" class="btn block">Pay by UPI</button><p class="muted small center" style="margin-top:8px">Test mode: no real money moves yet.</p>`);
  $$('#amts button', sh.el).forEach((b) => { b.onclick = () => { $('#tu').value = b.dataset.a; }; });
  $('#tugo', sh.el).onclick = run(async () => {
    await api('POST', '/api/driver/wallet/topup', { amount: Number($('#tu').value) });
    S.me = await api('GET', '/api/me'); sh.close(); toast('Wallet topped up'); render();
  });
}

// ---------------- profile, privacy ----------------
function renderProfile(app) {
  const me = S.me;
  if (me.role === 'driver' && S.sub === 'vehicle') return renderVehicle(app);
  app.innerHTML = `
    <div class="idcard"><div class="muted small" style="color:#ffffffaa">${{ rider: 'OLUB CUSTOMER', driver: 'OLUB DRIVER', admin: 'OLUB ADMIN' }[me.role]}</div>
      <div class="pid">${esc(me.publicId)}</div><div style="font-size:20px;font-weight:800;margin-top:10px">${esc(me.name)}</div>
      <div class="muted small" style="color:#ffffffcc">${[me.age && `${me.age} yrs`, me.gender, me.rating.count && `★ ${me.rating.average}`].filter(Boolean).join(' · ')}</div>
      <div class="chips" style="margin-top:12px;position:relative;z-index:1"><span class="chip">${ic('check')}Mobile confirmed</span>
        <span class="chip ${me.emailVerified ? '' : 'warn'}">${ic(me.emailVerified ? 'check' : 'clock')}Email ${me.emailVerified ? 'confirmed' : 'not confirmed'}</span></div></div>
    ${todoCard()}
    <div class="card menu">
      <button data-open="personal">${ic('id')}<span class="grow">About you<div class="muted small">${esc(me.dob || 'Date of birth, sex')}</div></span>${ic('right')}</button>
      <button data-open="email">${ic('mail')}<span class="grow">Email<div class="muted small">${esc(me.email || 'Not added')}</div></span>${ic('right')}</button>
      ${me.role === 'rider' ? `<button data-open="trusted">${ic('heart')}<span class="grow">Trusted contact<div class="muted small">${me.trusted ? `${esc(me.trusted.name)} · ${esc(me.trusted.phone)}` : 'Required for rides'}</div></span>${ic('right')}</button>
        <button id="m-guests">${ic('users')}<span class="grow">People I book for</span>${ic('right')}</button>` : ''}
      ${me.role === 'driver' ? `<button id="m-vehicle">${ic('car')}<span class="grow">Vehicle, documents & cab rules<div class="muted small">${esc(me.driver.vehicleNumber || 'Not added')} · ${esc(me.driver.status)}</div></span>${ic('right')}</button>
        <button id="m-qr">${ic('target')}<span class="grow">My Olub QR</span>${ic('right')}</button>` : ''}
    </div>
    <div class="card menu">
      <button id="m-privacy">${ic('lock')}<span class="grow">Privacy & my data</span>${ic('right')}</button>
      <button id="m-legal">${ic('file')}<span class="grow">Terms, liability & privacy notice</span>${ic('right')}</button>
      <button id="m-logout">${ic('logout')}<span class="grow">Log out</span></button>
    </div>
    <p class="center muted small">${esc(S.cfg.company.grievanceOfficer)}<br>Olub connects customers and drivers. It does not provide the ride.</p>`;
  bindTodos(app);
  $$('[data-open]').forEach((b) => { b.onclick = () => openTodo(b.dataset.open); });
  $('#m-legal').onclick = () => legalSheet(S.legal.required[me.role]);
  $('#m-privacy').onclick = run(privacySheet);
  $('#m-logout').onclick = run(async () => { await api('POST', '/api/auth/logout').catch(() => {}); logout(); });
  if ($('#m-vehicle')) $('#m-vehicle').onclick = () => { S.sub = 'vehicle'; render(); };
  if ($('#m-qr')) $('#m-qr').onclick = qrSheet;
  if ($('#m-guests')) $('#m-guests').onclick = run(async () => {
    const g = await api('GET', '/api/guests');
    sheet('People I book for', g.map((x) => `<div class="between" style="padding:10px 0;border-bottom:1px solid var(--line)"><div><b>${esc(x.name)}</b><div class="muted small">${esc(x.phone || 'No number')}</div></div><span class="chip grey">${esc(x.publicId)}</span></div>`).join('') || '<p class="muted">When you book a ride for someone else, they get their own Olub guest ID and appear here.</p>');
  });
}

function qrSheet() {
  const d = S.me.driver;
  sheet('My Olub QR', `<div class="qrbox">${qrSvg(d.qr)}</div><div class="center"><span class="plate" style="font-size:20px">${esc(d.vehicleNumber || '')}</span>
    <p style="margin-top:8px"><b>${esc(S.me.name)}</b> · ${esc(S.me.publicId)}</p><p class="muted">Customers scan this to see the fare and book you. Print it and stick it on your cab.</p></div>`);
}

async function privacySheet() {
  const list = await api('GET', '/api/privacy/requests');
  const sh = sheet('Privacy & my data', `<p class="muted">You can get a copy of your data, correct it, delete your account, withdraw consent or complain. We answer within ${S.cfg.dsrPublicDays - 2}–${S.cfg.dsrPublicDays} days.</p>
    ${S.me.emailVerified ? '' : '<div class="card warn">Confirm your email first — requests are accepted only from verified accounts.</div>'}
    <label class="f">What do you need?</label><select id="dt">${Object.entries(S.cfg.dsrTypes).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select>
    <label class="f">Details (optional)</label><textarea id="dd" maxlength="1000"></textarea>
    <button id="dgo" class="btn block">Send request</button>
    <h3>My requests</h3><div class="list">${list.map((r) => `<div><div class="between"><b>${esc(r.typeLabel)}</b><span class="chip ${r.status === 'completed' ? '' : r.status === 'received' ? 'warn' : 'grey'}">${esc(r.status)}</span></div>
      <div class="muted small">${esc(r.publicId)} · ${when(r.createdAt)}${r.status === 'received' ? ` · answer by ${new Date(r.answerBy).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}` : ''}</div>
      ${r.response ? `<p class="small" style="margin:6px 0 0">${esc(r.response)}</p>` : ''}
      <div class="row" style="margin-top:6px">${r.hasExport ? `<button class="btn small ghost" data-dl="${r.id}">${ic('download')}Download my data</button>` : ''}${r.status === 'received' ? `<button class="btn small ghost" data-wd="${r.id}">Cancel request</button>` : ''}</div></div>`).join('') || '<p class="muted">No requests yet.</p>'}</div>`);
  $('#dgo', sh.el).onclick = run(async () => { const r = await api('POST', '/api/privacy/requests', { type: $('#dt').value, details: $('#dd').value }); sh.close(); toast(`Request ${r.publicId} received`); privacySheet(); });
  $$('[data-wd]', sh.el).forEach((b) => { b.onclick = run(async () => { await api('POST', `/api/privacy/requests/${b.dataset.wd}/withdraw`); sh.close(); privacySheet(); }); });
  $$('[data-dl]', sh.el).forEach((b) => { b.onclick = run(async () => {
    const data = await api('GET', `/api/privacy/requests/${b.dataset.dl}/export`);
    const text = JSON.stringify(data, null, 2);
    if (Native && Native.saveText) return Native.saveText('olub-my-data.json', text);
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = 'olub-my-data.json'; a.click();
  }); });
}
