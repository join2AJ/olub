/* DIGIPIN — India Post's open national addressing grid (4 m × 4 m cells).
   Works in the browser (window.Digipin) and in Node (require). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Digipin = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var GRID = [['F', 'C', '9', '8'], ['J', '3', '2', '7'], ['K', '4', '5', '6'], ['L', 'M', 'P', 'T']];
  var B = { minLat: 2.5, maxLat: 38.5, minLon: 63.5, maxLon: 99.5 };

  function inIndia(lat, lon) { return lat >= B.minLat && lat <= B.maxLat && lon >= B.minLon && lon <= B.maxLon; }

  /** lat/lng → "XXX-XXX-XXXX" (or null outside the DIGIPIN area). */
  function encode(lat, lon) {
    lat = Number(lat); lon = Number(lon);
    if (!isFinite(lat) || !isFinite(lon) || !inIndia(lat, lon)) return null;
    var minLat = B.minLat, maxLat = B.maxLat, minLon = B.minLon, maxLon = B.maxLon, out = '';
    for (var level = 1; level <= 10; level++) {
      var dLat = (maxLat - minLat) / 4, dLon = (maxLon - minLon) / 4;
      var row = 3 - Math.min(3, Math.floor((lat - minLat) / dLat));
      var col = Math.min(3, Math.floor((lon - minLon) / dLon));
      out += GRID[row][col];
      if (level === 3 || level === 6) out += '-';
      maxLat = minLat + dLat * (4 - row); minLat = minLat + dLat * (3 - row);
      minLon = minLon + dLon * col; maxLon = minLon + dLon;
    }
    return out;
  }

  /** DIGIPIN (full or partial, with or without hyphens) → centre {lat, lng}, or null. */
  function decode(code) {
    var s = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!s.length || s.length > 10) return null;
    var minLat = B.minLat, maxLat = B.maxLat, minLon = B.minLon, maxLon = B.maxLon;
    for (var i = 0; i < s.length; i++) {
      var r = -1, c = -1;
      for (var a = 0; a < 4; a++) for (var b = 0; b < 4; b++) if (GRID[a][b] === s[i]) { r = a; c = b; }
      if (r < 0) return null;
      var dLat = (maxLat - minLat) / 4, dLon = (maxLon - minLon) / 4;
      var lat1 = maxLat - dLat * (r + 1), lon1 = minLon + dLon * c;
      minLat = lat1; maxLat = lat1 + dLat; minLon = lon1; maxLon = lon1 + dLon;
    }
    return { lat: (minLat + maxLat) / 2, lng: (minLon + maxLon) / 2 };
  }

  /** True if the text looks like a full DIGIPIN. */
  function looksLike(text) { return /^[2-9CFJKLMPT]{3}-?[2-9CFJKLMPT]{3}-?[2-9CFJKLMPT]{4}$/i.test(String(text || '').trim()); }

  return { encode: encode, decode: decode, looksLike: looksLike };
}));
