/* airports.js - Airport data loading, markers with ICAO labels, click popups, METAR layer */

(function () {
  'use strict';

  // Airport type configuration: color and marker size
  var TYPE_CONFIG = {
    'large_airport':   { color: '#e74c3c', size: 12, label: 'Large airports', fontSize: 12, minZoom: 0 },
    'medium_airport':  { color: '#3498db', size: 9,  label: 'Medium airports', fontSize: 11, minZoom: 6 },
    'small_airport':   { color: '#27ae60', size: 6,  label: 'Small airports', fontSize: 10, minZoom: 8 }
  };

  // Column indices in the array-of-arrays data format
  var COL = {
    ident: 0, type: 1, name: 2, lat: 3, lon: 4,
    elevation: 5, country: 6, municipality: 7,
    iata: 8, gps_code: 9, runways: 10,
    atc_level: 11, frequencies: 12
  };

  // Runway array indices: [designator, length_ft, width_ft, surface]
  var RWY = { designator: 0, length: 1, width: 2, surface: 3 };

  // METAR flight category config
  var METAR_CAT = {
    'VFR':  { color: '#27ae60', label: 'VFR' },
    'MVFR': { color: '#3498db', label: 'MVFR' },
    'BIR':  { color: '#e67e22', label: 'BIR' },
    'IFR':  { color: '#e74c3c', label: 'IFR' },
    'LIFR': { color: '#9b59b6', label: 'LIFR' }
  };

  var METAR_API = 'https://metar.vatsim.net/metar.php';
  var TAF_API = 'https://aviationweather.gov/api/data/taf';
  var CORS_PROXY = 'https://corsproxy.io/?';

  // Shared METAR cache: icao → parsed metar object
  var metarCache = {};
  // TAF cache: icao → taf json
  var tafCache = {};
  // Cache timestamps: icao → epoch ms
  var metarCacheTime = {};
  var tafCacheTime = {};
  var CACHE_MAX_AGE = 10 * 60 * 1000; // 10 minutes

  function isStale(timeMap, icao) {
    var t = timeMap[icao];
    return !t || (Date.now() - t > CACHE_MAX_AGE);
  }

  // Strong wind check: wspd > 15kt or gusts > 20kt
  function isStrongWind(wspd, wgst) {
    return (wspd != null && wspd > 15) || (wgst != null && wgst > 20);
  }

  // Inline SVG wind icon (two flowing lines with curls)
  var WIND_SVG = '<svg class="wind-svg" viewBox="0 0 24 14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M1 4h11a3 3 0 1 0-3-3"/><path d="M1 10h15a3 3 0 1 1-3 3"/></svg>';

  // Shared flight category calculator
  function calcFlightCat(ceilingFt, visM) {
    var c = ceilingFt != null ? ceilingFt : 99999;
    var v = visM != null ? visM : 99999;
    if (c > 3000 && v > 8000) return 'VFR';
    if (c >= 1000 && v >= 5000) return 'MVFR';
    if (c >= 600 && v >= 1500) return 'BIR';
    if (c < 500 || v < 1500) return 'LIFR';
    return 'IFR';
  }

  // --- Simple METAR parser ---
  function parseMetar(raw) {
    if (!raw || typeof raw !== 'string') return null;
    var result = { rawOb: raw.trim(), fltCat: null };
    var tokens = raw.trim().split(/\s+/);

    // Wind: dddssKT or dddssGggKT or VRBssKT
    for (var i = 0; i < tokens.length; i++) {
      var wm = tokens[i].match(/^(\d{3}|VRB)(\d{2,3})(G(\d{2,3}))?KT$/);
      if (wm) {
        result.wdir = wm[1] === 'VRB' ? 'VRB' : parseInt(wm[1], 10);
        result.wspd = parseInt(wm[2], 10);
        if (wm[4]) result.wgst = parseInt(wm[4], 10);
        break;
      }
    }

    // Visibility in meters (e.g. 9999, 4500, 0250) or statute miles (e.g. 3SM, 1/2SM)
    var visM = null;
    for (var i = 0; i < tokens.length; i++) {
      var vm = tokens[i].match(/^(\d{4})$/);
      if (vm && i > 1) { // skip ICAO and time
        visM = parseInt(vm[1], 10);
        if (visM === 9999) visM = 10000;
        break;
      }
      var sm = tokens[i].match(/^(\d+(?:\/\d+)?)SM$/);
      if (sm) {
        var parts = sm[1].split('/');
        visM = (parts.length === 2 ? parseInt(parts[0], 10) / parseInt(parts[1], 10) : parseFloat(parts[0])) * 1609.34;
        break;
      }
    }
    if (tokens.indexOf('CAVOK') >= 0) visM = 10000;
    result.visib = visM;

    // Clouds - find ceiling (lowest BKN or OVC)
    var ceiling = null;
    var clouds = [];
    for (var i = 0; i < tokens.length; i++) {
      var cm = tokens[i].match(/^(FEW|SCT|BKN|OVC|VV)(\d{3})/);
      if (cm) {
        var base = parseInt(cm[2], 10) * 100;
        clouds.push({ cover: cm[1], base: base });
        if ((cm[1] === 'BKN' || cm[1] === 'OVC' || cm[1] === 'VV') && (ceiling === null || base < ceiling)) {
          ceiling = base;
        }
      }
    }
    result.clouds = clouds;
    result.ceiling = ceiling;

    // Temperature/Dewpoint: Tnn/Dnn with optional M prefix for negative
    for (var i = 0; i < tokens.length; i++) {
      var tm = tokens[i].match(/^(M?\d{2})\/(M?\d{2})$/);
      if (tm) {
        result.temp = parseInt(tm[1].replace('M', '-'), 10);
        result.dewp = parseInt(tm[2].replace('M', '-'), 10);
        break;
      }
    }

    // QNH: Qnnnn (hPa) or Annnn (inHg)
    for (var i = 0; i < tokens.length; i++) {
      var qm = tokens[i].match(/^Q(\d{4})$/);
      if (qm) { result.altim = parseInt(qm[1], 10); break; }
      var am = tokens[i].match(/^A(\d{4})$/);
      if (am) { result.altim = Math.round(parseInt(am[1], 10) / 100 * 33.8639); break; }
    }

    // Flight category based on ceiling and visibility
    result.fltCat = calcFlightCat(ceiling, visM);

    return result;
  }

  // ATC level display config
  var ATC_DISPLAY = {
    'APP/TWR':      { label: 'Approach / Tower', css: 'atc-app' },
    'TWR':          { label: 'Tower (TWR)', css: 'atc-twr' },
    'AFIS/Radio':   { label: 'AFIS / Radio', css: 'atc-afis' },
    'CTAF/UNICOM':  { label: 'CTAF / UNICOM', css: 'atc-ctaf' },
    'UNCONTROLLED': { label: 'Uncontrolled', css: 'atc-none' }
  };

  function estimateFuel(row) {
    var type = row[COL.type];
    var runways = row[COL.runways] || [];
    var hasPaved = runways.some(function (r) {
      var s = (r[RWY.surface] || '').toUpperCase();
      return s.indexOf('ASP') >= 0 || s.indexOf('CON') >= 0 || s.indexOf('BIT') >= 0
        || s.indexOf('PEM') >= 0 || s.indexOf('ASPHALT') >= 0 || s.indexOf('CONCRETE') >= 0;
    });
    if (type === 'large_airport') return ['JET A-1', 'AVGAS 100LL'];
    if (type === 'medium_airport') {
      if (hasPaved) return ['JET A-1 (likely)', 'AVGAS 100LL (likely)'];
      return ['AVGAS 100LL (likely)'];
    }
    if (hasPaved) return ['AVGAS (possible)'];
    return null;
  }

  function estimateParking(row) {
    var type = row[COL.type];
    if (type === 'large_airport') return 'GA apron, terminal stands';
    if (type === 'medium_airport') return 'GA apron (likely)';
    return null;
  }

  function estimateHours(row) {
    var type = row[COL.type];
    var atc = row[COL.atc_level];
    if (type === 'large_airport') return 'H24 or extended hours (likely)';
    if (type === 'medium_airport' && (atc === 'APP/TWR' || atc === 'TWR')) {
      return 'Daytime / published hours (likely)';
    }
    if (atc === 'AFIS/Radio' || atc === 'CTAF/UNICOM') {
      return 'Daylight / PPR possible';
    }
    return null;
  }

  function getCode(row) {
    return row[COL.gps_code] || row[COL.ident] || '';
  }

  var METAR_LETTER = { 'VFR': 'V', 'MVFR': 'M', 'BIR': 'B', 'IFR': 'I', 'LIFR': 'L' };

  // Zoom-based scale: base at zoom 7, grows 15% per zoom level above that
  function zoomScale(zoom) {
    if (zoom <= 7) return 1;
    return 1 + (zoom - 7) * 0.15;
  }

  function createMarkerIcon(type, code, metarCat, zoom) {
    var config = TYPE_CONFIG[type] || { color: '#999', size: 6, fontSize: 10 };
    var scale = zoomScale(zoom || 7);
    var s = Math.round(config.size * scale);
    var fs = Math.round(config.fontSize * scale);
    var dot;
    if (metarCat) {
      var catCfg = METAR_CAT[metarCat] || { color: '#888' };
      var letter = METAR_LETTER[metarCat] || '?';
      var ms = Math.max(Math.round(s * 1.5), Math.round(14 * scale));
      var wxFs = Math.round(10 * scale);
      dot = '<div class="airport-dot wx-dot" style="width:' + ms + 'px;height:' + ms + 'px;background:' + catCfg.color + ';font-size:' + wxFs + 'px;">' + letter + '</div>';
    } else {
      dot = '<div class="airport-dot" style="width:' + s + 'px;height:' + s + 'px;background:' + config.color + ';"></div>';
    }
    var html = '<div class="airport-icon">' + dot +
      '<span class="airport-code" style="font-size:' + fs + 'px;color:' + config.color + ';">' + code +
      '</span></div>';
    return L.divIcon({
      className: 'airport-marker',
      iconSize: null,
      iconAnchor: [s / 2, s / 2],
      html: html
    });
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;');
  }

  function ftToM(ft) {
    if (ft == null) return '?';
    return Math.round(ft * 0.3048) + ' m';
  }

  function buildPopupContent(row) {
    var name = row[COL.name];
    var ident = row[COL.ident];
    var iata = row[COL.iata];
    var gpsCode = row[COL.gps_code];
    var municipality = row[COL.municipality];
    var country = row[COL.country];
    var elevation = row[COL.elevation];
    var lat = row[COL.lat];
    var lon = row[COL.lon];
    var runways = row[COL.runways] || [];
    var atcLevel = row[COL.atc_level] || 'UNCONTROLLED';
    var frequencies = row[COL.frequencies] || [];

    var codes = [];
    if (gpsCode && gpsCode !== ident) codes.push('ICAO: ' + gpsCode);
    else if (ident) codes.push('ICAO: ' + ident);
    if (iata) codes.push('IATA: ' + iata);

    var html = '<div class="popup-content">';
    html += '<div class="popup-name">' + escapeHtml(name) + '</div>';

    if (codes.length > 0) {
      html += '<div class="popup-codes">' + codes.join(' &middot; ') + '</div>';
    }

    var details = [];
    if (municipality) details.push(escapeHtml(municipality));
    if (country) details.push(country);
    if (elevation != null) details.push('Elev: ' + elevation + ' ft / ' + Math.round(elevation * 0.3048) + ' m');
    if (details.length > 0) {
      html += '<div class="popup-detail">' + details.join(' &middot; ') + '</div>';
    }

    // --- METAR (loaded dynamically) ---
    html += '<div class="popup-metar" data-icao="' + escapeHtml(gpsCode || ident) + '">';
    html += '<span class="metar-loading">Loading METAR...</span>';
    html += '</div>';

    // --- TAF forecast (loaded dynamically) ---
    html += '<div class="popup-taf" data-icao="' + escapeHtml(gpsCode || ident) + '">';
    html += '<span class="metar-loading">Loading TAF...</span>';
    html += '</div>';

    // --- Info grid ---
    html += '<div class="popup-info-grid">';

    var atcDisp = ATC_DISPLAY[atcLevel] || ATC_DISPLAY['UNCONTROLLED'];
    html += '<div class="info-row"><span class="info-label">ATC</span>';
    html += '<span class="info-value ' + atcDisp.css + '">' + atcDisp.label + '</span></div>';

    if (frequencies.length > 0) {
      html += '<div class="info-row info-row-freqs"><span class="info-label">Freq</span><span class="info-value freq-list">';
      for (var f = 0; f < frequencies.length; f++) {
        var fr = frequencies[f];
        html += '<span class="freq-item">' + escapeHtml(fr[0]) + ' ' + fr[1] + '</span>';
      }
      html += '</span></div>';
    }

    var fuel = estimateFuel(row);
    html += '<div class="info-row"><span class="info-label">Fuel</span>';
    html += fuel ? '<span class="info-value">' + fuel.join(', ') + '</span>' : '<span class="info-value info-unknown">No data</span>';
    html += '</div>';

    var hours = estimateHours(row);
    html += '<div class="info-row"><span class="info-label">Hours</span>';
    html += hours ? '<span class="info-value">' + hours + '</span>' : '<span class="info-value info-unknown">No data</span>';
    html += '</div>';

    var parking = estimateParking(row);
    html += '<div class="info-row"><span class="info-label">Parking</span>';
    html += parking ? '<span class="info-value">' + parking + '</span>' : '<span class="info-value info-unknown">No data</span>';
    html += '</div>';

    html += '</div>';

    // --- Links ---
    var icaoRaw = gpsCode || ident;
    var icaoEnc = encodeURIComponent(icaoRaw);
    html += '<div class="popup-links">';
    html += '<a href="https://www.google.com/search?q=' + icaoEnc + '+airport" target="_blank" rel="noopener" class="popup-link google-link">Google</a>';
    html += '<a href="https://skyvector.com/airport/' + icaoEnc + '" target="_blank" rel="noopener" class="popup-link sv-link">SkyVector</a>';
    html += '<a href="https://ourairports.com/airports/' + icaoEnc + '/" target="_blank" rel="noopener" class="popup-link oa-link">OurAirports</a>';
    html += '<a href="https://acukwik.com/Airport-Info/' + icaoEnc + '" target="_blank" rel="noopener" class="popup-link ac-link">AC-U-KWIK</a>';
    html += '<a href="https://www.windy.com/' + lat + '/' + lon + '?detail=true" target="_blank" rel="noopener" class="popup-link windy-link">Windy</a>';
    html += '</div>';

    // --- Runways ---
    if (runways.length > 0) {
      html += '<div class="popup-runways"><div class="popup-runways-title">Runways</div>';
      html += '<table class="runway-table"><thead><tr><th>RWY</th><th>Length</th><th>Width</th><th>Surface</th></tr></thead><tbody>';
      for (var i = 0; i < runways.length; i++) {
        var rwy = runways[i];
        html += '<tr>';
        html += '<td>' + escapeHtml(rwy[RWY.designator]) + '</td>';
        html += '<td>' + ftToM(rwy[RWY.length]) + '</td>';
        html += '<td>' + ftToM(rwy[RWY.width]) + '</td>';
        html += '<td>' + escapeHtml(rwy[RWY.surface]) + '</td>';
        html += '</tr>';
      }
      html += '</tbody></table></div>';
    }

    html += '</div>';
    return html;
  }

  // --- Render a METAR into the popup placeholder ---
  function renderMetarInPopup(el, metar) {
    if (!metar) {
      el.innerHTML = '<span class="info-unknown">No METAR available</span>';
      return;
    }
    var cat = METAR_CAT[metar.fltCat] || { color: '#888', label: metar.fltCat || '?' };

    var html = '<span class="metar-cat" style="background:' + cat.color + ';">' + cat.label + '</span>';
    if (isStrongWind(metar.wspd, metar.wgst)) {
      html += ' <span class="wind-badge">' + WIND_SVG + '</span>';
    }
    html += '<div class="metar-raw">' + escapeHtml(metar.rawOb) + '</div>';

    // Decoded summary
    var parts = [];
    if (metar.wdir != null && metar.wspd != null) {
      var wind = (metar.wdir === 'VRB' ? 'VRB' : metar.wdir + '&deg;') + '/' + metar.wspd + 'kt';
      if (metar.wgst) wind += ' G' + metar.wgst + 'kt';
      parts.push('Wind: ' + wind);
    }
    if (metar.visib != null) {
      if (metar.visib >= 9999) parts.push('Vis: 10+ km');
      else parts.push('Vis: ' + (metar.visib >= 1000 ? (metar.visib / 1000).toFixed(1) + ' km' : metar.visib + ' m'));
    }
    if (metar.ceiling != null) {
      parts.push('Ceil: ' + metar.ceiling + ' ft');
    } else if (metar.clouds && metar.clouds.length === 0) {
      parts.push('Ceil: CLR');
    }
    if (metar.temp != null) parts.push('Temp: ' + metar.temp + '&deg;C');
    if (metar.dewp != null) parts.push('Dew: ' + metar.dewp + '&deg;C');
    if (metar.altim != null) parts.push('QNH: ' + metar.altim + ' hPa');

    if (parts.length > 0) {
      html += '<div class="metar-decoded">' + parts.join(' &middot; ') + '</div>';
    }
    el.innerHTML = html;
  }

  // --- Fetch single METAR for popup ---
  function fetchMetarForPopup(el, icao) {
    if (metarCache[icao] && !isStale(metarCacheTime, icao)) {
      renderMetarInPopup(el, metarCache[icao]);
      return;
    }
    el.innerHTML = '<span class="metar-loading">Loading METAR...</span>';
    fetch(METAR_API + '?id=' + encodeURIComponent(icao))
      .then(function (res) { return res.text(); })
      .then(function (text) {
        var raw = text.trim();
        if (!raw) {
          el.innerHTML = '<span class="info-unknown">No METAR available</span>';
          return;
        }
        var metar = parseMetar(raw);
        if (metar) {
          metarCache[icao] = metar;
          metarCacheTime[icao] = Date.now();
          renderMetarInPopup(el, metar);
        } else {
          el.innerHTML = '<span class="info-unknown">No METAR available</span>';
        }
      })
      .catch(function () {
        el.innerHTML = '<span class="info-unknown">Failed to load METAR</span>';
      });
  }

  // --- TAF hourly forecast ---

  // API returns visib as statute miles: "6+" for unlimited, numeric for SM, "" for unchanged
  function parseTafVisib(visib) {
    if (visib == null || visib === '') return null;
    if (typeof visib === 'string') {
      if (visib.indexOf('6+') >= 0 || visib.indexOf('P6') >= 0) return 10000;
      var n = parseFloat(visib);
      if (isNaN(n)) return null;
      return Math.round(n * 1609.34);
    }
    return Math.round(visib * 1609.34);
  }

  function tafCeiling(clouds) {
    if (!clouds || clouds.length === 0) return null;
    var ceiling = null;
    for (var i = 0; i < clouds.length; i++) {
      var cl = clouds[i];
      if ((cl.cover === 'BKN' || cl.cover === 'OVC' || cl.cover === 'VV') && cl.base != null) {
        if (ceiling === null || cl.base < ceiling) ceiling = cl.base;
      }
    }
    return ceiling;
  }

  function computeHourlyCategories(tafJson) {
    if (!tafJson || !tafJson.length || !tafJson[0].fcsts || tafJson[0].fcsts.length === 0) return null;

    var fcsts = tafJson[0].fcsts;
    var now = new Date();
    var hours = [];
    var catOrder = ['VFR', 'MVFR', 'BIR', 'IFR', 'LIFR'];

    for (var h = 0; h < 12; h++) {
      var t = new Date(now.getTime() + h * 3600000);
      var epoch = t.getTime() / 1000;
      var utcHour = t.getUTCHours();

      // Find active base forecast: skip TEMPO, PROB, and BECMG still transitioning
      // BECMG uses timeBec for transition end (timeTo = end of TAF period)
      // Also track the initial (non-BECMG) base for field inheritance
      var active = null;
      var initialBase = null;
      for (var i = 0; i < fcsts.length; i++) {
        var f = fcsts[i];
        if (f.fcstChange === 'TEMPO' || f.fcstChange === 'PROB') continue;
        var becEnd = f.fcstChange === 'BECMG' ? (f.timeBec || f.timeTo) : null;
        if (becEnd && epoch < becEnd) continue;
        if (f.timeFrom <= epoch) {
          if (!f.fcstChange) initialBase = f;
          active = f;
        }
      }

      if (!active) {
        hours.push({ utcHour: utcHour, cat: null });
        continue;
      }

      // BECMG only specifies changed fields; inherit missing from initial base
      var visM = parseTafVisib(active.visib);
      if (visM === null && initialBase && active !== initialBase) {
        visM = parseTafVisib(initialBase.visib);
      }
      var ceiling = tafCeiling(active.clouds);
      var cat = calcFlightCat(ceiling, visM);

      // Extract wind from active forecast
      var wspd = active.wspd != null ? active.wspd : (initialBase && initialBase !== active ? initialBase.wspd : null);
      var wgst = active.wgst != null ? active.wgst : (initialBase && initialBase !== active ? initialBase.wgst : null);

      // Apply TEMPO, PROB, and transitioning BECMG overlays — use worst-case category and wind
      for (var i = 0; i < fcsts.length; i++) {
        var f = fcsts[i];
        var isTempo = f.fcstChange === 'TEMPO' || f.fcstChange === 'PROB';
        var becEnd = f.fcstChange === 'BECMG' ? (f.timeBec || f.timeTo) : null;
        var isBecmgTransition = f.fcstChange === 'BECMG' && becEnd && epoch < becEnd;
        if (!isTempo && !isBecmgTransition) continue;
        if (f.timeFrom > epoch || (f.timeTo && f.timeTo <= epoch)) continue;

        var tVisM = parseTafVisib(f.visib);
        if (tVisM === null) tVisM = visM;
        var tCeiling = tafCeiling(f.clouds);
        if (tCeiling === null) tCeiling = ceiling;
        var tCat = calcFlightCat(tCeiling, tVisM);

        if (catOrder.indexOf(tCat) > catOrder.indexOf(cat)) {
          cat = tCat;
          ceiling = tCeiling;
          visM = tVisM;
        }

        // Worst-case wind from overlays
        if (f.wspd != null && (wspd === null || f.wspd > wspd)) wspd = f.wspd;
        if (f.wgst != null && (wgst === null || f.wgst > wgst)) wgst = f.wgst;
      }

      hours.push({ utcHour: utcHour, cat: cat, ceiling: ceiling, visM: visM, wspd: wspd, wgst: wgst });
    }

    return hours;
  }

  function formatCeiling(ft) {
    if (ft == null) return '-';
    if (ft < 1000) return ft + '';
    if (ft % 1000 === 0) return (ft / 1000) + 'k';
    return (ft / 1000).toFixed(1) + 'k';
  }

  function formatVisKm(m) {
    if (m == null) return '-';
    if (m >= 10000) return '10+';
    if (m >= 1000) return (m / 1000).toFixed(0);
    return (m / 1000).toFixed(1);
  }

  function renderTafInPopup(el, hours, rawTaf) {
    if (!hours || hours.length === 0) {
      el.innerHTML = '<span class="info-unknown">No TAF available</span>';
      return;
    }
    var html = '<div class="taf-header">TAF</div>';
    html += '<table class="taf-table"><tbody>';
    // Hour row
    html += '<tr class="taf-row-hour"><td class="taf-row-label"></td>';
    for (var i = 0; i < hours.length; i++) {
      if (!hours[i].cat) continue;
      var hourStr = hours[i].utcHour < 10 ? '0' + hours[i].utcHour : '' + hours[i].utcHour;
      html += '<td class="taf-td-label">' + hourStr + 'Z</td>';
    }
    html += '</tr>';
    // Category row
    html += '<tr class="taf-row-cat"><td class="taf-row-label"></td>';
    for (var i = 0; i < hours.length; i++) {
      var h = hours[i];
      if (!h.cat) continue;
      var catCfg = METAR_CAT[h.cat] || { color: '#888' };
      var letter = METAR_LETTER[h.cat] || '?';
      html += '<td><div class="taf-hour" style="background:' + catCfg.color + ';">' + letter + '</div></td>';
    }
    html += '</tr>';
    // Ceiling row
    html += '<tr class="taf-row-data"><td class="taf-row-label">CIG</td>';
    for (var i = 0; i < hours.length; i++) {
      if (!hours[i].cat) continue;
      html += '<td class="taf-td-data">' + formatCeiling(hours[i].ceiling) + '</td>';
    }
    html += '</tr>';
    // Visibility row
    html += '<tr class="taf-row-data"><td class="taf-row-label">VIS</td>';
    for (var i = 0; i < hours.length; i++) {
      if (!hours[i].cat) continue;
      html += '<td class="taf-td-data">' + formatVisKm(hours[i].visM) + '</td>';
    }
    html += '</tr>';
    // Wind row
    var hasAnyWind = hours.some(function (h) { return h.cat && isStrongWind(h.wspd, h.wgst); });
    if (hasAnyWind) {
      html += '<tr class="taf-row-data"><td class="taf-row-label">WND</td>';
      for (var i = 0; i < hours.length; i++) {
        if (!hours[i].cat) continue;
        if (isStrongWind(hours[i].wspd, hours[i].wgst)) {
          html += '<td class="taf-td-data"><span class="taf-wind-dot">' + WIND_SVG + '</span></td>';
        } else {
          html += '<td class="taf-td-data"></td>';
        }
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    if (rawTaf) {
      html += '<div class="taf-raw">' + escapeHtml(rawTaf) + '</div>';
    }
    el.innerHTML = html;
  }

  function getRawTaf(tafJson) {
    return (tafJson && tafJson.length && tafJson[0].rawTAF) ? tafJson[0].rawTAF : null;
  }

  function fetchTafForPopup(el, icao) {
    if (tafCache[icao] && !isStale(tafCacheTime, icao)) {
      var hours = computeHourlyCategories(tafCache[icao]);
      renderTafInPopup(el, hours, getRawTaf(tafCache[icao]));
      return;
    }
    el.innerHTML = '<span class="metar-loading">Loading TAF...</span>';

    var url = TAF_API + '?ids=' + encodeURIComponent(icao) + '&format=json';

    fetch(url)
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (json) {
        if (!json || json.length === 0) throw new Error('empty');
        tafCache[icao] = json;
        tafCacheTime[icao] = Date.now();
        var hours = computeHourlyCategories(json);
        renderTafInPopup(el, hours, getRawTaf(json));
      })
      .catch(function () {
        // Retry via CORS proxy
        fetch(CORS_PROXY + encodeURIComponent(url))
          .then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          })
          .then(function (json) {
            if (!json || json.length === 0) throw new Error('empty');
            tafCache[icao] = json;
            tafCacheTime[icao] = Date.now();
            var hours = computeHourlyCategories(json);
            renderTafInPopup(el, hours, getRawTaf(json));
          })
          .catch(function () {
            el.innerHTML = '<span class="info-unknown">TAF unavailable</span>';
          });
      });
  }

  // --- METAR layer: updates airport marker icons with flight category ---
  function setupMetarLayer(map, layerControl, airportData, markersByIcao, typeLayers) {
    var metarLayer = L.layerGroup(); // dummy layer for toggle control
    var metarActive = false;
    var fetchTimer = null;
    var refreshTimer = null;
    var updatedIcaos = []; // track which markers we've modified
    var hiddenByWxFilter = []; // markers hidden by weather filter
    var wxFilterActive = false;

    var BAD_WX_CATS = { 'IFR': true, 'LIFR': true };

    // Collect airports that likely have METARs (large + medium with ICAO codes)
    var metarAirports = [];
    for (var i = 0; i < airportData.length; i++) {
      var row = airportData[i];
      var type = row[COL.type];
      if (type !== 'large_airport' && type !== 'medium_airport') continue;
      var icao = row[COL.gps_code] || row[COL.ident];
      if (!icao || icao.length !== 4) continue;
      var runways = row[COL.runways] || [];
      if (runways.length === 0) continue;
      metarAirports.push({ icao: icao, lat: row[COL.lat], lon: row[COL.lon] });
    }

    function restoreOriginalIcons() {
      var zoom = map.getZoom();
      for (var i = 0; i < updatedIcaos.length; i++) {
        var icao = updatedIcaos[i];
        var m = markersByIcao[icao];
        if (m) {
          m.setIcon(createMarkerIcon(m._airportType, m._airportCode, null, zoom));
        }
      }
      updatedIcaos = [];
    }

    function fetchMetarsForMap() {
      if (!metarActive) return;
      var bounds = map.getBounds();

      // Filter to airports in current viewport
      var visible = metarAirports.filter(function (a) {
        return bounds.contains([a.lat, a.lon]);
      });

      if (visible.length === 0) {
        restoreOriginalIcons();
        return;
      }

      // Batch fetch in groups of 50
      var batchSize = 50;
      var batches = [];
      for (var i = 0; i < visible.length; i += batchSize) {
        batches.push(visible.slice(i, i + batchSize));
      }

      var pending = batches.length;
      var allResults = [];

      batches.forEach(function (batch) {
        var ids = batch.map(function (a) { return a.icao; }).join(',');
        fetch(METAR_API + '?id=' + ids)
          .then(function (res) { return res.text(); })
          .then(function (text) {
            var lines = text.trim().split('\n').filter(Boolean);
            for (var j = 0; j < lines.length; j++) {
              var metar = parseMetar(lines[j]);
              if (metar) {
                var tokens = lines[j].trim().split(/\s+/);
                var icao = null;
                if (tokens[0] === 'METAR' || tokens[0] === 'SPECI') icao = tokens[1];
                else icao = tokens[0];
                if (icao) {
                  metar.icao = icao;
                  metarCache[icao] = metar;
                  metarCacheTime[icao] = Date.now();
                  allResults.push(metar);
                }
              }
            }
          })
          .catch(function (err) {
            console.error('METAR batch error:', err);
          })
          .finally(function () {
            pending--;
            if (pending === 0) {
              applyMetarToMarkers(allResults);
            }
          });
      });
    }

    function restoreWxFilter() {
      for (var i = 0; i < hiddenByWxFilter.length; i++) {
        var icao = hiddenByWxFilter[i];
        var marker = markersByIcao[icao];
        if (!marker) continue;
        var layer = typeLayers[marker._airportType];
        if (layer && !layer.hasLayer(marker)) {
          layer.addLayer(marker);
        }
      }
      hiddenByWxFilter = [];
    }

    function applyWxFilter() {
      restoreWxFilter();
      if (!wxFilterActive || !metarActive) return;
      var icaos = Object.keys(metarCache);
      for (var i = 0; i < icaos.length; i++) {
        var icao = icaos[i];
        var metar = metarCache[icao];
        if (!metar || !BAD_WX_CATS[metar.fltCat]) continue;
        var marker = markersByIcao[icao];
        if (!marker) continue;
        var layer = typeLayers[marker._airportType];
        if (layer && layer.hasLayer(marker)) {
          layer.removeLayer(marker);
          hiddenByWxFilter.push(icao);
        }
      }
    }

    function applyMetarToMarkers(results) {
      if (!metarActive) return;
      restoreOriginalIcons();

      for (var i = 0; i < results.length; i++) {
        var m = results[i];
        var marker = markersByIcao[m.icao];
        if (!marker) continue;
        marker.setIcon(createMarkerIcon(marker._airportType, marker._airportCode, m.fltCat, map.getZoom()));
        updatedIcaos.push(m.icao);
      }
      console.log('METAR: updated ' + results.length + ' airport markers');
      applyWxFilter();
    }

    function debouncedFetch() {
      clearTimeout(fetchTimer);
      fetchTimer = setTimeout(fetchMetarsForMap, 500);
    }

    map.on('overlayadd', function (e) {
      if (e.layer === metarLayer) {
        metarActive = true;
        fetchMetarsForMap();
        map.on('moveend', debouncedFetch);
        refreshTimer = setInterval(fetchMetarsForMap, 5 * 60 * 1000);
      }
    });

    map.on('overlayremove', function (e) {
      if (e.layer === metarLayer) {
        metarActive = false;
        map.off('moveend', debouncedFetch);
        clearTimeout(fetchTimer);
        clearInterval(refreshTimer);
        restoreWxFilter();
        restoreOriginalIcons();
      }
    });

    // Weather filter checkbox
    var wxToggle = document.getElementById('wx-filter-toggle');
    if (wxToggle) {
      wxToggle.addEventListener('change', function () {
        wxFilterActive = wxToggle.checked;
        if (wxFilterActive) {
          applyWxFilter();
        } else {
          restoreWxFilter();
        }
      });
    }

    layerControl.addOverlay(metarLayer, 'METAR weather');
    // Enable METAR layer by default
    map.addLayer(metarLayer);
  }

  // --- Main load ---
  function loadAirports() {
    var app = window.AirportApp;
    if (!app || !app.map) {
      setTimeout(loadAirports, 100);
      return;
    }

    var map = app.map;

    fetch('data/airports-eu.json')
      .then(function (res) {
        if (!res.ok) throw new Error('Failed to load airports-eu.json: ' + res.status);
        return res.json();
      })
      .then(function (json) {
        var data = json.data;
        console.log('Loaded ' + data.length + ' total airports from file');

        var typeLayers = {};
        Object.keys(TYPE_CONFIG).forEach(function (type) {
          typeLayers[type] = L.layerGroup();
        });

        var markersByIcao = {};
        var count = 0;
        for (var i = 0; i < data.length; i++) {
          var row = data[i];
          var type = row[COL.type];
          var lat = row[COL.lat];
          var lon = row[COL.lon];

          if (!lat || !lon) continue;

          var config = TYPE_CONFIG[type];
          if (!config) continue;

          var runways = row[COL.runways] || [];
          if (runways.length === 0) continue;

          // Filter: at least one runway >= 800m (2625ft) with asphalt/concrete
          var hasQualifyingRunway = runways.some(function (r) {
            var len = r[RWY.length];
            if (!len || len < 2625) return false;
            var s = (r[RWY.surface] || '').toUpperCase();
            return s.indexOf('ASP') >= 0 || s.indexOf('CON') >= 0
              || s.indexOf('BIT') >= 0 || s.indexOf('PEM') >= 0
              || s.indexOf('ASPHALT') >= 0 || s.indexOf('CONCRETE') >= 0;
          });
          if (!hasQualifyingRunway) continue;

          var code = getCode(row);
          var marker = L.marker([lat, lon], {
            icon: createMarkerIcon(type, code)
          });

          marker.bindPopup(buildPopupContent(row), {
            maxWidth: 620,
            minWidth: 450,
            className: 'airport-popup'
          });

          marker._airportData = row;
          marker._airportType = type;
          marker._airportCode = code;

          typeLayers[type].addLayer(marker);
          markersByIcao[code] = marker;
          count++;
        }

        console.log('Created ' + count + ' airport markers');

        // Zoom-based layer visibility + icon scaling
        var lastIconZoom = -1;

        function updateLayerVisibility() {
          var zoom = map.getZoom();
          Object.keys(TYPE_CONFIG).forEach(function (type) {
            var cfg = TYPE_CONFIG[type];
            if (zoom >= cfg.minZoom) {
              if (!map.hasLayer(typeLayers[type])) {
                map.addLayer(typeLayers[type]);
              }
            } else {
              if (map.hasLayer(typeLayers[type])) {
                map.removeLayer(typeLayers[type]);
              }
            }
          });

          // Rescale icons when zoom changes
          var scaleZoom = Math.floor(zoom);
          if (scaleZoom !== lastIconZoom) {
            lastIconZoom = scaleZoom;
            var icaos = Object.keys(markersByIcao);
            for (var i = 0; i < icaos.length; i++) {
              var m = markersByIcao[icaos[i]];
              var cached = metarCache[icaos[i]];
              var cat = cached ? cached.fltCat : null;
              m.setIcon(createMarkerIcon(m._airportType, m._airportCode, cat, zoom));
            }
          }
        }

        updateLayerVisibility();
        map.on('zoomend', updateLayerVisibility);

        if (app.layerControl) {
          Object.keys(TYPE_CONFIG).forEach(function (type) {
            var config = TYPE_CONFIG[type];
            app.layerControl.addOverlay(typeLayers[type], config.label);
          });

          // Add METAR layer (starts off)
          setupMetarLayer(map, app.layerControl, data, markersByIcao, typeLayers);
        }

        // Fetch METAR when any airport popup opens + trigger range circle
        map.on('popupopen', function (e) {
          var popup = e.popup;
          var el = popup.getElement();
          if (!el) return;
          var metarDiv = el.querySelector('.popup-metar');
          if (!metarDiv) return;
          var icao = metarDiv.getAttribute('data-icao');
          if (icao) fetchMetarForPopup(metarDiv, icao);

          var tafDiv = el.querySelector('.popup-taf');
          if (tafDiv) {
            var tafIcao = tafDiv.getAttribute('data-icao');
            if (tafIcao) fetchTafForPopup(tafDiv, tafIcao);
          }

          // Set range origin to the airport location (skip in route mode)
          var source = popup._source;
          if (source && source.getLatLng && window.AirportApp.setRangeOrigin && !window.AirportApp.routeMode) {
            window.AirportApp.setRangeOrigin(source.getLatLng());
          }
        });

        app.typeLayers = typeLayers;
        app.airportData = data;

        console.log('Airport markers ready');
      })
      .catch(function (err) {
        console.error('Error loading airports:', err);
      });
  }

  window.AirportApp = window.AirportApp || {};
  window.AirportApp.loadAirports = loadAirports;
  window.AirportApp.TAF_API = TAF_API;
  window.AirportApp.CORS_PROXY = CORS_PROXY;
  window.AirportApp.tafCache = tafCache;
  window.AirportApp.calcFlightCat = calcFlightCat;
  window.AirportApp.parseTafVisib = parseTafVisib;
  window.AirportApp.tafCeiling = tafCeiling;
  window.AirportApp.metarCache = metarCache;
  window.AirportApp.metarCacheTime = metarCacheTime;
  window.AirportApp.tafCacheTime = tafCacheTime;
  window.AirportApp.isStale = isStale;
  window.AirportApp.METAR_API = METAR_API;
  window.AirportApp.parseMetar = parseMetar;
  window.AirportApp.METAR_CAT = METAR_CAT;
  window.AirportApp.METAR_LETTER = METAR_LETTER;
  window.AirportApp.isStrongWind = isStrongWind;
  window.AirportApp.WIND_SVG = WIND_SVG;

  if (window.AirportApp.map && window.AirportApp.layerControl) {
    loadAirports();
  }
})();
