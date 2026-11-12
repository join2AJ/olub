'use strict';
/* Olub app core: state, API client, icons, helpers, sheets, maps. */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rs = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const when = (ts) => new Date(ts).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

function store(k, v) {
  try {
    if (v === undefined) return localStorage.getItem(k);
    if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v);
  } catch { /* storage unavailable */ }
  return null;
}

const Native = window.OlubNative || null; // injected by the Android app
const IN_APP = location.hostname === 'appassets.androidplatform.net' || location.protocol === 'file:';

const S = {
  base: (store('olub.server') || (Native && Native.defaultServer && Native.defaultServer()) || '').replace(/\/$/, ''),
  token: store('olub.token'),
  me: null, cfg: null, places: [], legal: null,
  tab: 'home', sub: null,
  trip: null, requests: [], messages: [],
  booking: { mode: 'plate', driver: '', src: null, dst: null, pet: false, guest: null }, quote: null,
  es: null, watchId: null, lastPing: 0, safety: null,
};

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(S.base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(S.token && { authorization: `Bearer ${S.token}` }) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch { throw new Error('No connection. Check your internet and try again.'); }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && S.token) { logout(); }
  if (!res.ok) throw Object.assign(new Error(data.error || `Error ${res.status}`), { status: res.status, todo: data.todo });
  return data;
}

// ---------- icons (inline SVG, 24×24 stroke) ----------
const P = {
  home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  car: '<path d="M5 11l1.5-4.5A2 2 0 0 1 8.4 5h7.2a2 2 0 0 1 1.9 1.5L19 11"/><rect x="3" y="11" width="18" height="6" rx="2"/><circle cx="7.5" cy="17.5" r="1.5"/><circle cx="16.5" cy="17.5" r="1.5"/>',
  pin: '<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  nav: '<path d="M3 11l18-8-8 18-2-8z"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  wallet: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M16 14.5h2"/>',
  paw: '<circle cx="7" cy="9" r="1.8"/><circle cx="12" cy="6.5" r="1.8"/><circle cx="17" cy="9" r="1.8"/><path d="M8 17c0-2.5 2-5 4-5s4 2.5 4 5c0 1.5-1.2 2-2.3 1.6L12 18l-1.7.6C9.2 19 8 18.5 8 17z"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  alert: '<path d="M12 3l9.5 17h-19z"/><path d="M12 10v4M12 17.2h.01"/>',
  share: '<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.2 10.9l7.6-3.8M8.2 13.1l7.6 3.8"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  file: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>',
  logout: '<path d="M10 4H5v16h5M15 8l4 4-4 4M19 12H9"/>',
  right: '<path d="M9 6l6 6-6 6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  heart: '<path d="M12 20s-7.5-4.6-7.5-10A4.5 4.5 0 0 1 12 7.5 4.5 4.5 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.5 3-5.5 6.5-5.5s6.5 2 6.5 5.5"/><path d="M16 4.7a3.5 3.5 0 0 1 0 6.6M18 14.7c2 .6 3.5 2.3 3.5 5.3"/>',
  download: '<path d="M12 4v11M7.5 11l4.5 4.5 4.5-4.5M5 20h14"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 7l8.5 6 8.5-6"/>',
  camera: '<path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  road: '<path d="M7 3L4 21M17 3l3 18M12 4v3M12 11v3M12 18v3"/>',
  cloud: '<path d="M7 17a4 4 0 0 1 .5-8 5.5 5.5 0 0 1 10.6 1.5A3.5 3.5 0 0 1 17.5 17z"/><path d="M9 20l.5-1M13 20l.5-1M17 20l.5-1"/>',
  bolt: '<path d="M13 3L5 13h6l-1 8 8-10h-6z"/>',
  id: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M6 16c.5-1.5 1.7-2 3-2s2.5.5 3 2M15 10h3M15 14h3"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9L7 7M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
};
const ic = (name, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[name] || ''}</svg>`;
const starsHtml = (r) => (r && r.count ? `<span class="stars">${ic('star', 'fill')} ${r.average.toFixed(1)}</span> <span class="muted small">(${r.count})</span>` : '<span class="chip grey">New</span>');

// ---------- feedback ----------
let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = `toast${err ? ' err' : ''}`; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, err ? 4500 : 3000);
  if (err && navigator.vibrate) navigator.vibrate(60);
}

/** Wrap an async click handler: shows a spinner on the button and a toast on failure. */
const run = (fn) => async function handler(ev) {
  const btn = ev && ev.currentTarget && ev.currentTarget.classList && ev.currentTarget.classList.contains('btn') ? ev.currentTarget : null;
  if (btn) btn.classList.add('loading');
  try { await fn.call(this, ev); } catch (e) {
    toast(e.message, true);
    if (e.todo) openTodo(e.todo[0]);
  } finally { if (btn) btn.classList.remove('loading'); }
};

// ---------- bottom sheets ----------
function sheet(title, html, { onClose } = {}) {
  const root = $('#sheet-root');
  const bg = document.createElement('div');
  bg.className = 'sheet-bg';
  bg.innerHTML = `<div class="sheet" role="dialog"><div class="grab"></div>
    <div class="sheet-head"><h2>${esc(title)}</h2><button class="xbtn" data-close>${ic('x')}</button></div><div class="sheet-body">${html}</div></div>`;
  const close = () => { bg.remove(); if (onClose) onClose(); };
  bg.addEventListener('click', (e) => { if (e.target === bg || e.target.closest('[data-close]')) close(); });
  root.appendChild(bg);
  return { el: bg.querySelector('.sheet-body'), close };
}
const closeSheets = () => { $('#sheet-root').innerHTML = ''; };

// ---------- device helpers ----------
function here() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Location is not available on this device'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => reject(new Error('Allow location access to use your current location')),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  });
}

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
    img.onerror = () => reject(new Error('Could not read that photo'));
    img.src = URL.createObjectURL(file);
  });
}

async function shareText(text) {
  if (Native && Native.share) return Native.share(text);
  if (navigator.share) { try { await navigator.share({ text }); return; } catch { /* cancelled */ } }
  try { await navigator.clipboard.writeText(text); toast('Link copied — paste it in WhatsApp or SMS'); } catch { prompt('Copy this link', text); }
}

/** Decode an encoded polyline (precision 5) into [[lat, lng], …]. */
function decodePolyline(str) {
  const out = []; let i = 0, lat = 0, lng = 0;
  const next = () => {
    let shift = 0, result = 0, b;
    do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20 && i < str.length);
    return (result & 1) ? ~(result >> 1) : (result >> 1);
  };
  while (i < str.length) { lat += next(); lng += next(); out.push([lat / 1e5, lng / 1e5]); }
  return out;
}

// ---------- maps (Leaflet + OpenStreetMap tiles) ----------
function makeMap(el, { src, dst, last, path, onPick, polyline } = {}) {
  if (!window.L) { el.innerHTML = '<div class="empty">Map unavailable</div>'; return null; }
  const map = L.map(el, { zoomControl: false, attributionControl: true }).setView([20.6, 78.9], 4);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  const icon = (cls, html = '') => L.divIcon({ className: '', html: `<div class="mk ${cls}">${html}</div>`, iconSize: cls === 'car' ? [34, 34] : [18, 18], iconAnchor: cls === 'car' ? [17, 17] : [9, 9] });
  const h = { map, car: null, line: null, trail: null, layers: [] };
  h.setRoute = (a, b, poly) => {
    h.layers.forEach((l) => l.remove()); h.layers = [];
    const pts = [];
    const road = poly ? decodePolyline(poly) : null;
    if (a) { h.layers.push(L.marker([a.lat, a.lng], { icon: icon('') }).addTo(map)); pts.push([a.lat, a.lng]); }
    if (b) { h.layers.push(L.marker([b.lat, b.lng], { icon: icon('d') }).addTo(map)); pts.push([b.lat, b.lng]); }
    if (road && road.length > 1) {
      // The actual road path.
      h.layers.push(L.polyline(road, { color: '#ffffff', weight: 8, opacity: .9, lineCap: 'round', lineJoin: 'round' }).addTo(map));
      h.layers.push(L.polyline(road, { color: '#0f7b4a', weight: 5, opacity: .95, lineCap: 'round', lineJoin: 'round' }).addTo(map));
      map.fitBounds(road, { padding: [36, 36] });
    } else if (pts.length === 2) { h.layers.push(L.polyline(pts, { color: '#0f7b4a', weight: 4, opacity: .55, dashArray: '2 9', lineCap: 'round' }).addTo(map)); map.fitBounds(pts, { padding: [36, 36] }); }
    else if (pts.length === 1) map.setView(pts[0], 14);
  };
  h.setCar = (p) => {
    if (!p) return;
    if (!h.car) h.car = L.marker([p.lat, p.lng], { icon: icon('car', ic('car')), zIndexOffset: 500 }).addTo(map);
    else h.car.setLatLng([p.lat, p.lng]);
  };
  h.setTrail = (pts) => {
    if (h.trail) h.trail.remove();
    if (pts && pts.length > 1) h.trail = L.polyline(pts.map((p) => [p.lat, p.lng]), { color: '#ffb300', weight: 5, opacity: .95 }).addTo(map);
  };
  h.setRoute(src, dst, polyline); h.setCar(last); h.setTrail(path);
  if (onPick) map.on('click', (e) => onPick({ lat: e.latlng.lat, lng: e.latlng.lng }));
  setTimeout(() => { if (el.isConnected && map._loaded) map.invalidateSize(); }, 60);
  return h;
}
