'use strict';
/* Olub web app — rider, driver and admin in one page. No build step. */

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rs = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

const S = {
  token: safeGet('olub.token'),
  me: null, cfg: null, places: [], tab: null,
  trip: null, requests: [], quote: null, booking: null, messages: [],
  es: null,
};

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } }

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', ...(S.token && { authorization: `Bearer ${S.token}` }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && S.token) { logout(); }
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = `toast${err ? ' err' : ''}`; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}
const run = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

// Downscale photos before upload so documents stay small.
function readImage(file, max = 1280) {
  return new Promise((resolve, reject) => {
    if (file.type === 'application/pdf') {
      const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file); return;
    }
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.72));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function here() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Location not available on this device'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => reject(new Error('Allow location access to use your current location')),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  });
}

// ---------------- boot ----------------
async function boot() {
  S.cfg = await api('GET', '/api/config');
  S.places = await api('GET', '/api/places');
  if (S.token) {
    try { S.me = await api('GET', '/api/me'); } catch { S.token = null; safeSet('olub.token', null); }
  }
  if (S.me) { connect(); await refreshTrip(); }
  render();
}

function logout() {
  S.token = null; S.me = null; S.trip = null; S.es?.close(); safeSet('olub.token', null); render();
}

function connect() {
  S.es?.close();
  S.es = new EventSource(`/api/events?token=${encodeURIComponent(S.token)}`);
  S.es.addEventListener('trip', run(async () => { await refreshTrip(); render(); }));
  S.es.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (S.trip && m.tripId === S.trip.id) { S.messages.push(m); renderChat(); toast(`💬 ${m.body}`); }
  });
  S.es.addEventListener('call', (e) => Call.onSignal(JSON.parse(e.data)));
}

async function refreshTrip() {
  const prevId = S.trip?.id;
  const cur = await api('GET', '/api/trips/current');
  S.trip = cur.trip; S.requests = cur.requests;
  if (prevId && !S.trip) {
    const old = await api('GET', `/api/trips/${prevId}`).catch(() => null);
    if (old?.status === 'rejected') toast('Driver declined the ride', true);
    if (old?.status === 'cancelled') toast('Trip was cancelled', true);
    // Keep the paid receipt on screen until the user taps "done".
    if (old?.status === 'completed' && old.paidAt) S.trip = old;
  }
  if (S.trip && S.trip.id !== prevId) S.messages = await api('GET', `/api/trips/${S.trip.id}/messages`);
  if (S.me?.role === 'driver') S.me = await api('GET', '/api/me');
}

function render() {
  const who = $('#who');
  who.innerHTML = S.me ? `<span>${esc(S.me.name || S.me.phone)} · ${esc(S.me.role)}</span><button id="logout">Logout</button>` : '';
  if (S.me) $('#logout').onclick = run(async () => { await api('POST', '/api/auth/logout').catch(() => {}); logout(); });
  const app = $('#app');
  if (!S.me) return renderLogin(app);
  if (S.me.role === 'rider') return renderRider(app);
  if (S.me.role === 'driver') return renderDriver(app);
  return renderAdmin(app);
}

function tabs(list, def) {
  if (!list.some(([k]) => k === S.tab)) S.tab = def;
  return `<div class="tabs">${list.map(([k, l]) => `<button data-tab="${k}" class="${S.tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>`;
}
function bindTabs(app) {
  app.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => { S.tab = b.dataset.tab; render(); }; });
}

// ---------------- login ----------------
function renderLogin(app) {
  app.innerHTML = `
    <div class="card hero">
      <h1>Book the cab in front of you</h1>
      <p class="muted">See an empty cab or auto waiting? Type its number, see a fair price, and go.
      Olub keeps just <b>${rs(S.cfg.platformFee)}</b> per trip — everything else goes to the driver.</p>
    </div>
    <div class="card">
      <label>Mobile number</label>
      <input id="phone" inputmode="numeric" maxlength="14" placeholder="98765 43210" autocomplete="tel">
      <div id="otp-step" hidden>
        <label>OTP</label>
        <input id="code" inputmode="numeric" maxlength="6" placeholder="6-digit code" autocomplete="one-time-code">
        <div id="new-user" hidden>
          <label>Your name</label><input id="name" placeholder="Name">
          <label>I am a</label>
          <div class="tabs" id="rolepick">
            <button data-r="rider" class="on">Rider</button><button data-r="driver">Driver</button>
          </div>
        </div>
        <p id="devcode" class="muted"></p>
      </div>
      <button id="go" class="btn block">Get OTP</button>
    </div>`;
  let step = 'phone', roleSel = 'rider';
  app.querySelectorAll('#rolepick button').forEach((b) => {
    b.onclick = () => { roleSel = b.dataset.r; app.querySelectorAll('#rolepick button').forEach((x) => x.classList.toggle('on', x === b)); };
  });
  $('#go').onclick = run(async () => {
    const phone = $('#phone').value;
    if (step === 'phone') {
      const r = await api('POST', '/api/auth/request-otp', { phone });
      $('#otp-step').hidden = false; $('#new-user').hidden = !r.isNewUser;
      if (r.devCode) $('#devcode').textContent = `Dev mode OTP: ${r.devCode}`;
      $('#go').textContent = 'Verify & continue'; step = 'otp'; $('#code').focus();
    } else {
      const r = await api('POST', '/api/auth/verify-otp', { phone, code: $('#code').value, name: $('#name').value, role: roleSel });
      S.token = r.token; safeSet('olub.token', r.token);
      S.me = await api('GET', '/api/me'); connect(); await refreshTrip();
      S.tab = null; render();
    }
  });
}

// ---------------- shared bits ----------------
function placeOptions(sel) {
  return `<option value="">Select…</option><option value="geo"${sel === 'geo' ? ' selected' : ''}>📍 My current location</option>` +
    S.places.map((p) => `<option value="${p.id}"${String(sel) === String(p.id) ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
}

function driverCard(d) {
  const img = d.photos?.selfie ? `<img src="${d.photos.selfie}" alt="">` : '<div class="ph"></div>';
  const badge = d.status === 'verified'
    ? `<span class="badge">✓ Verified${d.verifiedVia === 'customer' ? ' by rider' : ''}</span>`
    : '<span class="badge warn">Awaiting verification</span>';
  return `<div class="driver">${img}<div>
    <div><b>${esc(d.name || 'Driver')}</b> ${badge}</div>
    <div><span class="plate">${esc(d.vehicleNumber)}</span> · ${esc(d.vehicleLabel)} ${esc(d.vehicleModel || '')}</div>
    <div class="muted">${esc(d.experience)} · ${d.completedTrips} Olub trips · condition: ${esc(d.condition)}</div>
  </div></div>`;
}

function fareTable(f, title = 'Fare', isFinal = false) {
  const b = f.breakdown;
  const rideFare = b.rideFare;
  return `<h3>${title}</h3><table class="fare">
    <tr><td>Ride (${f.distanceKm} km)</td><td>${rs(rideFare)}</td></tr>
    <tr class="sub"><td colspan="2">Base ${rs(b.base)} + ${rs(b.distanceCharge)} distance · condition ×${b.conditionMultiplier}
      · road ×${b.roadMultiplier} · ${esc(b.experienceLabel)} ×${b.experienceMultiplier}${b.minFareApplied ? ' · minimum fare' : ''}</td></tr>
    <tr><td>Waiting (${b.waitMinutes} min${isFinal ? '' : ' est.'})</td><td>${rs(b.waitCharge)}</td></tr>
    ${b.tolls.map((t) => `<tr><td>Toll: ${esc(t.name)}${t.status === 'verified' ? '' : ' <span class="muted">(default)</span>'}</td><td>${rs(t.amount)}</td></tr>`).join('')}
    <tr class="sub"><td>Goes 100% to driver</td><td>${rs(f.driverFare)}</td></tr>
    <tr><td>Olub fee${f.calamity ? ' <span class="badge warn">calamity relief</span>' : ''}</td><td>${rs(f.platformFee)}</td></tr>
    ${f.discount ? `<tr><td>Driver verification reward</td><td>−${rs(f.discount)}</td></tr>` : ''}
    <tr class="total"><td>You pay</td><td>${rs(f.riderPays)}</td></tr>
  </table>`;
}

const STEPS = ['requested', 'accepted', 'started', 'completed'];
function steps(status) {
  const i = STEPS.indexOf(status);
  return `<div class="steps">${STEPS.map((_, k) => `<span class="${k <= i ? 'on' : ''}"></span>`).join('')}</div>`;
}

function commsBlock(t) {
  if (!['accepted', 'started', 'completed'].includes(t.status)) return '';
  return `<div class="card">
    <div class="switch"><h2>Talk to ${t.you === 'rider' ? 'driver' : 'rider'}</h2>
      <button id="callbtn" class="btn small">📞 Call</button></div>
    <p class="muted">Calls and chat go through Olub — your mobile number is never shared.</p>
    <div class="chat" id="chat"></div>
    <div class="row"><input id="msg" placeholder="Message…" maxlength="500"><button id="send" class="btn small" style="flex:0">Send</button></div>
  </div>`;
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
  $('#msg').onkeydown = (e) => { if (e.key === 'Enter') send(); };
  $('#callbtn').onclick = run(() => Call.start(t.id, t.you === 'rider' ? t.driver.name : t.rider.name));
}
function renderChat() {
  const c = $('#chat'); if (!c) return;
  c.innerHTML = S.messages.map((m) => `<div class="msg${m.mine ? ' mine' : ''}">${esc(m.body)}</div>`).join('') ||
    '<div class="muted">No messages yet.</div>';
  c.scrollTop = c.scrollHeight;
}

// ---------------- rider ----------------
function renderRider(app) {
  if (S.trip) return renderRiderTrip(app, S.trip);
  app.innerHTML = tabs([['book', 'Book'], ['history', 'My trips']], 'book') + '<div id="pane"></div>';
  bindTabs(app);
  if (S.tab === 'history') return renderHistory($('#pane'));
  const bk = S.booking || {};
  $('#pane').innerHTML = `
    <div class="card">
      <h2>Which cab is in front of you?</h2>
      <label>Driver's mobile number or vehicle number</label>
      <input id="drv" placeholder="KA 01 AB 1234  or  98765 43210" value="${esc(bk.driver || '')}">
      <label>Pickup</label><select id="src">${placeOptions(bk.srcSel)}</select>
      <label>Drop</label><select id="dst">${placeOptions(bk.dstSel)}</select>
      <div class="row">
        <div><label>Road</label><select id="road">${S.cfg.roads.map((r) => `<option${bk.road === r ? ' selected' : ''}>${r}</option>`).join('')}</select></div>
        <div><label>Traffic</label><select id="traffic">${S.cfg.traffic.map((r) => `<option${bk.traffic === r ? ' selected' : ''}>${r}</option>`).join('')}</select></div>
      </div>
      <button id="getfare" class="btn block">See fare</button>
    </div>
    <div id="quote"></div>`;
  if (S.quote) showQuote();
  $('#getfare').onclick = run(async () => {
    const pick = async (v) => {
      if (v === 'geo') return { ...(await here()), name: 'My location' };
      if (!v) throw new Error('Choose pickup and drop');
      return { placeId: Number(v) };
    };
    const srcSel = $('#src').value, dstSel = $('#dst').value;
    S.booking = { driver: $('#drv').value, srcSel, dstSel, road: $('#road').value, traffic: $('#traffic').value };
    S.booking.body = { driver: S.booking.driver, src: await pick(srcSel), dst: await pick(dstSel), road: S.booking.road, traffic: S.booking.traffic };
    S.quote = await api('POST', '/api/trips/quote', S.booking.body);
    showQuote();
  });
}

function showQuote() {
  const q = S.quote;
  $('#quote').innerHTML = `<div class="card">
    ${driverCard(q.driver)}
    <p class="muted">${esc(q.src.name)} → ${esc(q.dst.name)}</p>
    ${q.calamity ? `<p class="badge warn">${esc(q.calamity.reason)} — Olub fee reduced to ${rs(S.cfg.platformFeeCalamity)}</p>` : ''}
    ${fareTable(q.quote, 'Estimated fare')}
    ${q.tolls.some((t) => t.status !== 'verified') ? `<p class="muted">Unverified tolls use the ${esc(q.state)} default until ${S.cfg.tollConfirmationsRequired} more drivers confirm the amount.</p>` : ''}
    ${q.verifyOffer ? `<p class="badge">Get ${rs(q.verifyOffer)} off: this driver is new — verify their documents during the ride.</p>` : ''}
    <button id="request" class="btn block">Request this cab</button>
  </div>`;
  $('#request').onclick = run(async () => {
    await api('POST', '/api/trips', S.booking.body);
    S.quote = null; await refreshTrip(); render();
  });
}

function renderRiderTrip(app, t) {
  const f = t.final || t.quote;
  const statusText = {
    requested: 'Waiting for the driver to accept…',
    accepted: 'Driver accepted! Share the OTP when you get in.',
    started: 'Trip in progress. Have a safe ride!',
    completed: t.paidAt ? 'Paid. Thanks for riding with Olub!' : 'Trip complete — please pay the driver.',
  }[t.status];
  app.innerHTML = `
    <div class="card">
      ${steps(t.status)}<h2>${esc(statusText)}</h2>
      ${driverCard(t.driver)}
      <p class="muted">${esc(t.src.name)} → ${esc(t.dst.name)}</p>
      ${t.otp ? `<h3>Your trip OTP</h3><div class="otp">${esc(t.otp)}</div>
        <p class="muted" style="text-align:center">Tell this to the driver only after you are inside the cab.</p>` : ''}
      ${['requested', 'accepted'].includes(t.status) ? '<button id="cancel" class="btn ghost block">Cancel trip</button>' : ''}
    </div>
    ${t.canVerifyDriver ? `<div class="card hero">
      <h2>Verify your driver, get ${rs(S.cfg.verifyDiscount)} off</h2>
      <p class="muted">This driver is new on Olub. Check in person:</p>
      ${t.driver.photos.vehicle ? `<img src="${t.driver.photos.vehicle}" alt="Vehicle" style="width:100%;border-radius:10px">` : ''}
      <label><input type="checkbox" id="c1">Driver's face matches the photo above</label>
      <label><input type="checkbox" id="c2">Number plate reads <b>${esc(t.driver.vehicleNumber)}</b></label>
      <label><input type="checkbox" id="c3">Vehicle is a ${esc(t.driver.vehicleLabel)} ${esc(t.driver.vehicleModel || '')} as shown</label>
      <button id="verify" class="btn block">Confirm & verify driver</button>
    </div>` : ''}
    <div class="card">${fareTable(f, t.final ? 'Final fare' : 'Estimated fare', !!t.final)}
      ${t.status === 'completed' && !t.paidAt ? `<p class="muted">Pay the driver directly (cash or UPI), then confirm here.</p>
        <div class="row"><button id="paycash" class="btn">Paid cash</button><button id="payupi" class="btn">Paid by UPI</button></div>` : ''}
      ${t.paidAt ? '<button id="done" class="btn block">Book another ride</button>' : ''}
    </div>
    ${commsBlock(t)}`;
  $('#cancel') && ($('#cancel').onclick = run(async () => { await api('POST', `/api/trips/${t.id}/cancel`); S.trip = null; render(); }));
  $('#verify') && ($('#verify').onclick = run(async () => {
    S.trip = await api('POST', `/api/trips/${t.id}/verify-driver`, { checks: { face: $('#c1').checked, vehicleNumber: $('#c2').checked, vehicleMatches: $('#c3').checked } });
    toast(`Thanks! ${rs(S.cfg.verifyDiscount)} discount applied.`); render();
  }));
  const pay = (method) => run(async () => { S.trip = await api('POST', `/api/trips/${t.id}/pay`, { method }); render(); });
  $('#paycash') && ($('#paycash').onclick = pay('cash'));
  $('#payupi') && ($('#payupi').onclick = pay('upi'));
  $('#done') && ($('#done').onclick = () => { S.trip = null; render(); });
  bindComms(t);
}

async function renderHistory(pane) {
  pane.innerHTML = '<div class="card muted">Loading…</div>';
  const trips = await api('GET', '/api/trips');
  pane.innerHTML = `<div class="card list">${trips.map((t) => `<div>
    <div class="switch"><b>${esc(t.src.name)} → ${esc(t.dst.name)}</b><span class="badge${t.status === 'completed' ? '' : ' warn'}">${esc(t.status)}</span></div>
    <div class="muted">${new Date(t.createdAt).toLocaleString()} · ${esc(t.you === 'rider' ? t.driver.vehicleNumber : t.rider.name)}
      ${t.final ? ` · ${rs(t.you === 'rider' ? t.final.riderPays : t.final.driverFare)}` : ''}</div>
  </div>`).join('') || '<div class="muted">No trips yet.</div>'}</div>`;
}

// ---------------- driver ----------------
function renderDriver(app) {
  const d = S.me.driver;
  if (S.trip && S.trip.status !== 'requested') return renderDriverTrip(app, S.trip);
  app.innerHTML = tabs([['home', 'Home'], ['profile', 'Vehicle & KYC'], ['earnings', 'Earnings'], ['history', 'Trips']],
    d.status === 'incomplete' ? 'profile' : 'home') + '<div id="pane"></div>';
  bindTabs(app);
  const pane = $('#pane');
  if (S.tab === 'profile') return renderProfile(pane, d);
  if (S.tab === 'earnings') return renderEarnings(pane);
  if (S.tab === 'history') return renderHistory(pane);

  pane.innerHTML = `
    <div class="card">
      <div class="switch"><h2>${d.online ? '🟢 You are online' : '⚪ You are offline'}</h2>
        <button id="toggle" class="btn small">${d.online ? 'Go offline' : 'Go online'}</button></div>
      <p class="muted">Riders standing near you can book you by typing <span class="plate">${esc(d.vehicleNumber || '—')}</span> or your mobile number.
        Olub takes only ${rs(S.cfg.platformFee)} per trip.</p>
      ${d.status === 'submitted' ? `<p class="badge warn">Awaiting verification — your first rider can verify you in person (they get ${rs(S.cfg.verifyDiscount)} off, paid by Olub).</p>` : ''}
      ${d.status === 'rejected' ? '<p class="badge warn">Documents rejected — please re-upload.</p>' : ''}
    </div>
    <div class="card"><h2>Ride requests</h2>
      ${S.requests.map((t) => `<div class="card">
        <b>${esc(t.rider.name)}</b> · ${esc(t.src.name)} → ${esc(t.dst.name)}
        ${fareTable(t.quote, 'You earn ' + rs(t.quote.driverFare))}
        <div class="row"><button class="btn" data-acc="${t.id}">Accept</button><button class="btn ghost" data-rej="${t.id}">Decline</button></div>
      </div>`).join('') || `<p class="muted">${d.online ? 'Waiting for riders…' : 'Go online to receive requests.'}</p>`}
    </div>`;
  $('#toggle').onclick = run(async () => { await api('POST', '/api/driver/online', { online: !d.online }); S.me = await api('GET', '/api/me'); render(); });
  pane.querySelectorAll('[data-acc]').forEach((b) => { b.onclick = run(async () => { await api('POST', `/api/trips/${b.dataset.acc}/accept`); await refreshTrip(); render(); }); });
  pane.querySelectorAll('[data-rej]').forEach((b) => { b.onclick = run(async () => { await api('POST', `/api/trips/${b.dataset.rej}/reject`); await refreshTrip(); render(); }); });
}

function renderProfile(pane, d) {
  const docs = d.docs || {};
  const pending = {};
  const docLabel = { selfie: 'Your photo', vehicle: 'Vehicle with plate', license: 'Driving licence', rc: 'RC', kyc: 'Aadhaar / ID (KYC)' };
  pane.innerHTML = `<div class="card">
    <h2>Vehicle & documents</h2>
    <p class="muted">Status: <b>${esc(d.status)}</b>. Your KYC ID is only seen by Olub, never by riders.</p>
    <label>Your name</label><input id="p-name" value="${esc(S.me.name || '')}">
    <label>Vehicle number</label><input id="p-vn" value="${esc(d.vehicleNumber || '')}" placeholder="KA01AB1234">
    <div class="row">
      <div><label>Type</label><select id="p-type">${Object.entries(S.cfg.vehicles).map(([k, v]) => `<option value="${k}"${d.vehicleType === k ? ' selected' : ''}>${v.label}</option>`).join('')}</select></div>
      <div><label>Condition</label><select id="p-cond">${S.cfg.conditions.map((c) => `<option${d.condition === c ? ' selected' : ''}>${c}</option>`).join('')}</select></div>
    </div>
    <label>Model</label><input id="p-model" value="${esc(d.vehicleModel || '')}" placeholder="e.g. Swift Dzire">
    <label>State</label><input id="p-state" value="${esc(d.state || '')}" placeholder="KA" maxlength="4">
    <label>Driving licence no.</label><input id="p-dl" value="${esc(d.licenseNo || '')}">
    <label>RC no.</label><input id="p-rc" value="${esc(d.rcNo || '')}">
    <label>Aadhaar / ID no.</label><input id="p-kyc" value="${esc(d.kycIdNo || '')}">
    <h3>Upload</h3>
    <div class="docgrid">${Object.entries(docLabel).map(([k, l]) => `<label class="${docs[k] ? 'done' : ''}" id="l-${k}">
      ${docs[k] ? '✓ ' : '+ '}${l}<input type="file" accept="image/*,application/pdf" data-doc="${k}"></label>`).join('')}</div>
    <button id="save" class="btn block">Save & submit</button>
  </div>`;
  pane.querySelectorAll('[data-doc]').forEach((inp) => {
    inp.onchange = run(async () => {
      const f = inp.files[0]; if (!f) return;
      pending[inp.dataset.doc] = await readImage(f);
      const l = $(`#l-${inp.dataset.doc}`); l.classList.add('done'); l.firstChild.textContent = `✓ ${docLabel[inp.dataset.doc]}`;
    });
  });
  $('#save').onclick = run(async () => {
    const r = await api('PUT', '/api/driver/profile', {
      name: $('#p-name').value, vehicleNumber: $('#p-vn').value, vehicleType: $('#p-type').value, condition: $('#p-cond').value,
      vehicleModel: $('#p-model').value, state: $('#p-state').value, licenseNo: $('#p-dl').value, rcNo: $('#p-rc').value,
      kycIdNo: $('#p-kyc').value, docs: pending,
    });
    S.me = await api('GET', '/api/me');
    toast(r.missing.length ? `Saved. Still needed: ${r.missing.join(', ')}` : 'Submitted! You can go online now.');
    if (!r.missing.length) S.tab = 'home';
    render();
  });
}

async function renderEarnings(pane) {
  const e = await api('GET', '/api/driver/earnings');
  pane.innerHTML = `<div class="card"><h2>Earnings</h2><table class="fare">
    <tr><td>Paid trips</td><td>${e.trips}</td></tr>
    <tr><td>You earned (incl. tolls)</td><td>${rs(e.earned)}</td></tr>
    <tr class="sub"><td>of which tolls</td><td>${rs(e.tollsCollected)}</td></tr>
    <tr class="total"><td>${e.owedToOlub >= 0 ? 'Olub fees due' : 'Olub owes you'}</td><td>${rs(Math.abs(e.owedToOlub))}</td></tr>
  </table>
  ${S.cfg.subscriptionEnabled ? `<p class="muted">Monthly subscription ${rs(S.cfg.subscriptionMonthly)}</p>` : '<p class="muted">No monthly subscription during launch.</p>'}</div>`;
}

function renderDriverTrip(app, t) {
  const f = t.final || t.quote;
  app.innerHTML = `
    <div class="card">
      ${steps(t.status)}
      <h2>${{ accepted: 'Pick up your rider', started: 'Trip in progress', completed: t.paidAt ? 'Paid ✓' : 'Collect payment' }[t.status]}</h2>
      <p><b>${esc(t.rider.name)}</b> · ${esc(t.src.name)} → ${esc(t.dst.name)}</p>
      ${t.status === 'accepted' ? `<label>Rider's 4-digit OTP</label><input id="otp" inputmode="numeric" maxlength="4" class="otp">
        <button id="start" class="btn block">Start trip</button><button id="cancel" class="btn ghost block">Cancel</button>` : ''}
    </div>
    ${t.status === 'started' ? `<div class="card" id="tolls">
      <h2>Tolls on this trip</h2>
      ${t.tolls.map((x) => `<div class="switch"><span>${esc(x.name)} · ${rs(x.amount)} <span class="muted">(${esc(x.amountSource)})</span></span>
        <button class="btn small ghost" data-rmtoll="${x.id}">Not crossed</button></div>
        ${x.status !== 'verified' && !x.reportedByMe ? `<div class="card hero">
          <b>Help verify this toll</b> <span class="muted">(${x.reports}/${x.reportsNeeded} reports)</span>
          <div class="row"><input type="number" placeholder="Amount paid ₹" data-tamt="${x.id}">
          <label class="btn small ghost" style="flex:0;margin:0">📷<input type="file" accept="image/*" capture="environment" data-tphoto="${x.id}" hidden></label>
          <button class="btn small" data-tsend="${x.id}" style="flex:0">Send</button></div></div>` : ''}`).join('') || '<p class="muted">No tolls detected on this route.</p>'}
      <h3>Crossed a toll that is not listed?</h3>
      <input id="tname" placeholder="Toll plaza name">
      <div class="row"><input id="tamt" type="number" placeholder="Amount paid ₹">
        <label class="btn small ghost" style="flex:0;margin:0">📷 Receipt<input id="tphoto" type="file" accept="image/*" capture="environment" hidden></label></div>
      <button id="addtoll" class="btn ghost block">Add toll (uses your location)</button>
      <p class="muted">New tolls are charged at the ${esc(t.state)} default (${rs(S.cfg.stateDefaultToll[t.state] ?? S.cfg.defaultToll)}) until ${S.cfg.tollConfirmationsRequired} more drivers confirm the amount.</p>
    </div>
    <div class="card"><label>Waiting time (minutes, traffic/stops)</label><input id="wait" type="number" min="0" value="${Math.round(t.quote.breakdown.waitMinutes)}">
      <button id="complete" class="btn block">End trip</button></div>` : ''}
    <div class="card">${fareTable(f, t.final ? 'Final fare' : 'Estimated fare', !!t.final)}
      <p class="muted">You keep ${rs(f.driverFare)}. ${f.discount ? `Olub credits you the rider's ${rs(f.discount)} verification reward.` : ''}</p>
      ${t.status === 'completed' && !t.paidAt ? '<button id="gotcash" class="btn block">Received payment</button>' : ''}
      ${t.paidAt ? '<button id="done" class="btn block">Back to home</button>' : ''}
    </div>
    ${commsBlock(t)}`;

  $('#start') && ($('#start').onclick = run(async () => { S.trip = await api('POST', `/api/trips/${t.id}/start`, { otp: $('#otp').value }); render(); }));
  $('#cancel') && ($('#cancel').onclick = run(async () => { await api('POST', `/api/trips/${t.id}/cancel`); await refreshTrip(); render(); }));
  $('#complete') && ($('#complete').onclick = run(async () => { S.trip = await api('POST', `/api/trips/${t.id}/complete`, { waitMinutes: Number($('#wait').value) }); render(); }));
  $('#gotcash') && ($('#gotcash').onclick = run(async () => { S.trip = await api('POST', `/api/trips/${t.id}/pay`, { method: 'cash' }); render(); }));
  $('#done') && ($('#done').onclick = run(async () => { S.trip = null; await refreshTrip(); render(); }));

  const photos = {};
  app.querySelectorAll('[data-tphoto]').forEach((i) => { i.onchange = run(async () => { photos[i.dataset.tphoto] = await readImage(i.files[0], 900); toast('Photo attached'); }); });
  app.querySelectorAll('[data-tsend]').forEach((b) => {
    b.onclick = run(async () => {
      const id = b.dataset.tsend;
      await api('POST', `/api/trips/${t.id}/tolls`, { tollId: Number(id), amount: Number($(`[data-tamt="${id}"]`).value), photo: photos[id] });
      toast('Thanks! Toll report sent.'); await refreshTrip(); render();
    });
  });
  app.querySelectorAll('[data-rmtoll]').forEach((b) => {
    b.onclick = run(async () => { await api('DELETE', `/api/trips/${t.id}/tolls/${b.dataset.rmtoll}`); await refreshTrip(); render(); });
  });
  let newPhoto = null;
  $('#tphoto') && ($('#tphoto').onchange = run(async () => { newPhoto = await readImage($('#tphoto').files[0], 900); toast('Photo attached'); }));
  $('#addtoll') && ($('#addtoll').onclick = run(async () => {
    let pos;
    try { pos = await here(); } catch { pos = { lat: (t.src.lat + t.dst.lat) / 2, lng: (t.src.lng + t.dst.lng) / 2 }; }
    await api('POST', `/api/trips/${t.id}/tolls`, { name: $('#tname').value, amount: Number($('#tamt').value), photo: newPhoto, ...pos });
    toast('Toll added to this trip'); await refreshTrip(); render();
  }));
  bindComms(t);
}

// ---------------- admin ----------------
async function renderAdmin(app) {
  app.innerHTML = tabs([['drivers', 'Driver KYC'], ['calamity', 'Rain / calamity'], ['tolls', 'Tolls']], 'drivers') + '<div id="pane" class="card">Loading…</div>';
  bindTabs(app);
  const pane = $('#pane');
  if (S.tab === 'calamity') {
    const cfg = await api('GET', '/api/config');
    pane.innerHTML = `<h2>Calamity mode</h2>
      <p class="muted">While on, Olub charges ${rs(cfg.platformFeeCalamity)} instead of ${rs(cfg.platformFee)} per trip in that state.</p>
      <div class="list">${cfg.calamity.map((c) => `<div class="switch"><span><b>${esc(c.state === '*' ? 'All India' : c.state)}</b> — ${esc(c.reason)}</span>
        <button class="btn small ghost" data-off="${esc(c.state)}">Turn off</button></div>`).join('') || '<div class="muted">Normal operations everywhere.</div>'}</div>
      <div class="row"><input id="cs" placeholder="State (KA) or * for all" maxlength="4"><input id="cr" placeholder="Reason (Heavy rain)"></div>
      <button id="con" class="btn block">Turn on</button>`;
    $('#con').onclick = run(async () => { await api('POST', '/api/admin/calamity', { state: $('#cs').value || '*', reason: $('#cr').value, on: true }); render(); });
    pane.querySelectorAll('[data-off]').forEach((b) => { b.onclick = run(async () => { await api('POST', '/api/admin/calamity', { state: b.dataset.off, on: false }); render(); }); });
    return;
  }
  if (S.tab === 'tolls') {
    const tolls = await api('GET', '/api/tolls');
    pane.innerHTML = `<h2>Crowd-sourced tolls</h2><div class="list">${tolls.map((t) => `<div>
      <b>${esc(t.name)}</b> (${esc(t.state)}) <span class="badge${t.status === 'verified' ? '' : ' warn'}">${esc(t.status)}</span>
      <div class="muted">${rs(t.amount)} · ${esc(t.amountSource)} · ${t.reports}/${t.reportsNeeded} reports</div></div>`).join('') || '<div class="muted">No tolls reported yet.</div>'}</div>`;
    return;
  }
  const drivers = await api('GET', '/api/admin/drivers?status=submitted');
  pane.innerHTML = `<h2>Drivers awaiting verification</h2>
    <p class="muted">Riders can also verify a driver in person (and get ${rs(S.cfg.verifyDiscount)} off).</p>
    <div class="list">${drivers.map((d) => `<div>
      ${driverCard(d)}
      <div class="muted">📱 ${esc(d.phone)} · DL ${esc(d.licenseNo)} · RC ${esc(d.rcNo)} · ID ${esc(d.kycIdNo)}</div>
      <div class="row">${Object.entries(d.docs).map(([k, v]) => `<a href="${v}" target="_blank" class="badge">${esc(k)}</a>`).join('')}</div>
      <div class="row"><button class="btn small" data-ok="${d.id}">Approve</button><button class="btn small danger" data-no="${d.id}">Reject</button></div>
    </div>`).join('') || '<div class="muted">Nothing pending.</div>'}</div>`;
  const review = (id, approve) => run(async () => { await api('POST', `/api/admin/drivers/${id}/review`, { approve }); render(); });
  pane.querySelectorAll('[data-ok]').forEach((b) => { b.onclick = review(b.dataset.ok, true); });
  pane.querySelectorAll('[data-no]').forEach((b) => { b.onclick = review(b.dataset.no, false); });
}

// ---------------- in-app voice call (WebRTC, server only relays signals) ----------------
const Call = {
  pc: null, tripId: null, pendingOffer: null, queuedIce: [], stream: null,
  ui(name, state, incoming) {
    $('#call').hidden = false; $('#call-name').textContent = name || ''; $('#call-state').textContent = state;
    $('#call-accept').hidden = !incoming;
    $('#call-end').onclick = () => this.hangup(true);
    $('#call-accept').onclick = run(() => this.answer());
  },
  signal(type, data) { return api('POST', `/api/trips/${this.tripId}/call`, { type, data }); },
  async setup() {
    // TODO(prod): add a TURN server so calls connect across all mobile networks.
    this.pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.stream.getTracks().forEach((tr) => this.pc.addTrack(tr, this.stream));
    this.pc.onicecandidate = (e) => { if (e.candidate) this.signal('ice', e.candidate); };
    this.pc.ontrack = (e) => { $('#call-audio').srcObject = e.streams[0]; $('#call-state').textContent = 'Connected'; };
    this.pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(this.pc?.connectionState)) this.hangup(false); };
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
    await this.setup();
    await this.pc.setRemoteDescription(this.pendingOffer);
    for (const c of this.queuedIce.splice(0)) await this.pc.addIceCandidate(c);
    const ans = await this.pc.createAnswer();
    await this.pc.setLocalDescription(ans);
    await this.signal('answer', ans);
    $('#call-accept').hidden = true; $('#call-state').textContent = 'Connecting…';
  },
  async onSignal(s) {
    if (s.type === 'offer') {
      if (this.pc) return this.signal.call({ tripId: s.tripId }, 'decline'); // busy
      this.tripId = s.tripId; this.pendingOffer = s.data; this.queuedIce = [];
      this.ui(s.fromName, 'Incoming Olub call', true);
    } else if (s.type === 'answer' && this.pc) {
      await this.pc.setRemoteDescription(s.data);
    } else if (s.type === 'ice') {
      if (this.pc?.remoteDescription) await this.pc.addIceCandidate(s.data).catch(() => {});
      else this.queuedIce.push(s.data);
    } else if (s.type === 'hangup' || s.type === 'decline') {
      this.hangup(false);
      if (s.type === 'decline') toast('Call declined');
    }
  },
  hangup(notify) {
    if (notify && this.tripId) this.signal(this.pc ? 'hangup' : 'decline').catch(() => {});
    this.stream?.getTracks().forEach((t) => t.stop());
    this.pc?.close();
    Object.assign(this, { pc: null, pendingOffer: null, queuedIce: [], stream: null });
    $('#call').hidden = true;
  },
};

boot().catch((e) => { $('#app').innerHTML = `<div class="card">Could not load Olub: ${esc(e.message)}</div>`; });
