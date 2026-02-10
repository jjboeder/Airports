/* route-planner.js - Multi-leg route planning for DA62 */

(function () {
  'use strict';

  // --- Navigation math ---

  var DEG = Math.PI / 180;
  var R_NM = 3440.065; // Earth radius in nautical miles

  function haversineNm(lat1, lon1, lat2, lon2) {
    var dLat = (lat2 - lat1) * DEG;
    var dLon = (lon2 - lon1) * DEG;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R_NM * Math.asin(Math.sqrt(a));
  }

  function initialBearing(lat1, lon1, lat2, lon2) {
    var dLon = (lon2 - lon1) * DEG;
    var y = Math.sin(dLon) * Math.cos(lat2 * DEG);
    var x = Math.cos(lat1 * DEG) * Math.sin(lat2 * DEG) -
            Math.sin(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.cos(dLon);
    var brng = Math.atan2(y, x) / DEG;
    return (brng + 360) % 360;
  }

  // Simplified European magnetic declination model
  // Roughly: declination ≈ 0.24 * longitude - 2.0 (degrees east positive)
  function getMagDeclination(lat, lon) {
    return 0.24 * lon - 2.0;
  }

  function getMagneticHeading(trueBearing, lat, lon) {
    var dec = getMagDeclination(lat, lon);
    var mag = trueBearing - dec;
    return ((mag % 360) + 360) % 360;
  }

  // --- State ---

  var waypoints = [];  // {latlng, data, code, name}
  var legs = [];       // {dist, trueHdg, magHdg, time, fuel}
  var alternateIndex = -1; // index of the alternate waypoint, or -1
  var routeActive = false;
  var skipNextRouteAdd = false; // flag to prevent re-adding when opening popup from panel
  var routeLayerGroup = null;
  var map = null;
  var routeWxCache = {}; // icao → taf json, local to route planner
  var routeOwmCache = {}; // 'lat,lon' → {data, time}
  var routeOwmSamples = []; // [{lat, lon, timeH, wpCode}]
  var wxRefreshTimer = null;
  var WX_REFRESH_INTERVAL = 10 * 60 * 1000; // 10 minutes
  var OWM_PROXY = 'https://owm-proxy.jjboeder.workers.dev';

  // Autorouter state
  var autoRouteId = null;      // current autorouter route ID
  var autoRoutePolling = false; // whether we're polling
  var arAircraftId = null;     // DA62 aircraft ID from autorouter
  var lastFpl = null;          // intermediate fpl from autorouter (fallback)
  var arDepCode = null;        // locked dep airport for re-routing
  var arDestCode = null;       // locked dest airport for re-routing
  var arDepWp = null;          // full waypoint data for dep
  var arDestWp = null;         // full waypoint data for dest
  var arOptimizeIdx = 0;       // cycle optimization: 0=fuel, 1=time
  var AR_OPTIMIZE = ['fuel', 'time'];

  // --- DOM refs ---
  var toggleBtn, settingsDiv, waypointsDiv, totalsDiv, undoBtn, clearBtn;

  // --- Helpers ---

  function getProfile() {
    var app = window.AirportApp;
    var select = document.getElementById('range-power');
    if (!select || !app.DA62_PROFILES) return null;
    return app.DA62_PROFILES[select.selectedIndex];
  }

  function getFuel() {
    var input = document.getElementById('range-fuel');
    if (!input) return 86;
    var v = parseFloat(input.value);
    return isNaN(v) ? 86 : v;
  }

  function getCode(data) {
    // data is the airport row array
    return data[9] || data[0] || ''; // gps_code || ident
  }

  function getName(data) {
    return data[2] || ''; // name
  }

  function getDepEpoch() {
    var timeInput = document.getElementById('route-dep-time');
    if (!timeInput || !timeInput.value) return null;
    var parts = timeInput.value.split(':');
    var h = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10);
    if (isNaN(h) || isNaN(m)) return null;
    var now = new Date();
    var d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m, 0));
    // If the time is more than 6 hours in the past, assume tomorrow
    if (d.getTime() < now.getTime() - 6 * 3600000) {
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return Math.floor(d.getTime() / 1000);
  }

  function getFL() {
    var flInput = document.getElementById('route-fl');
    if (!flInput) return 80;
    var v = parseInt(flInput.value, 10);
    return isNaN(v) ? 80 : v;
  }

  // --- TAF weather for route ---

  var CAT_ORDER = ['VFR', 'MVFR', 'BIR', 'IFR', 'LIFR'];

  function tafCategoryAtEpoch(tafJson, epoch) {
    var app = window.AirportApp;
    if (!tafJson || !tafJson.length || !tafJson[0].fcsts || tafJson[0].fcsts.length === 0) return null;

    var fcsts = tafJson[0].fcsts;

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
    if (!active) return null;

    // BECMG only specifies changed fields; inherit missing from initial base
    var visM = app.parseTafVisib(active.visib);
    if (visM === null && initialBase && active !== initialBase) {
      visM = app.parseTafVisib(initialBase.visib);
    }
    var ceiling = app.tafCeiling(active.clouds);
    var cat = app.calcFlightCat(ceiling, visM);

    // Extract wind from active forecast
    var wspd = active.wspd != null ? active.wspd : (initialBase && initialBase !== active ? initialBase.wspd : null);
    var wgst = active.wgst != null ? active.wgst : (initialBase && initialBase !== active ? initialBase.wgst : null);

    // Apply TEMPO, PROB, and transitioning BECMG overlays — use worst-case
    for (var i = 0; i < fcsts.length; i++) {
      var f = fcsts[i];
      var isTempo = f.fcstChange === 'TEMPO' || f.fcstChange === 'PROB';
      var becEnd = f.fcstChange === 'BECMG' ? (f.timeBec || f.timeTo) : null;
      var isBecmgTransition = f.fcstChange === 'BECMG' && becEnd && epoch < becEnd;
      if (!isTempo && !isBecmgTransition) continue;
      if (f.timeFrom > epoch || (f.timeTo && f.timeTo <= epoch)) continue;

      var tVisM = app.parseTafVisib(f.visib);
      if (tVisM === null) tVisM = visM;
      var tCeiling = app.tafCeiling(f.clouds);
      if (tCeiling === null) tCeiling = ceiling;
      var tCat = app.calcFlightCat(tCeiling, tVisM);

      if (CAT_ORDER.indexOf(tCat) > CAT_ORDER.indexOf(cat)) {
        cat = tCat;
      }

      // Worst-case wind from overlays
      if (f.wspd != null && (wspd === null || f.wspd > wspd)) wspd = f.wspd;
      if (f.wgst != null && (wgst === null || f.wgst > wgst)) wgst = f.wgst;
    }

    return { cat: cat, wspd: wspd, wgst: wgst };
  }

  function worstCategory(a, b) {
    if (!a) return b;
    if (!b) return a;
    return CAT_ORDER.indexOf(a) >= CAT_ORDER.indexOf(b) ? a : b;
  }

  function getWpWeather(icao, arrivalEpoch) {
    var app = window.AirportApp;
    var taf = routeWxCache[icao] || (app.tafCache && app.tafCache[icao]);
    if (!taf) return null;

    var r0 = tafCategoryAtEpoch(taf, arrivalEpoch);
    var r1 = tafCategoryAtEpoch(taf, arrivalEpoch - 3600);
    var r2 = tafCategoryAtEpoch(taf, arrivalEpoch + 3600);

    var cat0 = r0 ? r0.cat : null;
    var cat1 = r1 ? r1.cat : null;
    var cat2 = r2 ? r2.cat : null;
    var cat = worstCategory(cat0, worstCategory(cat1, cat2));

    // Check strong wind across all three time samples
    var strongWind = false;
    var samples = [r0, r1, r2];
    for (var i = 0; i < samples.length; i++) {
      if (samples[i] && app.isStrongWind && app.isStrongWind(samples[i].wspd, samples[i].wgst)) {
        strongWind = true;
        break;
      }
    }

    return { cat: cat, strongWind: strongWind };
  }

  function fetchDepMetar() {
    if (waypoints.length === 0) return;
    var app = window.AirportApp;
    var icao = waypoints[0].code;
    if (!icao || !app.METAR_API) return;
    if (app.metarCache && app.metarCache[icao] && !app.isStale(app.metarCacheTime, icao)) return;

    fetch(app.METAR_API + '?ids=' + encodeURIComponent(icao))
      .then(function (res) { return res.text(); })
      .then(function (text) {
        var raw = text.trim();
        if (!raw || !app.parseMetar) return;
        var metar = app.parseMetar(raw);
        if (metar && app.metarCache) {
          app.metarCache[icao] = metar;
          app.metarCacheTime[icao] = Date.now();
          renderPanel();
        }
      })
      .catch(function () {});
  }

  function fetchRouteNotams() {
    if (waypoints.length === 0) return;
    var app = window.AirportApp;
    if (!app.fetchNotams || !app.parseNotamResponse) return;

    for (var i = 0; i < waypoints.length; i++) {
      (function (icao) {
        if (!icao || (app.notamCache[icao] && !app.isNotamStale(icao))) return;
        app.fetchNotams(icao)
          .then(function (json) {
            var data = app.parseNotamResponse(json);
            app.notamCache[icao] = data;
            app.notamCacheTime[icao] = Date.now();
            renderPanel();
          })
          .catch(function () {});
      })(waypoints[i].code);
    }
  }

  function fetchRouteWeather() {
    if (waypoints.length === 0) return;

    var app = window.AirportApp;
    var TAF_API = app.TAF_API;
    if (!TAF_API) return;

    // Fetch METAR for departure airport
    fetchDepMetar();

    // Fetch NOTAMs for all waypoints
    fetchRouteNotams();

    // Collect unique ICAO codes not yet cached or stale
    var toFetch = [];
    for (var i = 0; i < waypoints.length; i++) {
      var icao = waypoints[i].code;
      if (!icao) continue;
      var hasFresh = (routeWxCache[icao] || (app.tafCache && app.tafCache[icao]))
        && !app.isStale(app.tafCacheTime, icao);
      if (!hasFresh) {
        if (toFetch.indexOf(icao) < 0) toFetch.push(icao);
      }
    }

    if (toFetch.length === 0) {
      renderPanel();
      return;
    }

    var pending = toFetch.length;
    function done() {
      pending--;
      if (pending <= 0) renderPanel();
    }

    for (var i = 0; i < toFetch.length; i++) {
      (function (icao) {
        var url = TAF_API + '?ids=' + encodeURIComponent(icao);
        fetch(url)
          .then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          })
          .then(function (json) {
            if (json && json.length > 0) {
              routeWxCache[icao] = json;
              if (app.tafCache) app.tafCache[icao] = json;
              app.tafCacheTime[icao] = Date.now();
            }
            done();
          })
          .catch(function () {
            done();
          });
      })(toFetch[i]);
    }
  }

  // Build exactly 6 sample points along the route: start, 4 evenly spaced, arrival
  function buildRouteSamples() {
    routeOwmSamples = [];
    if (waypoints.length < 2 || legs.length === 0) return;

    // Cumulative time at each waypoint (hours)
    var cumTime = [0];
    for (var i = 0; i < legs.length; i++) {
      cumTime.push(cumTime[i] + legs[i].time);
    }
    var totalTime = cumTime[cumTime.length - 1];
    if (totalTime <= 0) return;

    var N = 6; // always 6 points
    for (var s = 0; s < N; s++) {
      var t = (s / (N - 1)) * totalTime;

      // Find which leg this time falls on
      var legIdx = 0;
      for (var j = 0; j < legs.length; j++) {
        if (t >= cumTime[j] && t <= cumTime[j + 1]) { legIdx = j; break; }
      }

      // Fraction along this leg
      var legTime = cumTime[legIdx + 1] - cumTime[legIdx];
      var frac = legTime > 0 ? (t - cumTime[legIdx]) / legTime : 0;

      var a = waypoints[legIdx].latlng;
      var b = waypoints[legIdx + 1].latlng;
      var lat = a.lat + (b.lat - a.lat) * frac;
      var lon = a.lng + (b.lng - a.lng) * frac;

      // Check if this sample is near a waypoint
      var wpCode = null;
      for (var w = 0; w < waypoints.length; w++) {
        if (Math.abs(t - cumTime[w]) < 0.02) { wpCode = waypoints[w].code; break; }
      }

      routeOwmSamples.push({
        lat: Math.round(lat * 100) / 100,
        lon: Math.round(lon * 100) / 100,
        timeH: t,
        wpCode: wpCode
      });
    }
  }

  function owmCacheKey(lat, lon) {
    return lat.toFixed(2) + ',' + lon.toFixed(2);
  }

  function fetchRouteOwmWeather() {
    if (waypoints.length < 2 || legs.length === 0) return;
    buildRouteSamples();
    if (routeOwmSamples.length === 0) return;

    var now = Date.now();
    var toFetch = [];
    var seen = {};
    for (var i = 0; i < routeOwmSamples.length; i++) {
      var s = routeOwmSamples[i];
      var key = owmCacheKey(s.lat, s.lon);
      if (seen[key]) continue;
      var cached = routeOwmCache[key];
      if (cached && (now - cached.time) < WX_REFRESH_INTERVAL) continue;
      seen[key] = true;
      toFetch.push({ key: key, lat: s.lat, lon: s.lon });
    }
    if (toFetch.length === 0) { renderRouteTimeline(); return; }

    var points = toFetch.map(function (item) { return item.lat + ',' + item.lon; }).join(',');
    fetch(OWM_PROXY + '/route-wx?points=' + points)
      .then(function (res) { return res.json(); })
      .then(function (results) {
        var now = Date.now();
        for (var i = 0; i < results.length && i < toFetch.length; i++) {
          var data = results[i];
          if (data && data.cod === 200) {
            routeOwmCache[toFetch[i].key] = { data: data, time: now };
          }
        }
        renderRouteTimeline();
      })
      .catch(function () { renderRouteTimeline(); });
  }

  function owmWxLabel(main) {
    var labels = {
      'Clear': 'CLR', 'Clouds': 'CLD', 'Rain': 'RA', 'Drizzle': 'DZ',
      'Thunderstorm': 'TS', 'Snow': 'SN', 'Mist': 'BR', 'Fog': 'FG',
      'Haze': 'HZ', 'Smoke': 'FU', 'Dust': 'DU', 'Sand': 'SA',
      'Squall': 'SQ', 'Tornado': 'FC'
    };
    return labels[main] || main;
  }

  function owmWxColor(main) {
    var colors = {
      'Clear': '#27ae60', 'Clouds': '#7f8c8d', 'Rain': '#2980b9', 'Drizzle': '#5dade2',
      'Thunderstorm': '#8e44ad', 'Snow': '#5dade2', 'Mist': '#95a5a6', 'Fog': '#e67e22',
      'Haze': '#bdc3c7', 'Smoke': '#95a5a6'
    };
    return colors[main] || '#888';
  }

  function visColor(visM) {
    if (visM >= 8000) return '#27ae60';
    if (visM >= 5000) return '#f1c40f';
    if (visM >= 1500) return '#e67e22';
    return '#e74c3c';
  }

  function renderRouteTimeline() {
    var el = document.getElementById('rw-timeline');
    if (!el) return;
    if (routeOwmSamples.length < 2) { el.innerHTML = ''; return; }

    // Check if we have any cached data
    var hasData = false;
    for (var i = 0; i < routeOwmSamples.length; i++) {
      var key = owmCacheKey(routeOwmSamples[i].lat, routeOwmSamples[i].lon);
      if (routeOwmCache[key]) { hasData = true; break; }
    }
    if (!hasData) { el.innerHTML = ''; return; }

    var depEpoch = getDepEpoch();

    var html = '<table class="route-wx-table">';

    // Row 1: Time labels
    html += '<tr><td class="route-wx-label">UTC</td>';
    for (var i = 0; i < routeOwmSamples.length; i++) {
      var s = routeOwmSamples[i];
      var timeStr;
      if (depEpoch) {
        var epoch = depEpoch + s.timeH * 3600;
        var d = new Date(epoch * 1000);
        var hh = d.getUTCHours();
        var mm = d.getUTCMinutes();
        timeStr = (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
      } else {
        var h = Math.floor(s.timeH);
        var m = Math.round((s.timeH - h) * 60);
        timeStr = '+' + h + ':' + (m < 10 ? '0' : '') + m;
      }
      html += '<td class="route-wx-time">' + timeStr + '</td>';
    }
    html += '</tr>';

    // Row 2: Waypoint code (if at a waypoint)
    html += '<tr><td class="route-wx-label"></td>';
    for (var i = 0; i < routeOwmSamples.length; i++) {
      var s = routeOwmSamples[i];
      if (s.wpCode) {
        html += '<td class="route-wx-code">' + escapeHtml(s.wpCode) + '</td>';
      } else {
        html += '<td class="route-wx-enroute">&middot;</td>';
      }
    }
    html += '</tr>';

    // Row 3: Weather condition
    html += '<tr><td class="route-wx-label">WX</td>';
    for (var i = 0; i < routeOwmSamples.length; i++) {
      var key = owmCacheKey(routeOwmSamples[i].lat, routeOwmSamples[i].lon);
      var c = routeOwmCache[key];
      if (c && c.data.weather && c.data.weather[0]) {
        var main = c.data.weather[0].main;
        var lbl = owmWxLabel(main);
        var clr = owmWxColor(main);
        html += '<td><span class="route-wx-cond" style="color:' + clr + '">' + lbl + '</span></td>';
      } else {
        html += '<td>-</td>';
      }
    }
    html += '</tr>';

    // Row 4: Visibility
    html += '<tr><td class="route-wx-label">VIS</td>';
    for (var i = 0; i < routeOwmSamples.length; i++) {
      var key = owmCacheKey(routeOwmSamples[i].lat, routeOwmSamples[i].lon);
      var c = routeOwmCache[key];
      if (c && c.data.visibility != null) {
        var visM = c.data.visibility;
        var visKm = visM >= 9999 ? '10+' : (visM / 1000).toFixed(0);
        html += '<td><span class="route-wx-vis" style="background:' + visColor(visM) + '">' + visKm + '</span></td>';
      } else {
        html += '<td>-</td>';
      }
    }
    html += '</tr>';

    // Row 5: Wind
    html += '<tr><td class="route-wx-label">WND</td>';
    for (var i = 0; i < routeOwmSamples.length; i++) {
      var key = owmCacheKey(routeOwmSamples[i].lat, routeOwmSamples[i].lon);
      var c = routeOwmCache[key];
      if (c && c.data.wind) {
        var spdKt = Math.round(c.data.wind.speed * 1.944);
        var deg = c.data.wind.deg || 0;
        var arrow = '<span class="route-wx-arrow" style="transform:rotate(' + (deg + 180) + 'deg)">&#8593;</span>';
        var gustStr = '';
        if (c.data.wind.gust) {
          gustStr = 'G' + Math.round(c.data.wind.gust * 1.944);
        }
        html += '<td class="route-wx-wind">' + arrow + spdKt + gustStr + '</td>';
      } else {
        html += '<td>-</td>';
      }
    }
    html += '</tr>';

    // Row 6: Temperature
    html += '<tr><td class="route-wx-label">TMP</td>';
    for (var i = 0; i < routeOwmSamples.length; i++) {
      var key = owmCacheKey(routeOwmSamples[i].lat, routeOwmSamples[i].lon);
      var c = routeOwmCache[key];
      if (c && c.data.main && c.data.main.temp != null) {
        html += '<td class="route-wx-temp">' + Math.round(c.data.main.temp) + '&deg;</td>';
      } else {
        html += '<td>-</td>';
      }
    }
    html += '</tr>';

    html += '</table>';
    el.innerHTML = html;
  }

  function startWxRefresh() {
    stopWxRefresh();
    wxRefreshTimer = setInterval(function () {
      if (waypoints.length > 0) fetchRouteWeather();
    }, WX_REFRESH_INTERVAL);
  }

  function stopWxRefresh() {
    if (wxRefreshTimer) {
      clearInterval(wxRefreshTimer);
      wxRefreshTimer = null;
    }
  }

  // --- AMA terrain check ---

  function getAmaAt(lat, lon) {
    var idx = window._amaIndex;
    if (!idx) return 0;
    var key = Math.floor(lat) + ',' + Math.floor(lon);
    var val = idx[key];
    return val || 0;
  }

  // Sample points along a leg and return the max AMA (in feet) encountered
  function getLegMaxAMA(lat1, lon1, lat2, lon2) {
    var maxAma = 0;
    // Sample every ~10 nm or at least 10 steps
    var distNm = haversineNm(lat1, lon1, lat2, lon2);
    var steps = Math.max(10, Math.ceil(distNm / 10));
    for (var s = 0; s <= steps; s++) {
      var t = s / steps;
      var lat = lat1 + (lat2 - lat1) * t;
      var lon = lon1 + (lon2 - lon1) * t;
      var ama = getAmaAt(lat, lon);
      if (ama > maxAma) maxAma = ama;
    }
    return maxAma;
  }

  // Check all legs and return array of {legIndex, maxAma} where FL is at or below AMA
  function checkRouteAMA() {
    var fl = getFL();
    var altFt = fl * 100;
    var warnings = [];
    for (var i = 0; i < waypoints.length - 1; i++) {
      var a = waypoints[i].latlng;
      var b = waypoints[i + 1].latlng;
      var maxAma = getLegMaxAMA(a.lat, a.lng, b.lat, b.lng);
      if (maxAma > 0 && altFt <= maxAma) {
        warnings.push({ leg: i, maxAma: maxAma });
      }
    }
    return warnings;
  }

  // --- Core logic ---

  function recalculate() {
    legs = [];
    var profile = getProfile();
    if (!profile || waypoints.length < 2) return;

    for (var i = 0; i < waypoints.length - 1; i++) {
      var a = waypoints[i];
      var b = waypoints[i + 1];
      var lat1 = a.latlng.lat, lon1 = a.latlng.lng;
      var lat2 = b.latlng.lat, lon2 = b.latlng.lng;

      var dist = haversineNm(lat1, lon1, lat2, lon2);
      var trueHdg = initialBearing(lat1, lon1, lat2, lon2);
      var magHdg = getMagneticHeading(trueHdg, lat1, lon1);
      var time = dist / profile.tas; // hours
      var fuel = time * profile.burn; // gallons

      legs.push({
        dist: dist,
        trueHdg: trueHdg,
        magHdg: magHdg,
        time: time,
        fuel: fuel
      });
    }
  }

  function addMapWaypoint(latlng) {
    if (!routeActive) return;
    var lat = latlng.lat.toFixed(4);
    var lon = latlng.lng.toFixed(4);
    var coordName = lat + ', ' + lon;
    var wp = { latlng: latlng, data: null, code: coordName, name: coordName };
    waypoints.push(wp);
    recalculate();
    renderRouteOnMap();
    renderPanel();
    updateButtons();
    fetchRouteWeather();
    startWxRefresh();

    // Reverse-geocode to get place name
    fetch(OWM_PROXY + '/weather?lat=' + lat + '&lon=' + lon)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.name) {
          wp.code = data.name;
          wp.name = data.name;
          renderRouteOnMap();
          renderPanel();
        }
      })
      .catch(function () {});
  }

  function addWaypoint(latlng, airportData) {
    var code = getCode(airportData);

    // Auto-move alternate to new last waypoint
    if (alternateIndex >= 0 && alternateIndex === waypoints.length - 1) {
      waypoints.push({
        latlng: latlng,
        data: airportData,
        code: code,
        name: getName(airportData)
      });
      alternateIndex = waypoints.length - 1;
    } else {
      waypoints.push({
        latlng: latlng,
        data: airportData,
        code: code,
        name: getName(airportData)
      });
    }
    recalculate();
    renderRouteOnMap();
    renderPanel();
    updateButtons();
    fetchRouteWeather();
    startWxRefresh();
  }

  function removeWaypoint(index) {
    if (index < 0 || index >= waypoints.length) return;
    if (index === alternateIndex) {
      alternateIndex = -1;
    } else if (index < alternateIndex) {
      alternateIndex--;
    }
    waypoints.splice(index, 1);
    if (waypoints.length < 3) alternateIndex = -1;
    recalculate();
    renderRouteOnMap();
    renderPanel();
    updateButtons();
    fetchRouteWeather();
  }

  function undoLast() {
    if (waypoints.length === 0) return;
    var removedIndex = waypoints.length - 1;
    if (removedIndex === alternateIndex) {
      alternateIndex = -1;
    } else if (removedIndex < alternateIndex) {
      alternateIndex--;
    }
    waypoints.pop();
    if (waypoints.length < 3) alternateIndex = -1;
    recalculate();
    renderRouteOnMap();
    renderPanel();
    updateButtons();
    fetchRouteWeather();
  }

  function clearRoute() {
    waypoints = [];
    legs = [];
    alternateIndex = -1;
    routeWxCache = {};
    routeOwmCache = {};
    routeOwmSamples = [];
    autoRouteId = null;
    autoRoutePolling = false;
    lastFpl = null;
    arDepCode = null;
    arDestCode = null;
    arDepWp = null;
    arDestWp = null;
    arOptimizeIdx = 0;

    routeLayerGroup.clearLayers();
    renderPanel();
    updateButtons();
    stopWxRefresh();
    closeRouteWxPanel();
  }

  function updateButtons() {
    var hasWp = waypoints.length > 0;
    undoBtn.disabled = !hasWp;
    clearBtn.disabled = !hasWp;
  }

  // --- Map rendering ---

  function midpoint(a, b) {
    return L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2);
  }

  function renderRouteOnMap() {
    routeLayerGroup.clearLayers();
    if (waypoints.length === 0) return;

    // Draw polylines
    for (var i = 0; i < waypoints.length - 1; i++) {
      var a = waypoints[i].latlng;
      var b = waypoints[i + 1].latlng;
      var isAltLeg = (alternateIndex >= 0 && i >= alternateIndex - 1);

      var polyOpts = {
        color: isAltLeg ? '#e67e22' : '#2980b9',
        weight: 3,
        opacity: 0.8,
        interactive: false
      };
      if (isAltLeg) polyOpts.dashArray = '8,6';

      L.polyline([a, b], polyOpts).addTo(routeLayerGroup);

      // Arrow at midpoint
      var mid = midpoint(a, b);
      var bearing = legs[i] ? legs[i].trueHdg : 0;
      var arrowColor = isAltLeg ? '#e67e22' : '#2980b9';
      var arrowIcon = L.divIcon({
        className: 'route-arrow-marker',
        iconSize: [12, 12],
        iconAnchor: [6, 6],
        html: '<div style="transform:rotate(' + Math.round(bearing) + 'deg);color:' + arrowColor + '">&#9650;</div>'
      });
      L.marker(mid, { icon: arrowIcon, interactive: false }).addTo(routeLayerGroup);
    }

    // Numbered waypoint markers with tooltips
    for (var i = 0; i < waypoints.length; i++) {
      var isAlt = (i === alternateIndex);
      var markerClass = isAlt ? 'route-number-marker route-number-marker-alt' : 'route-number-marker';
      var icon = L.divIcon({
        className: markerClass,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
        html: '' + (i + 1)
      });
      var wp = waypoints[i];
      var tipText = wp.code + (wp.name && wp.name !== wp.code ? ' \u2013 ' + wp.name : '');
      var isCustom = !wp.data;
      var marker = L.marker(wp.latlng, { icon: icon, interactive: true, draggable: isCustom })
        .bindTooltip(tipText, { direction: 'top', offset: [0, -11] })
        .addTo(routeLayerGroup);
      if (isCustom) {
        (function(wpRef, idx) {
          marker.on('dragend', function(e) {
            var newLatLng = e.target.getLatLng();
            wpRef.latlng = newLatLng;
            recalculate();
            renderRouteOnMap();
            renderPanel();
            fetchRouteWeather();
            // Reverse-geocode new position
            var lat = newLatLng.lat.toFixed(4);
            var lon = newLatLng.lng.toFixed(4);
            wpRef.code = lat + ', ' + lon;
            wpRef.name = lat + ', ' + lon;
            fetch(OWM_PROXY + '/weather?lat=' + lat + '&lon=' + lon)
              .then(function(r) { return r.json(); })
              .then(function(data) {
                if (data && data.name) {
                  wpRef.code = data.name;
                  wpRef.name = data.name;
                  renderRouteOnMap();
                  renderPanel();
                }
              })
              .catch(function() {});
          });
        })(wp, i);
      }
    }
  }

  // --- Panel rendering ---

  function renderPanel() {
    var profile = getProfile();
    var fuel = getFuel();
    var app = window.AirportApp;
    var METAR_CAT = app.METAR_CAT || {};
    var METAR_LETTER = app.METAR_LETTER || {};

    // Settings line
    if (profile) {
      var pctMatch = profile.label.match(/^(\d+%)/);
      var pct = pctMatch ? pctMatch[1] : '';
      settingsDiv.textContent = 'Using ' + pct + ' power \u00B7 ' + fuel + ' gal';
    } else {
      settingsDiv.textContent = '';
    }

    // Compute departure epoch and cumulative times
    var depEpoch = getDepEpoch();
    var cumTime = [0]; // cumulative time in hours, index 0 = departure
    for (var i = 0; i < legs.length; i++) {
      cumTime.push(cumTime[i] + legs[i].time);
    }

    // Waypoints and legs
    var html = '';
    var formatTime = app.formatTime || function (h) { return h.toFixed(1) + 'h'; };

    for (var i = 0; i < waypoints.length; i++) {
      var wp = waypoints[i];
      var isAlt = (i === alternateIndex);

      // Insert separator before alternate waypoint
      if (isAlt) {
        html += '<div class="route-alt-separator">Alternate</div>';
      }

      html += '<div class="route-waypoint">';
      html += '<span class="route-wp-num' + (isAlt ? ' route-wp-num-alt' : '') + '">' + (i + 1) + '</span>';
      html += '<span class="route-wp-info">';
      html += '<span class="route-wp-name"><span class="route-wp-code route-wp-code-link" data-code="' + escapeHtml(wp.code) + '" data-idx="' + i + '">' + escapeHtml(wp.code) + '</span>';

      // Weather badge: use METAR for departure, TAF for en-route
      if (depEpoch && i < cumTime.length) {
        var arrEpoch = depEpoch + cumTime[i] * 3600;
        var wxCat = null;
        var wxStrongWind = false;
        var wxIcing = false;
        if (i === 0 && app.metarCache && app.metarCache[wp.code]) {
          var metar = app.metarCache[wp.code];
          wxCat = metar.fltCat;
          if (app.isStrongWind) wxStrongWind = app.isStrongWind(metar.wspd, metar.wgst);
          if (app.isIcingRisk) wxIcing = app.isIcingRisk(metar);
        }
        if (!wxCat) {
          var wpWx = getWpWeather(wp.code, arrEpoch);
          if (wpWx) {
            wxCat = wpWx.cat;
            wxStrongWind = wpWx.strongWind;
          }
        }
        // Check icing from METAR cache for any waypoint (if not already set from departure)
        if (!wxIcing && app.isIcingRisk && app.metarCache && app.metarCache[wp.code]) {
          wxIcing = app.isIcingRisk(app.metarCache[wp.code]);
        }
        if (wxCat) {
          var catCfg = METAR_CAT[wxCat] || { color: '#888' };
          var letter = METAR_LETTER[wxCat] || '?';
          html += ' <span class="route-wp-wx" style="background:' + catCfg.color + ';">' + letter + '</span>';
          if (wxStrongWind) {
            html += '<span class="wind-badge">' + (app.WIND_SVG || 'W') + '</span>';
          }
          if (wxIcing) {
            html += '<span class="ice-badge">' + (app.ICE_SVG || 'ICE') + '</span>';
          }
          // NOTAM badge
          if (app.notamCache && app.notamCache[wp.code] && app.notamCache[wp.code].count > 0) {
            var nd = app.notamCache[wp.code];
            var notamBadgeClass = nd.hasCritical ? 'notam-badge notam-badge-critical' : 'notam-badge';
            html += '<span class="' + notamBadgeClass + '">' + (app.NOTAM_SVG || '!') + '</span>';
          }
        } else {
          html += ' <span class="route-wp-wx route-wp-wx-none">-</span>';
        }
      }

      if (wp.data && wp.name) html += '  ' + escapeHtml(wp.name);
      html += '</span>';
      html += '</span>';

      // ALT toggle on last waypoint when 3+ waypoints
      if (i === waypoints.length - 1 && waypoints.length >= 3) {
        html += '<button class="route-alt-toggle' + (isAlt ? ' active' : '') + '" data-idx="' + i + '" title="Toggle alternate">ALT</button>';
      }

      html += '<button class="route-wp-remove" data-idx="' + i + '" title="Remove">&times;</button>';
      html += '</div>';

      // Leg info after each waypoint (except last)
      if (i < legs.length) {
        var leg = legs[i];
        html += '<div class="route-leg-info">';
        html += '<span class="route-leg-arrow">&rarr;</span> ';
        html += Math.round(leg.dist) + ' nm &middot; ';
        html += Math.round(leg.magHdg) + '&deg;M &middot; ';
        html += formatTime(leg.time) + ' &middot; ';
        html += leg.fuel.toFixed(1) + ' gal';
        html += '</div>';
      }
    }
    waypointsDiv.innerHTML = html;

    // Wire up remove buttons
    var removeBtns = waypointsDiv.querySelectorAll('.route-wp-remove');
    for (var i = 0; i < removeBtns.length; i++) {
      removeBtns[i].addEventListener('click', function (e) {
        var idx = parseInt(e.currentTarget.getAttribute('data-idx'), 10);
        removeWaypoint(idx);
      });
    }

    // Wire up ALT toggle buttons
    var altBtns = waypointsDiv.querySelectorAll('.route-alt-toggle');
    for (var i = 0; i < altBtns.length; i++) {
      altBtns[i].addEventListener('click', function (e) {
        var idx = parseInt(e.currentTarget.getAttribute('data-idx'), 10);
        alternateIndex = (alternateIndex === idx) ? -1 : idx;
        renderRouteOnMap();
        renderPanel();
      });
    }

    // Wire up waypoint code clicks → pan map to waypoint
    var wpCodeLinks = waypointsDiv.querySelectorAll('.route-wp-code-link');
    for (var i = 0; i < wpCodeLinks.length; i++) {
      wpCodeLinks[i].addEventListener('click', function (e) {
        var code = e.currentTarget.getAttribute('data-code');
        var idx = parseInt(e.currentTarget.getAttribute('data-idx'), 10);
        var app = window.AirportApp;
        var marker = app.markersByIcao && app.markersByIcao[code];
        if (marker) {
          skipNextRouteAdd = true;
          map.panTo(marker.getLatLng());
          marker.openPopup();
        } else if (waypoints[idx]) {
          map.panTo(waypoints[idx].latlng);
        }
      });
    }

    // Totals
    if (legs.length > 0) {
      var thtml = '';
      var reserveHours = app.RESERVE_HOURS || 0.75;

      if (alternateIndex >= 0 && profile) {
        // Split totals: Trip / Alternate / Reserve / Required / Remaining
        var tripDist = 0, tripTime = 0, tripFuel = 0;
        var altDist = 0, altTime = 0, altFuel = 0;

        for (var i = 0; i < legs.length; i++) {
          if (i < alternateIndex - 1) {
            tripDist += legs[i].dist;
            tripTime += legs[i].time;
            tripFuel += legs[i].fuel;
          } else {
            altDist += legs[i].dist;
            altTime += legs[i].time;
            altFuel += legs[i].fuel;
          }
        }

        var reserveFuel = reserveHours * profile.burn;
        var requiredFuel = tripFuel + altFuel + reserveFuel;
        var remaining = fuel - requiredFuel;

        thtml += '<div class="route-totals-line">';
        thtml += 'Trip: ' + Math.round(tripDist) + ' nm &middot; ' + formatTime(tripTime) + ' &middot; ' + tripFuel.toFixed(1) + ' gal';
        thtml += '</div>';

        thtml += '<div class="route-totals-line route-totals-alt">';
        thtml += 'Alternate: ' + Math.round(altDist) + ' nm &middot; ' + formatTime(altTime) + ' &middot; ' + altFuel.toFixed(1) + ' gal';
        thtml += '</div>';

        thtml += '<div class="route-totals-line route-totals-sub">';
        thtml += 'Reserve: ' + Math.round(reserveHours * 60) + ' min &middot; ' + reserveFuel.toFixed(1) + ' gal';
        thtml += '</div>';

        thtml += '<div class="route-totals-line" style="border-top:1px solid #ddd;padding-top:2px;margin-top:2px">';
        thtml += 'Required: ' + requiredFuel.toFixed(1) + ' gal';
        thtml += '</div>';

        if (remaining < 0) {
          thtml += '<div class="route-fuel-warning">';
          thtml += 'Fuel deficit: ' + Math.abs(remaining).toFixed(1) + ' gal short!';
          thtml += '</div>';
        } else {
          var remainHours = remaining / profile.burn;
          thtml += '<div class="route-remaining">';
          thtml += 'Remaining: ' + remaining.toFixed(1) + ' gal';
          thtml += ' (' + formatTime(remainHours) + ' endurance)';
          thtml += '</div>';
        }
      } else {
        // Simple totals (no alternate)
        var totalDist = 0, totalTime = 0, totalFuel = 0;
        for (var i = 0; i < legs.length; i++) {
          totalDist += legs[i].dist;
          totalTime += legs[i].time;
          totalFuel += legs[i].fuel;
        }
        var remaining = fuel - totalFuel;

        thtml += '<div class="route-totals-line">';
        thtml += 'Total: ' + Math.round(totalDist) + ' nm &middot; ' + formatTime(totalTime) + ' &middot; ' + totalFuel.toFixed(1) + ' gal';
        thtml += '</div>';

        if (remaining < 0) {
          thtml += '<div class="route-fuel-warning">';
          thtml += 'Fuel deficit: ' + Math.abs(remaining).toFixed(1) + ' gal short!';
          thtml += '</div>';
        } else {
          var remainHours = profile ? remaining / profile.burn : 0;
          var warningClass = remainHours < reserveHours ? ' route-fuel-warning' : '';
          thtml += '<div class="route-remaining' + warningClass + '">';
          thtml += 'Remaining: ' + remaining.toFixed(1) + ' gal';
          if (profile) thtml += ' (' + formatTime(remainHours) + ' endurance)';
          if (remainHours < reserveHours) thtml += ' &mdash; below reserve!';
          thtml += '</div>';
        }
      }

      // Wind-adjusted totals placeholder (populated asynchronously)
      if (waypoints.length >= 2 && profile && depEpoch) {
        thtml += '<div id="route-wind-totals"></div>';
      }

      // AMA terrain warnings
      var amaWarnings = checkRouteAMA();
      if (amaWarnings.length > 0) {
        var fl = getFL();
        thtml += '<div class="route-terrain-warning">';
        thtml += '&#9888; FL' + fl + ' is at or below terrain:';
        for (var w = 0; w < amaWarnings.length; w++) {
          var aw = amaWarnings[w];
          var fromCode = waypoints[aw.leg].code || ('WP' + (aw.leg + 1));
          var toCode = waypoints[aw.leg + 1].code || ('WP' + (aw.leg + 2));
          thtml += '<br>' + escapeHtml(fromCode) + ' &rarr; ' + escapeHtml(toCode) + ': AMA ' + aw.maxAma + ' ft';
        }
        thtml += '</div>';
      }

      // Action buttons
      if (waypoints.length >= 2) {
        thtml += '<div class="route-wx-btns">';
        thtml += '<button class="route-wx-btn route-wx-open-btn">Weather</button>';
        thtml += '<button class="route-wx-btn route-export-fpl-btn">Export FPL</button>';
        thtml += '<button class="route-wx-btn route-export-gpx-btn">Export GPX</button>';
        thtml += '<button class="route-wx-btn route-print-btn">Print</button>';
        thtml += '</div>';
      }

      totalsDiv.innerHTML = thtml;

      // Wire up buttons
      var wxBtn = totalsDiv.querySelector('.route-wx-open-btn');
      if (wxBtn) wxBtn.addEventListener('click', function () { openRouteWxPanel('rw-airgram'); });
      var fplBtn = totalsDiv.querySelector('.route-export-fpl-btn');
      if (fplBtn) fplBtn.addEventListener('click', exportFPL);
      var gpxBtn = totalsDiv.querySelector('.route-export-gpx-btn');
      if (gpxBtn) gpxBtn.addEventListener('click', exportGPX);
      var printBtn = totalsDiv.querySelector('.route-print-btn');
      if (printBtn) printBtn.addEventListener('click', printFlightPlan);

      // Populate wind-adjusted totals from cache (non-blocking)
      updateWindTotals();
    } else {
      totalsDiv.innerHTML = '';
    }
  }

  // --- Wind-adjusted totals in route list ---

  function updateWindTotals() {
    var el = document.getElementById('route-wind-totals');
    if (!el) return;
    var profile = getProfile();
    var depEpoch = getDepEpoch();
    if (waypoints.length < 2 || !profile || !depEpoch || legs.length === 0) return;

    var app = window.AirportApp;
    var samples = buildRouteAirgramSamples();
    if (samples.length === 0) return;

    // Only use cached data — don't trigger a fetch from renderPanel
    app.fetchRouteAirgramData(samples, function (responses) {
      // Re-check element still exists (panel may have re-rendered)
      el = document.getElementById('route-wind-totals');
      if (!el || !responses) return;

      var result = computeWindTotals(responses, samples, profile);
      if (!result) return;

      var formatTime = app.formatTime || function (h) { return h.toFixed(1) + 'h'; };
      var fl = getFL();
      var flLabel = 'FL' + (fl < 100 ? '0' : '') + fl;

      var hwAbs = Math.abs(Math.round(result.avgHW));
      var windTotal = Math.round(result.avgWind);
      var windStr = '';
      if (windTotal > 0) {
        windStr = ' &middot; Wind ' + windTotal + ' kt';
        if (result.avgHW > 0.5) windStr += ' (Head ' + hwAbs + ')';
        else if (result.avgHW < -0.5) windStr += ' (Tail ' + hwAbs + ')';
      }

      // Compare against no-wind totals
      var noWindTime = 0, noWindFuel = 0;
      for (var i = 0; i < legs.length; i++) {
        noWindTime += legs[i].time;
        noWindFuel += legs[i].fuel;
      }
      var timeDiffMin = Math.round((result.time - noWindTime) * 60);
      var diffStr = '';
      if (timeDiffMin > 0) diffStr = ' (+' + timeDiffMin + 'min)';
      else if (timeDiffMin < 0) diffStr = ' (' + timeDiffMin + 'min)';

      el.innerHTML = '<div class="route-wind-line">'
        + 'Wind adj: ' + formatTime(result.time) + ' &middot; ' + result.fuel.toFixed(1) + ' gal'
        + windStr + diffStr
        + '</div>';
    });
  }

  function computeWindTotals(responses, samples, profile) {
    var app = window.AirportApp;
    var LEVELS = app.AIRGRAM_LEVELS;
    if (!LEVELS) return null;
    var nLevels = LEVELS.length;
    var nPoints = samples.length;
    var stdHts = [111, 762, 1457, 2164, 3012, 4206, 5574, 6344];

    // Parse grid
    var grid = [];
    for (var li = 0; li < nLevels; li++) {
      grid[li] = [];
      var lev = LEVELS[li];
      var wsKey = 'wind_speed_' + lev + 'hPa';
      var wdKey = 'wind_direction_' + lev + 'hPa';
      var ghKey = 'geopotential_height_' + lev + 'hPa';
      for (var pi = 0; pi < nPoints; pi++) {
        var resp = responses[pi];
        var hourly = resp && resp.hourly;
        if (!hourly || !hourly.time) {
          grid[li][pi] = { windSpd: null, windDir: null, geoHt: stdHts[li] };
          continue;
        }
        var hi = 0;
        if (samples[pi].etaEpoch) {
          var etaMs = samples[pi].etaEpoch * 1000;
          var bestDiff = Infinity;
          for (var h = 0; h < hourly.time.length; h++) {
            var diff = Math.abs(new Date(hourly.time[h]).getTime() - etaMs);
            if (diff < bestDiff) { bestDiff = diff; hi = h; }
          }
        }
        grid[li][pi] = {
          windSpd: hourly[wsKey] ? hourly[wsKey][hi] : null,
          windDir: hourly[wdKey] ? hourly[wdKey][hi] : null,
          geoHt: hourly[ghKey] ? hourly[ghKey][hi] : stdHts[li]
        };
      }
    }

    var avgGeoHt = [];
    for (var li = 0; li < nLevels; li++) {
      var sum = 0, cnt = 0;
      for (var pi = 0; pi < nPoints; pi++) {
        if (grid[li][pi].geoHt != null) { sum += grid[li][pi].geoHt; cnt++; }
      }
      avgGeoHt[li] = cnt > 0 ? sum / cnt : stdHts[li];
    }

    var cumDist = [0];
    for (var i = 0; i < legs.length; i++) cumDist.push(cumDist[i] + legs[i].dist);
    var totalDist = cumDist[cumDist.length - 1];
    if (totalDist <= 0) return null;

    var sampleLeg = [];
    for (var pi = 0; pi < nPoints; pi++) {
      var d = samples[pi].dist;
      var idx = 0;
      for (var j = 0; j < legs.length; j++) {
        if (d >= cumDist[j] && d <= cumDist[j + 1] + 0.01) { idx = j; break; }
      }
      sampleLeg[pi] = idx;
    }

    function interpWindAt(pi, targetM) {
      var spd = null, dir = null;
      for (var li = 0; li < nLevels - 1; li++) {
        var h0 = avgGeoHt[li], h1 = avgGeoHt[li + 1];
        if (targetM >= h0 && targetM <= h1) {
          var frac = (targetM - h0) / (h1 - h0);
          var s0 = grid[li][pi].windSpd, s1 = grid[li + 1][pi].windSpd;
          var d0 = grid[li][pi].windDir, d1 = grid[li + 1][pi].windDir;
          if (s0 != null && s1 != null) spd = s0 + frac * (s1 - s0);
          if (d0 != null && d1 != null) dir = interpAngle(d0, d1, frac);
          break;
        }
      }
      if (spd == null && targetM <= avgGeoHt[0]) {
        spd = grid[0][pi].windSpd; dir = grid[0][pi].windDir;
      }
      if (spd == null && targetM >= avgGeoHt[nLevels - 1]) {
        spd = grid[nLevels - 1][pi].windSpd; dir = grid[nLevels - 1][pi].windDir;
      }
      return { spd: spd, dir: dir };
    }

    var fl = getFL();
    var altM = fl * 100 * 0.3048;
    var totalTime = 0, totalFuelUsed = 0;
    var avgHW = 0, hwCount = 0;
    var avgWind = 0, windCount = 0;

    for (var legI = 0; legI < legs.length; legI++) {
      var legDist = legs[legI].dist;
      var track = legs[legI].trueHdg;
      var legWindSamples = [];
      var legSpdSamples = [];
      for (var pi = 0; pi < nPoints; pi++) {
        if (sampleLeg[pi] === legI) {
          var w = interpWindAt(pi, altM);
          if (w.spd != null && w.dir != null) {
            var angleDiff = (w.dir - track) * Math.PI / 180;
            legWindSamples.push(w.spd * Math.cos(angleDiff));
            legSpdSamples.push(w.spd);
          }
        }
      }
      var legHW = 0, legSpd = 0;
      if (legWindSamples.length > 0) {
        for (var s = 0; s < legWindSamples.length; s++) { legHW += legWindSamples[s]; legSpd += legSpdSamples[s]; }
        legHW /= legWindSamples.length;
        legSpd /= legWindSamples.length;
      }
      avgHW += legHW * legDist;
      avgWind += legSpd * legDist;
      hwCount += legDist;
      windCount += legDist;
      var gs = Math.max(50, profile.tas - legHW);
      totalTime += legDist / gs;
      totalFuelUsed += (legDist / gs) * profile.burn;
    }

    return {
      time: totalTime,
      fuel: totalFuelUsed,
      avgHW: hwCount > 0 ? avgHW / hwCount : 0,
      avgWind: windCount > 0 ? avgWind / windCount : 0
    };
  }

  // --- Route Weather floating panel ---

  var rwPanelLoaded = {}; // track which tabs have been populated

  function openRouteWxPanel(tab) {
    var panel = document.getElementById('route-wx-panel');
    if (!panel) return;
    panel.style.display = '';

    // Switch tabs
    var tabs = panel.querySelectorAll('.route-wx-panel-tab');
    var contents = panel.querySelectorAll('.route-wx-panel-content');
    for (var i = 0; i < tabs.length; i++) {
      var t = tabs[i].getAttribute('data-rwtab');
      tabs[i].classList.toggle('active', t === tab);
    }
    for (var i = 0; i < contents.length; i++) {
      contents[i].style.display = contents[i].id === tab ? '' : 'none';
    }

    // Populate content on first open
    if (tab === 'rw-airgram') {
      loadRouteAirgram();
    } else if (tab === 'rw-gramet') {
      loadRouteGramet();
    } else if (tab === 'rw-flcomp') {
      loadFlComparison();
    }
  }

  function closeRouteWxPanel() {
    var panel = document.getElementById('route-wx-panel');
    if (panel) panel.style.display = 'none';
  }

  function loadRouteGramet() {
    var el = document.getElementById('rw-gramet');
    if (!el) return;
    var depEpoch = getDepEpoch();
    if (!depEpoch || waypoints.length < 2) {
      el.innerHTML = '<span class="info-unknown">Set departure time and at least 2 waypoints</span>';
      return;
    }

    var cumTime = [0];
    for (var i = 0; i < legs.length; i++) {
      cumTime.push(cumTime[i] + legs[i].time);
    }
    var totalEetSec = Math.ceil((cumTime[cumTime.length - 1] || 1) * 3600);
    var fl = getFL();

    var grametWaypoints = waypoints.map(function (wp) { return wp.code; }).join(' ');
    var grametSrc = OWM_PROXY + '/ar/gramet?waypoints=' + encodeURIComponent(grametWaypoints)
      + '&departuretime=' + depEpoch
      + '&totaleet=' + totalEetSec
      + '&altitude=' + (fl * 100);

    el.innerHTML = '<div class="route-gramet-section">'
      + '<div class="route-gramet-label">GRAMET Cross Section</div>'
      + '<img class="route-gramet-img" src="' + escapeHtml(grametSrc) + '" alt="GRAMET" onerror="this.parentNode.innerHTML=\'<span class=info-unknown>GRAMET unavailable</span>\'" style="cursor:pointer" title="Click to open in new tab">'
      + '</div>';

    var img = el.querySelector('.route-gramet-img');
    if (img) {
      img.addEventListener('click', function () {
        window.open(grametSrc, '_blank');
      });
    }
  }

  function buildRouteAirgramSamples() {
    if (waypoints.length < 2 || legs.length === 0) return [];

    var cumDist = [0];
    var cumTime = [0];
    for (var i = 0; i < legs.length; i++) {
      cumDist.push(cumDist[i] + legs[i].dist);
      cumTime.push(cumTime[i] + legs[i].time);
    }
    var totalDist = cumDist[cumDist.length - 1];
    if (totalDist <= 0) return [];

    var depEpoch = getDepEpoch();
    var N = Math.min(16, Math.max(8, waypoints.length * 3));
    var samples = [];

    for (var s = 0; s < N; s++) {
      var frac = s / (N - 1);
      var dist = frac * totalDist;

      // Find which leg this distance falls on
      var legIdx = 0;
      for (var j = 0; j < legs.length; j++) {
        if (dist >= cumDist[j] && dist <= cumDist[j + 1]) { legIdx = j; break; }
      }

      var legDist = cumDist[legIdx + 1] - cumDist[legIdx];
      var legFrac = legDist > 0 ? (dist - cumDist[legIdx]) / legDist : 0;

      var a = waypoints[legIdx].latlng;
      var b = waypoints[legIdx + 1].latlng;
      var lat = a.lat + (b.lat - a.lat) * legFrac;
      var lon = a.lng + (b.lng - a.lng) * legFrac;

      // Time at this point
      var legTime = cumTime[legIdx + 1] - cumTime[legIdx];
      var timeH = cumTime[legIdx] + legFrac * legTime;

      // Check if near a waypoint
      var label = null;
      for (var w = 0; w < waypoints.length; w++) {
        if (Math.abs(dist - cumDist[w]) < totalDist * 0.03) {
          label = waypoints[w].code;
          break;
        }
      }

      var etaEpoch = depEpoch ? depEpoch + timeH * 3600 : null;
      samples.push({
        lat: Math.round(lat * 100) / 100,
        lon: Math.round(lon * 100) / 100,
        dist: dist,
        timeH: timeH,
        etaEpoch: etaEpoch,
        label: label
      });
    }
    return samples;
  }

  function loadRouteAirgram() {
    var el = document.getElementById('rw-airgram');
    if (!el) return;
    if (waypoints.length < 2) {
      el.innerHTML = '';
      return;
    }
    var samples = buildRouteAirgramSamples();
    if (samples.length === 0) {
      el.innerHTML = '';
      return;
    }
    var app = window.AirportApp;
    if (app.fetchRouteAirgramInto) {
      app.fetchRouteAirgramInto(el, samples);
    }
  }

  // --- Export FPL (Garmin flight plan) ---

  function exportFPL() {
    if (waypoints.length < 2) return;

    var now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    var xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<flight-plan xmlns="http://www8.garmin.com/xmlschemas/FlightPlan/v1">\n'
      + '  <created>' + now + '</created>\n'
      + '  <waypoint-table>\n';

    // Build waypoint identifiers (must be unique)
    var ids = [];
    var usedIds = {};
    for (var i = 0; i < waypoints.length; i++) {
      var wp = waypoints[i];
      var id;
      if (wp.data) {
        // Airport: use ICAO code
        id = (wp.data[9] || wp.data[0] || 'WP').toUpperCase();
      } else if (wp.code && isIfrIdent(wp.code)) {
        // IFR waypoint: use its real identifier (e.g. ENETI, AMROT)
        id = wp.code.toUpperCase();
      } else {
        // Custom map waypoint: generate ID
        id = 'USR' + (i + 1);
      }
      // Ensure uniqueness
      if (usedIds[id]) {
        var suffix = 2;
        while (usedIds[id + suffix]) suffix++;
        id = id + suffix;
      }
      usedIds[id] = true;
      ids.push(id);
    }

    // Waypoint table
    for (var i = 0; i < waypoints.length; i++) {
      var wp = waypoints[i];
      var lat = wp.latlng.lat.toFixed(6);
      var lon = wp.latlng.lng.toFixed(6);

      xml += '    <waypoint>\n';
      xml += '      <identifier>' + escapeXml(ids[i]) + '</identifier>\n';

      if (wp.data) {
        xml += '      <type>AIRPORT</type>\n';
        // Country code: first 2 chars of ICAO (e.g., EF from EFHK)
        var icao = wp.data[9] || wp.data[0] || '';
        if (icao.length >= 2) {
          xml += '      <country-code>' + escapeXml(icao.substring(0, 2).toUpperCase()) + '</country-code>\n';
        }
        var elev = wp.data[5];
        if (elev && !isNaN(parseFloat(elev))) {
          xml += '      <elevation>' + parseFloat(elev).toFixed(1) + '</elevation>\n';
        }
      } else {
        // Determine type: ifrType from autorouter, or infer from code
        var wpFplType = wp.ifrType || (isIfrIdent(wp.code) ? 'INT' : 'USER WAYPOINT');
        xml += '      <type>' + escapeXml(wpFplType) + '</type>\n';
      }

      xml += '      <lat>' + lat + '</lat>\n';
      xml += '      <lon>' + lon + '</lon>\n';
      if (wp.name) {
        xml += '      <comment>' + escapeXml(wp.name) + '</comment>\n';
      }
      xml += '    </waypoint>\n';
    }

    xml += '  </waypoint-table>\n';

    // Route
    var routeName = ids[0] + '-' + ids[ids.length - 1];
    xml += '  <route>\n';
    xml += '    <route-name>' + escapeXml(routeName) + '</route-name>\n';
    xml += '    <flight-plan-index>1</flight-plan-index>\n';

    for (var i = 0; i < waypoints.length; i++) {
      xml += '    <route-point>\n';
      xml += '      <waypoint-identifier>' + escapeXml(ids[i]) + '</waypoint-identifier>\n';
      if (waypoints[i].data) {
        xml += '      <waypoint-type>AIRPORT</waypoint-type>\n';
      } else {
        var rpType = waypoints[i].ifrType || (isIfrIdent(waypoints[i].code) ? 'INT' : 'USER WAYPOINT');
        xml += '      <waypoint-type>' + escapeXml(rpType) + '</waypoint-type>\n';
      }
      xml += '    </route-point>\n';
    }

    xml += '  </route>\n';
    xml += '</flight-plan>\n';

    // Trigger download
    var blob = new Blob([xml], { type: 'application/xml' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = routeName + '.fpl';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // --- Export GPX ---

  function exportGPX() {
    if (waypoints.length < 2) return;

    var now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    var depCode = waypoints[0].data ? (waypoints[0].data[9] || waypoints[0].data[0] || 'DEP') : 'DEP';
    var arrCode = waypoints[waypoints.length - 1].data ? (waypoints[waypoints.length - 1].data[9] || waypoints[waypoints.length - 1].data[0] || 'ARR') : 'ARR';
    var routeName = depCode.toUpperCase() + '-' + arrCode.toUpperCase();

    var xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<gpx version="1.1" creator="AirportsMap"\n'
      + '  xmlns="http://www.topografix.com/GPX/1/1"\n'
      + '  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"\n'
      + '  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">\n';

    // Waypoints
    for (var i = 0; i < waypoints.length; i++) {
      var wp = waypoints[i];
      var lat = wp.latlng.lat.toFixed(6);
      var lon = wp.latlng.lng.toFixed(6);
      var name = wp.data ? (wp.data[9] || wp.data[0] || wp.code) : wp.code;

      xml += '  <wpt lat="' + lat + '" lon="' + lon + '">\n';
      if (wp.data) {
        var elev = wp.data[5];
        if (elev && !isNaN(parseFloat(elev))) {
          xml += '    <ele>' + (parseFloat(elev) * 0.3048).toFixed(1) + '</ele>\n'; // ft to meters
        }
      }
      xml += '    <name>' + escapeXml(name) + '</name>\n';
      if (wp.name && wp.name !== name) {
        xml += '    <desc>' + escapeXml(wp.name) + '</desc>\n';
      }
      var gpxType = wp.data ? 'AIRPORT' : (wp.ifrType || (isIfrIdent(wp.code) ? 'INT' : 'WAYPOINT'));
      xml += '    <type>' + escapeXml(gpxType) + '</type>\n';
      xml += '  </wpt>\n';
    }

    // Route
    xml += '  <rte>\n';
    xml += '    <name>' + escapeXml(routeName) + '</name>\n';
    for (var i = 0; i < waypoints.length; i++) {
      var wp = waypoints[i];
      var lat = wp.latlng.lat.toFixed(6);
      var lon = wp.latlng.lng.toFixed(6);
      var name = wp.data ? (wp.data[9] || wp.data[0] || wp.code) : wp.code;

      xml += '    <rtept lat="' + lat + '" lon="' + lon + '">\n';
      if (wp.data) {
        var elev = wp.data[5];
        if (elev && !isNaN(parseFloat(elev))) {
          xml += '      <ele>' + (parseFloat(elev) * 0.3048).toFixed(1) + '</ele>\n';
        }
      }
      xml += '      <name>' + escapeXml(name) + '</name>\n';
      xml += '    </rtept>\n';
    }
    xml += '  </rte>\n';
    xml += '</gpx>\n';

    // Trigger download
    var blob = new Blob([xml], { type: 'application/gpx+xml' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = routeName + '.gpx';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // --- Print Flight Plan ---

  function printFlightPlan() {
    if (waypoints.length < 2 || legs.length === 0) return;

    var app = window.AirportApp;
    var profile = getProfile();
    var fuel = getFuel();
    var fl = getFL();
    var depEpoch = getDepEpoch();
    var formatTime = app.formatTime || function (h) { return h.toFixed(1) + 'h'; };
    var reserveHours = app.RESERVE_HOURS || 0.75;
    var METAR_CAT = app.METAR_CAT || {};

    // Header info
    var depCode = waypoints[0].code;
    var destIdx = alternateIndex >= 0 ? alternateIndex - 1 : waypoints.length - 1;
    var destCode = waypoints[destIdx].code;
    var altCode = alternateIndex >= 0 ? waypoints[alternateIndex].code : null;

    var dateStr = '';
    var depTimeStr = '';
    if (depEpoch) {
      var d = new Date(depEpoch * 1000);
      dateStr = d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
      depTimeStr = pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ' UTC';
    }

    var flLabel = 'FL' + (fl < 100 ? '0' : '') + fl;
    var profileLabel = profile ? profile.label : '';

    // Cumulative times
    var cumTime = [0];
    for (var i = 0; i < legs.length; i++) {
      cumTime.push(cumTime[i] + legs[i].time);
    }

    // Build nav log rows
    var navRows = '';
    var cumFuel = 0;
    var maxLeg = alternateIndex >= 0 ? alternateIndex - 1 : legs.length;

    for (var i = 0; i < waypoints.length; i++) {
      var wp = waypoints[i];
      var isAlt = (i === alternateIndex);

      // Alternate separator
      if (isAlt) {
        navRows += '<tr class="alt-sep"><td colspan="10">ALTERNATE</td></tr>';
      }

      // Waypoint row
      var wpName = wp.name && wp.name !== wp.code ? esc(wp.name) : '';
      if (wpName.length > 24) wpName = wpName.substring(0, 24) + '…';
      var wpElev = wp.data ? (wp.data[5] || '') : '';

      // Weather for this waypoint
      var wxLabel = '';
      if (depEpoch && i < cumTime.length) {
        var arrEpoch = depEpoch + cumTime[i] * 3600;
        var wxCat = null;
        if (i === 0 && app.metarCache && app.metarCache[wp.code]) {
          wxCat = app.metarCache[wp.code].fltCat;
        }
        if (!wxCat) {
          var wpWx = getWpWeather(wp.code, arrEpoch);
          if (wpWx) wxCat = wpWx.cat;
        }
        if (wxCat) wxLabel = wxCat;
      }

      // NOTAM count
      var notamLabel = '';
      if (app.notamCache && app.notamCache[wp.code]) {
        var nd = app.notamCache[wp.code];
        if (nd.count > 0) {
          notamLabel = nd.count + (nd.hasCritical ? '!' : '');
        }
      }

      // ETA
      var etaStr = '';
      if (depEpoch && i < cumTime.length) {
        var etaEpoch = depEpoch + cumTime[i] * 3600;
        var etaDate = new Date(etaEpoch * 1000);
        etaStr = pad2(etaDate.getUTCHours()) + ':' + pad2(etaDate.getUTCMinutes());
      }

      // Remaining fuel at this waypoint
      var remFuel = fuel - cumFuel;

      navRows += '<tr class="wp-row' + (isAlt ? ' alt-row' : '') + '">';
      navRows += '<td class="nr">' + (i + 1) + '</td>';
      navRows += '<td class="code">' + esc(wp.code) + '</td>';
      navRows += '<td class="name">' + wpName + '</td>';
      navRows += '<td class="num">' + (wpElev ? Math.round(parseFloat(wpElev)) : '') + '</td>';
      navRows += '<td class="num"></td>'; // HDG (blank on waypoint row)
      navRows += '<td class="num"></td>'; // DIST
      navRows += '<td class="num">' + etaStr + '</td>';
      navRows += '<td class="num">' + remFuel.toFixed(1) + '</td>';
      navRows += '<td class="wx">' + wxLabel + '</td>';
      navRows += '<td class="num">' + notamLabel + '</td>';
      navRows += '</tr>';

      // Leg row (after each waypoint except last)
      if (i < legs.length) {
        var leg = legs[i];
        cumFuel += leg.fuel;
        var legTimeMin = Math.round(leg.time * 60);

        navRows += '<tr class="leg-row">';
        navRows += '<td></td><td></td><td></td><td></td>';
        navRows += '<td class="num">' + Math.round(leg.magHdg) + '°</td>';
        navRows += '<td class="num">' + Math.round(leg.dist) + '</td>';
        navRows += '<td class="num">' + legTimeMin + ' min</td>';
        navRows += '<td class="num">' + leg.fuel.toFixed(1) + '</td>';
        navRows += '<td></td><td></td>';
        navRows += '</tr>';
      }
    }

    // Totals
    var totalDist = 0, totalTime = 0, totalFuel = 0;
    var tripDist = 0, tripTime = 0, tripFuel = 0;
    var altDist = 0, altTime = 0, altFuel = 0;
    for (var i = 0; i < legs.length; i++) {
      totalDist += legs[i].dist;
      totalTime += legs[i].time;
      totalFuel += legs[i].fuel;
      if (alternateIndex >= 0) {
        if (i < alternateIndex - 1) {
          tripDist += legs[i].dist; tripTime += legs[i].time; tripFuel += legs[i].fuel;
        } else {
          altDist += legs[i].dist; altTime += legs[i].time; altFuel += legs[i].fuel;
        }
      }
    }

    var totalsHtml = '';
    if (alternateIndex >= 0 && profile) {
      var reserveFuel = reserveHours * profile.burn;
      var requiredFuel = tripFuel + altFuel + reserveFuel;
      var remaining = fuel - requiredFuel;
      totalsHtml += '<tr class="totals-row"><td></td><td>TRIP</td><td></td><td></td><td></td>'
        + '<td class="num">' + Math.round(tripDist) + '</td>'
        + '<td class="num">' + formatTime(tripTime) + '</td>'
        + '<td class="num">' + tripFuel.toFixed(1) + '</td><td></td><td></td></tr>';
      totalsHtml += '<tr class="totals-row"><td></td><td>ALT</td><td>' + esc(altCode || '') + '</td><td></td><td></td>'
        + '<td class="num">' + Math.round(altDist) + '</td>'
        + '<td class="num">' + formatTime(altTime) + '</td>'
        + '<td class="num">' + altFuel.toFixed(1) + '</td><td></td><td></td></tr>';
      totalsHtml += '<tr class="totals-row"><td></td><td>RESERVE</td><td>' + Math.round(reserveHours * 60) + ' min</td><td></td><td></td>'
        + '<td></td><td></td>'
        + '<td class="num">' + reserveFuel.toFixed(1) + '</td><td></td><td></td></tr>';
      totalsHtml += '<tr class="totals-row totals-req"><td></td><td>REQUIRED</td><td></td><td></td><td></td>'
        + '<td></td><td></td>'
        + '<td class="num">' + requiredFuel.toFixed(1) + '</td><td></td><td></td></tr>';
      totalsHtml += '<tr class="totals-row"><td></td><td>REMAINING</td><td></td><td></td><td></td>'
        + '<td></td><td></td>'
        + '<td class="num' + (remaining < 0 ? ' warn' : '') + '">' + remaining.toFixed(1) + '</td><td></td><td></td></tr>';
    } else {
      totalsHtml += '<tr class="totals-row"><td></td><td>TOTAL</td><td></td><td></td><td></td>'
        + '<td class="num">' + Math.round(totalDist) + '</td>'
        + '<td class="num">' + formatTime(totalTime) + '</td>'
        + '<td class="num">' + totalFuel.toFixed(1) + '</td><td></td><td></td></tr>';
      var remaining = fuel - totalFuel;
      totalsHtml += '<tr class="totals-row"><td></td><td>REMAINING</td><td></td><td></td><td></td>'
        + '<td></td><td></td>'
        + '<td class="num' + (remaining < 0 ? ' warn' : '') + '">' + remaining.toFixed(1) + '</td><td></td><td></td></tr>';
    }

    // Wind-adjusted totals (read from DOM if available)
    var windLine = '';
    var windEl = document.getElementById('route-wind-totals');
    if (windEl && windEl.textContent.trim()) {
      windLine = '<p class="wind-adj">' + esc(windEl.textContent.trim()) + '</p>';
    }

    // W&B section — include input parameters
    var wbHtml = '';
    var wbResults = document.getElementById('wb-results');
    var wbEnvelope = document.getElementById('wb-envelope');
    if (wbResults && wbResults.innerHTML.trim()) {
      wbHtml += '<div class="section"><h2>WEIGHT &amp; BALANCE</h2>';

      // Loading table from input values
      var wbInputs = [
        { id: 'wb-empty-wt', label: 'Empty weight', unit: 'kg', id2: 'wb-empty-cg', label2: 'CG', unit2: 'm' },
        { id: 'wb-deice', label: 'TKS fluid', unit: 'kg' },
        { id: 'wb-front-l', label: 'Front left', unit: 'kg' },
        { id: 'wb-front-r', label: 'Front right', unit: 'kg' },
        { id: 'wb-row1-l', label: 'Rear left', unit: 'kg' },
        { id: 'wb-row1-r', label: 'Rear right', unit: 'kg' },
        { id: 'wb-nose-rh', label: 'Nose RH', unit: 'kg' },
        { id: 'wb-nose-lh', label: 'Nose LH', unit: 'kg' },
        { id: 'wb-tail-a', label: 'Tail A', unit: 'kg' },
        { id: 'wb-tail-b', label: 'Tail B', unit: 'kg' },
        { id: 'wb-tail-c', label: 'Tail C', unit: 'kg' },
        { id: 'wb-tail-d', label: 'Tail D', unit: 'kg' }
      ];
      wbHtml += '<table class="wb-loading"><thead><tr><th>Station</th><th>Weight</th></tr></thead><tbody>';
      for (var wi = 0; wi < wbInputs.length; wi++) {
        var wbi = wbInputs[wi];
        var el = document.getElementById(wbi.id);
        var val = el ? parseFloat(el.value) : 0;
        if (isNaN(val)) val = 0;
        if (val === 0 && wbi.id !== 'wb-empty-wt') continue; // skip zero entries
        var valStr = val + ' ' + wbi.unit;
        if (wbi.id2) {
          var el2 = document.getElementById(wbi.id2);
          var val2 = el2 ? parseFloat(el2.value) : 0;
          if (!isNaN(val2) && val2 > 0) valStr += ' / ' + wbi.label2 + ' ' + val2.toFixed(3) + ' ' + wbi.unit2;
        }
        wbHtml += '<tr><td>' + wbi.label + '</td><td>' + valStr + '</td></tr>';
      }
      // Fuel line
      var fuelDisplay = document.getElementById('wb-fuel-display');
      if (fuelDisplay) {
        wbHtml += '<tr class="wb-fuel-row"><td>Fuel</td><td>' + esc(fuelDisplay.textContent.replace('Fuel: ', '')) + '</td></tr>';
      }
      wbHtml += '</tbody></table>';

      wbHtml += '<div class="wb-data">' + wbResults.innerHTML + '</div>';
      if (wbEnvelope && wbEnvelope.innerHTML.trim()) {
        wbHtml += '<div class="wb-svg">' + wbEnvelope.innerHTML + '</div>';
      }
      wbHtml += '</div>';
    }

    // Weather section — METAR raw text for airports
    var wxHtml = '<div class="section"><h2>WEATHER</h2>';
    var wxCount = 0;
    for (var i = 0; i < waypoints.length; i++) {
      var wp = waypoints[i];
      if (!wp.data) continue; // skip non-airport waypoints
      var isAlt = (i === alternateIndex);
      var metar = app.metarCache && app.metarCache[wp.code];
      var rawTaf = null;
      var taf = routeWxCache[wp.code] || (app.tafCache && app.tafCache[wp.code]);
      if (taf && taf.length && taf[0].rawTAF) rawTaf = taf[0].rawTAF;

      var wxCat = '';
      if (depEpoch && i < cumTime.length) {
        var arrEpoch = depEpoch + cumTime[i] * 3600;
        if (i === 0 && metar) wxCat = metar.fltCat || '';
        if (!wxCat) {
          var wpWx = getWpWeather(wp.code, arrEpoch);
          if (wpWx) wxCat = wpWx.cat;
        }
      }

      wxHtml += '<div class="wx-entry">';
      wxHtml += '<strong>' + esc(wp.code) + (isAlt ? ' (ALT)' : '') + '</strong>';
      if (wxCat) wxHtml += ' — ' + wxCat;
      if (metar && metar.rawOb) {
        wxHtml += '<div class="metar-text">' + esc(metar.rawOb) + '</div>';
      }
      if (rawTaf) {
        wxHtml += '<div class="taf-text">' + esc(rawTaf) + '</div>';
      }
      wxHtml += '</div>';
      wxCount++;
    }
    if (wxCount === 0) wxHtml += '<p>No weather data available</p>';
    wxHtml += '</div>';

    // NOTAMs section — full text
    var notamHtml = '<div class="section"><h2>NOTAMs</h2>';
    var notamCount = 0;
    for (var i = 0; i < waypoints.length; i++) {
      var wp = waypoints[i];
      if (!wp.data) continue;
      var nd = app.notamCache && app.notamCache[wp.code];
      if (nd && nd.count > 0) {
        notamHtml += '<div class="notam-airport"><strong>' + esc(wp.code)
          + '</strong> — ' + nd.count + ' NOTAM' + (nd.count !== 1 ? 's' : '')
          + (nd.hasCritical ? ' (critical!)' : '') + '</div>';
        if (nd.notams) {
          for (var j = 0; j < nd.notams.length; j++) {
            var n = nd.notams[j];
            notamHtml += '<div class="notam-item' + (n.isCritical ? ' notam-critical' : '') + '">'
              + '<span class="notam-id">' + esc(n.id) + '</span> '
              + '<span class="notam-text">' + esc(n.text) + '</span></div>';
          }
        }
        notamCount++;
      }
    }
    if (notamCount === 0) notamHtml += '<p>No NOTAMs</p>';
    notamHtml += '</div>';

    // --- Async data gathering ---
    // We need to fetch: GRAMET (as data URL), SWC, FL Compare (from cached wind data)
    // Use a pending counter to open the print window when all are ready.

    var asyncData = { grametDataUrl: null, airgramDataUrl: null, flCompHtml: '', swcUrl: null };
    var pending = 4; // GRAMET, SWC, FL Compare, Airgram

    function onAsyncDone() {
      if (--pending > 0) return;
      openPrintWindow();
    }

    function openPrintWindow() {
      // --- Route map SVG ---
      var routeMapHtml = buildRouteMapSvg();

      var airgramHtml = '';
      if (asyncData.airgramDataUrl) {
        airgramHtml = '<div class="section airgram-section"><h2>Airgram — Vertical Profile</h2>'
          + '<img src="' + asyncData.airgramDataUrl + '" alt="Airgram">'
          + '</div>';
      }

      var grametHtml = '';
      if (asyncData.grametDataUrl) {
        grametHtml = '<div class="section gramet-section"><h2>GRAMET Cross Section</h2>'
          + '<img src="' + esc(asyncData.grametDataUrl) + '" alt="GRAMET" onerror="this.style.display=\'none\'">'
          + '</div>';
      }

      var flCompHtml = asyncData.flCompHtml;

      var swcHtml = '';
      if (asyncData.swcUrl) {
        swcHtml = '<div class="section swc-section"><h2>Significant Weather Chart (SWC)</h2>'
          + '<img src="' + esc(asyncData.swcUrl) + '" alt="SWC" onerror="this.style.display=\'none\'">'
          + '</div>';
      }

      var html = '<!DOCTYPE html><html><head><meta charset="utf-8">'
        + '<title>Flight Plan ' + esc(depCode) + ' — ' + esc(destCode) + '</title>'
        + '<style>' + printCSS() + '</style></head><body>'
        + '<div class="header">'
        + '<h1>FLIGHT PLAN — ' + esc(depCode) + ' \u2192 ' + esc(destCode) + '</h1>'
        + '<div class="header-details">'
        + '<span>Date: ' + dateStr + '</span>'
        + '<span>Dep: ' + depTimeStr + '</span>'
        + '<span>' + flLabel + '</span>'
        + '<span>' + esc(profileLabel) + '</span>'
        + '<span>Fuel: ' + fuel.toFixed(1) + ' gal</span>'
        + '<span>Reserve: ' + Math.round(reserveHours * 60) + ' min</span>'
        + '</div>'
        + '</div>'
        + routeMapHtml
        + '<div class="section"><h2>NAV LOG</h2>'
        + '<table class="nav-log">'
        + '<thead><tr>'
        + '<th>#</th><th>WPT</th><th>Name</th><th>ELEV</th><th>HDG</th><th>DIST</th><th>ETA/ETE</th><th>FUEL</th><th>WX</th><th>NOTAM</th>'
        + '</tr></thead>'
        + '<tbody>' + navRows + '</tbody>'
        + '<tfoot>' + totalsHtml + '</tfoot>'
        + '</table>'
        + windLine
        + '</div>'
        + wbHtml
        + wxHtml
        + notamHtml
        + airgramHtml
        + grametHtml
        + flCompHtml
        + swcHtml
        + '<div class="footer">Generated ' + new Date().toISOString().replace('T', ' ').replace(/\.\d+Z/, ' UTC') + '</div>'
        + '</body></html>';

      var win = window.open('', '_blank');
      if (!win) return;
      win.document.write(html);
      win.document.close();
      win.onload = function () { win.print(); };
    }

    // --- Airgram: render into offscreen element and capture canvas ---
    var existingAirgramCanvas = document.querySelector('#rw-airgram .airgram-container canvas');
    if (existingAirgramCanvas) {
      // Already rendered — just capture it
      try { asyncData.airgramDataUrl = existingAirgramCanvas.toDataURL('image/png'); }
      catch (e) { /* canvas tainted */ }
      onAsyncDone();
    } else if (profile && depEpoch && waypoints.length >= 2) {
      // Not rendered yet — render into offscreen element using cached data
      var airgramSamples = buildRouteAirgramSamples();
      if (airgramSamples.length >= 2 && app.fetchRouteAirgramInto) {
        var offscreen = document.createElement('div');
        offscreen.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:500px;';
        document.body.appendChild(offscreen);
        app.fetchRouteAirgramInto(offscreen, airgramSamples);
        // Wait for rendering (fetchRouteAirgramInto is async)
        var airgramRetries = 0;
        setTimeout(function checkCanvas() {
          var c = offscreen.querySelector('canvas');
          if (c) {
            try { asyncData.airgramDataUrl = c.toDataURL('image/png'); }
            catch (e) {}
            document.body.removeChild(offscreen);
            onAsyncDone();
          } else if (offscreen.querySelector('.metar-loading') && airgramRetries++ < 30) {
            setTimeout(checkCanvas, 200);
          } else {
            document.body.removeChild(offscreen);
            onAsyncDone();
          }
        }, 200);
      } else {
        onAsyncDone();
      }
    } else {
      onAsyncDone();
    }

    // --- GRAMET: construct image URL (loads directly in print window) ---
    if (depEpoch && waypoints.length >= 2) {
      var totalEetSec = Math.ceil((cumTime[cumTime.length - 1] || 1) * 3600);
      var grametWaypoints = waypoints.map(function (wp) { return wp.code; }).join(' ');
      asyncData.grametDataUrl = OWM_PROXY + '/ar/gramet?waypoints=' + encodeURIComponent(grametWaypoints)
        + '&departuretime=' + depEpoch
        + '&totaleet=' + totalEetSec
        + '&altitude=' + (fl * 100);
    }
    onAsyncDone();

    // --- FL Compare: compute from cached wind data ---
    if (profile && depEpoch && waypoints.length >= 2) {
      var flSamples = buildRouteAirgramSamples();
      if (flSamples.length >= 2) {
        app.fetchRouteAirgramData(flSamples, function (responses) {
          if (responses) {
            var tempEl = document.createElement('div');
            renderFlComparison(tempEl, responses, flSamples, profile);
            if (tempEl.querySelector('.flcomp-table')) {
              asyncData.flCompHtml = '<div class="section flcomp-section"><h2>FL Comparison</h2>'
                + tempEl.innerHTML + '</div>';
            }
          }
          onAsyncDone();
        });
      } else {
        onAsyncDone();
      }
    } else {
      onAsyncDone();
    }

    // --- SWC: try existing image, otherwise fetch from API ---
    var swcImg = document.querySelector('.swc-chart-img');
    if (swcImg && swcImg.src) {
      asyncData.swcUrl = swcImg.src;
      onAsyncDone();
    } else {
      fetch('https://www.ilmailusaa.fi/weatheranim.php?region=scandinavia&id=swc&level=SWC&time=')
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (data.images && data.images.length > 0) {
            asyncData.swcUrl = 'https://www.ilmailusaa.fi/' + data.images[0].src.replace('../', '');
          }
        })
        .catch(function () {})
        .finally(onAsyncDone);
    }
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function esc(s) { return escapeHtml(s); }

  function buildRouteMapSvg() {
    if (waypoints.length < 2) return '';

    // Collect lat/lon bounds
    var lats = [], lons = [];
    for (var i = 0; i < waypoints.length; i++) {
      lats.push(waypoints[i].latlng.lat);
      lons.push(waypoints[i].latlng.lng);
    }
    var minLat = Math.min.apply(null, lats);
    var maxLat = Math.max.apply(null, lats);
    var minLon = Math.min.apply(null, lons);
    var maxLon = Math.max.apply(null, lons);

    // Add 15% padding
    var latPad = Math.max((maxLat - minLat) * 0.15, 0.5);
    var lonPad = Math.max((maxLon - minLon) * 0.15, 0.5);
    minLat -= latPad; maxLat += latPad;
    minLon -= lonPad; maxLon += lonPad;

    // SVG dimensions — full page height for A4
    var svgW = 700, svgH = 900;
    var pad = { top: 18, right: 14, bottom: 18, left: 14 };
    var plotW = svgW - pad.left - pad.right;
    var plotH = svgH - pad.top - pad.bottom;

    // Mercator projection (simple cylindrical with cos(lat) correction)
    var midLat = (minLat + maxLat) / 2;
    var cosLat = Math.cos(midLat * Math.PI / 180);
    var lonRange = maxLon - minLon;
    var latRange = maxLat - minLat;
    // Adjust aspect ratio
    var lonSpan = lonRange * cosLat;
    var latSpan = latRange;
    var scaleX = plotW / lonSpan;
    var scaleY = plotH / latSpan;
    var scale = Math.min(scaleX, scaleY);
    var offX = pad.left + (plotW - lonSpan * scale) / 2;
    var offY = pad.top + (plotH - latSpan * scale) / 2;

    function px(lon) { return offX + (lon - minLon) * cosLat * scale; }
    function py(lat) { return offY + (maxLat - lat) * scale; }

    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + svgW + ' ' + svgH + '">';

    // Background
    svg += '<rect width="' + svgW + '" height="' + svgH + '" fill="#f8fafe" stroke="#ccc" stroke-width="0.5" rx="3"/>';

    // Lat/lon grid lines
    var latStep = niceStep(latRange, 5);
    var lonStep = niceStep(lonRange, 5);
    var startLat = Math.ceil(minLat / latStep) * latStep;
    var startLon = Math.ceil(minLon / lonStep) * lonStep;
    for (var gl = startLat; gl <= maxLat; gl += latStep) {
      var gy = py(gl);
      svg += '<line x1="' + pad.left + '" y1="' + r(gy) + '" x2="' + (svgW - pad.right) + '" y2="' + r(gy) + '" stroke="#e0e4ea" stroke-width="0.5"/>';
      svg += '<text x="' + (pad.left + 2) + '" y="' + r(gy - 3) + '" font-size="9" fill="#aaa">' + gl.toFixed(0) + '\u00b0</text>';
    }
    for (var gn = startLon; gn <= maxLon; gn += lonStep) {
      var gx = px(gn);
      svg += '<line x1="' + r(gx) + '" y1="' + pad.top + '" x2="' + r(gx) + '" y2="' + (svgH - pad.bottom) + '" stroke="#e0e4ea" stroke-width="0.5"/>';
      svg += '<text x="' + r(gx + 2) + '" y="' + (svgH - pad.bottom - 3) + '" font-size="9" fill="#aaa">' + gn.toFixed(0) + '\u00b0</text>';
    }

    // Route lines
    for (var i = 0; i < waypoints.length - 1; i++) {
      var a = waypoints[i].latlng;
      var b = waypoints[i + 1].latlng;
      var isAltLeg = (alternateIndex >= 0 && i >= alternateIndex - 1);
      var x1 = px(a.lng), y1 = py(a.lat);
      var x2 = px(b.lng), y2 = py(b.lat);
      var color = isAltLeg ? '#e67e22' : '#2980b9';
      var dash = isAltLeg ? ' stroke-dasharray="6,4"' : '';
      svg += '<line x1="' + r(x1) + '" y1="' + r(y1) + '" x2="' + r(x2) + '" y2="' + r(y2) + '" stroke="' + color + '" stroke-width="2.5"' + dash + '/>';

      // Leg annotation at midpoint: heading and distance
      if (legs[i]) {
        var mx = (x1 + x2) / 2;
        var my = (y1 + y2) / 2;
        var hdg = Math.round(legs[i].magHdg);
        var dist = Math.round(legs[i].dist);
        var angle = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
        // Keep text right-side up
        if (angle > 90 || angle < -90) angle += 180;
        // Offset perpendicular to the line
        var perpX = -(y2 - y1), perpY = x2 - x1;
        var perpLen = Math.sqrt(perpX * perpX + perpY * perpY) || 1;
        var offLbl = 14;
        var lx = mx + perpX / perpLen * offLbl;
        var ly = my + perpY / perpLen * offLbl;
        svg += '<text x="' + r(lx) + '" y="' + r(ly) + '" font-size="10" fill="#555" text-anchor="middle"'
          + ' transform="rotate(' + r(angle) + ' ' + r(lx) + ' ' + r(ly) + ')">'
          + hdg + '\u00b0 / ' + dist + 'nm</text>';
      }

      // Arrow at midpoint
      var amx = (x1 + x2) / 2, amy = (y1 + y2) / 2;
      var arrowAngle = Math.atan2(y2 - y1, x2 - x1);
      var ax = 7;
      svg += '<polygon points="'
        + r(amx + ax * Math.cos(arrowAngle)) + ',' + r(amy + ax * Math.sin(arrowAngle)) + ' '
        + r(amx + ax * Math.cos(arrowAngle + 2.5)) + ',' + r(amy + ax * Math.sin(arrowAngle + 2.5)) + ' '
        + r(amx + ax * Math.cos(arrowAngle - 2.5)) + ',' + r(amy + ax * Math.sin(arrowAngle - 2.5))
        + '" fill="' + color + '"/>';
    }

    // Waypoint dots and labels
    for (var i = 0; i < waypoints.length; i++) {
      var wp = waypoints[i];
      var cx = px(wp.latlng.lng);
      var cy = py(wp.latlng.lat);
      var isAlt = (i === alternateIndex);
      var dotColor = isAlt ? '#e67e22' : '#2980b9';
      var dotR = 7;

      svg += '<circle cx="' + r(cx) + '" cy="' + r(cy) + '" r="' + dotR + '" fill="' + dotColor + '" stroke="#fff" stroke-width="2"/>';
      svg += '<text x="' + r(cx) + '" y="' + r(cy + 1.5) + '" font-size="9" fill="#fff" text-anchor="middle" font-weight="700">' + (i + 1) + '</text>';

      // Label
      var label = wp.code;
      if (label.length > 10) label = label.substring(0, 10);
      // Position label to avoid overlap: alternate sides
      var labelX = cx + 12;
      var labelAnchor = 'start';
      // If waypoint is on the right side of the map, put label to the left
      if (cx > svgW * 0.7) { labelX = cx - 12; labelAnchor = 'end'; }
      svg += '<text x="' + r(labelX) + '" y="' + r(cy + 4) + '" font-size="11" fill="#333" font-weight="600" text-anchor="' + labelAnchor + '">'
        + esc(label) + (isAlt ? ' (ALT)' : '') + '</text>';
    }

    svg += '</svg>';

    return '<div class="section first route-map-section">'
      + '<h2>ROUTE MAP</h2>' + svg + '</div>';
  }

  function niceStep(range, maxTicks) {
    var rough = range / maxTicks;
    var mag = Math.pow(10, Math.floor(Math.log10(rough)));
    var norm = rough / mag;
    if (norm <= 1) return mag;
    if (norm <= 2) return 2 * mag;
    if (norm <= 5) return 5 * mag;
    return 10 * mag;
  }

  function r(n) { return Math.round(n * 10) / 10; }

  function printCSS() {
    return ''
      + '*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }'
      + 'body { font-family: "SF Mono", "Menlo", "Consolas", monospace; font-size: 10px; color: #222; padding: 12mm; line-height: 1.4; }'
      + 'h1 { font-size: 15px; margin-bottom: 2px; }'
      + 'h2 { font-size: 12px; margin-bottom: 4px; border-bottom: 1px solid #333; padding-bottom: 2px; }'
      + '.header { margin-bottom: 10px; border-bottom: 2px solid #222; padding-bottom: 6px; }'
      + '.header-details { display: flex; gap: 14px; flex-wrap: wrap; font-size: 10px; margin-top: 4px; }'
      + '.section { margin-bottom: 12px; page-break-before: always; }'
      + '.section.first { page-break-before: auto; }'
      + 'table.nav-log { width: 100%; border-collapse: collapse; font-size: 10px; }'
      + 'table.nav-log th { background: #f0f0f0; font-weight: 700; text-align: left; padding: 2px 4px; border: 1px solid #bbb; }'
      + 'table.nav-log td { padding: 1px 4px; border: 1px solid #ddd; }'
      + 'table.nav-log .nr { width: 20px; text-align: center; }'
      + 'table.nav-log .code { font-weight: 700; }'
      + 'table.nav-log .name { max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }'
      + 'table.nav-log .num { text-align: right; }'
      + 'table.nav-log .wx { text-align: center; font-weight: 700; }'
      + 'tr.leg-row td { color: #555; font-size: 9px; border-top: none; }'
      + 'tr.wp-row td { border-bottom: none; }'
      + 'tr.alt-sep td { background: #ffe0b2; font-weight: 700; text-align: center; border: 1px solid #bbb; padding: 2px; }'
      + 'tr.alt-row td { background: #fff8f0; }'
      + 'tr.totals-row td { border-top: 2px solid #333; font-weight: 700; }'
      + 'tr.totals-req td { border-top: 1px solid #aaa; }'
      + '.warn { color: #c0392b; font-weight: 700; }'
      + '.wind-adj { font-size: 10px; margin-top: 4px; color: #555; }'
      + '.wb-loading { border-collapse: collapse; font-size: 10px; margin-bottom: 8px; }'
      + '.wb-loading th { background: #f0f0f0; font-weight: 700; text-align: left; padding: 2px 8px; border: 1px solid #bbb; }'
      + '.wb-loading td { padding: 2px 8px; border: 1px solid #ddd; }'
      + '.wb-fuel-row td { font-weight: 700; border-top: 2px solid #333; }'
      + '.wb-data { margin-bottom: 6px; font-size: 11px; }'
      + '.wb-data div { margin: 2px 0; }'
      + '.wb-svg { margin-top: 4px; }'
      + '.wb-svg svg { max-width: 300px; }'
      + '.wb-result-ok { color: #27ae60; }'
      + '.wb-result-warn { color: #c0392b; }'
      + '.wx-entry { margin-bottom: 6px; }'
      + '.metar-text, .taf-text { font-size: 9px; color: #444; margin: 1px 0; word-break: break-all; }'
      + '.taf-text { white-space: pre-wrap; }'
      // NOTAM styles
      + '.notam-airport { margin-top: 6px; margin-bottom: 2px; }'
      + '.notam-item { font-size: 9px; margin: 1px 0; padding: 2px 4px; border-left: 2px solid #ddd; }'
      + '.notam-critical { border-left-color: #e74c3c; background: #fff5f5; }'
      + '.notam-id { font-weight: 700; color: #555; }'
      + '.notam-text { color: #333; }'
      // Airgram
      + '.airgram-section img { max-width: 100%; height: auto; }'
      // FL Compare
      + '.flcomp-section { page-break-inside: avoid; }'
      + '.flcomp-ref { font-size: 10px; margin-bottom: 4px; font-weight: 700; }'
      + '.flcomp-table { width: 100%; border-collapse: collapse; font-size: 9px; }'
      + '.flcomp-table th, .flcomp-table td { padding: 1px 4px; border: 1px solid #ddd; text-align: right; }'
      + '.flcomp-table th { background: #f0f0f0; font-weight: 700; text-align: left; }'
      + '.flcomp-fl { text-align: left; font-weight: 700; }'
      + '.flcomp-current td { background: #e8f4fd; }'
      + '.flcomp-best-time td { background: #e8f8e8; }'
      + '.flcomp-best-fuel td { background: #fff8e8; }'
      + '.flcomp-sel { font-size: 7px; color: #2980b9; }'
      + '.flcomp-hw { color: #c0392b; }'
      + '.flcomp-tw { color: #27ae60; }'
      + '.flcomp-fuel-warn { color: #c0392b; font-weight: 700; }'
      + '.flcomp-diff-bad { color: #c0392b; }'
      + '.flcomp-diff-good { color: #27ae60; }'
      + '.flcomp-legend { display: flex; gap: 10px; font-size: 8px; margin-top: 4px; }'
      + '.flcomp-legend-swatch { display: inline-block; width: 10px; height: 10px; border: 1px solid #ccc; vertical-align: middle; margin-right: 2px; }'
      + '.flcomp-best-time-swatch { background: #e8f8e8; }'
      + '.flcomp-best-fuel-swatch { background: #fff8e8; }'
      + '.flcomp-current-swatch { background: #e8f4fd; }'
      // Route map — full page
      + '.route-map-section svg { width: 100%; }'
      + '.route-map-section { page-break-inside: avoid; }'
      // Images
      + '.gramet-section img, .swc-section img { max-width: 100%; height: auto; }'
      + '.footer { margin-top: 16px; font-size: 8px; color: #999; border-top: 1px solid #ddd; padding-top: 4px; }'
      + '@media print {'
      + '  body { padding: 6mm; }'
      + '  .section { page-break-inside: avoid; }'
      + '  .route-map-section svg { height: calc(100vh - 20mm); }'
      + '}';
  }

  // Check if a code looks like an IFR waypoint ident (e.g. BADEP, AMVAR, KR, OL2, TP364)
  // vs a place name (Helsinki) or coordinates (61.1234, 25.5678)
  function isIfrIdent(code) {
    if (!code) return false;
    return /^[A-Z]{1,5}[0-9]{0,3}$/.test(code) && code.length >= 2 && code.length <= 5;
  }

  function escapeXml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // --- FL Compare ---

  function loadFlComparison() {
    var el = document.getElementById('rw-flcomp');
    if (!el) return;
    var profile = getProfile();
    var depEpoch = getDepEpoch();
    if (waypoints.length < 2 || !profile) {
      el.innerHTML = '<span class="info-unknown">Need 2+ waypoints and a power setting</span>';
      return;
    }
    if (!depEpoch) {
      el.innerHTML = '<span class="info-unknown">Set departure time for wind data</span>';
      return;
    }

    var samples = buildRouteAirgramSamples();
    if (samples.length === 0) {
      el.innerHTML = '<span class="info-unknown">Could not build route samples</span>';
      return;
    }

    el.innerHTML = '<span class="metar-loading">Loading wind data...</span>';

    var app = window.AirportApp;
    app.fetchRouteAirgramData(samples, function (responses) {
      if (!responses) {
        el.innerHTML = '<span class="info-unknown">Wind data unavailable</span>';
        return;
      }
      renderFlComparison(el, responses, samples, profile);
    });
  }

  function interpAngle(a0, a1, frac) {
    // Circular interpolation for angles in degrees
    var diff = a1 - a0;
    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;
    return (a0 + frac * diff + 360) % 360;
  }

  function renderFlComparison(el, responses, samples, profile) {
    var app = window.AirportApp;
    var LEVELS = app.AIRGRAM_LEVELS; // [1000, 925, 850, 775, 700, 600, 500, 450]
    var nLevels = LEVELS.length;
    var nPoints = samples.length;

    // Standard atmosphere heights (m) for fallback
    var stdHts = [111, 762, 1457, 2164, 3012, 4206, 5574, 6344];

    // Parse Open-Meteo data into grid[levelIdx][pointIdx] = {windSpd, windDir, geoHt}
    // Pick closest forecast hour to each sample's ETA
    var grid = [];
    for (var li = 0; li < nLevels; li++) {
      grid[li] = [];
      var lev = LEVELS[li];
      var wsKey = 'wind_speed_' + lev + 'hPa';
      var wdKey = 'wind_direction_' + lev + 'hPa';
      var ghKey = 'geopotential_height_' + lev + 'hPa';

      for (var pi = 0; pi < nPoints; pi++) {
        var resp = responses[pi];
        var hourly = resp && resp.hourly;
        if (!hourly || !hourly.time) {
          grid[li][pi] = { windSpd: null, windDir: null, geoHt: stdHts[li] };
          continue;
        }

        // Find closest hour to ETA
        var hi = 0;
        if (samples[pi].etaEpoch) {
          var etaMs = samples[pi].etaEpoch * 1000;
          var bestDiff = Infinity;
          for (var h = 0; h < hourly.time.length; h++) {
            var tMs = new Date(hourly.time[h]).getTime();
            var diff = Math.abs(tMs - etaMs);
            if (diff < bestDiff) { bestDiff = diff; hi = h; }
          }
        }

        grid[li][pi] = {
          windSpd: hourly[wsKey] ? hourly[wsKey][hi] : null,
          windDir: hourly[wdKey] ? hourly[wdKey][hi] : null,
          geoHt: hourly[ghKey] ? hourly[ghKey][hi] : stdHts[li]
        };
      }
    }

    // Average geopotential heights per level
    var avgGeoHt = [];
    for (var li = 0; li < nLevels; li++) {
      var sum = 0, cnt = 0;
      for (var pi = 0; pi < nPoints; pi++) {
        if (grid[li][pi].geoHt != null) { sum += grid[li][pi].geoHt; cnt++; }
      }
      avgGeoHt[li] = cnt > 0 ? sum / cnt : stdHts[li];
    }

    // Build cumulative distances and map sample points to legs
    var cumDist = [0];
    for (var i = 0; i < legs.length; i++) {
      cumDist.push(cumDist[i] + legs[i].dist);
    }
    var totalDist = cumDist[cumDist.length - 1];
    if (totalDist <= 0) { el.innerHTML = ''; return; }

    // Leg track bearings
    var legBearings = [];
    for (var i = 0; i < legs.length; i++) {
      legBearings.push(legs[i].trueHdg);
    }

    // Map each sample to a leg index
    var sampleLeg = [];
    for (var pi = 0; pi < nPoints; pi++) {
      var d = samples[pi].dist;
      var li = 0;
      for (var j = 0; j < legs.length; j++) {
        if (d >= cumDist[j] && d <= cumDist[j + 1] + 0.01) { li = j; break; }
      }
      sampleLeg[pi] = li;
    }

    // Interpolate wind at target altitude (meters) for a given sample point
    function interpWindAt(pi, targetM) {
      var spd = null, dir = null;
      for (var li = 0; li < nLevels - 1; li++) {
        var h0 = avgGeoHt[li], h1 = avgGeoHt[li + 1];
        if (targetM >= h0 && targetM <= h1) {
          var frac = (targetM - h0) / (h1 - h0);
          var s0 = grid[li][pi].windSpd, s1 = grid[li + 1][pi].windSpd;
          var d0 = grid[li][pi].windDir, d1 = grid[li + 1][pi].windDir;
          if (s0 != null && s1 != null) spd = s0 + frac * (s1 - s0);
          if (d0 != null && d1 != null) dir = interpAngle(d0, d1, frac);
          break;
        }
      }
      // Extrapolate below lowest or above highest level
      if (spd == null && targetM <= avgGeoHt[0]) {
        spd = grid[0][pi].windSpd;
        dir = grid[0][pi].windDir;
      }
      if (spd == null && targetM >= avgGeoHt[nLevels - 1]) {
        spd = grid[nLevels - 1][pi].windSpd;
        dir = grid[nLevels - 1][pi].windDir;
      }
      return { spd: spd, dir: dir };
    }

    var currentFL = getFL();
    var formatTime = app.formatTime || function (h) { return h.toFixed(1) + 'h'; };
    var fuelOnBoard = getFuel();

    // Helper: compute wind-adjusted totals for a given FL
    // Exclude alternate leg (from destination to alternate airport)
    var maxLeg = (alternateIndex >= 0) ? alternateIndex - 1 : legs.length;
    function computeFL(fl) {
      var altM = fl * 100 * 0.3048;
      var totalTime = 0, totalFuelUsed = 0;
      var avgHW = 0, hwCount = 0;
      var avgWind = 0, windCount = 0;

      for (var legI = 0; legI < maxLeg; legI++) {
        var legDist = legs[legI].dist;
        var track = legBearings[legI];

        var legWindSamples = [];
        var legSpdSamples = [];
        for (var pi = 0; pi < nPoints; pi++) {
          if (sampleLeg[pi] === legI) {
            var w = interpWindAt(pi, altM);
            if (w.spd != null && w.dir != null) {
              var angleDiff = (w.dir - track) * Math.PI / 180;
              var hw = w.spd * Math.cos(angleDiff);
              legWindSamples.push(hw);
              legSpdSamples.push(w.spd);
            }
          }
        }

        var legHW = 0, legSpd = 0;
        if (legWindSamples.length > 0) {
          for (var s = 0; s < legWindSamples.length; s++) { legHW += legWindSamples[s]; legSpd += legSpdSamples[s]; }
          legHW /= legWindSamples.length;
          legSpd /= legSpdSamples.length;
        }

        avgHW += legHW * legDist;
        avgWind += legSpd * legDist;
        hwCount += legDist;
        windCount += legDist;

        var gs = Math.max(50, profile.tas - legHW);
        var legTime = legDist / gs;
        var legFuel = legTime * profile.burn;
        totalTime += legTime;
        totalFuelUsed += legFuel;
      }

      return {
        time: totalTime,
        fuel: totalFuelUsed,
        avgHW: hwCount > 0 ? avgHW / hwCount : 0,
        avgWind: windCount > 0 ? avgWind / windCount : 0
      };
    }

    // Compute selected FL as the benchmark
    var selResult = computeFL(currentFL);

    // Compute for each FL from 10 to 200 (step 10)
    var rows = [];
    var bestTimeIdx = -1, bestFuelIdx = -1;
    var bestTime = Infinity, bestFuel = Infinity;

    for (var flIdx = 0; flIdx < 20; flIdx++) {
      var fl = (flIdx + 1) * 10;
      var result = (fl === currentFL) ? selResult : computeFL(fl);

      rows.push({
        fl: fl,
        time: result.time,
        fuel: result.fuel,
        avgHW: result.avgHW,
        avgWind: result.avgWind,
        timeDiff: result.time - selResult.time,
        fuelDiff: result.fuel - selResult.fuel
      });

      if (result.time < bestTime) { bestTime = result.time; bestTimeIdx = flIdx; }
      if (result.fuel < bestFuel) { bestFuel = result.fuel; bestFuelIdx = flIdx; }
    }

    // Render HTML table
    var html = '<div class="flcomp-ref">FL' + (currentFL < 100 ? '0' : '') + currentFL
      + ': ' + formatTime(selResult.time) + ' &middot; ' + selResult.fuel.toFixed(1) + ' gal';
    var selHwAbs = Math.abs(Math.round(selResult.avgHW));
    html += ' &middot; Wind ' + Math.round(selResult.avgWind) + ' kt';
    if (selResult.avgHW > 0.5) html += ' (Head ' + selHwAbs + ')';
    else if (selResult.avgHW < -0.5) html += ' (Tail ' + selHwAbs + ')';
    html += '</div>';

    html += '<table class="flcomp-table">';
    html += '<thead><tr>';
    html += '<th>FL</th>';
    html += '<th>Wind</th>';
    html += '<th>Time</th>';
    html += '<th>Fuel (gal)</th>';
    html += '<th>vs FL' + (currentFL < 100 ? '0' : '') + currentFL + '</th>';
    html += '</tr></thead><tbody>';

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var isCurrent = (r.fl === currentFL);
      var isBestTime = (i === bestTimeIdx);
      var isBestFuel = (i === bestFuelIdx);

      var rowClass = 'flcomp-row';
      if (isCurrent) rowClass += ' flcomp-current';
      if (isBestTime) rowClass += ' flcomp-best-time';
      if (isBestFuel && !isBestTime) rowClass += ' flcomp-best-fuel';

      html += '<tr class="' + rowClass + '">';

      // FL column
      html += '<td class="flcomp-fl">';
      html += 'FL' + (r.fl < 100 ? '0' : '') + r.fl;
      if (isCurrent) html += ' <span class="flcomp-sel">SEL</span>';
      html += '</td>';

      // Wind column: total wind + head/tail component
      var hwAbs = Math.abs(Math.round(r.avgHW));
      var windTotal = Math.round(r.avgWind);
      var hwLabel = r.avgHW > 0.5 ? ' H' + hwAbs : (r.avgHW < -0.5 ? ' T' + hwAbs : '');
      var windClass = r.avgHW > 0.5 ? 'flcomp-hw' : (r.avgHW < -0.5 ? 'flcomp-tw' : '');
      html += '<td class="flcomp-wind ' + windClass + '">' + windTotal + 'kt' + hwLabel + '</td>';

      // Time column
      html += '<td class="flcomp-time">' + formatTime(r.time) + '</td>';

      // Fuel column
      var remaining = fuelOnBoard - r.fuel;
      var fuelWarn = remaining < 0 ? ' flcomp-fuel-warn' : '';
      html += '<td class="flcomp-fuel' + fuelWarn + '">' + r.fuel.toFixed(1) + '</td>';

      // vs Selected FL column
      if (isCurrent) {
        html += '<td class="flcomp-diff">&mdash;</td>';
      } else {
        var timeDiffMin = Math.round(r.timeDiff * 60);
        var fuelDiffGal = r.fuelDiff.toFixed(1);
        var diffSign = timeDiffMin > 0 ? '+' : (timeDiffMin < 0 ? '' : '');
        var diffFSign = r.fuelDiff > 0.05 ? '+' : (r.fuelDiff < -0.05 ? '' : '');
        var diffClass = timeDiffMin > 0 ? 'flcomp-diff-bad' : (timeDiffMin < 0 ? 'flcomp-diff-good' : '');
        html += '<td class="flcomp-diff ' + diffClass + '">' + diffSign + timeDiffMin + 'min / ' + diffFSign + fuelDiffGal + 'g</td>';
      }

      html += '</tr>';
    }

    html += '</tbody></table>';

    // Legend
    html += '<div class="flcomp-legend">';
    html += '<span class="flcomp-legend-item"><span class="flcomp-legend-swatch flcomp-best-time-swatch"></span>Best time</span>';
    html += '<span class="flcomp-legend-item"><span class="flcomp-legend-swatch flcomp-best-fuel-swatch"></span>Best fuel</span>';
    html += '<span class="flcomp-legend-item"><span class="flcomp-legend-swatch flcomp-current-swatch"></span>Selected FL</span>';
    html += '</div>';

    el.innerHTML = html;
  }

  function setupRouteWxPanel() {
    var panel = document.getElementById('route-wx-panel');
    if (!panel) return;

    // Close button
    var closeBtn = panel.querySelector('.route-wx-panel-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', closeRouteWxPanel);
    }

    // Tab switching within the panel
    var tabs = panel.querySelectorAll('.route-wx-panel-tab');
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        var target = tab.getAttribute('data-rwtab');
        openRouteWxPanel(target);
      });
    });
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // --- Tab switching ---

  function setupTabs() {
    var tabs = document.querySelectorAll('.panel-tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function () {
        var target = this.getAttribute('data-tab');
        // Deactivate all tabs and content
        var allTabs = document.querySelectorAll('.panel-tab');
        for (var j = 0; j < allTabs.length; j++) allTabs[j].classList.remove('active');
        var allContent = document.querySelectorAll('.tab-content');
        for (var j = 0; j < allContent.length; j++) allContent[j].classList.remove('active');
        // Activate clicked tab and its content
        this.classList.add('active');
        var el = document.getElementById(target);
        if (el) el.classList.add('active');
      });
    }
  }

  // --- Route mode toggle ---

  function startRoute() {
    routeActive = true;
    window.AirportApp.routeMode = true;
    toggleBtn.textContent = 'Stop Route';
    toggleBtn.className = 'route-btn route-btn-stop';
    renderPanel();
  }

  function stopRoute() {
    routeActive = false;
    window.AirportApp.routeMode = false;
    toggleBtn.textContent = 'Start Route';
    toggleBtn.className = 'route-btn route-btn-start';
  }

  // --- Autorouter IFR route finder ---

  function fetchAircraftId() {
    if (arAircraftId) return;
    fetch(OWM_PROXY + '/ar/aircraft')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        // Response: {rows: [{id, callsign, manufacturer, model, ...}], ...}
        var rows = data.rows || data;
        if (!Array.isArray(rows)) return;
        for (var i = 0; i < rows.length; i++) {
          var ac = rows[i];
          var model = (ac.model || '').toUpperCase().replace(/\s+/g, '');
          if (model.indexOf('DA62') >= 0) {
            arAircraftId = ac.id;
            console.log('Autorouter DA62 aircraft ID:', arAircraftId);
            return;
          }
        }
        // Fallback: use first (default) aircraft if only one exists
        if (rows.length === 1) {
          arAircraftId = rows[0].id;
          console.log('Autorouter aircraft ID (default):', arAircraftId);
        } else {
          console.warn('DA62 not found in autorouter aircraft list');
        }
      })
      .catch(function (e) {
        console.error('Failed to fetch autorouter aircraft:', e);
      });
  }

  function startAutoRoute() {
    if (waypoints.length < 2) return;
    var depEpoch = getDepEpoch();
    if (!depEpoch) {
      alert('Set departure time before auto-routing');
      return;
    }
    if (!arAircraftId) {
      alert('Autorouter aircraft not yet loaded. Try again.');
      fetchAircraftId();
      return;
    }

    // Lock dep/dest from first and last waypoint
    var dep = waypoints[0].code;
    var dest = waypoints[waypoints.length - 1].code;
    arDepCode = dep;
    arDestCode = dest;
    arDepWp = { latlng: waypoints[0].latlng, data: waypoints[0].data, code: dep, name: waypoints[0].name };
    arDestWp = { latlng: waypoints[waypoints.length - 1].latlng, data: waypoints[waypoints.length - 1].data, code: dest, name: waypoints[waypoints.length - 1].name };

    // Cycle optimization on each click
    var optimize = AR_OPTIMIZE[arOptimizeIdx % AR_OPTIMIZE.length];
    arOptimizeIdx++;

    var btn = document.getElementById('auto-route-btn');
    if (btn) {
      btn.textContent = 'Finding route...';
      btn.disabled = true;
    }

    lastFpl = null;

    var body = {
      departure: dep,
      destination: dest,
      departuretime: depEpoch,
      aircraftid: arAircraftId,
      optimize: optimize
    };

    fetch(OWM_PROXY + '/ar/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (data.id || data._id) {
        autoRouteId = data.id || data._id;
        autoRoutePolling = true;
        pollAutoRoute(autoRouteId, 0);
      } else {
        throw new Error(data.error || data.message || 'No route ID returned');
      }
    })
    .catch(function (e) {
      console.error('Auto-route start error:', e);
      if (btn) { btn.textContent = 'Auto Route (IFR)'; btn.disabled = false; }
      alert('Auto-route failed: ' + e.message);
    });
  }

  function pollAutoRoute(routeId, attempt) {
    if (!autoRoutePolling || routeId !== autoRouteId) return;
    if (attempt >= 60) {
      autoRoutePolling = false;
      var btn = document.getElementById('auto-route-btn');
      if (btn) { btn.textContent = 'Auto Route (IFR)'; btn.disabled = false; }
      console.warn('Auto-route polling timed out');
      return;
    }

    fetch(OWM_PROXY + '/ar/route/' + encodeURIComponent(routeId) + '/poll', {
      method: 'PUT'
    })
    .then(function (res) { return res.json(); })
    .then(function (commands) {
      if (!autoRoutePolling || routeId !== autoRouteId) return;
      if (!Array.isArray(commands)) commands = [commands];

      var shouldPollImmediately = false;
      var bestSolution = null;
      var stopped = false;
      for (var i = 0; i < commands.length; i++) {
        var cmd = commands[i];
        console.log('autoroute cmd:', cmd.cmdname, cmd);

        // Solution found — keep the last (best) one
        if (cmd.cmdname === 'solution') {
          bestSolution = cmd;
        }

        // Intermediate fpl (not yet IFPS-validated) — use as fallback
        if (cmd.cmdname === 'fpl') {
          lastFpl = cmd;
        }

        // Server says poll again immediately (more messages pending)
        if (cmd.cmdname === 'pollagain') {
          shouldPollImmediately = true;
        }

        // Routing finished — check if successful
        if (cmd.cmdname === 'autoroute' && cmd.status === 'stopping') {
          stopped = true;
          if (!cmd.routesuccess && !bestSolution) {
            autoRoutePolling = false;
            var btn = document.getElementById('auto-route-btn');
            if (btn) { btn.textContent = 'Auto Route (IFR)'; btn.disabled = false; }
            console.warn('Auto-route failed: no route found');
            if (lastFpl) {
              applyAutoRoute(lastFpl);
              stopAutoRoute(routeId);
            }
            return;
          }
        }

        // Routing terminated or quit
        if (cmd.cmdname === 'autoroute' && (cmd.status === 'terminate' || cmd.status === 'quit')) {
          autoRoutePolling = false;
          var btn = document.getElementById('auto-route-btn');
          if (btn) { btn.textContent = 'Auto Route (IFR)'; btn.disabled = false; }
          return;
        }
      }

      // Apply best solution found in this batch
      if (bestSolution) {
        autoRoutePolling = false;
        applyAutoRoute(bestSolution);
        stopAutoRoute(routeId);
        return;
      }

      // Continue polling
      var delay = shouldPollImmediately ? 0 : 500;
      setTimeout(function () { pollAutoRoute(routeId, attempt + 1); }, delay);
    })
    .catch(function () {
      if (!autoRoutePolling || routeId !== autoRouteId) return;
      // Network error (e.g. CF timeout), retry
      setTimeout(function () { pollAutoRoute(routeId, attempt + 1); }, 2000);
    });
  }

  function applyAutoRoute(solution) {
    var btn = document.getElementById('auto-route-btn');
    if (btn) { btn.textContent = 'Auto Route (IFR)'; btn.disabled = false; }

    if (!solution) return;

    // Extract waypoints from autorouter fplan array
    var solutionWps = solution.fplan || solution.waypoints || [];
    if (solutionWps.length < 2) {
      console.warn('Auto-route solution has fewer than 2 waypoints');
      return;
    }

    // Clear current route
    waypoints = [];
    legs = [];
    alternateIndex = -1;
    routeWxCache = {};
    routeOwmCache = {};
    routeOwmSamples = [];
    if (routeLayerGroup) routeLayerGroup.clearLayers();

    var app = window.AirportApp;
    var markersByIcao = app.markersByIcao || {};

    for (var i = 0; i < solutionWps.length; i++) {
      var swp = solutionWps[i];
      var ident = swp.ident || swp.icao || swp.name || '';
      var lat = swp.coordlatdeg != null ? swp.coordlatdeg : swp.lat;
      var lon = swp.coordlondeg != null ? swp.coordlondeg : swp.lon;

      if (lat == null || lon == null) continue;

      var latlng = L.latLng(lat, lon);
      var marker = markersByIcao[ident];
      if (marker && marker._airportData) {
        waypoints.push({
          latlng: latlng,
          data: marker._airportData,
          code: getCode(marker._airportData),
          name: getName(marker._airportData)
        });
      } else {
        // IFR waypoint from autorouter (fix, VOR, NDB, etc.)
        // autorouter types: ARPT, INT, VOR, VORDME, VORTAC, NDB, NDBDME, DME, TACAN
        var swpType = (swp.type || '').toUpperCase();
        var fplType = 'INT'; // default: all autorouter waypoints are IFR
        if (swpType === 'VOR' || swpType === 'VORDME' || swpType === 'VORTAC') fplType = 'VOR';
        else if (swpType === 'NDB' || swpType === 'NDBDME') fplType = 'NDB';
        waypoints.push({
          latlng: latlng,
          data: null,
          code: ident,
          name: swp.name || ident,
          ifrType: fplType
        });
      }
    }

    if (!routeActive) startRoute();
    recalculate();
    renderRouteOnMap();
    renderPanel();
    updateButtons();
    fetchRouteWeather();
    startWxRefresh();

    // Fit map to route bounds
    if (map && waypoints.length >= 2) {
      var bounds = L.latLngBounds(waypoints.map(function (wp) { return wp.latlng; }));
      map.fitBounds(bounds, { padding: [40, 40] });
    }
  }

  function stopAutoRoute(routeId) {
    // Fire-and-forget stop + close
    fetch(OWM_PROXY + '/ar/route/' + encodeURIComponent(routeId) + '/stop', { method: 'PUT' }).catch(function () {});
    setTimeout(function () {
      fetch(OWM_PROXY + '/ar/route/' + encodeURIComponent(routeId) + '/close', { method: 'PUT' }).catch(function () {});
    }, 500);
  }

  // --- Event wiring ---

  function setupRoutePlanner() {
    map = window.AirportApp.map;
    if (!map) return;

    routeLayerGroup = L.layerGroup().addTo(map);

    toggleBtn = document.getElementById('route-toggle');
    settingsDiv = document.getElementById('route-settings');
    waypointsDiv = document.getElementById('route-waypoints');
    totalsDiv = document.getElementById('route-totals');
    undoBtn = document.getElementById('route-undo');
    clearBtn = document.getElementById('route-clear');

    // Set default dep time to current UTC hour
    var depTimeInput = document.getElementById('route-dep-time');
    if (depTimeInput) {
      var now = new Date();
      var hh = now.getUTCHours();
      var mm = now.getUTCMinutes();
      depTimeInput.value = (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
    }

    setupTabs();
    setupRouteWxPanel();

    // Fetch autorouter aircraft ID (DA62)
    fetchAircraftId();

    // Auto Route (IFR) button
    var autoRouteBtn = document.getElementById('auto-route-btn');
    if (autoRouteBtn) {
      autoRouteBtn.addEventListener('click', function () {
        startAutoRoute();
      });
    }

    // Toggle route mode
    toggleBtn.addEventListener('click', function () {
      if (routeActive) {
        stopRoute();
      } else {
        startRoute();
      }
    });

    // Undo / Clear
    undoBtn.addEventListener('click', undoLast);
    clearBtn.addEventListener('click', clearRoute);

    // Listen for popup open to add waypoints in route mode
    var justAddedFromPopup = false;
    map.on('popupopen', function (e) {
      if (!routeActive) return;
      if (skipNextRouteAdd) { skipNextRouteAdd = false; return; }
      var source = e.popup._source;
      if (!source || !source._airportData) return;
      justAddedFromPopup = true;
      window.AirportApp.justAddedAirport = true;
      setTimeout(function () { justAddedFromPopup = false; window.AirportApp.justAddedAirport = false; }, 50);
      addWaypoint(source.getLatLng(), source._airportData);
      // Close popup immediately — in route mode we just add waypoints, no popups
      map.closePopup(e.popup);
    });

    // Recalculate when fuel/power changes
    var fuelInput = document.getElementById('range-fuel');
    var powerSelect = document.getElementById('range-power');
    if (fuelInput) {
      fuelInput.addEventListener('input', function () {
        if (waypoints.length > 0) { recalculate(); renderPanel(); }
      });
    }
    if (powerSelect) {
      powerSelect.addEventListener('change', function () {
        if (waypoints.length > 0) { recalculate(); renderPanel(); }
      });
    }

    // Re-render when dep time or FL changes
    if (depTimeInput) {
      depTimeInput.addEventListener('input', function () {
        if (waypoints.length > 0) renderPanel();
      });
    }
    var flInput = document.getElementById('route-fl');
    if (flInput) {
      flInput.addEventListener('input', function () {
        if (waypoints.length > 0) renderPanel();
      });
    }
  }

  // --- Route state export/import ---

  function getRouteState() {
    if (waypoints.length === 0) return null;
    return {
      waypoints: waypoints.map(function (wp) {
        return {
          code: wp.code,
          name: wp.name,
          lat: wp.latlng.lat,
          lng: wp.latlng.lng,
          data: wp.data
        };
      }),
      alternateIndex: alternateIndex
    };
  }

  function loadRoute(state) {
    if (!state || !state.waypoints || state.waypoints.length === 0) return;
    // Clear existing route
    waypoints = [];
    legs = [];
    alternateIndex = -1;
    routeWxCache = {};
    routeOwmCache = {};
    routeOwmSamples = [];
    if (routeLayerGroup) routeLayerGroup.clearLayers();

    for (var i = 0; i < state.waypoints.length; i++) {
      var wp = state.waypoints[i];
      waypoints.push({
        latlng: L.latLng(wp.lat, wp.lng),
        data: wp.data,
        code: wp.code,
        name: wp.name
      });
    }
    if (state.alternateIndex >= 0 && state.alternateIndex < waypoints.length) {
      alternateIndex = state.alternateIndex;
    }

    // Activate route mode
    if (!routeActive) startRoute();
    recalculate();
    renderRouteOnMap();
    renderPanel();
    updateButtons();
    fetchRouteWeather();
    startWxRefresh();
  }

  window.AirportApp = window.AirportApp || {};
  window.AirportApp.getRouteState = getRouteState;
  window.AirportApp.loadRoute = loadRoute;
  window.AirportApp.addMapWaypoint = addMapWaypoint;

  // --- Init ---

  function init() {
    if (window.AirportApp && window.AirportApp.map && window.AirportApp.DA62_PROFILES) {
      setupRoutePlanner();
    } else {
      var check = setInterval(function () {
        if (window.AirportApp && window.AirportApp.map && window.AirportApp.DA62_PROFILES) {
          clearInterval(check);
          setupRoutePlanner();
        }
      }, 100);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
