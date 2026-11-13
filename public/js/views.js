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
    if (S.trip && m.tripId === S.trip.id) { S.messages.push(m); renderChat(); toast(m.body, false, 'chat'); }
  });
  S.es.addEventListener('call', (e) => Call.onSignal(JSON.parse(e.data)));
  S.es.addEventListener('loc', (e) => {
    const p = JSON.parse(e.data);
    if (S.trip && p.tripId === S.trip.id) { S.trip.last = { ...p, digipin: Digipin.encode(p.lat, p.lng) }; if (S.map) S.map.setCar(p); const el = $('#livepin'); if (el) el.textContent = S.trip.last.digipin || ''; const d = $('#livedist'); if (d) d.textContent = liveDistance(S.trip); }
  });
  S.es.addEventListener('safety', (e) => onSafety(JSON.parse(e.data)));
  S.es.addEventListener('duty', run(async (e) => {
    const d = JSON.parse(e.data);
    toast({ duty_limit: 'You have reached 12 hours. Time to rest for 10 hours.', wallet_low: 'Wallet below ₹100 — top up to get customers.', suspended: 'Your account has been put on hold.' }[d.reason] || 'You are offline', true);
    S.me = await api('GET', '/api/me'); render();
  }));
}

/** Plain-words result of a cancellation for the person looking at it. */
function cancelText(t) {
  const c = t.cancellation || {};
  if (c.youPay) return t.you === 'driver' ? `Ride cancelled. ${rs(c.youPay)} cancellation fee taken from your wallet.` : `Ride cancelled. ${rs(c.youPay)} cancellation fee will be added to your next ride.`;
  if (c.reason === 'no_driver') return 'No cab accepted this time. Nothing was charged — try again, or scan a cab near you.';
  if (c.charged) return `Ride cancelled. The ${c.charged === 'driver' ? 'driver' : 'customer'} pays the ${rs(c.fee)} fee — you pay nothing.`;
  return 'Ride cancelled. No fee.';
}

function cancelSheet(t) {
  const fee = t.distanceKm > S.cfg.platformFeeLongKm ? S.cfg.platformFeeLong : S.cfg.platformFee;
  const rider = t.you === 'rider';
  const reasons = [['driver_not_coming', 'Driver is not coming'], ['changed_plan', 'My plan changed'], ['mistake', 'Booked by mistake']];
  const free = t.status === 'requested';
  const sh = sheet('Cancel this ride?', `
    ${free ? '<p class="muted">The driver has not accepted yet, so there is no fee.</p>' : rider ? `<p class="muted">Free within ${S.cfg.cancel.freeMin} minutes of booking. After that the fee is ${rs(fee)}, paid by one side only:</p>
      <div class="legal"><p>If you say the driver is not coming and GPS shows that, the driver pays.</p><p>Otherwise you pay (never more than ${S.cfg.cancel.capPercent}% of the fare). It is added to your next ride.</p><p>The app's decision is final.</p></div>
      <label class="f">Why are you cancelling?</label><div class="seg" id="cwhy" style="flex-direction:column;gap:3px">${reasons.map(([k, l], i) => `<button data-k="${k}" class="${i === 1 ? 'on' : ''}">${l}</button>`).join('')}</div>`
    : `<p>You accepted this ride. If you cancel now, <b>${rs(fee)}</b> will be taken from your wallet.</p>`}
    <button id="cyes" class="btn danger block">Cancel ride</button><button class="btn ghost block" data-close>Keep ride</button>`);
  let why = rider ? 'changed_plan' : 'driver_cancelled';
  $$('#cwhy button', sh.el).forEach((b) => { b.onclick = () => { why = b.dataset.k; $$('#cwhy button').forEach((x) => x.classList.toggle('on', x === b)); }; });
  $('#cyes', sh.el).onclick = run(async () => {
    const r = await api('POST', `/api/trips/${t.id}/cancel`, { reason: why });
    sh.close(); S.trip = null; await refreshTrip();
    if (S.me.role === 'rider') S.me = await api('GET', '/api/me');
    render(); toast(cancelText(r), !!(r.cancellation && r.cancellation.youPay));
  });
}

async function refreshTrip() {
  const prevId = S.trip && S.trip.id;
  const cur = await api('GET', '/api/trips/current');
  const known = new Set((S.requests || []).map((t) => t.id));
  S.trip = cur.trip; S.requests = cur.requests;
  if (S.me && S.me.role === 'driver' && S.requestsLoaded && cur.requests.some((t) => !known.has(t.id))) { chime(); S.tab = 'home'; toast('New ride request', false, 'car'); }
  S.requestsLoaded = true;
  if (prevId && !S.trip) {
    const old = await api('GET', `/api/trips/${prevId}`).catch(() => null);
    if (old && old.status === 'rejected') toast('Driver declined the ride', true);
    if (old && old.status === 'cancelled') toast(cancelText(old), true);
    if (old && old.status === 'completed' && old.paidAt) S.trip = old; // keep the receipt until dismissed
  }
  if (S.trip && S.trip.id !== prevId) S.messages = await api('GET', `/api/trips/${S.trip.id}/messages`);
  if (S.me && S.me.role === 'driver') S.me = await api('GET', '/api/me');
  syncTracking(); syncPresence();
}

/** Rough place from the IP address (asked once), used to open the map on the right city. */
function whereAmI() {
  if (!S.wherePromise) S.wherePromise = api('GET', '/api/where').then((w) => { S.where = w; return w; }).catch(() => null);
  return S.wherePromise;
}

// ---------------- live GPS during a ride ----------------
function syncTracking() {
  const live = S.trip && ['accepted', 'started'].includes(S.trip.status);
  if (!live) return stopTracking();
  if (Native && Native.startTracking && S.me.role === 'driver') { Native.startTracking(S.base, S.token, String(S.trip.id)); S.nativeMode = 'trip'; } // keeps working with the screen off
  if (S.watchId != null || !navigator.geolocation) return;
  S.watchId = navigator.geolocation.watchPosition((p) => {
    if (!S.trip || Date.now() - S.lastPing < 6000) return;
    S.lastPing = Date.now();
    api('POST', `/api/trips/${S.trip.id}/location`, { lat: p.coords.latitude, lng: p.coords.longitude, kmph: p.coords.speed != null ? p.coords.speed * 3.6 : null }).catch(() => {});
  }, () => {}, { enableHighAccuracy: true, maximumAge: 4000 });
}
// While a driver is online, tell Olub roughly where the cab is waiting so nearby customers can be matched.
function syncPresence() {
  const on = S.me && S.me.role === 'driver' && S.me.driver.online;
  const liveTrip = S.trip && ['accepted', 'started'].includes(S.trip.status);
  if (Native && Native.startPresence) {
    // Keeps the cab's waiting position fresh with the screen off, so nearby customers can still be matched.
    if (on && !liveTrip) { Native.startPresence(S.base, S.token); S.nativeMode = 'presence'; }
    else if (!on && S.nativeMode === 'presence') { Native.stopTracking(); S.nativeMode = null; }
  }
  if (!on) { if (S.presenceId != null) { navigator.geolocation.clearWatch(S.presenceId); S.presenceId = null; } return; }
  if (S.presenceId != null || !navigator.geolocation) return;
  S.presenceId = navigator.geolocation.watchPosition((p) => {
    if (Date.now() - (S.lastPresence || 0) < 25000) return;
    S.lastPresence = Date.now();
    api('POST', '/api/driver/location', { lat: p.coords.latitude, lng: p.coords.longitude }).catch(() => {});
  }, () => {}, { enableHighAccuracy: true, maximumAge: 15000 });
}
function stopTracking() {
  if (S.watchId != null) { navigator.geolocation.clearWatch(S.watchId); S.watchId = null; }
  if (Native && Native.stopTracking && S.nativeMode === 'trip') { Native.stopTracking(); S.nativeMode = null; }
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
  rider: [['home', 'Ride', 'car'], ['activity', 'Activity', 'list'], ['safety', 'Safety', 'shield'], ['feedback', 'Ratings', 'star'], ['profile', 'Profile', 'user']],
  driver: [['home', 'Drive', 'car'], ['money', 'Earnings', 'wallet'], ['trips', 'Trips', 'list'], ['feedback', 'Ratings', 'star'], ['profile', 'Profile', 'user']],
  admin: [['home', 'Admin', 'shield'], ['profile', 'Profile', 'user']],
};

const viewKey = () => (S.me ? `${S.me.role}:${S.tab}:${S.sub || ''}:${S.trip ? 'trip' : ''}` : 'auth');
/** Put the page back where the user was. Called again by screens that load their content after a moment. */
function applyScroll() { foldify($('#app')); if (S.keepScroll != null) window.scrollTo(0, S.keepScroll); }

function render() {
  const app = $('#app');
  S.scrollPos = S.scrollPos || {};
  if (S.lastKey) S.scrollPos[S.lastKey] = window.scrollY;
  const key = viewKey(); S.keepScroll = S.scrollPos[key] || 0; S.lastKey = key;
  const done = renderView(app); applyScroll(); return done;
}

function renderView(app) {
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
  $$('#nav button').forEach((b) => { b.onclick = () => { if (S.tab === b.dataset.tab) { S.scrollPos[viewKey()] = 0; window.scrollTo(0, 0); } S.tab = b.dataset.tab; render(); }; });
  if (S.tab === 'profile') return renderProfile(app);
  if (S.tab === 'feedback') return renderFeedback(app);
  if (['activity', 'money', 'trips'].includes(S.tab)) return renderInsights(app);
  if (S.tab === 'safety') return renderSafety(app);
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
      <p class="muted">Scan its QR, see a fair fare, and go. Olub keeps only <b>${rs(S.cfg.platformFee)}</b> a trip (${rs(S.cfg.platformFeeLong)} over ${S.cfg.platformFeeLongKm} km) — the rest is the driver's.</p></div>
    <div class="card">
      <label class="f">Mobile number</label>
      <input id="phone" inputmode="numeric" maxlength="14" placeholder="98765 43210" autocomplete="tel">
      <div id="otp-step" hidden>
        <label class="f">Enter the 6-digit code we sent</label>
        <input id="code" inputmode="numeric" maxlength="6" class="otp-in" autocomplete="one-time-code">
        <div class="between"><p id="devcode" class="muted small" style="margin:6px 0"></p><button id="resend" type="button" class="btn small ghost">Send a new code</button></div>
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
    <p class="center muted small">${ic('lock')} Your number is never shown to drivers or customers.</p>
    ${S.cfg.demoLogin ? `<div class="card demo"><div class="between"><h2 style="margin:0">${ic('sparkle')} Try the demo</h2><span class="chip gold">Test mode</span></div>
      <p class="muted small" style="margin:6px 0 12px">One tap, no code. Loads sample drivers, passengers and trips around Lucknow.</p>
      <div class="demo3"><button data-demo="rider">${ic('user')}<b>Passenger</b><span>Book a ride</span></button><button data-demo="driver">${ic('car')}<b>Driver</b><span>Accept a ride</span></button><button data-demo="admin">${ic('shield')}<b>Admin</b><span>Run Olub</span></button></div></div>` : ''}`;
  $$('[data-demo]').forEach((b) => { b.onclick = run(async () => {
    const r = await api('POST', '/api/auth/demo', { role: b.dataset.demo });
    S.token = r.token; store('olub.token', r.token); S.me = r.user; S.tab = 'home'; S.booking = { mode: 'plate', driver: '', src: null, dst: null, pet: false }; S.estimate = null; S.nearby = null; S.quote = null;
    connect(); await refreshTrip(); render(); toast(`Signed in as ${r.user.name}`);
  }); });
  let step = 'phone', roleSel = 'rider';
  $$('#rolepick button').forEach((b) => { b.onclick = () => { roleSel = b.dataset.r; $$('#rolepick button').forEach((x) => x.classList.toggle('on', x === b)); }; });
  $('#see-terms').onclick = (e) => { e.preventDefault(); legalSheet(S.legal.required[roleSel]); };
  const sendCode = async () => {
    const r = await api('POST', '/api/auth/request-otp', { phone: $('#phone').value });
    $('#otp-step').hidden = false; $('#new-user').hidden = !r.isNewUser;
    $('#code').value = '';
    $('#devcode').textContent = r.devCode ? `Test mode code: ${r.devCode}` : 'Code sent.';
  };
  $('#resend').onclick = run(async () => { await sendCode(); toast('New code sent'); });
  $('#go').onclick = run(async () => {
    const phone = $('#phone').value;
    if (step === 'phone') {
      await sendCode();
      $('#go').firstChild.textContent = 'Continue'; step = 'otp'; $('#code').focus();
    } else {
      let r;
      try {
        r = await api('POST', '/api/auth/verify-otp', { phone, code: $('#code').value, name: $('#name').value, role: roleSel, acceptTerms: $('#terms').checked });
      } catch (e) {
        if (!/expired/i.test(e.message)) throw e;
        // The code is no longer valid (too old, or the server restarted): get a fresh one straight away.
        await sendCode();
        throw new Error('That code had expired. We sent a new one — please enter it.');
      }
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
  terms: ['file', 'Accept the latest terms'], email: ['mail', 'Confirm your email'], personal: ['id', 'Add personal details'],
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
  let photo;  // undefined = unchanged
  const pic = () => (photo !== undefined ? photo : S.me.photo);
  const sh = sheet('Personal details', `
    <div class="row" style="margin-bottom:6px"><div id="pp-box">${pic() ? `<img class="avatar" src="${pic()}" alt="" style="width:76px;height:76px">` : `<div class="avatar" style="width:76px;height:76px">${ic('user')}</div>`}</div>
      <div class="grow"><label class="btn small ghost" style="margin:0">${ic('camera')}${S.me.photo ? 'Change photo' : 'Add your photo'}<input id="pp" type="file" accept="image/*" hidden></label>
      <p class="muted small" style="margin:6px 0 0">${S.me.role === 'driver' ? 'Customers see this photo.' : 'Your driver sees this so they can recognise you.'}</p></div></div>
    <label class="f">Name</label><input id="pn" value="${esc(S.me.name || '')}">
    <label class="f">Date of birth</label><input id="pd" type="date" value="${esc(S.me.dob || '')}" max="${new Date().toISOString().slice(0, 10)}">
    <label class="f">Sex</label><div class="seg" id="pg">${['male', 'female', 'other'].map((g) => `<button data-g="${g}" class="${S.me.gender === g ? 'on' : ''}">${g[0].toUpperCase() + g.slice(1)}</button>`).join('')}</div>
    <p class="muted small" style="margin-top:10px">You must be ${S.cfg.minAge} or older. ${S.me.role === 'driver' ? 'Customers see your age and sex on your driver card.' : ''}</p>
    <button id="pgo" class="btn block">Save</button>`);
  let g = S.me.gender;
  $$('#pg button', sh.el).forEach((b) => { b.onclick = () => { g = b.dataset.g; $$('#pg button').forEach((x) => x.classList.toggle('on', x === b)); }; });
  $('#pp', sh.el).onchange = run(async (e) => {
    if (!e.target.files[0]) return;
    photo = await readImage(e.target.files[0], 360);
    $('#pp-box').innerHTML = `<img class="avatar" src="${photo}" alt="" style="width:76px;height:76px">`;
  });
  $('#pgo', sh.el).onclick = run(async () => saved(await api('PATCH', '/api/me', { name: $('#pn').value, dob: $('#pd').value, gender: g, ...(photo !== undefined && { photo }) }), sh, 'Saved'));
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
    <div id="precent"></div><h3>Places</h3><div id="plist" class="menu"></div><div id="pmap" class="map" hidden style="margin-top:10px"></div><button id="p-ok" class="btn block" hidden>Use this spot</button>`);
  const pick = (p) => { sh.close(); onPick(p); };
  const list = (items) => {
    $('#plist', sh.el).innerHTML = items.map((p, i) => `<button data-i="${i}">${ic('pin')}<span class="grow">${esc(p.name)}</span>${ic('right')}</button>`).join('') || '<p class="muted">No matches. Try the map.</p>';
    $$('#plist button', sh.el).forEach((b) => { b.onclick = () => { const p = items[b.dataset.i]; pick(p.placeId ? { placeId: p.placeId, name: p.name, lat: p.lat, lng: p.lng, digipin: Digipin.encode(p.lat, p.lng) } : { ...p, digipin: Digipin.encode(p.lat, p.lng) }); }; });
  };
  // Nearest known places first.
  const ref = S.booking.src || S.where; const far = (p) => (ref ? (p.lat - ref.lat) ** 2 + (p.lng - ref.lng) ** 2 : 0);
  list([...S.places].sort((a, b) => far(a) - far(b)).slice(0, 8).map((p) => ({ placeId: p.id, name: p.name, lat: p.lat, lng: p.lng })));
  if (S.me.role === 'rider') api('GET', '/api/places/recent').then((rec) => {
    const box = $('#precent', sh.el); if (!box || !rec.length) return;
    box.innerHTML = `<h3>Recent</h3><div class="menu">${rec.map((p, i) => `<button data-r="${i}">${ic('clock')}<span class="grow">${esc(p.name)}</span>${ic('right')}</button>`).join('')}</div>`;
    $$('[data-r]', box).forEach((b) => { b.onclick = () => pick(rec[b.dataset.r]); });
  }).catch(() => {});
  let timer;
  $('#pq', sh.el).oninput = (e) => {
    clearTimeout(timer);
    const q = e.target.value.trim();
    if (Digipin.looksLike(q)) { const c = Digipin.decode(q); return list([{ name: `DIGIPIN ${Digipin.encode(c.lat, c.lng)}`, lat: c.lat, lng: c.lng }]); }
    timer = setTimeout(async () => { try { const near = S.booking.src || S.lastSeen; list(await api('GET', `/api/places/search?q=${encodeURIComponent(q)}${near ? `&lat=${near.lat}&lng=${near.lng}` : ''}`)); } catch { /* keep the old list */ } }, 250);
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
const pointBody = (p) => (p.placeId ? { placeId: p.placeId } : { lat: p.lat, lng: p.lng, name: p.name, state: p.state });

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
    ${b.pickupKm ? `<tr class="sub"><td colspan="2">${b.pickupKm} km for the cab to reach ${forDriver ? 'the customer' : 'you'} + ${b.tripKm} km trip</td></tr>` : ''}
    <tr class="sub"><td colspan="2">${rs(b.base)} base + ${rs(b.perKm)}/km · vehicle ×${b.conditionMultiplier} · ${esc(b.experienceLabel)} ×${b.experienceMultiplier}${b.minFareApplied ? ' · minimum fare' : ''}</td></tr>
    ${b.waitCharge || !final ? `<tr><td>Traffic / waiting · ${b.waitMinutes} min${final ? '' : ' (estimate)'}</td><td>${rs(b.waitCharge)}</td></tr>` : ''}
    ${b.petCharge ? `<tr><td>Pet charge</td><td>${rs(b.petCharge)}</td></tr>` : ''}
    ${b.tolls.map((t) => `<tr><td>Toll · ${esc(t.name)}${t.status === 'verified' ? '' : ' <span class="muted small">(state default)</span>'}</td><td>${rs(t.amount)}</td></tr>`).join('')}
    <tr class="to-driver"><td>${forDriver ? 'You keep' : 'Driver keeps'}</td><td>${rs(f.driverFare)}</td></tr>
    ${f.taxes.rideGst ? `<tr><td>GST ${f.taxes.rideGstRate * 100}% on ride</td><td>${rs(f.taxes.rideGst)}</td></tr>` : ''}
    <tr><td>Olub fee <span class="muted small">incl. GST</span>${f.calamity ? ' <span class="chip warn">relief rate</span>' : ''}</td><td>${rs(f.platformFee)}</td></tr>
    ${f.dues ? `<tr><td>Earlier cancellation fee</td><td>${rs(f.dues)}</td></tr>` : ''}
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

/** "1.2 km away" before pickup, "about 6 km to go" during the ride — from the cab's latest GPS. */
function liveDistance(t) {
  if (!t.last) return '';
  const target = t.status === 'started' ? t.dst : t.src; const km = kmBetween(t.last, target) * 1.3;
  if (t.status === 'accepted') return km < 0.15 ? 'The cab is at the pickup point' : `The cab is about ${km < 1 ? `${Math.round(km * 1000 / 50) * 50} m` : `${km.toFixed(1)} km`} away`;
  return km < 0.2 ? 'Almost there' : `About ${km.toFixed(1)} km to go`;
}

function tripMapHtml(t) {
  return `<div id="tmap" class="map"></div>
    <div class="card flat" style="margin-top:-4px"><div class="route" style="pointer-events:none">
      <button><span class="dotp"></span><span class="t">${esc(t.src.name)}</span>${pinTag(t.src)}</button>
      <button><span class="dotd"></span><span class="t">${esc(t.dst.name)}</span>${pinTag(t.dst)}</button></div>
      ${['accepted', 'started'].includes(t.status) ? `<p class="muted small" style="margin:8px 0 0">${ic('target')} Cab is at <span class="digipin" id="livepin">${esc((t.last && t.last.digipin) || 'waiting for GPS…')}</span></p><p class="small" style="margin:6px 0 0;font-weight:650" id="livedist">${esc(liveDistance(t))}</p>` : ''}</div>`;
}
function mountTripMap(t) { const el = $('#tmap'); if (el) { S.map = makeMap(el, { src: t.src, dst: t.dst, last: t.last, polyline: t.routePolyline }); if (S.map) S.map.setHexGrid(t.src, []); } }

function commsBlock(t) {
  if (!['accepted', 'started'].includes(t.status) && !(t.status === 'completed' && !t.paidAt)) return '';
  const other = t.you === 'rider' ? 'driver' : 'customer';
  return `<div class="card"><div class="between"><h2 style="margin:0">Talk to your ${other}</h2><button id="callbtn" class="btn small" aria-label="Call inside the app">${ic('phone')}Call</button></div>
    <p class="muted small" style="margin:6px 0 0">${ic('lock')} Calls and chat stay inside Olub. Numbers are never shared.</p>
    <div class="chat" id="chat"></div>
    <div class="quick">${(t.you === 'rider' ? ['I am at the pickup point', 'Coming in 2 minutes', 'Where are you?'] : ['I have arrived', 'Reaching in 2 minutes', 'Please come to the main road']).map((q) => `<button data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>
    <div class="row"><div class="grow"><input id="msg" placeholder="Message…" maxlength="500" aria-label="Message"></div><button id="send" class="btn small" aria-label="Send message">${ic('nav')}</button></div></div>`;
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
  $$('.quick button').forEach((b) => { b.onclick = (ev) => { $('#msg').value = b.dataset.q; send(ev); }; });
  $('#msg').onkeydown = (e) => { if (e.key === 'Enter') send(e); };
  $('#callbtn').onclick = run(() => Call.start(t.id, t.you === 'rider' ? t.driver.name : t.rider.name));
}
function renderChat() {
  const c = $('#chat'); if (!c) return;
  const hm = (ts) => new Date(ts).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  c.innerHTML = S.messages.map((m) => `<div class="msg${m.mine ? ' mine' : ''}">${esc(m.body)}<time>${hm(m.createdAt)}</time></div>`).join('') || '<div class="muted small">No messages yet. Tap a quick reply or type below.</div>';
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
    <div class="dl3"><button id="inv-jpg" class="btn ghost">${ic('camera')}JPG</button><button id="inv-xls" class="btn ghost">${ic('file')}Excel</button><button id="inv-share" class="btn ghost">${ic('share')}Share</button></div>`);
  $('#inv-share', sh.el).onclick = run(() => shareText(textOut));
  const fname = `Olub-invoice-${String(v.invoiceNo).replace(/[^A-Za-z0-9]+/g, '-')}`;
  const money = (n) => `${n < 0 ? '-' : ''}Rs ${Math.abs(n).toLocaleString('en-IN')}`;
  $('#inv-jpg', sh.el).onclick = run(async () => saveFile(`${fname}.jpg`, await cardImage({
    title: v.title.replace(' — ', ': '), subtitle: `${v.invoiceNo}  |  ${when(v.date)}`, big: money(v.total), bigLabel: v.kind === 'ride' ? 'Total paid to the driver' : 'Charged to your wallet',
    rows: [['Billed to', `${v.billedTo.name} (${v.billedTo.id})`], ['Vehicle', v.vehicle.number], ['Driver', `${v.vehicle.driverName} (${v.vehicle.driverId})`], ['From', v.trip.from.digipin || ''], [v.trip.from.name, '', 'muted'], ['To', v.trip.to.digipin || ''], [v.trip.to.name, '', 'muted'], ['', '', 'line'],
      ...v.lines.map((l) => [l.label, money(l.amount)]), ['Taxable value', money(v.taxable), 'muted'], ...v.taxes.map((l) => [l.label, money(l.amount)]), ...v.other.map((l) => [l.label, money(l.amount)]), ['', '', 'line'], ['Total', money(v.total), 'bold']],
    footer: `${v.issuedBy.name}. GSTIN ${v.issuedBy.gstin}. ${v.note}`,
  })));
  $('#inv-xls', sh.el).onclick = run(() => saveFile(`${fname}.xlsx`, makeXlsx([{ name: 'Invoice', rows: [['Item', 'SAC', 'Amount (Rs)'],
    ...v.lines.map((l) => [l.label, l.sac || '', l.amount]), ['Taxable value', '', v.taxable], ...v.taxes.map((l) => [l.label, '', l.amount]), ...v.other.map((l) => [l.label, '', l.amount]), ['Total', '', v.total]] },
  { name: 'Details', rows: [['Field', 'Value'], ['Invoice number', v.invoiceNo], ['Date', when(v.date)], ['Issued by', v.issuedBy.name], ['GSTIN', v.issuedBy.gstin], ['Billed to', `${v.billedTo.name} (${v.billedTo.id})`],
    ['Vehicle', v.vehicle.number], ['Driver', `${v.vehicle.driverName} (${v.vehicle.driverId})`], ['From', v.trip.from.name], ['From DIGIPIN', v.trip.from.digipin || ''], ['To', v.trip.to.name], ['To DIGIPIN', v.trip.to.digipin || ''], ['Distance (km)', v.trip.distanceKm], ['Place of supply', v.placeOfSupply || '']] }])));
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
// ---------- period filter shared by Activity, Earnings and Trips ----------
const PERIODS = [['7d', '7 days'], ['month', 'This month'], ['last', 'Last month'], ['90d', '3 months'], ['all', 'All time'], ['custom', 'Custom']];
function periodRange() {
  const p = S.period || (S.period = { key: 'month' });
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = new Date(); const ago = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d; };
  if (p.key === '7d') return { from: iso(ago(6)), to: iso(today), label: 'last 7 days' };
  if (p.key === 'month') return { from: iso(new Date(today.getFullYear(), today.getMonth(), 1)), to: iso(today), label: 'this month' };
  if (p.key === 'last') return { from: iso(new Date(today.getFullYear(), today.getMonth() - 1, 1)), to: iso(new Date(today.getFullYear(), today.getMonth(), 0)), label: 'last month' };
  if (p.key === '90d') return { from: iso(ago(89)), to: iso(today), label: 'last 3 months' };
  if (p.key === 'custom' && p.from && p.to) return { from: p.from <= p.to ? p.from : p.to, to: p.from <= p.to ? p.to : p.from, label: `${p.from} to ${p.to}` };
  return { from: '', to: '', label: 'all time' };
}
function periodBar() {
  const p = S.period || { key: 'month' }; const r = periodRange();
  return `<div class="filters" id="periods">${PERIODS.map(([k, l]) => `<button data-p="${k}" class="${p.key === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    ${p.key === 'custom' ? `<div class="card flat" style="padding:12px"><div class="grid2"><div><label class="f" style="margin-top:0">From</label><input type="date" id="pfrom" value="${esc(p.from || r.from)}"></div><div><label class="f" style="margin-top:0">To</label><input type="date" id="pto" value="${esc(p.to || r.to)}"></div></div></div>` : ''}`;
}
function bindPeriod() {
  $$('#periods button').forEach((b) => { b.onclick = () => { S.period = { ...(S.period || {}), key: b.dataset.p }; render(); }; });
  const f = $('#pfrom'), t = $('#pto');
  if (f) f.onchange = () => { S.period.from = f.value; if (S.period.to) render(); };
  if (t) t.onchange = () => { S.period.to = t.value; if (S.period.from) render(); };
}

const TRIP_ICON = { completed: 'check', cancelled: 'x', rejected: 'ban', requested: 'clock', accepted: 'car', started: 'nav' };
const TRIP_WORD = { completed: 'Completed', cancelled: 'Cancelled', rejected: 'Declined', requested: 'Waiting', accepted: 'Driver coming', started: 'On the way' };

function tripRows(trips, driver) {
  const f = S.tripFilter || 'all';
  const match = { all: () => true, completed: (t) => t.status === 'completed', cancelled: (t) => ['cancelled', 'rejected'].includes(t.status), live: (t) => ['requested', 'accepted', 'started'].includes(t.status) };
  const list = trips.filter(match[f]);
  const count = (k) => trips.filter(match[k]).length;
  return `<div class="filters">${[['all', 'All'], ['completed', 'Completed'], ['cancelled', 'Cancelled'], ['live', 'Live']].map(([k, l]) => `<button data-f="${k}" class="${f === k ? 'on' : ''}">${l} · ${count(k)}</button>`).join('')}</div>
    ${list.map((t) => { const amt = t.final ? (driver ? t.final.driverFare : t.final.riderPays) : null; const c = t.cancellation; return `<button class="trow ${t.status}" data-trip="${t.id}">
      <div class="ti">${ic(TRIP_ICON[t.status])}</div>
      <div class="tm"><b>${esc(t.dst.name)}</b><span class="muted small">from ${esc(t.src.name)}</span>
        <span class="muted small">${when(t.createdAt)} · ${esc(driver ? (t.guest ? t.guest.name : t.rider.name) : `${t.driver.vehicleLabel} ${t.driver.vehicleNumber}`)}</span></div>
      <div class="amt">${amt != null ? rs(amt) : (c && c.youPay ? `<span style="color:var(--danger)">−${rs(c.youPay)}</span>` : '')}<div class="muted small" style="font-weight:600">${TRIP_WORD[t.status]}</div></div></button>`; }).join('')
    || `<div class="card empty">${ic('car')}<div>No trips in this period.</div></div>`}`;
}

function tripSheet(t, driver) {
  const f = t.final || t.quote; const c = t.cancellation;
  const why = { changed_plan: 'Plan changed', mistake: 'Booked by mistake', driver_not_coming: 'Driver was not coming', driver_cancelled: 'Driver could not take the ride', no_driver: 'No cab accepted' };
  const sh = sheet(`Trip #${t.id}`, `
    <div class="between"><span class="chip ${t.status === 'completed' ? '' : ['cancelled', 'rejected'].includes(t.status) ? 'danger' : 'warn'}">${ic(TRIP_ICON[t.status])}${TRIP_WORD[t.status]}</span><span class="muted small">${when(t.createdAt)}</span></div>
    <div class="route" style="pointer-events:none;margin:8px 0"><button><span class="dotp"></span><span class="t">${esc(t.src.name)}</span>${pinTag(t.src)}</button><button><span class="dotd"></span><span class="t">${esc(t.dst.name)}</span>${pinTag(t.dst)}</button></div>
    ${driver ? `<p><b>${esc(t.guest ? `${t.guest.name} (guest of ${t.rider.name})` : t.rider.name)}</b> · <span class="chip grey">${esc((t.guest || t.rider).publicId)}</span></p>` : driverCard(t.driver)}
    ${c ? `<div class="card ${c.youPay ? 'alert' : 'soft'}" style="margin-top:10px"><b>${c.by === 'system' ? 'Not booked' : `Cancelled by the ${c.by === 'rider' ? 'customer' : 'driver'}`}</b> — ${esc(why[c.reason] || c.reason || '')}.<br>
      ${c.youPay ? `You were charged ${rs(c.youPay)}.` : c.charged ? `The ${c.charged === 'rider' ? 'customer' : 'driver'} was charged ${rs(c.fee)}; you paid nothing.` : 'No fee was charged.'}</div>` : ''}
    ${t.status === 'rejected' ? '<div class="card soft" style="margin-top:10px">The driver declined this request. No fee.</div>' : ''}
    <h3>${t.final ? 'Bill' : 'Fare quoted'}</h3>${fareTable(f, { final: !!t.final, forDriver: driver })}
    ${t.safety && t.safety.score != null ? `<p class="muted small" style="margin-top:8px">${ic('shield')} Driving safety score <b>${t.safety.score}</b>/100${t.safety.overspeed ? ` · ${t.safety.overspeed} overspeed` : ''}${t.safety.harshBrakes ? ` · ${t.safety.harshBrakes} harsh braking` : ''}</p>` : ''}
    ${!driver && ['completed', 'cancelled', 'rejected'].includes(t.status) ? `<button class="btn block" id="ts-again">${ic('nav')}Book this trip again</button>` : ''}
    ${t.status === 'completed' ? `<div class="grid2" style="margin-top:12px"><button class="btn ghost" id="ts-inv">${ic('file')}Invoice</button>${t.rated ? `<span class="chip" style="justify-content:center">${ic('check')}Rated</span>` : `<button class="btn" id="ts-rate">${ic('star')}Rate</button>`}</div>` : ''}`);
  const again = $('#ts-again', sh.el); if (again) again.onclick = () => { sh.close(); S.booking = { mode: 'plate', driver: '', src: S.booking.src, dst: t.dst, pet: false }; S.estimate = null; S.nearby = null; S.quote = null; S.tab = 'home'; S.scrollPos[`rider:home::`] = 0; render(); };
  const inv = $('#ts-inv', sh.el); if (inv) inv.onclick = run(() => { sh.close(); return invoiceSheet(t.id); });
  const rt = $('#ts-rate', sh.el); if (rt) rt.onclick = () => { sh.close(); ratingSheet(t); };
}

async function renderInsights(app) {
  app.innerHTML = '<div class="skel" style="height:46px"></div><div class="skel" style="height:190px"></div><div class="skel"></div><div class="skel"></div>';
  const driver = S.me.role === 'driver'; const mode = S.tab; const r = periodRange(); const pkey = JSON.stringify(S.period || {});
  const [x, allTrips, wallet] = await Promise.all([api('GET', `/api/insights?from=${r.from}&to=${r.to}`), api('GET', '/api/trips'), driver ? api('GET', '/api/driver/wallet') : null]);
  if (S.tab !== mode || pkey !== JSON.stringify(S.period || {})) return;
  const lo = r.from ? new Date(`${r.from}T00:00:00`).getTime() : 0, hi = r.to ? new Date(`${r.to}T23:59:59`).getTime() : Infinity;
  const trips = allTrips.filter((t) => t.createdAt >= lo && t.createdAt <= hi);
  const money = (t) => (driver ? t.driverKeeps : t.riderPaid);
  const G = S.groupBy || (S.groupBy = 'date');
  const nDone = trips.filter((t) => t.status === 'completed').length, nCan = trips.filter((t) => ['cancelled', 'rejected'].includes(t.status)).length, nLive = trips.length - nDone - nCan;
  const pct = (n) => (trips.length ? (n / trips.length) * 100 : 0);
  const hm = (m) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const labelOf = { month: (k) => new Date(`${k}-15`).toLocaleString('en-IN', { month: 'short' }), date: (k) => `${Number(k.slice(8))} ${new Date(`${k}T12:00`).toLocaleString('en-IN', { month: 'short' })}`,
    weekday: (k) => DAY[k], hour: (k) => `${k % 12 || 12}${k < 12 ? 'a' : 'p'}` };
  const chartFor = (g) => {
    const data = x.groups[g]; const byMoney = g === 'month' || g === 'date'; const val = (d) => (byMoney ? d.amount : d.trips);
    const max = Math.max(1, ...data.map(val));
    if (!data.some((d) => d.trips)) return `<div class="empty" style="padding:18px 6px">${ic('list')}<div>No completed trips in this period.</div></div>`;
    return `<div class="chart ${data.length > 9 ? 'wide' : ''}"><div class="cols" style="${data.length > 9 ? `min-width:${data.length * 40}px` : ''}">${data.map((d, i) => `<div class="colb"><span class="val">${val(d) ? (byMoney ? Math.round(val(d)).toLocaleString('en-IN') : val(d)) : ''}</span><i class="${val(d) ? '' : 'z'}" style="height:${Math.max(3, val(d) / max * 100)}%;animation-delay:${Math.min(i, 20) * 25}ms"></i><span class="lab">${labelOf[g](d.key)}</span></div>`).join('')}</div></div>
      <p class="muted small" style="margin:8px 0 0">${byMoney ? `Rupees ${driver ? 'kept' : 'spent'}` : 'Number of trips'} by ${{ month: 'month', date: 'date', weekday: 'day of the week', hour: 'hour of the day' }[g]}.</p>`;
  };
  const dash = `<div class="dash"><div class="between" style="position:relative;z-index:1"><span class="muted">${driver ? 'You kept' : 'You spent'} · ${esc(r.label)}</span></div>
      <div class="bignum" style="position:relative;z-index:1">${rs(money(x.sel))}</div>
      <div class="mini"><div><b>${x.sel.trips}</b><span>trips</span></div><div><b>${x.sel.km}</b><span>km</span></div><div><b>${rs(money(x.all))}</b><span>overall</span></div></div></div>`;
  const chartCard = `<div class="card"><div class="between"><h2 style="margin:0">When you ${driver ? 'drive' : 'ride'}</h2></div>
      <div class="seg" id="groupby" style="margin:10px 0 12px">${[['month', 'Month'], ['date', 'Date'], ['weekday', 'Day'], ['hour', 'Hour']].map(([k, l]) => `<button data-g="${k}" class="${G === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div id="chartbox">${chartFor(G)}</div></div>`;
  const breakdown = `<div class="card" data-fold="in-bookings" data-sum="${nDone} completed · ${trips.length - nDone - nLive} cancelled"><h2>Bookings</h2><div class="segmeter"><i style="width:${pct(nDone)}%;background:var(--brand)"></i><i style="width:${pct(nLive)}%;background:var(--accent)"></i><i style="width:${pct(nCan)}%;background:var(--danger)"></i></div>
      <div class="legend"><span><i style="background:var(--brand)"></i>${nDone} completed</span><span><i style="background:var(--accent)"></i>${nLive} live</span><span><i style="background:var(--danger)"></i>${nCan} cancelled or declined</span></div></div>`;
  const places = x.topPlaces.length ? `<div class="card" data-fold="in-places" data-sum="${esc(x.topPlaces[0].name)}"><h2>Top destinations</h2>${x.topPlaces.map((p) => `<div class="between" style="padding:6px 0"><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${ic('pin')} ${esc(p.name)}</span><b>${p.visits}×</b></div>`).join('')}</div>` : '';
  const downloads = `<div class="card" data-fold="in-dl" data-sum="Excel or JPG"><h2>Download</h2><p class="muted small" style="margin:0 0 10px">Your ${driver ? 'earnings' : 'rides'} for ${esc(r.label)}.</p><div class="grid2"><button class="btn ghost" id="dl-xls">${ic('file')}Excel</button><button class="btn ghost" id="dl-jpg">${ic('camera')}JPG</button></div></div>`;
  const safetyTile = `<div class="stat"><div class="v">${x.safety.average != null ? x.safety.average : '—'}<span class="muted small">/100</span></div><div class="l">Safety score${x.safety.trips ? ` · ${x.safety.overspeed} overspeed, ${x.safety.harshBrakes} harsh braking` : ''}</div></div>`;

  if (!driver) {
    app.innerHTML = `${periodBar()}${dash}${chartCard}
      <div class="grid2" style="margin-bottom:14px">
        <div class="stat good"><div class="v">${x.sel.trips}</div><div class="l">Completed trips</div></div>
        <div class="stat"><div class="v">${x.sel.km}<span class="muted small"> km</span></div><div class="l">Distance travelled</div></div>
        <div class="stat"><div class="v">${x.cancelled}</div><div class="l">Cancelled or declined</div></div>${safetyTile}</div>
      ${breakdown}${places}${downloads}<h2 style="margin:18px 2px 8px">My trips</h2><div id="trips">${tripRows(trips, false)}</div>`;
  } else if (mode === 'trips') {
    app.innerHTML = `${periodBar()}${breakdown}<div id="trips">${tripRows(trips, true)}</div>${downloads}`;
  } else {
    const h = x.hours;
    app.innerHTML = `
      <div class="card hero"><div class="between"><div><div class="muted">Wallet balance</div><div class="bignum">${rs(wallet.balance)}</div>
        <div class="muted small">${wallet.ok ? `Keep at least ${rs(wallet.min)} to get customers` : `Below ${rs(wallet.min)} — top up to get customers`}</div></div>
        <button id="topup" class="btn accent" style="position:relative;z-index:1">${ic('plus')}Top up</button></div></div>
      ${periodBar()}${dash}${chartCard}
      <div class="card" data-fold="in-road" data-open data-sum="${hm(x.hours.onlineMin)} online"><h2>Your time on the road</h2>
        <table class="fare"><tr><td>${ic('clock')} Online</td><td>${hm(h.onlineMin)}</td></tr>
          <tr><td>${ic('car')} With a passenger</td><td>${hm(h.withPassengerMin)}</td></tr>
          <tr><td>${ic('nav')} Going to pickups</td><td>${hm(h.toPickupMin)}</td></tr>
          <tr><td>${ic('search')} Waiting for customers</td><td>${hm(h.waitingForCustomersMin)}</td></tr>
          <tr class="sub"><td colspan="2">Inside your rides, ${hm(h.trafficDelayMin)} was traffic or waiting time that you were paid for.</td></tr></table>
        <p class="muted small" style="margin:10px 0 0">${ic('shield')} ${esc(h.limitNote)} Today: ${hm(x.duty.workedMin)} used, ${hm(x.duty.remainingMin)} left.</p></div>
      <div class="grid2" style="margin-bottom:14px">
        <div class="stat good"><div class="v">${rs(x.sel.driverKeeps)}</div><div class="l">You kept</div></div>
        <div class="stat"><div class="v">${x.sel.trips}</div><div class="l">Trips · ${x.sel.km} km</div></div>
        <div class="stat"><div class="v">${rs(x.sel.totalGst)}</div><div class="l">GST collected and remitted</div></div>
        <div class="stat"><div class="v">${rs(x.sel.platformFees)}</div><div class="l">Olub trip fees</div></div>
        <div class="stat"><div class="v">${rs(x.sel.km ? Math.round((x.sel.driverKeeps / x.sel.km) * 100) / 100 : 0)}</div><div class="l">Kept per km</div></div>${safetyTile}</div>
      <div class="card" data-fold="in-gst" data-sum="${esc(r.label)}"><h2>Money earned vs GST</h2><table class="fare">
        <tr><td>Customers paid you</td><td>${rs(x.sel.riderPaid)}</td></tr>
        <tr><td>GST on rides (Olub remits)</td><td>−${rs(x.sel.rideGst)}</td></tr>
        <tr><td>Olub fees <span class="muted small">incl. ${rs(x.sel.platformFeeGst)} GST</span></td><td>−${rs(x.sel.platformFees)}</td></tr>
        <tr class="sub"><td colspan="2">Includes ${rs(x.sel.tolls)} of tolls you paid on the way.</td></tr>
        <tr class="total"><td>You kept</td><td>${rs(x.sel.driverKeeps)}</td></tr></table></div>
      ${x.monthly ? `<div class="card" data-fold="in-monthly" data-sum="${rs(x.monthly.thisMonth.amount)} if the month ended today"><h2>Monthly charge</h2>
        <p class="muted small">${rs(x.monthly.max)} or ${x.monthly.sharePercent}% of what you earned in the month, whichever is less. Taken from your wallet on the 1st. Olub's total (trip fees + this) never goes above 20% of your earnings.</p>
        <table class="fare"><tr><td>Earned this month so far</td><td>${rs(x.monthly.thisMonth.earned)}</td></tr><tr><td>Trip fees already paid</td><td>${rs(x.monthly.thisMonth.tripFees)}</td></tr>
        <tr class="total"><td>Charge if the month ended today</td><td>${rs(x.monthly.thisMonth.amount)}</td></tr></table>
        ${x.monthly.past.map((m) => `<div class="between small" style="padding:4px 0"><span class="muted">${esc(m.month)} · earned ${rs(m.earned)}</span><b>${rs(m.amount)}</b></div>`).join('')}</div>` : ''}
      ${places}${downloads}
      <div class="card" data-fold="in-wallet" data-sum="${wallet.txns.length ? `${Math.min(wallet.txns.length, 100)} entries` : 'Nothing yet'}"><h2>Wallet activity</h2><div class="list">${wallet.txns.slice(0, S.walletAll ? 100 : 8).map((t) => `<div class="txn"><div><b>${WALLET_WORD[t.type] || t.type}</b>
        <div class="muted small">${when(t.ts)}${t.tripId ? ` · trip #${t.tripId}` : ''}</div></div><span class="a ${t.amount >= 0 ? 'cr' : 'dr'}">${t.amount >= 0 ? '+' : '−'}${rs(Math.abs(t.amount))}</span></div>`).join('') || '<p class="muted">No activity yet.</p>'}</div>
        ${wallet.txns.length > 8 && !S.walletAll ? `<button class="btn ghost block" id="wmore">Show all ${wallet.txns.length}</button>` : ''}</div>`;
  }
  applyScroll();
  bindPeriod();
  if ($('#topup')) $('#topup').onclick = topupSheet;
  if ($('#wmore')) $('#wmore').onclick = () => { S.walletAll = true; render(); };
  $$('#groupby button').forEach((b) => { b.onclick = () => { S.groupBy = b.dataset.g; $$('#groupby button').forEach((y) => y.classList.toggle('on', y === b)); $('#chartbox').innerHTML = chartFor(S.groupBy); }; });
  const bindTrips = () => {
    $$('[data-f]').forEach((b) => { b.onclick = () => { S.tripFilter = b.dataset.f; $('#trips').innerHTML = tripRows(trips, driver); bindTrips(); }; });
    $$('[data-trip]').forEach((b) => { b.onclick = () => tripSheet(trips.find((t) => String(t.id) === b.dataset.trip), driver); });
  };
  bindTrips();

  // ---- downloads for the selected period ----
  const stamp = (r.from && r.to ? `${r.from}_to_${r.to}` : 'all-time');
  const summaryRows = driver
    ? [['Period', r.label], ['Completed trips', x.sel.trips], ['Distance (km)', x.sel.km], ['Customers paid (Rs)', x.sel.riderPaid], ['GST on rides (Rs)', x.sel.rideGst], ['Olub trip fees (Rs)', x.sel.platformFees], ['Tolls (Rs)', x.sel.tolls], ['You kept (Rs)', x.sel.driverKeeps],
      ['Online (minutes)', x.hours.onlineMin], ['With a passenger (minutes)', x.hours.withPassengerMin], ['Going to pickups (minutes)', x.hours.toPickupMin], ['Waiting for customers (minutes)', x.hours.waitingForCustomersMin], ['Cancelled or declined', x.cancelled]]
    : [['Period', r.label], ['Completed trips', x.sel.trips], ['Distance (km)', x.sel.km], ['Spent (Rs)', x.sel.riderPaid], ['Cancelled or declined', x.cancelled], ['Spent overall (Rs)', x.all.riderPaid]];
  if ($('#dl-xls')) $('#dl-xls').onclick = run(() => saveFile(`Olub-${driver ? 'earnings' : 'rides'}-${stamp}.xlsx`, makeXlsx([
    { name: 'Summary', rows: [['Item', 'Value'], ...summaryRows] },
    { name: 'Trips', rows: [['Trip', 'Date', 'Status', 'From', 'To', 'Km', driver ? 'You kept (Rs)' : 'Paid (Rs)', ...(driver ? ['Customer paid (Rs)', 'GST (Rs)', 'Olub fee (Rs)', 'Customer'] : ['Vehicle', 'Driver']), 'Invoice'],
      ...trips.map((t) => [t.id, when(t.createdAt), TRIP_WORD[t.status], t.src.name, t.dst.name, t.distanceKm, t.final ? (driver ? t.final.driverFare : t.final.riderPays) : '',
        ...(driver ? [t.final ? t.final.riderPays : '', t.final ? t.final.taxes.rideGst : '', t.final ? t.final.platformFee : '', t.guest ? t.guest.name : t.rider.name] : [t.driver.vehicleNumber, t.driver.name]), t.invoiceNo || ''])] },
    { name: 'By month', rows: [['Month', 'Trips', 'Km', 'Rs'], ...x.groups.month.map((d) => [d.key, d.trips, d.km, d.amount])] },
    { name: 'By date', rows: [['Date', 'Trips', 'Km', 'Rs'], ...x.groups.date.map((d) => [d.key, d.trips, d.km, d.amount])] },
    { name: 'By day', rows: [['Day', 'Trips', 'Rs'], ...x.groups.weekday.map((d) => [DAY[d.key], d.trips, d.amount])] },
    { name: 'By hour', rows: [['Hour', 'Trips', 'Rs'], ...x.groups.hour.map((d) => [`${d.key}:00`, d.trips, d.amount])] },
    ...(driver ? [{ name: 'Wallet', rows: [['Date', 'Type', 'Amount (Rs)', 'Balance after (Rs)', 'Trip', 'Note'], ...wallet.txns.map((t) => [when(t.ts), WALLET_WORD[t.type] || t.type, t.amount, t.balanceAfter, t.tripId || '', t.note || ''])] }] : []),
  ])));
  if ($('#dl-jpg')) $('#dl-jpg').onclick = run(async () => saveFile(`Olub-${driver ? 'earnings' : 'rides'}-${stamp}.jpg`, await cardImage({
    title: driver ? 'My Olub earnings' : 'My Olub rides', subtitle: `${S.me.name}  |  ${S.me.publicId}`, big: `Rs ${Math.round(money(x.sel)).toLocaleString('en-IN')}`, bigLabel: `${driver ? 'Kept' : 'Spent'}, ${r.label}`,
    rows: [...summaryRows.slice(1).map(([k, v]) => [k, typeof v === 'number' ? v.toLocaleString('en-IN') : String(v)]), ['', '', 'line'], ...x.topPlaces.slice(0, 3).map((p) => [p.name, `${p.visits} trips`, 'muted'])],
    footer: `Made on ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}.`,
  })));
}
const WALLET_WORD = { topup: 'Top-up', platform_fee: 'Olub fee', ride_gst: 'Ride GST', verify_reward: 'Reward from Olub', adjustment: 'Adjustment', cancel_fee: 'Cancellation fee', cancel_fee_passthrough: "Customer's cancellation fee", monthly_fee: 'Monthly charge' };

// ---------------- safety (customers) ----------------
function renderSafety(app) {
  const t = S.me.trusted;
  const feat = (icon, title, text) => `<div class="feat"><div class="n">${ic(icon)}</div><div><b>${title}</b><div class="muted small">${text}</div></div></div>`;
  app.innerHTML = `
    <div class="card hero"><h1 style="margin:0">Your safety</h1><p class="muted" style="margin:6px 0 0">Every Olub ride is tracked, and someone you trust can follow it.</p></div>
    <div class="card"><div class="between"><h2 style="margin:0">Trusted contact</h2><button class="btn small ghost" id="s-edit">${t ? 'Change' : 'Add'}</button></div>
      ${t ? `<p style="margin:8px 0 0"><b>${esc(t.name)}</b>${t.relation ? ` · ${esc(t.relation)}` : ''}<br><span class="muted">${esc(t.phone)}</span></p>` : '<p class="muted" style="margin:8px 0 0">Required before your first ride.</p>'}</div>
    <div class="card" data-fold="sf-every" data-open data-sum="What Olub does to keep you safe"><h2>On every ride</h2>
      ${feat('share', 'Live tracking link', `${t ? esc(t.name) : 'Your contact'} can watch the cab on a map, with its DIGIPIN, without installing anything.`)}
      ${feat('clock', 'Late-ride alert', `If you are ${S.cfg.overdue.warn} minutes late your contact is told; at ${S.cfg.overdue.alert} minutes they are asked to check on you.`)}
      ${feat('nav', 'Off-route alarm', 'If the cab leaves the expected road, you and your contact are alerted.')}
      ${feat('alert', 'SOS', 'One tap sends your location and the cab number to your contact, with a button to call 112.')}
      ${feat('heart', 'Fit-to-drive check', 'Your driver must confirm they are healthy and have not had alcohol or drugs before the ride can start.')}
      ${feat('lock', 'Private numbers', 'Calls and chat go through Olub. The driver never sees your mobile number.')}
      ${feat('shield', 'Verified drivers', 'Licence, RC, permit, insurance and ID are checked, and you see the driver\'s photo, rating and number plate first.')}</div>
    <a class="btn danger block" href="tel:112">${ic('phone')}Call 112 (emergency)</a>
    ${S.trip && S.trip.trackPath ? `<button class="btn ghost block" id="s-share">${ic('share')}Share my current ride</button>` : ''}`;
  $('#s-edit').onclick = trustedSheet;
  if ($('#s-share')) $('#s-share').onclick = run(() => shareText(`Track my Olub ride live (${S.trip.driver.vehicleNumber}): ${S.base || location.origin}${S.trip.trackPath}`));
}

function topupSheet() {
  const sh = sheet('Top up wallet', `<p class="muted">Olub takes its fee (${rs(S.cfg.platformFee)}, or ${rs(S.cfg.platformFeeLong)} over ${S.cfg.platformFeeLongKm} km) and the ride GST from this wallet when a trip ends. Keep at least ${rs(S.cfg.wallet.min)} to get customers.</p>
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
    <div class="idcard">${me.photo ? `<img src="${me.photo}" alt="" class="avatar" style="float:right;position:relative;z-index:1;width:72px;height:72px;border:2px solid #ffffff55">` : ''}<div class="muted small" style="color:#ffffffaa">${{ rider: 'OLUB CUSTOMER', driver: 'OLUB DRIVER', admin: 'OLUB ADMIN' }[me.role]}</div>
      <div class="pid">${esc(me.publicId)}</div><div style="font-size:20px;font-weight:800;margin-top:10px">${esc(me.name)}</div>
      <div class="muted small" style="color:#ffffffcc">${[me.age && `${me.age} yrs`, cap(me.gender), me.rating.count && `${ic('star', 'fill')} ${me.rating.average.toFixed(1)}`].filter(Boolean).join(' · ')}</div>
      <div class="chips" style="margin-top:12px;position:relative;z-index:1"><span class="chip">${ic('check')}Mobile confirmed</span>
        <span class="chip ${me.emailVerified ? '' : 'warn'}">${ic(me.emailVerified ? 'check' : 'clock')}Email ${me.emailVerified ? 'confirmed' : 'not confirmed'}</span></div></div>
    ${todoCard()}
    <div class="card menu">
      <button data-open="personal">${ic('id')}<span class="grow">Personal details<div class="muted small">${esc([niceDate(me.dob), cap(me.gender)].filter(Boolean).join(' · ') || 'Photo, date of birth, sex')}</div></span>${ic('right')}</button>
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
  const fields = S.cfg.dsrCorrectionFields;
  const sh = sheet('Privacy & my data', `<p class="muted">You can get a copy of your data, correct it, delete your account, withdraw consent or complain. We answer within ${S.cfg.dsrPublicDays - 2}–${S.cfg.dsrPublicDays} days.</p>
    ${S.me.emailVerified ? '' : '<div class="card warn">Confirm your email first — requests are accepted only from verified accounts.</div>'}
    <label class="f">What do you need?</label><select id="dt">${Object.entries(S.cfg.dsrTypes).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select>
    <div id="corr" hidden><label class="f">What needs correcting?</label><select id="df">${Object.entries(fields).map(([k, f]) => `<option value="${k}">${esc(f.label)}</option>`).join('')}</select><div id="dv"></div></div>
    <div id="ddwrap"><label class="f" id="ddl">Details (optional)</label><textarea id="dd" maxlength="1000"></textarea></div>
    <button id="dgo" class="btn block">Send request</button>
    <h3>My requests</h3><div class="list">${list.map((r) => `<div><div class="between"><b>${esc(r.typeLabel)}</b><span class="chip ${r.status === 'completed' ? '' : r.status === 'received' ? 'warn' : 'grey'}">${esc(r.status)}</span></div>
      <div class="muted small">${esc(r.publicId)} · ${when(r.createdAt)}${r.status === 'received' ? ` · answer by ${new Date(r.answerBy).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}` : ''}</div>
      ${r.response ? `<p class="small" style="margin:6px 0 0">${esc(r.response)}</p>` : ''}
      <div class="row" style="margin-top:6px">${r.hasExport ? `<button class="btn small ghost" data-dl="${r.id}">${ic('download')}Download my data</button>` : ''}${r.status === 'received' ? `<button class="btn small ghost" data-wd="${r.id}">Cancel request</button>` : ''}</div></div>`).join('') || '<p class="muted">No requests yet.</p>'}</div>`);
  const me = S.me; const t = me.trusted || {};
  // Each kind of correction asks only for what it needs.
  const inputs = {
    name: () => `<label class="f">Correct name</label><input id="cv" value="${esc(me.name || '')}">`,
    dob: () => `<label class="f">Correct date of birth</label><input id="cv" type="date" value="${esc(me.dob || '')}" max="${new Date().toISOString().slice(0, 10)}">`,
    gender: () => `<label class="f">Correct sex</label><select id="cv">${['male', 'female', 'other'].map((x) => `<option value="${x}" ${me.gender === x ? 'selected' : ''}>${x[0].toUpperCase() + x.slice(1)}</option>`).join('')}</select>`,
    trusted: () => `<label class="f">Trusted contact's name</label><input id="cv1" value="${esc(t.name || '')}"><label class="f">Their mobile number</label><input id="cv2" inputmode="numeric" maxlength="14" value="${esc(t.phone || '')}">`,
  };
  const sync = () => {
    const corr = $('#dt').value === 'correction'; const f = $('#df').value; const mode = fields[f].mode;
    $('#corr').hidden = !corr;
    $('#dv').innerHTML = !corr ? '' : mode === 'auto' ? `${inputs[f]()}<p class="muted small" style="margin-top:8px">${ic('bolt')} Corrected straight away.</p>`
      : mode === 'guide' ? `<p class="muted small" style="margin-top:8px">${ic('bolt')} We will tell you right away where to change this — it needs a quick check.</p>`
      : `<p class="muted small" style="margin-top:8px">${ic('clock')} Our team will check this and answer you.</p>`;
    $('#ddwrap').hidden = corr && mode !== 'manual';
    $('#ddl').textContent = corr ? 'What is wrong, and what should it be?' : 'Details (optional)';
  };
  $('#dt', sh.el).onchange = sync; $('#df', sh.el).onchange = sync; sync();
  $('#dgo', sh.el).onclick = run(async () => {
    const body = { type: $('#dt').value, details: $('#dd').value };
    if (body.type === 'correction') {
      body.field = $('#df').value;
      if (fields[body.field].mode === 'auto') body.value = body.field === 'trusted' ? { name: $('#cv1').value, phone: $('#cv2').value } : $('#cv').value;
    }
    const r = await api('POST', '/api/privacy/requests', body);
    if (r.status === 'completed') S.me = await api('GET', '/api/me');
    sh.close(); render(); toast(r.status === 'completed' ? (r.response || 'Done') : `Request ${r.publicId} received`); privacySheet();
  });
  $$('[data-wd]', sh.el).forEach((b) => { b.onclick = run(async () => { await api('POST', `/api/privacy/requests/${b.dataset.wd}/withdraw`); sh.close(); privacySheet(); }); });
  $$('[data-dl]', sh.el).forEach((b) => { b.onclick = run(async () => {
    const data = await api('GET', `/api/privacy/requests/${b.dataset.dl}/export`);
    const text = JSON.stringify(data, null, 2);
    if (Native && Native.saveText) return Native.saveText('olub-my-data.json', text);
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = 'olub-my-data.json'; a.click();
  }); });
}
