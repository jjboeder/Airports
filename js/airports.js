/* airports.js - Airport data loading, markers with ICAO labels, click popups, METAR layer */

(function () {
  'use strict';

  // Airport type configuration: color and marker size
  var TYPE_CONFIG = {
    'large_airport':   { color: '#e74c3c', size: 12, label: 'Large airports', fontSize: 12, minZoom: 0 },
    'medium_airport':  { color: '#3498db', size: 12, label: 'Medium airports', fontSize: 12, minZoom: 6 },
    'small_airport':   { color: '#27ae60', size: 12, label: 'Small airports', fontSize: 12, minZoom: 8 }
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

  var OWM_PROXY = 'https://owm-proxy.jjboeder.workers.dev';
  var METAR_API = OWM_PROXY + '/metar';
  var TAF_API = OWM_PROXY + '/taf';
  var AR_METARTAF_API = OWM_PROXY + '/ar/metartaf/';

  // Lentopaikat.fi ICAO → slug mapping (loaded at startup)
  var lentopaikatMap = null;

  // Shared METAR cache: icao → parsed metar object
  var metarCache = {};
  // TAF cache: icao → taf json
  var tafCache = {};
  // Raw TAF text cache from autorouter combo endpoint
  var rawTafCache = {};
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
  function windTitle(wdir, wspd, wgst) {
    var s = '';
    if (wdir != null) s += (wdir === 'VRB' ? 'VRB' : wdir + '\u00B0');
    if (wspd != null) s += (s ? '/' : '') + wspd + 'kt';
    if (wgst) s += ' G' + wgst + 'kt';
    return s;
  }

  // Inline SVG wind icon (two flowing lines with curls)
  var WIND_SVG = '<svg class="wind-svg" viewBox="0 0 24 14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M1 4h11a3 3 0 1 0-3-3"/><path d="M1 10h15a3 3 0 1 1-3 3"/></svg>';

  // Inline SVG wind shear icon (zigzag arrow)
  var WS_SVG = '<svg class="ws-svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="2,12 5,4 8,10 11,2"/><polyline points="9,2 11,2 11,4"/></svg>';

  // Detect wind shear between base wind and a TEMPO/PROB overlay
  // Returns description string or null if no significant shear
  function detectWindShear(baseDir, baseSpd, tempoDir, tempoSpd, tempoGst) {
    if (baseSpd == null && tempoSpd == null) return null;
    var bs = baseSpd || 0;
    var ts = tempoSpd || 0;
    // Speed shear: difference >= 10kt
    var spdDelta = Math.abs(ts - bs);
    // Direction shear: >= 60° with at least 8kt on both sides
    var dirDelta = 0;
    if (baseDir != null && tempoDir != null && baseDir !== 'VRB' && tempoDir !== 'VRB' && bs >= 8 && ts >= 8) {
      dirDelta = Math.abs(tempoDir - baseDir);
      if (dirDelta > 180) dirDelta = 360 - dirDelta;
    }
    // Gust shear: gusts exceed sustained by >= 15kt
    var gustDelta = (tempoGst && ts) ? tempoGst - ts : 0;
    if (spdDelta >= 10 || dirDelta >= 60 || gustDelta >= 15) {
      return windTitle(baseDir, baseSpd, null) + ' \u2192 ' + windTitle(tempoDir, tempoSpd, tempoGst);
    }
    return null;
  }

  // Inline SVG ice crystal icon
  var ICE_SVG = '<svg class="ice-svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="8" y1="1" x2="8" y2="15"/><line x1="1" y1="8" x2="15" y2="8"/><line x1="3" y1="3" x2="13" y2="13"/><line x1="13" y1="3" x2="3" y2="13"/><line x1="8" y1="1" x2="6" y2="3"/><line x1="8" y1="1" x2="10" y2="3"/><line x1="8" y1="15" x2="6" y2="13"/><line x1="8" y1="15" x2="10" y2="13"/></svg>';

  // Inline SVG NOTAM square icon with "N"
  var NOTAM_SVG = '<svg class="notam-svg" viewBox="0 0 16 16"><rect x="1" y="1" width="14" height="14" rx="2" fill="currentColor"/><text x="8" y="12.5" text-anchor="middle" font-size="11" font-weight="700" font-family="sans-serif" fill="#fff">N</text></svg>';

  // NOTAM API via worker proxy

  // NOTAM cache: icao → parsed notam data
  var notamCache = {};
  var notamCacheTime = {};
  var NOTAM_CACHE_MAX_AGE = 30 * 60 * 1000; // 30 minutes
  var chartsCache = {}; // icao → airport docs JSON

  // OpenAIP airport cache: icao → { data, time }
  var openaipCache = {};
  var OPENAIP_CACHE_AGE = 60 * 60 * 1000; // 1 hour

  var FUEL_LABELS = {
    0: 'Super PLUS', 1: 'AVGAS', 2: 'Jet A', 3: 'JET A-1',
    4: 'Jet B', 5: 'Diesel', 6: 'AVGAS UL91'
  };

  var HANDLING_LABELS = {
    0: 'Cargo', 1: 'De-icing', 2: 'Maintenance', 3: 'Security', 4: 'Shelter'
  };

  var PASSENGER_LABELS = {
    0: 'Bank', 1: 'Post Office', 2: 'Customs', 3: 'Lodging',
    4: 'Medical', 5: 'Restaurant', 6: 'Sanitation', 7: 'Transport',
    8: 'Laundry', 9: 'Camping'
  };

  var IAA_LABELS = {
    0: 'ILS', 1: 'LOC', 2: 'LDA', 3: 'Locator', 4: 'DME', 5: 'GP'
  };

  var VAA_LABELS = {
    0: 'VASI', 1: 'PAPI', 2: 'T-VASI', 3: 'P-VASI', 4: 'AEOS'
  };

  var SURFACE_COMP = {
    0: 'Asphalt', 1: 'Concrete', 2: 'Grass', 3: 'Sand', 4: 'Water',
    5: 'Macadam', 6: 'Stone', 7: 'Coral', 8: 'Clay', 9: 'Laterite',
    10: 'Gravel', 11: 'Earth', 12: 'Ice', 13: 'Snow', 14: 'Rubber',
    15: 'Metal', 16: 'Landing Mat', 17: 'PSP', 18: 'Wood', 19: 'Non-Bituminous'
  };

  var SURFACE_COND = { 0: 'Good', 1: 'Fair', 2: 'Poor', 3: 'Unsafe', 4: 'Deformed' };

  // Look up an OpenAIP runway by end designator
  function findOaipRunway(icao, desig) {
    var cached = openaipCache[icao];
    if (!cached || !cached.data || !cached.data.runways) return null;
    var norm = desig.replace(/^0/, '');
    for (var i = 0; i < cached.data.runways.length; i++) {
      var d = cached.data.runways[i].designator || '';
      if (d === desig || d.replace(/^0/, '') === norm) return cached.data.runways[i];
    }
    return null;
  }

  // Build aids HTML for a runway end designator (e.g. "04R") from OpenAIP data
  function buildAidsHtml(icao, desig) {
    var rw = findOaipRunway(icao, desig);
    if (!rw) return '';
    var html = '';
    var iaa = rw.instrumentApproachAids || [];
    for (var a = 0; a < iaa.length; a++) {
      var aid = iaa[a];
      var label = IAA_LABELS[aid.type] || 'NAV';
      if (aid.identifier) label += ' ' + aid.identifier;
      if (aid.frequency && aid.frequency.value) label += ' ' + aid.frequency.value;
      html += '<span class="oaip-ils">' + escapeHtml(label) + '</span>';
    }
    var vaa = rw.visualApproachAids || [];
    for (var v = 0; v < vaa.length; v++) {
      html += '<span class="oaip-visual">' + escapeHtml(VAA_LABELS[vaa[v]] || 'Visual') + '</span>';
    }
    if (rw.pilotCtrlLighting) {
      html += '<span class="oaip-service">PCL</span>';
    }
    return html;
  }

  // Build surface detail HTML from OpenAIP runway data (condition + PCN)
  function buildSurfaceDetail(icao, desig) {
    var rw = findOaipRunway(icao, desig);
    if (!rw || !rw.surface) return '';
    var html = '';
    var cond = rw.surface.condition;
    if (cond != null && cond !== 0) { // 0 = Good (don't show)
      var condLabel = SURFACE_COND[cond] || 'Unknown';
      var condClass = cond >= 2 ? 'oaip-cond-warn' : 'oaip-cond';
      html += ' <span class="' + condClass + '">' + condLabel + '</span>';
    }
    return html;
  }

  function isNotamStale(icao) {
    var t = notamCacheTime[icao];
    return !t || (Date.now() - t > NOTAM_CACHE_MAX_AGE);
  }

  // --- Fetch NOTAMs via worker proxy ---
  function fetchNotams(icao) {
    return fetch(OWM_PROXY + '/notams?icao=' + encodeURIComponent(icao))
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      });
  }

  // --- Parse and classify NOTAMs ---
  var NOTAM_CRITICAL_RE = /\b(CLSD|CLOSED|RESTRICTED|PROHIBITED|DANGER)\b/i;
  var NOTAM_NAVAID_US_RE = /\b(ILS|VOR|NDB|DME|LOC|GP)\b.*\bU\/S\b/i;

  function parseNotamResponse(json) {
    var result = { count: 0, hasCritical: false, notams: [] };
    if (!json || !json.notamList) return result;

    var list = json.notamList;
    result.count = json.totalNotamCount || list.length;

    for (var i = 0; i < list.length; i++) {
      var raw = list[i];
      var text = raw.icaoMessage || raw.traditionalMessage || raw.notamText || '';
      if (!text && typeof raw === 'string') text = raw;
      var id = raw.notamNumber || raw.id || ('NOTAM-' + (i + 1));
      var isCritical = NOTAM_CRITICAL_RE.test(text) || NOTAM_NAVAID_US_RE.test(text);
      if (isCritical) result.hasCritical = true;
      result.notams.push({ id: id, text: text, isCritical: isCritical });
    }

    return result;
  }

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

  // Color helpers for individual ceiling/visibility values
  function ceilColor(ft) {
    if (ft == null) return '#27ae60'; // no ceiling = clear
    if (ft > 3000) return '#27ae60';
    if (ft >= 1000) return '#3498db';
    if (ft >= 600) return '#e67e22';
    if (ft >= 500) return '#e74c3c';
    return '#9b59b6';
  }

  function visColor(m) {
    if (m == null) return '#888';
    if (m > 8000) return '#27ae60';
    if (m >= 5000) return '#3498db';
    if (m >= 1500) return '#e67e22';
    return '#9b59b6';
  }

  function fmtVis(m) {
    if (m == null) return '?';
    if (m >= 9999) return '10km+';
    if (m >= 1000) {
      var km = m / 1000;
      return (km === Math.floor(km) ? km.toFixed(0) : km.toFixed(1)) + 'km';
    }
    return m + 'm';
  }

  function fmtCeil(ft) {
    if (ft == null) return 'CLR';
    return ft + 'ft';
  }

  // Decode METAR weather codes to plain English
  var WX_INTENSITY = { '-': 'Light ', '+': 'Heavy ', '': '' };
  var WX_DESC = {
    MI: 'shallow ', BC: 'patches of ', PR: 'partial ', DR: 'drifting ',
    BL: 'blowing ', SH: 'showers of ', TS: 'thunderstorm ', FZ: 'freezing '
  };
  var WX_PHENOM = {
    DZ: 'drizzle', RA: 'rain', SN: 'snow', SG: 'snow grains',
    PL: 'ice pellets', GR: 'hail', GS: 'small hail', UP: 'unknown precip',
    BR: 'mist', FG: 'fog', FU: 'smoke', VA: 'volcanic ash',
    DU: 'dust', SA: 'sand', HZ: 'haze', PY: 'spray',
    PO: 'dust whirls', SQ: 'squall', FC: 'funnel cloud',
    SS: 'sandstorm', DS: 'dust storm'
  };

  function decodeWx(code) {
    if (!code) return code;
    var m = code.match(/^([+-]?)(?:VC)?(MI|BC|PR|DR|BL|SH|TS|FZ)?((?:DZ|RA|SN|SG|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS)+)$/);
    if (!m) return code;
    var intensity = WX_INTENSITY[m[1]] || '';
    var desc = m[2] ? (WX_DESC[m[2]] || '') : '';
    // Extract all 2-char phenomenon codes from the group
    var phenoms = [];
    var rest = m[3];
    while (rest.length >= 2) {
      var p = rest.substring(0, 2);
      if (WX_PHENOM[p]) phenoms.push(WX_PHENOM[p]);
      else phenoms.push(p);
      rest = rest.substring(2);
    }
    var text = intensity + desc + phenoms.join('/');
    if (code.indexOf('VC') >= 0) text += ' in vicinity';
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  // Build base HTML tooltip (used for both plain and METAR tooltips)
  function baseTipHtml(code, row) {
    return '<div class="metar-tip">' +
      '<div class="metar-tip-hdr">' + code + ' ' + (row[COL.name] || '') + '</div>' +
      (row[COL.elevation] ? '<div class="metar-tip-elev">' + row[COL.elevation] + ' ft</div>' : '') +
      '</div>';
  }

  // --- Simple METAR parser ---
  function parseMetar(raw) {
    if (!raw || typeof raw !== 'string') return null;
    var result = { rawOb: raw.trim(), fltCat: null };
    var tokens = raw.trim().split(/\s+/);

    // Observation time: ddHHmmZ (e.g. 121920Z)
    for (var i = 0; i < tokens.length; i++) {
      var tm = tokens[i].match(/^(\d{2})(\d{2})(\d{2})Z$/);
      if (tm) {
        var now = new Date();
        var obsDay = parseInt(tm[1], 10);
        var obsH = parseInt(tm[2], 10);
        var obsM = parseInt(tm[3], 10);
        var obs = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), obsDay, obsH, obsM, 0));
        // Handle month rollover (obs day > current day = last month)
        if (obs.getTime() > now.getTime() + 86400000) {
          obs.setUTCMonth(obs.getUTCMonth() - 1);
        }
        result.obsTime = obs.getTime();
        break;
      }
    }

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

    // Weather phenomena: [+-]?(VC)?(MI|BC|PR|DR|BL|SH|TS|FZ)?(DZ|RA|SN|SG|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS)+
    var wxPattern = /^([+-]?)(?:VC)?((?:MI|BC|PR|DR|BL|SH|TS|FZ)?(?:DZ|RA|SN|SG|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS)+)$/;
    var wx = [];
    for (var i = 0; i < tokens.length; i++) {
      if (wxPattern.test(tokens[i])) {
        wx.push(tokens[i]);
      }
    }
    result.wx = wx;

    // Flight category based on ceiling and visibility
    result.fltCat = calcFlightCat(ceiling, visM);

    return result;
  }

  // Icing risk detection
  function isIcingRisk(metar) {
    if (!metar) return false;

    // Severe icing: freezing rain or freezing drizzle — always flag
    var wx = metar.wx || [];
    for (var i = 0; i < wx.length; i++) {
      if (wx[i].indexOf('FZ') >= 0) return true;
    }

    var temp = metar.temp;
    if (temp == null) return false;

    // Temperature must be in icing range: -20°C to +2°C
    if (temp < -20 || temp > 2) return false;

    // Check for precipitation
    var precipTypes = ['RA', 'SN', 'DZ', 'PL', 'SG', 'GR', 'GS'];
    for (var i = 0; i < wx.length; i++) {
      for (var j = 0; j < precipTypes.length; j++) {
        if (wx[i].indexOf(precipTypes[j]) >= 0) return true;
      }
    }

    // Check for low clouds with near-saturation (temp/dewpoint spread ≤ 3°C)
    var ceiling = metar.ceiling;
    var dewp = metar.dewp;
    if (ceiling != null && ceiling <= 5000 && dewp != null) {
      if (Math.abs(temp - dewp) <= 3) return true;
    }

    return false;
  }

  // Icing risk from TAF hourly data: uses wxStr + ceiling, with METAR temp as proxy
  function isTafHourIcingRisk(hour, metarTemp, metarDewp) {
    if (!hour || !hour.wxStr) {
      // No weather string — check low cloud + near-saturation with METAR temp
      if (metarTemp != null && metarTemp >= -20 && metarTemp <= 2 &&
          hour && hour.ceiling != null && hour.ceiling <= 5000 &&
          metarDewp != null && Math.abs(metarTemp - metarDewp) <= 3) {
        return true;
      }
      return false;
    }
    var wx = hour.wxStr;
    // Freezing precip always flags
    if (wx.indexOf('FZ') >= 0) return true;
    // Other precip needs icing-range temp (use METAR as proxy)
    if (metarTemp == null) return false;
    if (metarTemp < -20 || metarTemp > 2) return false;
    var precipTypes = ['RA', 'SN', 'DZ', 'PL', 'SG', 'GR', 'GS'];
    for (var i = 0; i < precipTypes.length; i++) {
      if (wx.indexOf(precipTypes[i]) >= 0) return true;
    }
    // Low clouds + near-saturation
    if (hour.ceiling != null && hour.ceiling <= 5000 && metarDewp != null && Math.abs(metarTemp - metarDewp) <= 3) {
      return true;
    }
    return false;
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

    // --- Tab row ---
    var icaoSafe = escapeHtml(gpsCode || ident);
    var icaoRaw = gpsCode || ident;
    var icaoEnc = encodeURIComponent(icaoRaw);
    html += '<div class="popup-extra-tabs">';
    html += '<button class="popup-extra-tab active" data-panel="popup-info">Info</button>';
    html += '<button class="popup-extra-tab" data-panel="popup-taf">TAF</button>';
    html += '<button class="popup-extra-tab" data-panel="popup-weather">Weather</button>';
    html += '<button class="popup-extra-tab" data-panel="popup-notam">NOTAMs</button>';
    html += '<button class="popup-extra-tab" data-panel="popup-charts">Charts</button>';
    html += '<button class="popup-extra-tab" data-panel="popup-airgram">Airgram</button>';
    html += '<button class="popup-extra-tab" data-panel="popup-briefing">Briefing</button>';
    html += '</div>';

    // --- Info tab (default open) ---
    html += '<div class="popup-info popup-extra-content">';
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
    html += '</div>';
    if (runways.length > 0) {
      html += '<table class="runway-table" data-icao="' + escapeHtml(gpsCode || ident) + '"><thead><tr><th>RWY</th><th>Length</th><th>Width</th><th>Surface</th><th class="rwy-aids-th">Aids</th></tr></thead><tbody>';
      for (var ri = 0; ri < runways.length; ri++) {
        var rwy = runways[ri];
        var ends = parseRunwayEnds(rwy[RWY.designator]);
        var span = ends.length || 1;
        for (var ej = 0; ej < ends.length; ej++) {
          html += '<tr>';
          html += '<td>' + escapeHtml(ends[ej].name) + '</td>';
          if (ej === 0) {
            html += '<td rowspan="' + span + '">' + ftToM(rwy[RWY.length]) + '</td>';
            html += '<td rowspan="' + span + '">' + ftToM(rwy[RWY.width]) + '</td>';
            html += '<td rowspan="' + span + '">' + escapeHtml(rwy[RWY.surface]) + '</td>';
          }
          html += '<td class="rwy-aids-cell" data-desig="' + escapeHtml(ends[ej].name) + '"></td>';
          html += '</tr>';
        }
      }
      html += '</tbody></table>';
    }
    html += '<div class="popup-links">';
    html += '<a class="popup-link aip-link" data-icao="' + escapeHtml(icaoRaw) + '" style="display:none" target="_blank" rel="noopener">AIP</a>';
    html += '<a href="https://www.google.com/search?q=' + icaoEnc + '+airport" target="_blank" rel="noopener" class="popup-link google-link">Google</a>';
    html += '<a href="https://skyvector.com/airport/' + icaoEnc + '" target="_blank" rel="noopener" class="popup-link sv-link">SkyVector</a>';
    html += '<a href="https://ourairports.com/airports/' + icaoEnc + '/" target="_blank" rel="noopener" class="popup-link oa-link">OurAirports</a>';
    html += '<a href="https://www.windy.com/' + lat + '/' + lon + '?detail=true" target="_blank" rel="noopener" class="popup-link windy-link">Windy</a>';
    if (lentopaikatMap && lentopaikatMap[icaoRaw]) {
      html += '<a href="https://lentopaikat.fi/' + lentopaikatMap[icaoRaw] + '/" target="_blank" rel="noopener" class="popup-link lp-link">Lentopaikat</a>';
    }
    html += '</div>';
    html += '</div>';

    // --- TAF / Weather / NOTAMs / Charts / Airgram tabs ---
    html += '<div class="popup-taf popup-extra-content" data-icao="' + icaoSafe + '" style="display:none;"></div>';
    html += '<div class="popup-weather popup-extra-content" data-lat="' + lat + '" data-lon="' + lon + '" style="display:none;"></div>';
    html += '<div class="popup-notam popup-extra-content" data-icao="' + icaoSafe + '" style="display:none;"></div>';
    html += '<div class="popup-charts popup-extra-content" data-icao="' + icaoSafe + '" style="display:none;"></div>';
    html += '<div class="popup-airgram popup-extra-content" data-lat="' + lat + '" data-lon="' + lon + '" data-elev="' + (elevation || 0) + '" style="display:none;"></div>';
    html += '<div class="popup-briefing popup-extra-content" data-icao="' + icaoSafe + '" data-name="' + escapeHtml(name) + '" data-elev="' + (elevation || 0) + '" data-lat="' + lat + '" data-lon="' + lon + '" style="display:none;"></div>';

    html += '</div>';
    return html;
  }

  // --- Render airport charts into popup ---
  var CHART_SECTIONS = ['Airport', 'Departure', 'Arrival', 'Approach', 'VFR'];
  var CHART_ICONS = { Airport: '\u2708', Departure: '\u2197', Arrival: '\u2198', Approach: '\u2B07', VFR: '\u2600' };

  function formatFileSize(bytes) {
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
    return Math.round(bytes / 1024) + ' KB';
  }

  function shortenHeading(heading, icao) {
    // Strip common prefixes like "AD 2 EFHK "
    var short = heading.replace(/^AD 2 [A-Z]{4}\s*/i, '').replace(/ - ICAO$/i, '');
    return short || 'Aerodrome Info (AIP)';
  }

  function findAipDoc(icao, data) {
    var docs = data && data['Airport'] || [];
    var pat = new RegExp('^AD 2 ' + icao + '$', 'i');
    for (var i = 0; i < docs.length; i++) {
      if (pat.test(docs[i].heading)) return docs[i];
    }
    return null;
  }

  function showAipLink(linkEl, icao, data) {
    var doc = findAipDoc(icao, data);
    if (doc) {
      linkEl.href = OWM_PROXY + '/ar/airport-doc/' + (doc.docid || doc.id) + '?icao=' + encodeURIComponent(icao);
      linkEl.style.display = '';
    }
  }

  function renderChartsInPopup(el, icao, data) {
    if (!data) { el.innerHTML = '<span class="info-unknown">No charts available</span>'; return; }

    var aipDoc = findAipDoc(icao, data);

    var html = '<div class="charts-container">';


    for (var s = 0; s < CHART_SECTIONS.length; s++) {
      var section = CHART_SECTIONS[s];
      var docs = data[section];
      if (!docs || docs.length === 0) continue;

      // Filter out the AIP doc from the Airport section
      var filteredDocs = docs;
      if (section === 'Airport' && aipDoc) {
        filteredDocs = [];
        for (var f = 0; f < docs.length; f++) {
          if (docs[f] !== aipDoc) filteredDocs.push(docs[f]);
        }
        if (filteredDocs.length === 0) continue;
      }

      var icon = CHART_ICONS[section] || '';
      html += '<div class="charts-section">';
      html += '<div class="charts-section-hdr" data-section="' + section + '">'
        + icon + ' ' + escapeHtml(section) + ' <span class="charts-count">(' + filteredDocs.length + ')</span>'
        + '<span class="charts-chevron">\u25B8</span></div>';
      html += '<div class="charts-section-list" style="display:none;">';

      for (var d = 0; d < filteredDocs.length; d++) {
        var doc = filteredDocs[d];
        var title = shortenHeading(doc.heading || doc.filename || '', icao);
        var size = formatFileSize(doc.filesize || 0);
        html += '<a href="' + OWM_PROXY + '/ar/airport-doc/' + (doc.docid || doc.id)
          + '?icao=' + encodeURIComponent(icao) + '" target="_blank" rel="noopener" class="charts-doc">'
          + '<span class="charts-doc-name">' + escapeHtml(title) + '</span>'
          + '<span class="charts-doc-size">' + size + '</span></a>';
      }

      html += '</div></div>';
    }

    html += '</div>';
    el.innerHTML = html;

    // Wire up section toggles
    var hdrs = el.querySelectorAll('.charts-section-hdr');
    for (var i = 0; i < hdrs.length; i++) {
      hdrs[i].addEventListener('click', function () {
        var list = this.nextElementSibling;
        var chevron = this.querySelector('.charts-chevron');
        if (list.style.display === 'none') {
          list.style.display = '';
          chevron.textContent = '\u25BE';
        } else {
          list.style.display = 'none';
          chevron.textContent = '\u25B8';
        }
      });
    }
  }

  // --- OpenAIP popup enrichment ---

  // Map OpenAIP frequency name to short label
  var OAIP_FREQ_TYPE_MAP = { 0: 'APP', 1: 'APRON', 5: 'DEL', 9: 'GND', 13: 'RADAR', 14: 'TWR', 15: 'ATIS', 17: 'TWR' };
  function oaipFreqLabel(f) {
    var name = (f.name || '').toUpperCase();
    if (name.indexOf('TOWER') >= 0) return 'TWR';
    if (name.indexOf('GROUND') >= 0 || name.indexOf('GND') >= 0) return 'GND';
    if (name.indexOf('DELIVERY') >= 0 || name.indexOf('CLNC') >= 0) return 'DEL';
    if (name.indexOf('ATIS') >= 0) return 'ATIS';
    if (name.indexOf('RADAR') >= 0) return 'RADAR';
    if (name.indexOf('APPROACH') >= 0 || name.indexOf(' APP') >= 0) return 'APP';
    if (name.indexOf('DEPARTURE') >= 0 || name.indexOf(' DEP') >= 0) return 'DEP';
    if (name.indexOf('AFIS') >= 0) return 'AFIS';
    if (name.indexOf('APRON') >= 0) return 'APRON';
    if (name.indexOf('INFO') >= 0) return 'INFO';
    return OAIP_FREQ_TYPE_MAP[f.type] || f.name || 'COMM';
  }

  // Update marker frequency data from OpenAIP (no popup needed)
  function enrichFreqsFromOpenAip(icao, data) {
    var oaipFreqs = data && data.frequencies;
    if (!oaipFreqs || oaipFreqs.length === 0) return;
    var newFreqs = [];
    for (var i = 0; i < oaipFreqs.length; i++) {
      newFreqs.push([oaipFreqLabel(oaipFreqs[i]), oaipFreqs[i].value]);
    }
    var app = window.AirportApp;
    var marker = app && app.markersByIcao && app.markersByIcao[icao];
    if (marker && marker._airportData) {
      marker._airportData[COL.frequencies] = newFreqs;
    }
  }

  // Fetch OpenAIP data for an airport and update marker frequencies (headless, no popup)
  function fetchOpenAipFreqs(icao) {
    var cached = openaipCache[icao];
    if (cached && (Date.now() - cached.time < OPENAIP_CACHE_AGE)) {
      if (cached.data) enrichFreqsFromOpenAip(icao, cached.data);
      return;
    }
    fetch(OWM_PROXY + '/airport?icao=' + encodeURIComponent(icao))
      .then(function (res) { return res.json(); })
      .then(function (data) {
        openaipCache[icao] = { data: data, time: Date.now() };
        if (data) enrichFreqsFromOpenAip(icao, data);
      })
      .catch(function () {});
  }

  function fetchOpenAipForPopup(popupEl, icao) {
    var cached = openaipCache[icao];
    if (cached && (Date.now() - cached.time < OPENAIP_CACHE_AGE)) {
      if (cached.data) enrichInfoTab(popupEl, icao, cached.data);
      return;
    }
    fetch(OWM_PROXY + '/airport?icao=' + encodeURIComponent(icao))
      .then(function (res) { return res.json(); })
      .then(function (data) {
        openaipCache[icao] = { data: data, time: Date.now() };
        if (data) enrichInfoTab(popupEl, icao, data);
      })
      .catch(function () { /* graceful degradation */ });
  }

  function enrichInfoTab(popupEl, icao, data) {
    var infoGrid = popupEl.querySelector('.popup-info-grid');
    if (!infoGrid) return;

    // 0. Replace frequencies with OpenAIP data (more accurate than OurAirports)
    var oaipFreqs = data.frequencies;
    if (oaipFreqs && oaipFreqs.length > 0) {
      var newFreqs = [];
      for (var fi = 0; fi < oaipFreqs.length; fi++) {
        var of = oaipFreqs[fi];
        newFreqs.push([oaipFreqLabel(of), of.value]);
      }
      // Update the marker data so route planner also picks up correct frequencies
      var app = window.AirportApp;
      var marker = app && app.markersByIcao && app.markersByIcao[icao];
      if (marker && marker._airportData) {
        marker._airportData[COL.frequencies] = newFreqs;
      }
      // Update popup freq display
      var freqRow = infoGrid.querySelector('.info-row-freqs');
      if (freqRow) {
        var freqHtml = '<span class="info-label">Freq</span><span class="info-value freq-list">';
        for (var fi = 0; fi < newFreqs.length; fi++) {
          freqHtml += '<span class="freq-item">' + escapeHtml(newFreqs[fi][0]) + ' ' + newFreqs[fi][1] + '</span>';
        }
        freqHtml += '</span>';
        freqRow.innerHTML = freqHtml;
      } else if (newFreqs.length > 0) {
        // No freq row existed (OurAirports had none) — add one after ATC row
        var atcRow = infoGrid.querySelector('.info-row');
        if (atcRow) {
          var newRow = document.createElement('div');
          newRow.className = 'info-row info-row-freqs';
          var freqHtml = '<span class="info-label">Freq</span><span class="info-value freq-list">';
          for (var fi = 0; fi < newFreqs.length; fi++) {
            freqHtml += '<span class="freq-item">' + escapeHtml(newFreqs[fi][0]) + ' ' + newFreqs[fi][1] + '</span>';
          }
          freqHtml += '</span>';
          newRow.innerHTML = freqHtml;
          atcRow.insertAdjacentElement('afterend', newRow);
        }
      }
    }

    // Find last existing row as insertion anchor
    var lastRow = null;
    var rows = infoGrid.querySelectorAll('.info-row');
    if (rows.length) lastRow = rows[rows.length - 1];

    // Helper: append a new info row at the end of the grid
    function addRow(label, valueHtml) {
      var row = document.createElement('div');
      row.className = 'info-row';
      row.innerHTML = '<span class="info-label">' + label + '</span><span class="info-value">' + valueHtml + '</span>';
      infoGrid.appendChild(row);
    }

    // 1. Status badges (VFR/IFR, PPR, Private)
    var statusBadges = '';
    var trafficType = data.trafficType || [];
    for (var t = 0; t < trafficType.length; t++) {
      if (trafficType[t] === 0) statusBadges += '<span class="oaip-badge oaip-vfr">VFR</span>';
      if (trafficType[t] === 1) statusBadges += '<span class="oaip-badge oaip-ifr">IFR</span>';
    }
    if (data.ppr) statusBadges += '<span class="oaip-badge oaip-ppr">PPR</span>';
    if (data.private) statusBadges += '<span class="oaip-badge oaip-private">PRIVATE</span>';
    if (statusBadges) addRow('Status', statusBadges);

    // 2. Fuel types
    if (data.services) {
      var fuelTypes = data.services.fuelTypes || [];
      if (fuelTypes.length === 0) {
        addRow('Fuel', '<span class="oaip-no-fuel">No fuel</span>');
      } else {
        var fuelHtml = '';
        for (var f = 0; f < fuelTypes.length; f++) {
          fuelHtml += '<span class="fuel-badge">' + escapeHtml(FUEL_LABELS[fuelTypes[f]] || ('Type ' + fuelTypes[f])) + '</span>';
        }
        addRow('Fuel', fuelHtml);
      }
    }

    // 3. Services (handling + passenger facilities)
    var services = [];
    if (data.services) {
      var handling = data.services.handlingFacilities || [];
      for (var h = 0; h < handling.length; h++) {
        services.push(HANDLING_LABELS[handling[h]] || ('Service ' + handling[h]));
      }
      var passenger = data.services.passengerFacilities || [];
      for (var p = 0; p < passenger.length; p++) {
        services.push(PASSENGER_LABELS[passenger[p]] || ('Facility ' + passenger[p]));
      }
    }
    if (services.length > 0) {
      var svcHtml = '';
      for (var s = 0; s < services.length; s++) {
        svcHtml += '<span class="oaip-service">' + escapeHtml(services[s]) + '</span>';
      }
      addRow('Services', svcHtml);
    }

    // 4. Skydive activity warning
    if (data.skydiveActivity) {
      addRow('Warning', '<span class="oaip-badge oaip-ppr">SKYDIVE ACTIVITY</span>');
    }

    // 5. Fill Aids cells in runway table
    var aidsCells = popupEl.querySelectorAll('.rwy-aids-cell[data-desig]');
    for (var i = 0; i < aidsCells.length; i++) {
      var desig = aidsCells[i].getAttribute('data-desig');
      aidsCells[i].innerHTML = buildAidsHtml(icao, desig);
    }
    // Case B: wind table already built (per-end rows without data-desig)
    var windTable = popupEl.querySelector('.runway-table-wind');
    if (windTable && !windTable.querySelector('.rwy-aids-th')) {
      var thead = windTable.querySelector('thead tr');
      if (thead) {
        var th = document.createElement('th');
        th.className = 'rwy-aids-th';
        th.textContent = 'Aids';
        thead.appendChild(th);
      }
      var bodyRows = windTable.querySelectorAll('tbody tr');
      for (var i = 0; i < bodyRows.length; i++) {
        var desigCell = bodyRows[i].querySelector('.rwy-wind-desig');
        if (!desigCell) continue;
        var endName = desigCell.childNodes[0] ? desigCell.childNodes[0].textContent.trim() : '';
        var td = document.createElement('td');
        td.className = 'rwy-aids-cell';
        td.innerHTML = buildAidsHtml(icao, endName);
        bodyRows[i].appendChild(td);
      }
    }

    // 6. Enrich surface cells with condition & PCN from OpenAIP
    var rwyTable = popupEl.querySelector('.runway-table[data-icao="' + icao + '"]');
    if (rwyTable) {
      var trs = rwyTable.querySelectorAll('tbody tr');
      for (var i = 0; i < trs.length; i++) {
        var aidsCell = trs[i].querySelector('.rwy-aids-cell[data-desig]');
        if (!aidsCell) continue;
        var endDesig = aidsCell.getAttribute('data-desig');
        var surfDetail = buildSurfaceDetail(icao, endDesig);
        if (surfDetail) {
          // Surface cell uses rowspan — find closest surface td (in this row or parent via rowspan)
          var surfTd = trs[i].querySelector('td:nth-child(4)');
          if (surfTd && !surfTd.classList.contains('rwy-aids-cell')) {
            surfTd.insertAdjacentHTML('beforeend', surfDetail);
          }
        }
      }
    }
  }

  // Format data age as human-readable string with staleness color
  // METAR: <30min green, 30-60min orange, >60min red
  // TAF: <2h green, 2-6h orange, >6h red
  function formatAge(epochMs, type) {
    if (!epochMs) return null;
    var ageMin = Math.round((Date.now() - epochMs) / 60000);
    if (ageMin < 0) ageMin = 0;
    var label;
    if (ageMin < 60) label = ageMin + 'min';
    else label = Math.floor(ageMin / 60) + 'h' + (ageMin % 60 ? (ageMin % 60) + 'm' : '');
    var color;
    if (type === 'taf') {
      color = ageMin < 120 ? '#27ae60' : ageMin < 360 ? '#e67e22' : '#e74c3c';
    } else {
      color = ageMin < 30 ? '#27ae60' : ageMin < 60 ? '#e67e22' : '#e74c3c';
    }
    return '<span class="data-age" style="color:' + color + ';" title="Data age">' + label + ' ago</span>';
  }

  // --- Render a METAR into the popup placeholder ---
  function renderMetarInPopup(el, metar) {
    if (!metar) {
      el.innerHTML = '<span class="info-unknown">No METAR available</span>';
      return;
    }
    var cat = METAR_CAT[metar.fltCat] || { color: '#888', label: metar.fltCat || '?' };

    var metarAge = formatAge(metar.obsTime, 'metar');
    var html = '';
    if (metarAge) html += '<div class="data-age-wrap">' + metarAge + '</div>';
    html += '<span class="metar-cat" style="background:' + cat.color + ';">' + cat.label + '</span>';
    if (isStrongWind(metar.wspd, metar.wgst)) {
      html += ' <span class="wind-badge" title="' + escapeHtml(windTitle(metar.wdir, metar.wspd, metar.wgst)) + '">' + WIND_SVG + '</span>';
    }
    if (isIcingRisk(metar)) {
      html += ' <span class="ice-badge">' + ICE_SVG + '</span>';
    }

    // Decoded summary as chips (before raw METAR)
    var chips = [];
    if (metar.wdir != null && metar.wspd != null) {
      var wind = (metar.wdir === 'VRB' ? 'VRB' : metar.wdir + '\u00B0') + '/' + metar.wspd + 'kt';
      if (metar.wgst) wind += ' G' + metar.wgst;
      chips.push('Wind ' + wind);
    }
    if (metar.visib != null) {
      if (metar.visib >= 9999) chips.push('Vis 10+km');
      else chips.push('Vis ' + (metar.visib >= 1000 ? (metar.visib / 1000).toFixed(1) + 'km' : metar.visib + 'm'));
    }
    if (metar.ceiling != null) {
      chips.push('Ceil ' + metar.ceiling + 'ft');
    } else if (metar.clouds && metar.clouds.length === 0) {
      chips.push('Ceil CLR');
    }
    if (metar.wx && metar.wx.length > 0) chips.push(metar.wx.map(decodeWx).join(', '));
    if (metar.temp != null) {
      var tempStr = metar.temp + '\u00B0C';
      if (metar.dewp != null) tempStr += '/' + metar.dewp + '\u00B0C';
      chips.push(tempStr);
    }
    if (metar.altim != null) chips.push('QNH ' + metar.altim);
    if (chips.length > 0) {
      html += '<div class="wx-chips metar-chips">';
      for (var ci = 0; ci < chips.length; ci++) {
        html += '<span class="wx-chip">' + chips[ci] + '</span>';
      }
      html += '</div>';
    }

    html += '<div class="metar-raw">' + escapeHtml(metar.rawOb) + '</div>';
    el.innerHTML = html;

    // Update runway wind components in the same popup
    var icao = el.getAttribute('data-icao');
    if (icao) {
      var popup = el.closest('.popup-content');
      if (popup) renderRunwayWind(popup, icao);
    }
  }

  // --- Runway diagram SVG for popup ---
  function buildRunwayDiagramSvg(runways) {
    if (!runways || !runways.length) return '';
    var svgW = 200, svgH = 200;
    var cx = svgW / 2, cy = svgH / 2;
    // Scale: longest runway ≈ 70px
    var maxLen = 0;
    for (var i = 0; i < runways.length; i++) {
      if (runways[i][RWY.length] > maxLen) maxLen = runways[i][RWY.length];
    }
    var sc = maxLen > 0 ? 70 / maxLen : 0.005;

    // Count parallels per heading
    var hCnt = {}, hIdx = {};
    for (var i = 0; i < runways.length; i++) {
      var pm = (runways[i][RWY.designator] || '').split('/')[0].trim().match(/^(\d{1,2})/);
      if (!pm) continue;
      var hk = (parseInt(pm[1], 10) * 10) % 180;
      hCnt[hk] = (hCnt[hk] || 0) + 1;
    }

    function r(v) { return Math.round(v * 10) / 10; }

    var svg = '<svg class="rwy-diagram" viewBox="0 0 ' + svgW + ' ' + svgH + '">';
    // North arrow
    svg += '<text x="' + svgW / 2 + '" y="14" font-size="10" fill="#999" text-anchor="middle" font-weight="600">N</text>';
    svg += '<line x1="' + svgW / 2 + '" y1="16" x2="' + svgW / 2 + '" y2="24" stroke="#bbb" stroke-width="1"/>';

    for (var i = 0; i < runways.length; i++) {
      var rwy = runways[i];
      var desig = rwy[RWY.designator] || '';
      var lenFt = rwy[RWY.length] || 0;
      var widFt = rwy[RWY.width] || 60;
      var parts = desig.split('/');
      var m0 = parts[0] ? parts[0].trim().match(/^(\d{1,2})/) : null;
      if (!m0) continue;
      var hdgDeg = parseInt(m0[1], 10) * 10;
      var hdgRad = hdgDeg * Math.PI / 180;
      var halfLen = lenFt * sc / 2;
      var rwyW = Math.max(widFt * sc, 3);

      // Parallel offset
      var hk = hdgDeg % 180;
      var nP = hCnt[hk] || 1;
      if (!hIdx[hk]) hIdx[hk] = 0;
      var pI = hIdx[hk]++;
      var latOff = 0;
      if (nP > 1) {
        latOff = (pI - (nP - 1) / 2) * halfLen * 0.4;
      }

      var dx = Math.sin(hdgRad), dy = -Math.cos(hdgRad);
      var perpDx = dy, perpDy = -dx;
      var ocx = cx + perpDx * latOff, ocy = cy - perpDy * latOff;
      var x1 = ocx - dx * halfLen, y1 = ocy - dy * halfLen;
      var x2 = ocx + dx * halfLen, y2 = ocy + dy * halfLen;

      // Runway strip
      svg += '<line x1="' + r(x1) + '" y1="' + r(y1) + '" x2="' + r(x2) + '" y2="' + r(y2)
        + '" stroke="#fff" stroke-width="' + r(rwyW + 2) + '" stroke-linecap="butt"/>';
      svg += '<line x1="' + r(x1) + '" y1="' + r(y1) + '" x2="' + r(x2) + '" y2="' + r(y2)
        + '" stroke="#555" stroke-width="' + r(rwyW) + '" stroke-linecap="butt"/>';
      svg += '<line x1="' + r(x1) + '" y1="' + r(y1) + '" x2="' + r(x2) + '" y2="' + r(y2)
        + '" stroke="#ccc" stroke-width="0.5" stroke-dasharray="3,3"/>';

      // Designators at each end
      for (var ep = 0; ep < parts.length; ep++) {
        var endName = parts[ep].trim();
        var ex = ep === 0 ? x1 : x2;
        var ey = ep === 0 ? y1 : y2;
        var outDir = ep === 0 ? -1 : 1;
        var tx = ex + outDir * dx * 12;
        var ty = ey + outDir * dy * 12;
        var textAngle = hdgDeg;
        if (ep === 1) textAngle = (hdgDeg + 180) % 360;
        if (textAngle > 90 && textAngle < 270) textAngle = (textAngle + 180) % 360;
        svg += '<text x="' + r(tx) + '" y="' + r(ty)
          + '" font-size="9" fill="#333" stroke="#fff" stroke-width="2" paint-order="stroke" font-weight="700" text-anchor="middle" dominant-baseline="central"'
          + ' transform="rotate(' + r(textAngle) + ' ' + r(tx) + ' ' + r(ty) + ')">'
          + escapeHtml(endName) + '</text>';
      }
    }
    svg += '</svg>';
    return '<div class="rwy-diagram-wrap">' + svg + '</div>';
  }

  // --- Runway wind components from METAR ---
  function parseRunwayEnds(designator) {
    // "04/22" → [{name:'04', hdg:40}, {name:'22', hdg:220}]
    // "09R/27L" → [{name:'09R', hdg:90}, {name:'27L', hdg:270}]
    var parts = designator.split('/');
    var ends = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      var m = p.match(/^(\d{1,2})/);
      if (m) {
        ends.push({ name: p, hdg: parseInt(m[1], 10) * 10 });
      }
    }
    return ends;
  }

  function renderRunwayWind(popupEl, icao) {
    var metar = metarCache[icao];
    if (!metar || metar.wdir == null || metar.wdir === 'VRB' || metar.wspd == null) return;

    var rwyTable = popupEl.querySelector('.runway-table[data-icao="' + icao + '"]');
    if (!rwyTable) return;
    // Don't re-render if already combined
    if (rwyTable.classList.contains('runway-table-wind')) return;

    // Collect runway data from the existing table rows (one end per row, rowspan for shared cols)
    var rows = rwyTable.querySelectorAll('tbody tr');
    var runways = []; // { length, width, surface, ends: [{name, hdg}] }
    for (var i = 0; i < rows.length; i++) {
      var tds = rows[i].querySelectorAll('td');
      var desig = tds[0].textContent.trim();
      var m = desig.match(/^(\d{1,2})/);
      if (!m) continue;
      var end = { name: desig, hdg: parseInt(m[1], 10) * 10 };
      if (tds.length >= 4) {
        // First end of a physical runway (has length/width/surface via rowspan)
        runways.push({
          length: tds[1].textContent.trim(),
          width: tds[2].textContent.trim(),
          surface: tds[3].textContent.trim(),
          ends: [end]
        });
      } else if (runways.length > 0) {
        // Second end (rowspanned — only desig + aids cells)
        runways[runways.length - 1].ends.push(end);
      }
    }
    if (runways.length === 0) return;

    var wdir = metar.wdir;
    var wspd = metar.wspd;
    var wgst = metar.wgst || 0;
    var DEG = Math.PI / 180;

    // Compute wind components for each runway end, track global best
    var allEnds = [];
    for (var r = 0; r < runways.length; r++) {
      for (var j = 0; j < runways[r].ends.length; j++) {
        var e = runways[r].ends[j];
        var angleDiff = (wdir - e.hdg) * DEG;
        e.headwind = wspd * Math.cos(angleDiff);
        e.crosswind = wspd * Math.sin(angleDiff);
        e.gustXwind = wgst > 0 ? wgst * Math.sin(angleDiff) : null;
        e.rwyIdx = r;
        allEnds.push(e);
      }
    }
    var bestIdx = 0, worstIdx = 0;
    var bestHeadwind = -Infinity, worstHeadwind = Infinity;
    for (var i = 0; i < allEnds.length; i++) {
      if (allEnds[i].headwind > bestHeadwind) { bestHeadwind = allEnds[i].headwind; bestIdx = i; }
      if (allEnds[i].headwind < worstHeadwind) { worstHeadwind = allEnds[i].headwind; worstIdx = i; }
    }
    var bestName = allEnds[bestIdx].name;
    var worstName = allEnds.length > 2 ? allEnds[worstIdx].name : null;

    // Check if OpenAIP aids data is available
    var hasAids = openaipCache[icao] && openaipCache[icao].data && openaipCache[icao].data.runways;

    // Build combined table replacing the original
    var html = '<table class="runway-table runway-table-wind">';
    html += '<thead><tr><th>RWY</th><th>Length</th><th>Surface</th><th>Head/Tail</th><th>Xwind</th>';
    if (hasAids) html += '<th class="rwy-aids-th">Aids</th>';
    html += '</tr></thead><tbody>';
    for (var r = 0; r < runways.length; r++) {
      var rw = runways[r];
      var ends = rw.ends;
      var span = ends.length || 1;
      for (var j = 0; j < ends.length; j++) {
        var e = ends[j];
        var isBest = (e.name === bestName);
        var isWorst = (e.name === worstName);
        var hw = Math.round(Math.abs(e.headwind));
        var xw = Math.round(Math.abs(e.crosswind));
        var hwLabel = e.headwind >= 0 ? 'Head ' + hw : 'Tail ' + hw;
        var hwClass = e.headwind >= 0 ? 'rwy-head' : 'rwy-tail';
        var xwSide = e.crosswind > 0.5 ? 'R' : (e.crosswind < -0.5 ? 'L' : '');
        var xwStr = xwSide + ' ' + xw + ' kt';
        if (e.gustXwind != null && Math.abs(e.gustXwind) > Math.abs(e.crosswind)) {
          xwStr += ' (G' + Math.round(Math.abs(e.gustXwind)) + ')';
        }
        var xwClass = xw > 15 ? 'rwy-xw-warn' : (xw > 10 ? 'rwy-xw-caution' : '');
        var rowClass = isBest ? 'rwy-active' : (isWorst ? 'rwy-worst' : '');
        var badge = isBest ? ' <span class="rwy-inuse">BEST</span>' : (isWorst ? ' <span class="rwy-worst-badge">WORST</span>' : '');

        html += '<tr class="' + rowClass + '">';
        html += '<td class="rwy-wind-desig">' + escapeHtml(e.name) + badge + '</td>';
        if (j === 0) {
          html += '<td rowspan="' + span + '">' + rw.length + '</td>';
          html += '<td rowspan="' + span + '">' + rw.surface + (hasAids ? buildSurfaceDetail(icao, ends[0].name) : '') + '</td>';
        }
        html += '<td class="' + hwClass + '">' + hwLabel + ' kt</td>';
        html += '<td class="' + xwClass + '">' + xwStr + '</td>';
        if (hasAids) html += '<td class="rwy-aids-cell">' + buildAidsHtml(icao, e.name) + '</td>';
        html += '</tr>';
      }
    }
    html += '</tbody></table>';

    // Replace the original runway table with the combined one
    rwyTable.outerHTML = html;
  }

  // --- Fetch single METAR for popup ---
  function fetchMetarForPopup(el, icao) {
    if (metarCache[icao] && !isStale(metarCacheTime, icao)) {
      renderMetarInPopup(el, metarCache[icao]);
      return;
    }
    el.innerHTML = '<span class="metar-loading">Loading METAR...</span>';
    fetch(METAR_API + '?ids=' + encodeURIComponent(icao))
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

  // --- Combo METAR+TAF from autorouter ---
  function fetchMetarTafCombo(metarEl, tafToggle, tafDiv, icao) {
    // If we have a fresh cached METAR, render it immediately
    if (metarCache[icao] && !isStale(metarCacheTime, icao)) {
      renderMetarInPopup(metarEl, metarCache[icao]);
      return;
    }
    metarEl.innerHTML = '<span class="metar-loading">Loading METAR...</span>';
    fetch(AR_METARTAF_API + encodeURIComponent(icao))
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (json) {
        // Parse and cache METAR
        if (json.metar) {
          var metar = parseMetar(json.metar);
          if (metar) {
            metarCache[icao] = metar;
            metarCacheTime[icao] = Date.now();
            renderMetarInPopup(metarEl, metar);
          } else {
            metarEl.innerHTML = '<span class="info-unknown">No METAR available</span>';
          }
        } else {
          metarEl.innerHTML = '<span class="info-unknown">No METAR available</span>';
        }
        // Cache raw TAF for immediate display when toggled
        if (json.taf) {
          rawTafCache[icao] = json.taf;
        }
      })
      .catch(function () {
        // Fall back to VATSIM METAR endpoint
        fetchMetarForPopup(metarEl, icao);
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

  // Check if weather string contains persistent phenomena (rule e)
  // Persistent: BR,FG,HZ,FU,DU,SA,RA,DZ,SN,SG,PL,GR,GS,IC,UP and continuous precip
  // Transient: TS,SH-only (showers without persistent phenomena)
  // No wxString = ceiling/vis change only → apply conservatively
  function isPersistentWx(wxString) {
    if (!wxString) return true;
    var persistent = ['BR','FG','HZ','FU','DU','SA','RA','DZ','SN','SG','PL','GR','GS','IC','UP'];
    for (var i = 0; i < persistent.length; i++) {
      if (wxString.indexOf(persistent[i]) >= 0) return true;
    }
    return false;
  }

  // Decode a single wx group (e.g. "+TSRA", "BCFG", "-FZDZ") to readable text
  var WX_DESC = {
    MI:'Shallow',BC:'Patches',PR:'Partial',DR:'Low Drifting',BL:'Blowing',
    SH:'Showers',TS:'Thunderstorm',FZ:'Freezing',
    DZ:'Drizzle',RA:'Rain',SN:'Snow',SG:'Snow Grains',IC:'Ice Crystals',
    PL:'Ice Pellets',GR:'Hail',GS:'Small Hail',UP:'Unknown Precip',
    BR:'Mist',FG:'Fog',FU:'Smoke',VA:'Volcanic Ash',DU:'Dust',
    SA:'Sand',HZ:'Haze',PO:'Dust Whirls',SQ:'Squall',
    FC:'Funnel Cloud',SS:'Sandstorm',DS:'Duststorm'
  };
  function decodeWxGroup(code) {
    if (!code) return '';
    var intensity = '';
    var s = code;
    if (s.charAt(0) === '+') { intensity = 'Heavy '; s = s.substring(1); }
    else if (s.charAt(0) === '-') { intensity = 'Light '; s = s.substring(1); }
    else if (s.substring(0, 2) === 'VC') { intensity = 'Vicinity '; s = s.substring(2); }
    var parts = [];
    while (s.length >= 2) {
      var token = s.substring(0, 2);
      if (WX_DESC[token]) { parts.push(WX_DESC[token]); s = s.substring(2); }
      else break;
    }
    if (parts.length === 0) return code;
    return intensity + parts.join(' ');
  }
  function decodeWxString(wxStr) {
    if (!wxStr) return '';
    if (Array.isArray(wxStr)) return wxStr.map(decodeWxGroup).join(', ');
    var groups = wxStr.split(/\s+/);
    var decoded = [];
    for (var i = 0; i < groups.length; i++) {
      decoded.push(decodeWxGroup(groups[i]));
    }
    return decoded.join(', ');
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

      // Find active base forecast (AMC1 NCO.OP.160 rules c/d)
      // BECMG deterioration → apply from timeFrom (start of transition)
      // BECMG improvement → apply from timeBec (end of transition)
      var active = null;
      var initialBase = null;
      for (var i = 0; i < fcsts.length; i++) {
        var f = fcsts[i];
        if (f.fcstChange === 'TEMPO' || f.fcstChange === 'PROB') continue;
        if (f.timeFrom > epoch) continue;
        if (f.fcstChange === 'BECMG') {
          var becEnd = f.timeBec || f.timeTo;
          if (becEnd && epoch >= becEnd) {
            // BECMG transition complete — apply as base
            active = f;
          } else {
            // BECMG still transitioning — check deterioration vs improvement
            // Compute BECMG category (inherit missing fields from current base or initialBase)
            var refBase = active || initialBase;
            var bVisM = parseTafVisib(f.visib);
            if (bVisM === null && refBase) bVisM = parseTafVisib(refBase.visib);
            var bCeil = tafCeiling(f.clouds);
            if (bCeil === null && refBase) bCeil = tafCeiling(refBase.clouds);
            var bCat = calcFlightCat(bCeil, bVisM);
            var refVisM = refBase ? parseTafVisib(refBase.visib) : null;
            var refCeil = refBase ? tafCeiling(refBase.clouds) : null;
            var refCat = calcFlightCat(refCeil, refVisM);
            if (catOrder.indexOf(bCat) > catOrder.indexOf(refCat)) {
              // Deterioration — apply from start (rule d.1)
              active = f;
            }
            // Improvement — keep current base, BECMG applies at becEnd (rule d.2)
          }
        } else {
          // FM or initial forecast
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

      // Extract wind and weather from active forecast
      var wdir = active.wdir != null ? active.wdir : (initialBase && initialBase !== active ? initialBase.wdir : null);
      var wspd = active.wspd != null ? active.wspd : (initialBase && initialBase !== active ? initialBase.wspd : null);
      var wgst = active.wgst != null ? active.wgst : (initialBase && initialBase !== active ? initialBase.wgst : null);
      var wxStr = active.wxString || (initialBase && initialBase !== active ? initialBase.wxString : null) || '';

      // Apply TEMPO/PROB overlays per AMC1 NCO.OP.160 rules (e) and (f)
      for (var i = 0; i < fcsts.length; i++) {
        var f = fcsts[i];
        if (f.fcstChange !== 'TEMPO' && f.fcstChange !== 'PROB') continue;
        if (f.timeFrom > epoch || (f.timeTo && f.timeTo <= epoch)) continue;

        // Rule (f): PROB30/40 TEMPO → disregard entirely
        if (f.fcstChange === 'TEMPO' && f.probability >= 30) continue;

        // Rule (e): standalone TEMPO or PROB30/40
        var tVisM = parseTafVisib(f.visib);
        if (tVisM === null) tVisM = visM;
        var tCeiling = tafCeiling(f.clouds);
        if (tCeiling === null) tCeiling = ceiling;
        var tCat = calcFlightCat(tCeiling, tVisM);

        // Rule (e.3): improvement → disregard
        if (catOrder.indexOf(tCat) <= catOrder.indexOf(cat)) continue;

        // Rule (e.2): transient/showery only (TS, SH without persistent) → may ignore
        if (!isPersistentWx(f.wxString)) continue;

        // Persistent deterioration → apply (rule e.1)
        cat = tCat;
        ceiling = tCeiling;
        visM = tVisM;

        // Worst-case wind from overlays
        if (f.wspd != null && (wspd === null || f.wspd > wspd)) wspd = f.wspd;
        if (f.wgst != null && (wgst === null || f.wgst > wgst)) wgst = f.wgst;
        // Merge weather strings from overlays
        if (f.wxString) wxStr = wxStr ? wxStr + ' ' + f.wxString : f.wxString;
      }

      // Compute worst-case TEMPO category/ceiling/vis across all TEMPO/PROB overlays (unfiltered)
      // Also collect all weather strings and detect wind shear from active overlays
      var tempoCat = null;
      var tempoCeiling = null;
      var tempoVisM = null;
      var allWx = [];
      var wsDesc = null; // wind shear description (first detected)
      if (wxStr) allWx.push(wxStr);
      for (var i = 0; i < fcsts.length; i++) {
        var f = fcsts[i];
        if (f.fcstChange !== 'TEMPO' && f.fcstChange !== 'PROB') continue;
        if (f.timeFrom > epoch || (f.timeTo && f.timeTo <= epoch)) continue;
        if (f.wxString) allWx.push(f.wxString);
        var tVisM = parseTafVisib(f.visib);
        if (tVisM === null) tVisM = visM;
        var tCeiling = tafCeiling(f.clouds);
        if (tCeiling === null) tCeiling = ceiling;
        var tCat = calcFlightCat(tCeiling, tVisM);
        if (catOrder.indexOf(tCat) > catOrder.indexOf(cat)) {
          if (!tempoCat || catOrder.indexOf(tCat) > catOrder.indexOf(tempoCat)) {
            tempoCat = tCat;
            tempoCeiling = tCeiling;
            tempoVisM = tVisM;
          }
        }
        // Wind shear: compare base wind with TEMPO wind
        if (!wsDesc && (f.wspd != null || f.wdir != null)) {
          wsDesc = detectWindShear(wdir, wspd, f.wdir != null ? f.wdir : wdir, f.wspd != null ? f.wspd : wspd, f.wgst);
        }
      }
      // Deduplicate and join all weather phenomena
      var wxPhenomena = [];
      for (var i = 0; i < allWx.length; i++) {
        var parts = allWx[i].split(/\s+/);
        for (var j = 0; j < parts.length; j++) {
          if (parts[j] && parts[j] !== 'NSW' && wxPhenomena.indexOf(parts[j]) < 0) wxPhenomena.push(parts[j]);
        }
      }
      var combinedWx = wxPhenomena.join(' ');

      hours.push({ utcHour: utcHour, cat: cat, ceiling: ceiling, visM: visM, wdir: wdir, wspd: wspd, wgst: wgst, wxStr: combinedWx, tempoCat: tempoCat, tempoCeiling: tempoCeiling, tempoVisM: tempoVisM, wsDesc: wsDesc });
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

  function renderTafInPopup(el, hours, rawTaf, icao) {
    if (!hours || hours.length === 0) {
      el.innerHTML = '<span class="info-unknown">No TAF available</span>';
      return;
    }

    // Get METAR temp/dewp as proxy for icing detection
    var mTemp = null, mDewp = null;
    if (icao && metarCache[icao]) {
      mTemp = metarCache[icao].temp;
      mDewp = metarCache[icao].dewp;
    }

    var tafIssue = null;
    if (icao && tafCache[icao] && tafCache[icao][0] && tafCache[icao][0].issueTime) {
      tafIssue = new Date(tafCache[icao][0].issueTime).getTime();
    }
    var tafAge = formatAge(tafIssue, 'taf');
    var html = '<div class="taf-header">TAF' + (tafAge ? '<div class="data-age-wrap">' + tafAge + '</div>' : '') + '</div>';
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
    // TEMPO row — show worst-case TEMPO category when worse than base TAF
    var hasAnyTempo = hours.some(function (h) { return h.cat && h.tempoCat; });
    if (hasAnyTempo) {
      html += '<tr class="taf-row-tempo"><td class="taf-row-label">TMP</td>';
      for (var i = 0; i < hours.length; i++) {
        var h = hours[i];
        if (!h.cat) continue;
        if (h.tempoCat) {
          var tCatCfg = METAR_CAT[h.tempoCat] || { color: '#888' };
          var tLetter = METAR_LETTER[h.tempoCat] || '?';
          html += '<td><div class="taf-hour taf-hour-tempo" style="background:' + tCatCfg.color + ';">' + tLetter + '</div></td>';
        } else {
          html += '<td></td>';
        }
      }
      html += '</tr>';
    }
    // Ceiling row — show "base/tempo" when TEMPO ceiling differs
    html += '<tr class="taf-row-data"><td class="taf-row-label">CIG</td>';
    for (var i = 0; i < hours.length; i++) {
      var h = hours[i];
      if (!h.cat) continue;
      var cigStr = formatCeiling(h.ceiling);
      if (h.tempoCat && h.tempoCeiling !== h.ceiling) {
        cigStr += '<span class="taf-tempo-val">/' + formatCeiling(h.tempoCeiling) + '</span>';
      }
      html += '<td class="taf-td-data">' + cigStr + '</td>';
    }
    html += '</tr>';
    // Visibility row — show "base/tempo" when TEMPO visibility differs
    html += '<tr class="taf-row-data"><td class="taf-row-label">VIS</td>';
    for (var i = 0; i < hours.length; i++) {
      var h = hours[i];
      if (!h.cat) continue;
      var visStr = formatVisKm(h.visM);
      if (h.tempoCat && h.tempoVisM !== h.visM) {
        visStr += '<span class="taf-tempo-val">/' + formatVisKm(h.tempoVisM) + '</span>';
      }
      html += '<td class="taf-td-data">' + visStr + '</td>';
    }
    html += '</tr>';
    // Weather phenomena row
    var hasAnyWx = hours.some(function (h) { return h.cat && h.wxStr; });
    if (hasAnyWx) {
      html += '<tr class="taf-row-data"><td class="taf-row-label">WX</td>';
      for (var i = 0; i < hours.length; i++) {
        var h = hours[i];
        if (!h.cat) continue;
        if (h.wxStr) {
          html += '<td class="taf-td-data taf-td-wx" title="' + escapeHtml(decodeWxString(h.wxStr)) + '">' + escapeHtml(h.wxStr) + '</td>';
        } else {
          html += '<td class="taf-td-data"></td>';
        }
      }
      html += '</tr>';
    }
    // Wind row
    var hasAnyWind = hours.some(function (h) { return h.cat && isStrongWind(h.wspd, h.wgst); });
    if (hasAnyWind) {
      html += '<tr class="taf-row-data"><td class="taf-row-label">WND</td>';
      for (var i = 0; i < hours.length; i++) {
        if (!hours[i].cat) continue;
        if (isStrongWind(hours[i].wspd, hours[i].wgst)) {
          html += '<td class="taf-td-data"><span class="taf-wind-dot" title="' + escapeHtml(windTitle(hours[i].wdir, hours[i].wspd, hours[i].wgst)) + '">' + WIND_SVG + '</span></td>';
        } else {
          html += '<td class="taf-td-data"></td>';
        }
      }
      html += '</tr>';
    }
    // Wind shear row
    var hasAnyWS = hours.some(function (h) { return h.cat && h.wsDesc; });
    if (hasAnyWS) {
      html += '<tr class="taf-row-data"><td class="taf-row-label">WS</td>';
      for (var i = 0; i < hours.length; i++) {
        if (!hours[i].cat) continue;
        if (hours[i].wsDesc) {
          html += '<td class="taf-td-data"><span class="taf-ws-dot" title="' + escapeHtml(hours[i].wsDesc) + '">' + WS_SVG + '</span></td>';
        } else {
          html += '<td class="taf-td-data"></td>';
        }
      }
      html += '</tr>';
    }
    // Icing row
    var hasAnyIce = hours.some(function (h) { return h.cat && isTafHourIcingRisk(h, mTemp, mDewp); });
    if (hasAnyIce) {
      html += '<tr class="taf-row-data"><td class="taf-row-label">ICE</td>';
      for (var i = 0; i < hours.length; i++) {
        if (!hours[i].cat) continue;
        if (isTafHourIcingRisk(hours[i], mTemp, mDewp)) {
          html += '<td class="taf-td-data"><span class="taf-ice-dot">' + ICE_SVG + '</span></td>';
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
      renderTafInPopup(el, hours, getRawTaf(tafCache[icao]), icao);
      return;
    }
    el.innerHTML = '<span class="metar-loading">Loading TAF...</span>';

    var url = TAF_API + '?ids=' + encodeURIComponent(icao);

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
        renderTafInPopup(el, hours, getRawTaf(json), icao);
      })
      .catch(function () {
        el.innerHTML = '<span class="info-unknown">TAF unavailable</span>';
      });
  }

  // --- NOTAM popup rendering ---
  function renderNotamInPopup(el, data) {
    if (!data || data.count === 0) {
      el.innerHTML = '<span class="info-unknown">No active NOTAMs</span>';
      return;
    }

    var notamHdrClass = data.hasCritical ? 'notam-header notam-header-critical' : 'notam-header';
    var html = '<div class="' + notamHdrClass + '">' + NOTAM_SVG + ' <strong>' + data.count + ' NOTAM' + (data.count > 1 ? 's' : '') + '</strong></div>';
    html += '<div class="notam-list">';
    for (var i = 0; i < data.notams.length; i++) {
      var n = data.notams[i];
      html += '<div class="notam-item' + (n.isCritical ? ' notam-critical' : '') + '">';
      html += '<div class="notam-id">' + escapeHtml(n.id) + '</div>';
      html += '<div class="notam-text">' + escapeHtml(n.text) + '</div>';
      html += '</div>';
    }
    html += '</div>';
    el.innerHTML = html;
  }

  function fetchNotamForPopup(el, icao) {
    if (notamCache[icao] && !isNotamStale(icao)) {
      renderNotamInPopup(el, notamCache[icao]);
      return;
    }
    el.innerHTML = '<span class="metar-loading">Loading NOTAMs...</span>';
    fetchNotams(icao)
      .then(function (json) {
        var data = parseNotamResponse(json);
        notamCache[icao] = data;
        notamCacheTime[icao] = Date.now();
        renderNotamInPopup(el, data);
      })
      .catch(function () {
        el.innerHTML = '<span class="info-unknown">NOTAMs unavailable</span>';
      });
  }

  // --- METAR layer: updates airport marker icons with flight category ---
  function setupMetarLayer(map, layerControl, airportData, markersByIcao, typeLayers) {
    var metarActive = true;
    var fetchTimer = null;
    var refreshTimer = null;
    var updatedIcaos = []; // track which markers we've modified

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
          // Restore original tooltip
          m.setTooltipContent(baseTipHtml(m._airportCode, m._airportData));
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
        fetch(METAR_API + '?ids=' + ids)
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

    function applyMetarToMarkers(results) {
      if (!metarActive) return;
      restoreOriginalIcons();

      for (var i = 0; i < results.length; i++) {
        var m = results[i];
        var marker = markersByIcao[m.icao];
        if (!marker) continue;
        marker.setIcon(createMarkerIcon(marker._airportType, marker._airportCode, m.fltCat, map.getZoom()));
        updatedIcaos.push(m.icao);
        // Update tooltip with visual METAR summary
        var row = marker._airportData;
        var catCfg = METAR_CAT[m.fltCat] || { color: '#888', label: m.fltCat || '?' };
        var tip = '<div class="metar-tip">' +
          '<div class="metar-tip-hdr">' + marker._airportCode + ' ' + (row[COL.name] || '') + '</div>' +
          '<div class="metar-tip-row">' +
          '<span class="metar-cat" style="background:' + catCfg.color + '">' + catCfg.label + '</span>';
        if (m.wdir != null && m.wspd != null) {
          tip += '<span>' + (m.wdir === 'VRB' ? 'VRB' : m.wdir + '\u00b0') + '/' + m.wspd + 'kt';
          if (m.wgst) tip += ' G' + m.wgst;
          tip += '</span>';
        }
        if (m.temp != null) tip += '<span>' + m.temp + '\u00b0C</span>';
        tip += '</div>' +
          '<div class="metar-tip-cv">' +
          '<span class="metar-cv-item"><span class="metar-dot" style="background:' + ceilColor(m.ceiling) + '"></span>' + fmtCeil(m.ceiling) + '</span>' +
          '<span class="metar-cv-item"><span class="metar-dot" style="background:' + visColor(m.visib) + '"></span>' + fmtVis(m.visib) + '</span>' +
          (row[COL.elevation] ? '<span class="metar-cv-item"><span class="metar-cv-lbl">Elev</span>' + row[COL.elevation] + 'ft</span>' : '') +
          '</div>';
        if ((m.wx && m.wx.length) || isIcingRisk(m)) {
          tip += '<div class="metar-tip-wx">';
          if (m.wx && m.wx.length) tip += m.wx.map(decodeWx).join(', ');
          if (isIcingRisk(m)) tip += (m.wx && m.wx.length ? ' \u00b7 ' : '') + '\u2744 ICING';
          tip += '</div>';
        }
        tip += '</div>';
        marker.setTooltipContent(tip);
      }
      console.log('METAR: updated ' + results.length + ' airport markers');
    }

    function debouncedFetch() {
      clearTimeout(fetchTimer);
      fetchTimer = setTimeout(fetchMetarsForMap, 500);
    }

    // Start fetching METARs immediately and on map move
    fetchMetarsForMap();
    map.on('moveend', debouncedFetch);
    refreshTimer = setInterval(fetchMetarsForMap, 5 * 60 * 1000);
  }

  // --- Main load ---
  function loadAirports() {
    var app = window.AirportApp;
    if (!app || !app.map) {
      setTimeout(loadAirports, 100);
      return;
    }

    var map = app.map;

    // Load lentopaikat.fi slug mapping (optional, non-blocking)
    fetch('data/lentopaikat.json')
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (json) { if (json) lentopaikatMap = json; })
      .catch(function () { /* optional data, ignore errors */ });

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
        var shortRwyMarkers = []; // markers for airports without qualifying runway
        var rwyFilterActive = document.getElementById('rwy-filter-toggle');
        var rwyFilterOn = rwyFilterActive ? rwyFilterActive.checked : true;
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

          // Check: at least one runway >= 800m (2625ft) with asphalt/concrete
          var hasQualifyingRunway = runways.some(function (r) {
            var len = r[RWY.length];
            if (!len || len < 2625) return false;
            var s = (r[RWY.surface] || '').toUpperCase();
            return s.indexOf('ASP') >= 0 || s.indexOf('CON') >= 0
              || s.indexOf('BIT') >= 0 || s.indexOf('PEM') >= 0
              || s.indexOf('ASPHALT') >= 0 || s.indexOf('CONCRETE') >= 0;
          });

          var code = getCode(row);
          var marker = L.marker([lat, lon], {
            icon: createMarkerIcon(type, code)
          });

          marker.bindPopup(buildPopupContent(row), {
            maxWidth: 700,
            minWidth: 500,
            className: 'airport-popup',
            autoPan: true,
            autoPanPadding: [40, 40]
          });

          marker.bindTooltip(baseTipHtml(code, row), { direction: 'top', offset: [0, -6] });

          marker._airportData = row;
          marker._airportType = type;
          marker._airportCode = code;
          marker._shortRwy = !hasQualifyingRunway;

          if (!hasQualifyingRunway) {
            shortRwyMarkers.push(marker);
            if (!rwyFilterOn) {
              typeLayers[type].addLayer(marker);
            }
          } else {
            typeLayers[type].addLayer(marker);
          }
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

        // Runway filter toggle
        if (rwyFilterActive) {
          rwyFilterActive.addEventListener('change', function () {
            rwyFilterOn = rwyFilterActive.checked;
            for (var j = 0; j < shortRwyMarkers.length; j++) {
              var sm = shortRwyMarkers[j];
              var layer = typeLayers[sm._airportType];
              if (!layer) continue;
              if (rwyFilterOn) {
                if (layer.hasLayer(sm)) layer.removeLayer(sm);
              } else {
                if (!layer.hasLayer(sm)) layer.addLayer(sm);
              }
            }
          });
        }

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

          var tafDiv = el.querySelector('.popup-taf');
          var wxDiv = el.querySelector('.popup-weather');
          var notamDiv = el.querySelector('.popup-notam');

          // Fetch METAR only (TAF lazy-loaded on tab click)
          if (icao) fetchMetarTafCombo(metarDiv, null, tafDiv, icao);

          // Fetch OpenAIP data to enrich Info tab (in parallel with METAR)
          if (icao) fetchOpenAipForPopup(el, icao);

          // Populate AIP link
          var aipLink = el.querySelector('.aip-link');
          if (aipLink && icao) {
            var aipIcao = aipLink.getAttribute('data-icao');
            if (chartsCache[aipIcao]) {
              showAipLink(aipLink, aipIcao, chartsCache[aipIcao]);
            } else {
              fetch(OWM_PROXY + '/ar/airport-docs/' + encodeURIComponent(aipIcao))
                .then(function (res) { return res.json(); })
                .then(function (data) {
                  var d = Array.isArray(data) ? data[0] : data;
                  chartsCache[aipIcao] = d;
                  showAipLink(aipLink, aipIcao, d);
                })
                .catch(function () {});
            }
          }

          // Tab switching
          var extraTabs = el.querySelectorAll('.popup-extra-tab');
          var extraPanels = el.querySelectorAll('.popup-extra-content');
          var loadedPanels = { 'popup-info': true };

          extraTabs.forEach(function (tab) {
            tab.addEventListener('click', function () {
              var target = tab.getAttribute('data-panel');
              var isActive = tab.classList.contains('active');

              // Deactivate all
              extraTabs.forEach(function (t) { t.classList.remove('active'); });
              extraPanels.forEach(function (p) { p.style.display = 'none'; });

              // If clicking already-active tab, just close
              if (isActive) return;

              // Activate clicked tab
              tab.classList.add('active');
              var panel = el.querySelector('.' + target);
              if (panel) panel.style.display = '';

              // Lazy-load content on first open
              if (!loadedPanels[target]) {
                loadedPanels[target] = true;
                if (target === 'popup-taf' && tafDiv) {
                  var tafIcao = tafDiv.getAttribute('data-icao');
                  if (tafIcao) {
                    if (rawTafCache[tafIcao]) {
                      tafDiv.innerHTML = '<div class="taf-header">TAF</div><div class="taf-raw">' + escapeHtml(rawTafCache[tafIcao]) + '</div>';
                    } else {
                      tafDiv.innerHTML = '<span class="metar-loading">Loading TAF...</span>';
                    }
                    fetchTafForPopup(tafDiv, tafIcao);
                  }
                } else if (target === 'popup-weather' && wxDiv && window.AirportApp.fetchWeatherInto) {
                  var wLat = wxDiv.getAttribute('data-lat');
                  var wLon = wxDiv.getAttribute('data-lon');
                  window.AirportApp.fetchWeatherInto(wxDiv, wLat, wLon);
                } else if (target === 'popup-notam' && notamDiv) {
                  var nIcao = notamDiv.getAttribute('data-icao');
                  if (nIcao) {
                    notamDiv.innerHTML = '<span class="metar-loading">Loading NOTAMs...</span>';
                    fetchNotamForPopup(notamDiv, nIcao);
                  }
                } else if (target === 'popup-charts') {
                  var cDiv = el.querySelector('.popup-charts');
                  if (cDiv) {
                    var cIcao = cDiv.getAttribute('data-icao');
                    if (cIcao) {
                      if (chartsCache[cIcao]) {
                        renderChartsInPopup(cDiv, cIcao, chartsCache[cIcao]);
                      } else {
                        cDiv.innerHTML = '<span class="metar-loading">Loading charts...</span>';
                        fetch(OWM_PROXY + '/ar/airport-docs/' + encodeURIComponent(cIcao))
                          .then(function (res) { return res.json(); })
                          .then(function (data) {
                            var d = Array.isArray(data) ? data[0] : data;
                            chartsCache[cIcao] = d;
                            renderChartsInPopup(cDiv, cIcao, d);
                          })
                          .catch(function () {
                            cDiv.innerHTML = '<span class="info-unknown">Charts not available</span>';
                          });
                      }
                    }
                  }
                } else if (target === 'popup-airgram') {
                  var agDiv = el.querySelector('.popup-airgram');
                  if (agDiv && window.AirportApp.fetchAirgramInto) {
                    var aLat = agDiv.getAttribute('data-lat');
                    var aLon = agDiv.getAttribute('data-lon');
                    var aElev = parseFloat(agDiv.getAttribute('data-elev')) || 0;
                    window.AirportApp.fetchAirgramInto(agDiv, aLat, aLon, aElev);
                  }
                } else if (target === 'popup-briefing') {
                  var bDiv = el.querySelector('.popup-briefing');
                  if (bDiv && window.AirportApp.streamBriefing) {
                    var bIcao = bDiv.getAttribute('data-icao');
                    var bName = bDiv.getAttribute('data-name');
                    var bElev = bDiv.getAttribute('data-elev');

                    function streamAirportBriefing() {
                      var bMetar = metarCache[bIcao] ? metarCache[bIcao].rawOb : null;
                      var bTaf = rawTafCache[bIcao] || null;
                      if (!bTaf && tafCache[bIcao]) {
                        bTaf = getRawTaf(tafCache[bIcao]);
                      }
                      var bNotams = [];
                      if (notamCache[bIcao] && notamCache[bIcao].notams) {
                        for (var ni = 0; ni < notamCache[bIcao].notams.length; ni++) {
                          var nn = notamCache[bIcao].notams[ni];
                          bNotams.push({ id: nn.id, text: nn.text });
                        }
                      }
                      var bData = { icao: bIcao, name: bName, elevation: bElev, metar: bMetar, taf: bTaf, notams: bNotams };
                      var app = window.AirportApp;
                      var bLat = parseFloat(bDiv.getAttribute('data-lat'));
                      var bLon = parseFloat(bDiv.getAttribute('data-lon'));
                      var llfArea = app.llfAreaForCoord && app.llfAreaForCoord(bLat, bLon);
                      if (llfArea && app.fetchLlfForBriefing) {
                        app.fetchLlfForBriefing([llfArea]).then(function (llf) {
                          if (llf) bData.llf = llf;
                          app.streamBriefing(bDiv, { type: 'airport', data: bData });
                        });
                      } else {
                        app.streamBriefing(bDiv, { type: 'airport', data: bData });
                      }
                    }

                    var hasTaf = rawTafCache[bIcao] || tafCache[bIcao];
                    var hasMetar = metarCache[bIcao] && metarCache[bIcao].rawOb;

                    function fetchTafThenBrief() {
                      bDiv.innerHTML = '<span class="metar-loading">Loading TAF...</span>';
                      fetch(TAF_API + '?ids=' + encodeURIComponent(bIcao))
                        .then(function (res) { return res.ok ? res.json() : Promise.reject(); })
                        .then(function (json) {
                          if (json && json.length && json[0].rawTAF) {
                            rawTafCache[bIcao] = json[0].rawTAF;
                            tafCache[bIcao] = json;
                            tafCacheTime[bIcao] = Date.now();
                          }
                          streamAirportBriefing();
                        })
                        .catch(function () { streamAirportBriefing(); });
                    }

                    if (hasMetar && hasTaf) {
                      streamAirportBriefing();
                    } else if (hasMetar && !hasTaf) {
                      fetchTafThenBrief();
                    } else {
                      bDiv.innerHTML = '<span class="metar-loading">Loading weather data...</span>';
                      fetch(AR_METARTAF_API + encodeURIComponent(bIcao))
                        .then(function (res) { return res.ok ? res.json() : Promise.reject(); })
                        .then(function (json) {
                          if (json.metar) {
                            var m = parseMetar(json.metar);
                            if (m) { metarCache[bIcao] = m; metarCacheTime[bIcao] = Date.now(); }
                          }
                          if (json.taf) { rawTafCache[bIcao] = json.taf; return; }
                          // Combo didn't return TAF, try dedicated TAF endpoint
                          return fetch(TAF_API + '?ids=' + encodeURIComponent(bIcao))
                            .then(function (res) { return res.ok ? res.json() : null; })
                            .then(function (tJson) {
                              if (tJson && tJson.length && tJson[0].rawTAF) {
                                rawTafCache[bIcao] = tJson[0].rawTAF;
                                tafCache[bIcao] = tJson;
                                tafCacheTime[bIcao] = Date.now();
                              }
                            });
                        })
                        .then(function () { streamAirportBriefing(); })
                        .catch(function () {
                          bDiv.innerHTML = '<div class="briefing-content">Could not load weather data for briefing.</div>';
                        });
                    }
                  }
                }
              }
            });
          });

          // Pre-fetch NOTAMs to show warning badge in title
          var nameEl = el.querySelector('.popup-name');
          if (icao && nameEl) {
            var cachedNotam = notamCache[icao];
            if (cachedNotam && !isNotamStale(icao)) {
              if (cachedNotam.count > 0) {
                var nwCls = cachedNotam.hasCritical ? 'notam-warning notam-warning-critical' : 'notam-warning';
                nameEl.insertAdjacentHTML('beforeend', ' <span class="' + nwCls + '" title="' + cachedNotam.count + ' active NOTAM(s)">' + NOTAM_SVG + '</span>');
              }
            } else {
              fetchNotams(icao)
                .then(function (json) {
                  var data = parseNotamResponse(json);
                  notamCache[icao] = data;
                  notamCacheTime[icao] = Date.now();
                  if (data.count > 0 && nameEl) {
                    var nwCls = data.hasCritical ? 'notam-warning notam-warning-critical' : 'notam-warning';
                    nameEl.insertAdjacentHTML('beforeend', ' <span class="' + nwCls + '" title="' + data.count + ' active NOTAM(s)">' + NOTAM_SVG + '</span>');
                  }
                })
                .catch(function () { /* silently skip */ });
            }
          }

          // Set range origin to the airport location (skip in route mode)
          var source = popup._source;
          if (source && source.getLatLng && window.AirportApp.setRangeOrigin && !window.AirportApp.routeMode) {
            window.AirportApp.setRangeOrigin(source.getLatLng());
          }

        });

        app.typeLayers = typeLayers;
        app.airportData = data;
        app.markersByIcao = markersByIcao;
        app.COL = COL;

        console.log('Airport markers ready');
      })
      .catch(function (err) {
        console.error('Error loading airports:', err);
      });
  }

  window.AirportApp = window.AirportApp || {};
  window.AirportApp.loadAirports = loadAirports;
  window.AirportApp.OWM_PROXY = OWM_PROXY;
  window.AirportApp.TAF_API = TAF_API;
  window.AirportApp.tafCache = tafCache;
  window.AirportApp.calcFlightCat = calcFlightCat;
  window.AirportApp.parseTafVisib = parseTafVisib;
  window.AirportApp.tafCeiling = tafCeiling;
  window.AirportApp.isPersistentWx = isPersistentWx;
  window.AirportApp.decodeWxString = decodeWxString;
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
  window.AirportApp.ICE_SVG = ICE_SVG;
  window.AirportApp.isIcingRisk = isIcingRisk;
  window.AirportApp.NOTAM_SVG = NOTAM_SVG;
  window.AirportApp.notamCache = notamCache;
  window.AirportApp.notamCacheTime = notamCacheTime;
  window.AirportApp.fetchNotams = fetchNotams;
  window.AirportApp.parseNotamResponse = parseNotamResponse;
  window.AirportApp.isNotamStale = isNotamStale;
  window.AirportApp.rawTafCache = rawTafCache;
  window.AirportApp.fetchOpenAipFreqs = fetchOpenAipFreqs;

  if (window.AirportApp.map && window.AirportApp.layerControl) {
    loadAirports();
  }
})();
