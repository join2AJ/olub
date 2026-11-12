'use strict';
(async function boot() {
  const hideSplash = () => setTimeout(() => $('#splash').classList.add('out'), 500);
  try {
    if (IN_APP && !S.base) { hideSplash(); return render(); }
    [S.cfg, S.places, S.legal] = await Promise.all([api('GET', '/api/config'), api('GET', '/api/places'), api('GET', '/api/legal')]);
    if (S.token) {
      try { S.me = await api('GET', '/api/me'); } catch { S.token = null; store('olub.token', null); }
    }
    if (S.me) { connect(); await refreshTrip(); }
    render();
  } catch (e) {
    $('#app').innerHTML = `<div class="card"><h2>Could not reach Olub</h2><p class="muted">${esc(e.message)}</p>
      <button class="btn block" onclick="location.reload()">Try again</button>
      ${IN_APP ? '<button class="btn ghost block" id="chg">Change server address</button>' : ''}</div>`;
    const c = $('#chg'); if (c) c.onclick = () => { store('olub.server', null); location.reload(); };
  }
  hideSplash();
  // Keep "minutes left / late" fresh while a ride is on screen.
  setInterval(() => { if (S.me && S.trip && S.trip.status === 'started' && S.tab === 'home' && !$('#sheet-root').children.length && document.activeElement.tagName !== 'INPUT') refreshTrip().then(render).catch(() => {}); }, 60000);
}());
