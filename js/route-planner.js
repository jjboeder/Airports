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
  var routeWxOverlay = []; // [{lat, lon, windSpd, windDir, cloud}, ...]
  var routeWxMarkers = null; // L.layerGroup for on-map wind barbs
  var routeCtrTmaCache = []; // cached CTR/TMA airspaces along the route

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
  var arSavedAlternate = null; // saved alternate wp to re-append after autoroute

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

  function isFreqEnabled() {
    var cb = document.getElementById('route-freq-show');
    return cb && cb.checked;
  }

  // Altitude profile along the route (climb/descent aware)
  var CLIMB_FT_PER_NM = 500;
  var DESCENT_FT_PER_NM = 400;

  // Returns altitude in feet at a given distance (nm) from departure
  function routeAltAtDist(distFromDep) {
    var cruiseFt = getFL() * 100;
    if (legs.length === 0) return cruiseFt;

    // Departure elevation
    var depElev = 0;
    if (waypoints[0] && waypoints[0].data && waypoints[0].data[5]) {
      depElev = parseFloat(waypoints[0].data[5]) || 0;
    }
    // Arrival elevation
    var arrIdx = alternateIndex >= 0 ? alternateIndex - 1 : waypoints.length - 1;
    var arrElev = 0;
    if (arrIdx >= 0 && waypoints[arrIdx] && waypoints[arrIdx].data && waypoints[arrIdx].data[5]) {
      arrElev = parseFloat(waypoints[arrIdx].data[5]) || 0;
    }

    var totalDist = 0;
    for (var i = 0; i < legs.length; i++) totalDist += legs[i].dist;
    if (totalDist === 0) return cruiseFt;

    var climbGain = Math.max(0, cruiseFt - depElev);
    var descentLoss = Math.max(0, cruiseFt - arrElev);
    var climbDist = climbGain / CLIMB_FT_PER_NM;
    var descentDist = descentLoss / DESCENT_FT_PER_NM;

    // Scale if route too short for full climb + descent
    if (climbDist + descentDist > totalDist) {
      var scale = totalDist / (climbDist + descentDist);
      climbDist *= scale;
      descentDist *= scale;
    }

    var distFromArr = totalDist - distFromDep;

    if (distFromDep < climbDist) {
      return depElev + distFromDep * CLIMB_FT_PER_NM;
    }
    if (distFromArr < descentDist) {
      return arrElev + distFromArr * DESCENT_FT_PER_NM;
    }
    return cruiseFt;
  }

  // Cumulative distances at each waypoint (index 0 = 0, index i = sum of legs 0..i-1)
  function getCumDists() {
    var d = [0];
    for (var i = 0; i < legs.length; i++) {
      d.push(d[i] + legs[i].dist);
    }
    return d;
  }

  // --- TAF weather for route ---

  var CAT_ORDER = ['VFR', 'MVFR', 'BIR', 'IFR', 'LIFR'];

  function tafCategoryAtEpoch(tafJson, epoch) {
    var app = window.AirportApp;
    if (!tafJson || !tafJson.length || !tafJson[0].fcsts || tafJson[0].fcsts.length === 0) return null;

    var fcsts = tafJson[0].fcsts;

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
          var refBase = active || initialBase;
          var bVisM = app.parseTafVisib(f.visib);
          if (bVisM === null && refBase) bVisM = app.parseTafVisib(refBase.visib);
          var bCeil = app.tafCeiling(f.clouds);
          if (bCeil === null && refBase) bCeil = app.tafCeiling(refBase.clouds);
          var bCat = app.calcFlightCat(bCeil, bVisM);
          var refVisM = refBase ? app.parseTafVisib(refBase.visib) : null;
          var refCeil = refBase ? app.tafCeiling(refBase.clouds) : null;
          var refCat = app.calcFlightCat(refCeil, refVisM);
          if (CAT_ORDER.indexOf(bCat) > CAT_ORDER.indexOf(refCat)) {
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

    // Apply TEMPO/PROB overlays per AMC1 NCO.OP.160 rules (e) and (f)
    for (var i = 0; i < fcsts.length; i++) {
      var f = fcsts[i];
      if (f.fcstChange !== 'TEMPO' && f.fcstChange !== 'PROB') continue;
      if (f.timeFrom > epoch || (f.timeTo && f.timeTo <= epoch)) continue;

      // Rule (f): PROB30/40 TEMPO → disregard entirely
      if (f.fcstChange === 'TEMPO' && f.probability >= 30) continue;

      // Rule (e): standalone TEMPO or PROB30/40
      var tVisM = app.parseTafVisib(f.visib);
      if (tVisM === null) tVisM = visM;
      var tCeiling = app.tafCeiling(f.clouds);
      if (tCeiling === null) tCeiling = ceiling;
      var tCat = app.calcFlightCat(tCeiling, tVisM);

      // Rule (e.3): improvement → disregard
      if (CAT_ORDER.indexOf(tCat) <= CAT_ORDER.indexOf(cat)) continue;

      // Rule (e.2): transient/showery only (TS, SH without persistent) → may ignore
      if (app.isPersistentWx && !app.isPersistentWx(f.wxString)) continue;

      // Persistent deterioration → apply (rule e.1)
      cat = tCat;

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

  // Fetch CTR/TMA airspace data along the route (independent of map layer)
  function fetchRouteCtrTma() {
    if (waypoints.length < 2) return;
    var minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (var i = 0; i < waypoints.length; i++) {
      var ll = waypoints[i].latlng;
      if (ll.lat < minLat) minLat = ll.lat;
      if (ll.lat > maxLat) maxLat = ll.lat;
      if (ll.lng < minLng) minLng = ll.lng;
      if (ll.lng > maxLng) maxLng = ll.lng;
    }
    // Add margin around route bbox
    var latMargin = (maxLat - minLat) * 0.1 + 0.05;
    var lngMargin = (maxLng - minLng) * 0.1 + 0.05;
    var bbox = [
      (minLng - lngMargin).toFixed(4),
      (minLat - latMargin).toFixed(4),
      (maxLng + lngMargin).toFixed(4),
      (maxLat + latMargin).toFixed(4)
    ].join(',');
    fetch(OWM_PROXY + '/airspaces?bbox=' + bbox + '&type=4,7,26,28')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data || !data.items) return;
        routeCtrTmaCache = [];
        for (var i = 0; i < data.items.length; i++) {
          var item = data.items[i];
          if (!item.geometry) continue;
          if (item.type !== 4 && item.type !== 7 && item.type !== 26 && item.type !== 28) continue;
          // Try to get frequencies from airport data if missing
          if ((!item.frequencies || item.frequencies.length === 0) && item.name) {
            var icaoMatch = item.name.match(/^([A-Z]{4})\b/);
            if (icaoMatch) {
              var app = window.AirportApp;
              var marker = app && app.markersByIcao && app.markersByIcao[icaoMatch[1]];
              var row = marker && marker._airportData;
              if (row && row[12] && row[12].length > 0) {
                item.frequencies = row[12].map(function (f) {
                  return { name: f[0], value: f[1] };
                });
              }
            }
          }
          var ring = item.geometry.type === 'MultiPolygon'
            ? item.geometry.coordinates[0][0] : item.geometry.coordinates[0];
          if (ring) {
            routeCtrTmaCache.push({
              ring: ring,
              name: item.name,
              type: item.type,
              lowerLimit: item.lowerLimit,
              upperLimit: item.upperLimit,
              frequencies: item.frequencies
            });
          }
        }
        renderPanel();
      })
      .catch(function () {});
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

    // Fetch CTR/TMA airspace data along route
    fetchRouteCtrTma();

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
      if (maxAma > 0 && altFt < maxAma) {
        warnings.push({ leg: i, maxAma: maxAma });
      }
    }
    return warnings;
  }

  // --- Radio frequency helpers ---

  // Point-in-polygon (ray casting)
  function pointInPolygon(lat, lng, coords) {
    var inside = false;
    var ring = coords[0]; // outer ring
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1];
      var xj = ring[j][0], yj = ring[j][1];
      if ((yi > lat) !== (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  // Convert airspace limit to feet
  function limitToFeet(limit) {
    if (!limit) return null;
    if (limit.unit === 6) return limit.value * 100; // FL → feet
    if (limit.unit === 0) return Math.round(limit.value * 3.281); // meters → feet
    return limit.value; // already feet
  }

  // Find CTR/TMA airspaces at a point that include the given altitude
  function getCtrTmaAtPoint(lat, lng, altFt) {
    // Use route planner's own cache (fetched independently of map layer)
    // Fall back to map's cached data if route cache is empty
    var app = window.AirportApp;
    var airspaces = routeCtrTmaCache.length > 0
      ? routeCtrTmaCache
      : (app && app.ctrTmaAirspaces ? app.ctrTmaAirspaces : []);
    var results = [];
    for (var i = 0; i < airspaces.length; i++) {
      var a = airspaces[i];
      if (a.type !== 4 && a.type !== 7 && a.type !== 26 && a.type !== 28) continue; // CTR=4, TMA=7, CTA=26, RMZ=28
      if (!a.frequencies || a.frequencies.length === 0) continue;
      var ring = a.ring;
      var inside = false;
      for (var j = 0, k = ring.length - 1; j < ring.length; k = j++) {
        var xj = ring[j][0], yj = ring[j][1];
        var xk = ring[k][0], yk = ring[k][1];
        if ((yj > lat) !== (yk > lat) && lng < (xk - xj) * (lat - yj) / (yk - yj) + xj) {
          inside = !inside;
        }
      }
      if (!inside) continue;
      var lower = limitToFeet(a.lowerLimit);
      var upper = limitToFeet(a.upperLimit);
      if (lower !== null && altFt < lower) continue;
      if (upper !== null && altFt > upper) continue;
      results.push(a);
    }
    return results;
  }

  // Find ACC sector at a given lat/lng
  function getAccSector(lat, lng) {
    var app = window.AirportApp;
    if (!app || !app.accSectors) return null;
    var features = app.accSectors.features;
    for (var i = 0; i < features.length; i++) {
      var f = features[i];
      if (pointInPolygon(lat, lng, f.geometry.coordinates)) {
        return { name: f.properties.name, freq: f.properties.freq };
      }
    }
    return null;
  }

  // Get radio sectors along a leg: CTR/TMA (altitude-aware) + ACC (outside CTR/TMA)
  // startDist = cumulative nm from departure at leg start, legDist = leg distance in nm
  function getLegRadioSectors(lat1, lng1, lat2, lng2, startDist, legDist) {
    var sectors = [];
    var seen = {};
    var steps = 5;
    for (var s = 0; s <= steps; s++) {
      var t = s / steps;
      var lat = lat1 + (lat2 - lat1) * t;
      var lng = lng1 + (lng2 - lng1) * t;
      var altFt = routeAltAtDist(startDist + t * legDist);
      // Check CTR/TMA first
      var ctrTma = getCtrTmaAtPoint(lat, lng, altFt);
      var inCtrTma = false;
      for (var c = 0; c < ctrTma.length; c++) {
        var a = ctrTma[c];
        var f0 = a.frequencies[0];
        var label = f0.name || a.name;
        var key = label + '|' + f0.value;
        if (!seen[key]) {
          seen[key] = true;
          var TYPE_LABELS = { 4: 'CTR', 7: 'TMA', 26: 'CTA', 28: 'RMZ' };
          var typeLbl = TYPE_LABELS[a.type] || 'TMA';
          sectors.push({ name: label, freq: f0.value, phase: typeLbl });
        }
        inCtrTma = true;
      }
      // ACC sector only if not inside CTR/TMA at this altitude
      if (!inCtrTma) {
        var sec = getAccSector(lat, lng);
        if (sec && !seen[sec.name]) {
          seen[sec.name] = true;
          sectors.push({ name: sec.name, freq: sec.freq, phase: 'ACC' });
        }
      }
    }
    return sectors;
  }

  // Get airport frequencies from waypoint data (or look up by ICAO)
  function getAirportFreqs(wp) {
    if (wp.data && wp.data[12]) return wp.data[12];
    // Fall back to markersByIcao lookup
    if (wp.code) {
      var app = window.AirportApp;
      var marker = app && app.markersByIcao && app.markersByIcao[wp.code];
      var row = marker && marker._airportData;
      if (row && row[12]) return row[12];
    }
    return [];
  }

  // Filter airport frequencies to operationally relevant ones (ATIS, TWR, APP/RADAR, AFIS etc.)
  var RELEVANT_FREQ_TYPES = ['ATIS', 'TWR', 'TOWER', 'APP', 'APPROACH', 'DEP', 'DEPARTURE', 'RADAR', 'AFIS', 'A/G', 'AG', 'RDO'];
  // Sort order: ATIS first, then TWR, then APP/RADAR, then rest
  var FREQ_ORDER = { 'ATIS': 0, 'TWR': 1, 'TOWER': 1, 'APP': 2, 'APPROACH': 2, 'RADAR': 2, 'DEP': 3, 'DEPARTURE': 3, 'AFIS': 4, 'A/G': 4, 'AG': 4, 'RDO': 4 };
  function freqSortKey(type) {
    var t = (type || '').toUpperCase();
    for (var k in FREQ_ORDER) {
      if (t.indexOf(k) >= 0) return FREQ_ORDER[k];
    }
    return 9;
  }
  function getRelevantFreqs(wp) {
    var all = getAirportFreqs(wp);
    var filtered = [];
    for (var i = 0; i < all.length; i++) {
      var type = (all[i][0] || '').toUpperCase();
      for (var j = 0; j < RELEVANT_FREQ_TYPES.length; j++) {
        if (type.indexOf(RELEVANT_FREQ_TYPES[j]) >= 0) {
          filtered.push(all[i]);
          break;
        }
      }
    }
    var result = filtered.length > 0 ? filtered : all;
    result.sort(function (a, b) { return freqSortKey(a[0]) - freqSortKey(b[0]); });
    return result;
  }

  // Format airport frequencies for display (compact)
  function formatAirportFreqs(freqs) {
    var parts = [];
    for (var i = 0; i < freqs.length; i++) {
      parts.push(freqs[i][0] + ' ' + freqs[i][1]);
    }
    return parts.join(', ');
  }

  // Build radio info for a waypoint (airport freqs)
  function wpRadioInfo(wp) {
    var freqs = getAirportFreqs(wp);
    if (freqs.length === 0) return '';
    return formatAirportFreqs(freqs);
  }

  // Build radio info for a leg (CTR/TMA + ACC sectors)
  function legRadioInfo(lat1, lng1, lat2, lng2, startDist, legDist) {
    var sectors = getLegRadioSectors(lat1, lng1, lat2, lng2, startDist, legDist);
    if (sectors.length === 0) return '';
    return sectors.map(function (s) { return s.name + ' ' + s.freq; }).join(', ');
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

  function addNamedWaypoint(latlng, code, name) {
    if (!routeActive) return;
    // Try to get airport data from loaded markers
    var data = null;
    var app = window.AirportApp;
    if (code && app && app.markersByIcao && app.markersByIcao[code]) {
      data = app.markersByIcao[code]._airportData;
      if (!name && data) name = getName(data);
    }
    waypoints.push({ latlng: latlng, data: data, code: code, name: name || code });
    recalculate();
    renderRouteOnMap();
    renderPanel();
    updateButtons();
    fetchRouteWeather();
    startWxRefresh();
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
    routeWxOverlay = [];
    if (routeWxMarkers) routeWxMarkers.clearLayers();
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
      // Show permanent name label for non-airport waypoints (airports already show ICAO on map)
      if (isCustom && wp.code) {
        var labelIcon = L.divIcon({
          className: 'route-wp-label',
          html: wp.code,
          iconSize: null,
          iconAnchor: [-14, 10]
        });
        L.marker(wp.latlng, { icon: labelIcon, interactive: false }).addTo(routeLayerGroup);
      }
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

    // Collision tracking for all frequency labels (screen-space boxes)
    var placedBoxes = [];
    var LBL_W = 90, LBL_H = 28; // approximate label size in pixels
    var LBL_PAD = 6; // padding between labels

    function boxOverlaps(bx) {
      for (var pb = 0; pb < placedBoxes.length; pb++) {
        var ob = placedBoxes[pb];
        if (bx.x < ob.x + ob.w + LBL_PAD && bx.x + bx.w + LBL_PAD > ob.x &&
            bx.y < ob.y + ob.h + LBL_PAD && bx.y + bx.h + LBL_PAD > ob.y) return true;
      }
      return false;
    }

    // Airport frequency labels at departure, arrival, and alternate
    if (isFreqEnabled() && waypoints.length >= 2) {
      var freqApts = [0]; // departure
      var arrIdx = alternateIndex >= 0 ? alternateIndex - 1 : waypoints.length - 1;
      if (arrIdx > 0 && freqApts.indexOf(arrIdx) === -1) freqApts.push(arrIdx);
      if (alternateIndex >= 0 && freqApts.indexOf(alternateIndex) === -1) freqApts.push(alternateIndex);
      for (var fa = 0; fa < freqApts.length; fa++) {
        var fIdx = freqApts[fa];
        var fwp = waypoints[fIdx];
        var allFqs = getAirportFreqs(fwp);
        var fqs = [];
        for (var af = 0; af < allFqs.length; af++) {
          if ((allFqs[af][0] || '').toUpperCase().indexOf('ATIS') >= 0) fqs.push(allFqs[af]);
        }
        if (fqs.length === 0) continue;

        var freqLines = '';
        for (var ffi = 0; ffi < fqs.length; ffi++) {
          if (ffi > 0) freqLines += '<br>';
          freqLines += fqs[ffi][0] + ' ' + fqs[ffi][1];
        }
        var fIcon = L.divIcon({
          className: 'route-apt-freq',
          html: '<span>' + freqLines + '</span>',
          iconSize: [0, 0]
        });
        L.marker(fwp.latlng, { icon: fIcon, interactive: false }).addTo(routeLayerGroup);

        // Register bounding box (offset matches CSS: left 14px, top 16px)
        var aptPt = map.latLngToContainerPoint(fwp.latlng);
        placedBoxes.push({ x: aptPt.x + 14, y: aptPt.y + 16, w: LBL_W, h: LBL_H });
      }
    }

    // Runway diagrams at departure and arrival when zoomed in
    if (map.getZoom() >= 9 && waypoints.length >= 2) {
      var rwyApts = [0]; // departure
      var arrI = alternateIndex >= 0 ? alternateIndex - 1 : waypoints.length - 1;
      if (arrI > 0 && rwyApts.indexOf(arrI) === -1) rwyApts.push(arrI);
      for (var ra = 0; ra < rwyApts.length; ra++) {
        var rwp = waypoints[rwyApts[ra]];
        if (!rwp || !rwp.data || !rwp.data[10] || !rwp.data[10].length) continue;
        var rwys = rwp.data[10];
        var elevFt = rwp.data[5] || '';
        var aptLatLng = rwp.latlng;
        var cosAptLat = Math.cos(aptLatLng.lat * Math.PI / 180);
        var rwyWeight = Math.max((map.getZoom() - 4) * 2, 4);

        // Count parallel runways per heading for lateral offset
        var hdgCount = {};
        for (var rr = 0; rr < rwys.length; rr++) {
          var m_ = (rwys[rr][0] || '').split('/')[0].trim().match(/^(\d{1,2})/);
          if (!m_) continue;
          var h_ = parseInt(m_[1], 10) * 10;
          var hk = h_ % 180; // normalize so 04 and 22 are same group
          hdgCount[hk] = (hdgCount[hk] || 0) + 1;
        }
        var hdgIdx = {};

        for (var rr = 0; rr < rwys.length; rr++) {
          var rwy = rwys[rr];
          var desig = rwy[0] || '';
          var lenFt = rwy[1] || 0;
          var parts = desig.split('/');
          var m0 = parts[0] ? parts[0].trim().match(/^(\d{1,2})/) : null;
          if (!m0) continue;
          var hdgDeg = parseInt(m0[1], 10) * 10;
          var hdgRad = hdgDeg * Math.PI / 180;
          var lenM = lenFt * 0.3048 * 4; // 4x scale for visibility
          var halfLenDeg = (lenM / 111320) / 2;

          // Lateral offset for parallel runways
          var hk = hdgDeg % 180;
          var nParallel = hdgCount[hk] || 1;
          if (!hdgIdx[hk]) hdgIdx[hk] = 0;
          var parallelIdx = hdgIdx[hk]++;
          var lateralOffDeg = 0;
          if (nParallel > 1) {
            var spacing = halfLenDeg * 0.35; // spacing between parallels
            lateralOffDeg = (parallelIdx - (nParallel - 1) / 2) * spacing;
          }
          // Perpendicular direction (90° to runway heading)
          var perpLat = -Math.sin(hdgRad) * lateralOffDeg;
          var perpLon = Math.cos(hdgRad) * lateralOffDeg / cosAptLat;

          // Runway center with lateral offset
          var cLat = aptLatLng.lat + perpLat;
          var cLon = aptLatLng.lng + perpLon;
          var dLat = halfLenDeg * Math.cos(hdgRad);
          var dLon = halfLenDeg * Math.sin(hdgRad) / cosAptLat;
          var end1 = L.latLng(cLat - dLat, cLon - dLon);
          var end2 = L.latLng(cLat + dLat, cLon + dLon);

          L.polyline([end1, end2], {
            color: '#fff', weight: rwyWeight + 3, opacity: 0.9,
            interactive: false, lineCap: 'butt'
          }).addTo(routeLayerGroup);
          L.polyline([end1, end2], {
            color: '#555', weight: rwyWeight, opacity: 0.9,
            interactive: false, lineCap: 'butt'
          }).addTo(routeLayerGroup);
          L.polyline([end1, end2], {
            color: '#ccc', weight: 1, opacity: 0.7,
            dashArray: '4,4', interactive: false
          }).addTo(routeLayerGroup);

          // Runway designator labels at each end
          for (var ep = 0; ep < parts.length; ep++) {
            var endName = parts[ep].trim();
            var endLL = ep === 0 ? end1 : end2;
            var outDir = ep === 0 ? -1 : 1;
            var lblLat = endLL.lat + outDir * halfLenDeg * 0.25 * Math.cos(hdgRad);
            var lblLon = endLL.lng + outDir * halfLenDeg * 0.25 * Math.sin(hdgRad) / cosAptLat;
            var lblIcon = L.divIcon({
              className: 'route-rwy-label',
              html: '<span>' + endName + '</span>',
              iconSize: [40, 18], iconAnchor: [20, 9]
            });
            L.marker(L.latLng(lblLat, lblLon), { icon: lblIcon, interactive: false })
              .addTo(routeLayerGroup);
          }
        }
        // Elevation label at airport position
        if (elevFt) {
          var elevIcon = L.divIcon({
            className: 'route-rwy-elev',
            html: '<span>' + Math.round(elevFt) + ' ft</span>',
            iconSize: [50, 14], iconAnchor: [25, -4]
          });
          L.marker(aptLatLng, { icon: elevIcon, interactive: false })
            .addTo(routeLayerGroup);
        }
      }
    }

    // Register waypoint markers as collision boxes too
    for (var wi = 0; wi < waypoints.length; wi++) {
      var wpPt = map.latLngToContainerPoint(waypoints[wi].latlng);
      placedBoxes.push({ x: wpPt.x - 11, y: wpPt.y - 11, w: 22, h: 22 });
    }

    // --- Frequency transition markers along route ---
    if (isFreqEnabled()) addFreqTransitionMarkers(placedBoxes, boxOverlaps);
  }

  // Identify the active radio key at a point (CTR/TMA name|freq or ACC name)
  function radioKeyAtPoint(lat, lng, altFt) {
    var ctrTma = getCtrTmaAtPoint(lat, lng, altFt);
    if (ctrTma.length > 0) {
      var a = ctrTma[0];
      var f0 = a.frequencies[0];
      return { key: (f0.name || a.name) + '|' + f0.value, label: f0.name || a.name, freq: f0.value };
    }
    var sec = getAccSector(lat, lng);
    if (sec) return { key: sec.name + '|' + sec.freq, label: sec.name, freq: sec.freq };
    return null;
  }

  function addFreqTransitionMarkers(placedBoxes, boxOverlaps) {
    if (waypoints.length < 2) return;
    var cumD = getCumDists();
    var seen = {};
    var BASE_OFFSET = 60; // base pixels offset perpendicular to route
    var TRANS_LBL_W = 100, TRANS_LBL_H = 30;
    var side = 1; // alternate sides: 1 = right, -1 = left

    for (var i = 0; i < waypoints.length - 1; i++) {
      var a = waypoints[i].latlng;
      var b = waypoints[i + 1].latlng;
      var legDist = legs[i] ? legs[i].dist : 0;
      var legStart = cumD[i];
      var STEPS = 30;
      var prevAlt = routeAltAtDist(legStart);
      var prevInfo = radioKeyAtPoint(a.lat, a.lng, prevAlt);
      var prevKey = prevInfo ? prevInfo.key : null;

      for (var s = 1; s <= STEPS; s++) {
        var t = s / STEPS;
        var lat = a.lat + (b.lat - a.lat) * t;
        var lng = a.lng + (b.lng - a.lng) * t;
        var sampleAlt = routeAltAtDist(legStart + t * legDist);
        var info = radioKeyAtPoint(lat, lng, sampleAlt);
        var curKey = info ? info.key : null;

        if (curKey && curKey !== prevKey && !seen[curKey]) {
          seen[curKey] = true;
          // Binary search for more precise crossing point
          var tLow = (s - 1) / STEPS, tHigh = t;
          for (var b2 = 0; b2 < 6; b2++) {
            var tMid = (tLow + tHigh) / 2;
            var mLat = a.lat + (b.lat - a.lat) * tMid;
            var mLng = a.lng + (b.lng - a.lng) * tMid;
            var midAlt = routeAltAtDist(legStart + tMid * legDist);
            var mInfo = radioKeyAtPoint(mLat, mLng, midAlt);
            var mKey = mInfo ? mInfo.key : null;
            if (mKey === curKey) tHigh = tMid;
            else tLow = tMid;
          }
          var crossT = (tLow + tHigh) / 2;
          var crossLat = a.lat + (b.lat - a.lat) * crossT;
          var crossLng = a.lng + (b.lng - a.lng) * crossT;

          // Offset label perpendicular to route in screen space
          var pA = map.latLngToContainerPoint(a);
          var pB = map.latLngToContainerPoint(b);
          var dx = pB.x - pA.x, dy = pB.y - pA.y;
          var len = Math.sqrt(dx * dx + dy * dy) || 1;
          var crossPt = map.latLngToContainerPoint([crossLat, crossLng]);

          // Try multiple positions: alternate sides, increasing offset
          var placed = false;
          var bestPt = null;
          for (var attempt = 0; attempt < 6 && !placed; attempt++) {
            var tryS = (attempt % 2 === 0) ? side : -side;
            var tryOff = BASE_OFFSET + Math.floor(attempt / 2) * 40;
            var tnx = -dy / len * tryS, tny = dx / len * tryS;
            var tryPt = L.point(crossPt.x + tnx * tryOff, crossPt.y + tny * tryOff);
            var box = { x: tryPt.x - TRANS_LBL_W / 2, y: tryPt.y - TRANS_LBL_H / 2, w: TRANS_LBL_W, h: TRANS_LBL_H };
            if (!bestPt) bestPt = { pt: tryPt, box: box };
            if (!boxOverlaps(box)) {
              bestPt = { pt: tryPt, box: box };
              placed = true;
            }
          }

          placedBoxes.push(bestPt.box);
          var lblLL = map.containerPointToLatLng(bestPt.pt);

          // Connector line from crossing point to label
          L.polyline([[crossLat, crossLng], [lblLL.lat, lblLL.lng]], {
            color: '#c0392b', weight: 1.5, opacity: 0.8, interactive: false
          }).addTo(routeLayerGroup);

          // Dot at crossing point
          L.circleMarker([crossLat, crossLng], {
            radius: 4, color: '#fff', fillColor: '#c0392b', fillOpacity: 1,
            weight: 1.5, interactive: false
          }).addTo(routeLayerGroup);

          // Label at offset position
          var markerIcon = L.divIcon({
            className: 'route-freq-marker',
            html: '<span>' + info.label + '<br>' + info.freq + '</span>',
            iconSize: [0, 0]
          });
          L.marker([lblLL.lat, lblLL.lng], { icon: markerIcon, interactive: false })
            .addTo(routeLayerGroup);

          side *= -1; // alternate sides
        }
        prevKey = curKey;
        prevInfo = info;
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
            html += ' <span class="route-wp-wx" style="background:#5dade2;">\u2744</span>';
          }
          // NOTAM badge (same style as wx badge)
          if (app.notamCache && app.notamCache[wp.code] && app.notamCache[wp.code].count > 0) {
            var nd = app.notamCache[wp.code];
            var notamColor = nd.hasCritical ? '#e74c3c' : '#f0ad4e';
            html += ' <span class="route-wp-wx" style="background:' + notamColor + ';">N</span>';
          }
        } else {
          html += ' <span class="route-wp-wx route-wp-wx-none">-</span>';
        }
      }

      if (wp.data && wp.name) html += '  ' + escapeHtml(wp.name);
      html += '</span>';
      // Relevant airport frequencies (ATIS, TWR, RADAR, AFIS etc.)
      var wpFreqs = isFreqEnabled() ? getRelevantFreqs(wp) : [];
      if (wpFreqs.length > 0) {
        html += '<div class="route-wp-freq">';
        for (var fi = 0; fi < wpFreqs.length; fi++) {
          if (fi > 0) html += ' &nbsp; ';
          html += '<span class="route-wp-freq-item">' + escapeHtml(wpFreqs[fi][0]) + ' ' + escapeHtml(String(wpFreqs[fi][1])) + '</span>';
        }
        html += '</div>';
      }
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
        if (isFreqEnabled()) {
          var cumD = getCumDists();
          var accInfo = legRadioInfo(
            waypoints[i].latlng.lat, waypoints[i].latlng.lng,
            waypoints[i + 1].latlng.lat, waypoints[i + 1].latlng.lng,
            cumD[i], leg.dist);
          if (accInfo) html += '<div class="route-leg-freq">' + accInfo + '</div>';
        }
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

      // Icing warning placeholder (populated asynchronously alongside wind totals)
      thtml += '<div id="route-icing-warning"></div>';

      // Weather below BIR warning for departure and destination
      if (depEpoch && waypoints.length >= 2) {
        var wxWarnings = [];
        var depCode = waypoints[0].code;
        var destIdx = (alternateIndex >= 0) ? alternateIndex - 1 : waypoints.length - 1;
        var destCode = waypoints[destIdx].code;
        var arrEpoch = depEpoch + cumTime[destIdx] * 3600;

        var depTaf = routeWxCache[depCode] || (app.tafCache && app.tafCache[depCode]);
        if (depTaf) {
          var depR = tafCategoryAtEpoch(depTaf, depEpoch);
          var depCat = depR ? depR.cat : null;
          if (depCat && CAT_ORDER.indexOf(depCat) > CAT_ORDER.indexOf('BIR')) {
            var catInfo = METAR_CAT[depCat] || {};
            wxWarnings.push('<span style="color:' + (catInfo.color || '#e74c3c') + '">' + escapeHtml(depCode) + ' departure: ' + depCat + '</span>');
          }
        }

        if (destCode !== depCode || arrEpoch !== depEpoch) {
          // Check arrival time and +1h; only check -1h if it's after departure
          var destTaf = routeWxCache[destCode] || (app.tafCache && app.tafCache[destCode]);
          if (destTaf) {
            var dr0 = tafCategoryAtEpoch(destTaf, arrEpoch);
            var dr2 = tafCategoryAtEpoch(destTaf, arrEpoch + 3600);
            var destCat = worstCategory(dr0 ? dr0.cat : null, dr2 ? dr2.cat : null);
            if (arrEpoch - 3600 >= depEpoch) {
              var dr1 = tafCategoryAtEpoch(destTaf, arrEpoch - 3600);
              destCat = worstCategory(destCat, dr1 ? dr1.cat : null);
            }
            if (destCat && CAT_ORDER.indexOf(destCat) > CAT_ORDER.indexOf('BIR')) {
              var catInfo = METAR_CAT[destCat] || {};
              wxWarnings.push('<span style="color:' + (catInfo.color || '#e74c3c') + '">' + escapeHtml(destCode) + ' arrival: ' + destCat + '</span>');
            }
          }
        }

        if (wxWarnings.length > 0) {
          thtml += '<div class="route-wx-warning">&#9888; Below BIR minimums: ' + wxWarnings.join(', ') + '</div>';
        }
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

      // Extract wind/cloud overlay for route map print
      extractRouteWxOverlay(responses, samples);

      // Check and render icing warnings
      var icingResult = checkRouteIcing(responses, samples);
      var icingEl = document.getElementById('route-icing-warning');
      if (icingEl) renderIcingWarning(icingEl, icingResult);

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

  // --- Extract wind/cloud overlay for route map ---

  function extractRouteWxOverlay(responses, samples) {
    var app = window.AirportApp;
    var LEVELS = app.AIRGRAM_LEVELS;
    if (!LEVELS) { routeWxOverlay = []; return; }
    var nLevels = LEVELS.length;
    var nPoints = samples.length;
    var stdHts = [111, 762, 1457, 2164, 3012, 4206, 5574, 6344];

    // Parse grid: grid[levelIdx][pointIdx] = {windSpd, windDir, cloud, geoHt, temp, rh}
    var grid = [];
    for (var li = 0; li < nLevels; li++) {
      grid[li] = [];
      var lev = LEVELS[li];
      var wsKey = 'wind_speed_' + lev + 'hPa';
      var wdKey = 'wind_direction_' + lev + 'hPa';
      var ccKey = 'cloud_cover_' + lev + 'hPa';
      var ghKey = 'geopotential_height_' + lev + 'hPa';
      var tKey = 'temperature_' + lev + 'hPa';
      var rhKey = 'relative_humidity_' + lev + 'hPa';
      for (var pi = 0; pi < nPoints; pi++) {
        var resp = responses[pi];
        var hourly = resp && resp.hourly;
        if (!hourly || !hourly.time) {
          grid[li][pi] = { windSpd: null, windDir: null, cloud: null, geoHt: stdHts[li], temp: null, rh: null };
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
          cloud: hourly[ccKey] ? hourly[ccKey][hi] : null,
          geoHt: hourly[ghKey] ? hourly[ghKey][hi] : stdHts[li],
          temp: hourly[tKey] ? hourly[tKey][hi] : null,
          rh: hourly[rhKey] ? hourly[rhKey][hi] : null
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

    var fl = getFL();
    var altM = fl * 100 * 0.3048;

    var overlay = [];
    for (var pi = 0; pi < nPoints; pi++) {
      var spd = null, dir = null, cloud = null, temp = null, rh = null;
      for (var li = 0; li < nLevels - 1; li++) {
        var h0 = avgGeoHt[li], h1 = avgGeoHt[li + 1];
        if (altM >= h0 && altM <= h1) {
          var frac = (altM - h0) / (h1 - h0);
          var s0 = grid[li][pi].windSpd, s1 = grid[li + 1][pi].windSpd;
          var d0 = grid[li][pi].windDir, d1 = grid[li + 1][pi].windDir;
          var c0 = grid[li][pi].cloud, c1 = grid[li + 1][pi].cloud;
          var t0 = grid[li][pi].temp, t1 = grid[li + 1][pi].temp;
          var rh0 = grid[li][pi].rh, rh1 = grid[li + 1][pi].rh;
          if (s0 != null && s1 != null) spd = s0 + frac * (s1 - s0);
          if (d0 != null && d1 != null) dir = interpAngle(d0, d1, frac);
          if (c0 != null && c1 != null) cloud = c0 + frac * (c1 - c0);
          if (t0 != null && t1 != null) temp = t0 + frac * (t1 - t0);
          if (rh0 != null && rh1 != null) rh = rh0 + frac * (rh1 - rh0);
          break;
        }
      }
      // Clamp to lowest/highest level if outside range
      if (spd == null && altM <= avgGeoHt[0]) {
        spd = grid[0][pi].windSpd; dir = grid[0][pi].windDir; cloud = grid[0][pi].cloud;
        temp = grid[0][pi].temp; rh = grid[0][pi].rh;
      }
      if (spd == null && altM >= avgGeoHt[nLevels - 1]) {
        spd = grid[nLevels - 1][pi].windSpd; dir = grid[nLevels - 1][pi].windDir; cloud = grid[nLevels - 1][pi].cloud;
        temp = grid[nLevels - 1][pi].temp; rh = grid[nLevels - 1][pi].rh;
      }
      if (spd != null) {
        // Compute route bearing at this point from adjacent samples
        var brg = 0;
        if (pi < nPoints - 1) {
          brg = initialBearing(samples[pi].lat, samples[pi].lon, samples[pi + 1].lat, samples[pi + 1].lon);
        } else if (pi > 0) {
          brg = initialBearing(samples[pi - 1].lat, samples[pi - 1].lon, samples[pi].lat, samples[pi].lon);
        }
        var roundTemp = temp != null ? Math.round(temp) : null;
        var icing = temp != null && cloud != null && rh != null
          && temp >= -20 && temp <= 2 && (cloud > 50 || rh > 80);
        overlay.push({
          lat: samples[pi].lat,
          lon: samples[pi].lon,
          windSpd: Math.round(spd),
          windDir: Math.round(dir || 0),
          cloud: cloud != null ? Math.round(cloud) : null,
          temp: roundTemp,
          rh: rh != null ? Math.round(rh) : null,
          icing: icing,
          routeBrg: brg
        });
      }
    }
    routeWxOverlay = overlay;
    renderRouteWxOnMap();
  }

  // Check icing conditions along the route at all relevant altitude levels
  function checkRouteIcing(responses, samples) {
    var app = window.AirportApp;
    var LEVELS = app.AIRGRAM_LEVELS;
    if (!LEVELS || !responses || responses.length === 0 || samples.length === 0) return null;
    var nLevels = LEVELS.length;
    var stdHts = [111, 762, 1457, 2164, 3012, 4206, 5574, 6344];
    var fl = getFL();
    var cruiseM = fl * 100 * 0.3048;

    // Helper: check icing at a single grid point for a given response and hour index
    function getHourIdx(resp, sample) {
      var hourly = resp && resp.hourly;
      if (!hourly || !hourly.time) return 0;
      var hi = 0;
      if (sample.etaEpoch) {
        var etaMs = sample.etaEpoch * 1000;
        var bestDiff = Infinity;
        for (var h = 0; h < hourly.time.length; h++) {
          var diff = Math.abs(new Date(hourly.time[h]).getTime() - etaMs);
          if (diff < bestDiff) { bestDiff = diff; hi = h; }
        }
      }
      return hi;
    }

    function getLevelData(resp, hi, li) {
      var hourly = resp && resp.hourly;
      if (!hourly) return null;
      var lev = LEVELS[li];
      var tKey = 'temperature_' + lev + 'hPa';
      var ccKey = 'cloud_cover_' + lev + 'hPa';
      var rhKey = 'relative_humidity_' + lev + 'hPa';
      var ghKey = 'geopotential_height_' + lev + 'hPa';
      var temp = hourly[tKey] ? hourly[tKey][hi] : null;
      var cloud = hourly[ccKey] ? hourly[ccKey][hi] : null;
      var rh = hourly[rhKey] ? hourly[rhKey][hi] : null;
      var geoHt = hourly[ghKey] ? hourly[ghKey][hi] : stdHts[li];
      return { temp: temp, cloud: cloud, rh: rh, geoHt: geoHt };
    }

    function isIcing(temp, cloud, rh) {
      return temp != null && cloud != null && rh != null
        && temp >= -20 && temp <= 2 && (cloud > 50 || rh > 80);
    }

    // Check climb/descent layers at dep or arrival
    function checkVertical(resp, sample, elevFt) {
      if (!resp || !resp.hourly) return [];
      var hi = getHourIdx(resp, sample);
      var elevM = elevFt * 0.3048;
      var minM = Math.min(elevM, cruiseM);
      var maxM = Math.max(elevM, cruiseM);
      var icingLevels = [];
      for (var li = 0; li < nLevels; li++) {
        var d = getLevelData(resp, hi, li);
        if (!d) continue;
        if (d.geoHt >= minM - 100 && d.geoHt <= maxM + 100) {
          if (isIcing(d.temp, d.cloud, d.rh)) {
            var flVal = Math.round(d.geoHt / 0.3048 / 100);
            icingLevels.push({ fl: flVal, temp: Math.round(d.temp) });
          }
        }
      }
      return icingLevels;
    }

    // En-route: icing flags from overlay (already computed at cruise FL)
    var enroute = [];
    for (var i = 0; i < routeWxOverlay.length; i++) {
      if (routeWxOverlay[i].icing) {
        enroute.push({ idx: i, temp: routeWxOverlay[i].temp });
      }
    }

    // Departure: first waypoint
    var departure = [];
    var depCode = '';
    var depMinFL = 0, depMaxFL = 0;
    if (waypoints.length >= 2 && waypoints[0].data) {
      var depElev = parseFloat(waypoints[0].data[5]) || 0;
      depCode = waypoints[0].code || '';
      departure = checkVertical(responses[0], samples[0], depElev);
      if (departure.length > 0) {
        var fls = departure.map(function (d) { return d.fl; });
        depMinFL = Math.min.apply(null, fls);
        depMaxFL = Math.max.apply(null, fls);
      }
    }

    // Arrival: last waypoint before alternate (or last waypoint if no alternate)
    var arrival = [];
    var arrCode = '';
    var arrMinFL = 0, arrMaxFL = 0;
    var arrWpIdx = alternateIndex > 0 ? alternateIndex - 1 : waypoints.length - 1;
    if (arrWpIdx >= 0 && waypoints[arrWpIdx] && waypoints[arrWpIdx].data) {
      var arrElev = parseFloat(waypoints[arrWpIdx].data[5]) || 0;
      arrCode = waypoints[arrWpIdx].code || '';
      // Use the last sample point (or closest to arrival)
      var arrSampleIdx = responses.length - 1;
      if (alternateIndex > 0 && samples.length > 2) {
        // Find sample closest to arrival waypoint
        var arrLat = waypoints[arrWpIdx].latlng.lat;
        var arrLon = waypoints[arrWpIdx].latlng.lng;
        var bestDist = Infinity;
        for (var si = 0; si < samples.length; si++) {
          var d = haversineNm(arrLat, arrLon, samples[si].lat, samples[si].lon);
          if (d < bestDist) { bestDist = d; arrSampleIdx = si; }
        }
      }
      arrival = checkVertical(responses[arrSampleIdx], samples[arrSampleIdx], arrElev);
      if (arrival.length > 0) {
        var fls = arrival.map(function (d) { return d.fl; });
        arrMinFL = Math.min.apply(null, fls);
        arrMaxFL = Math.max.apply(null, fls);
      }
    }

    if (departure.length === 0 && enroute.length === 0 && arrival.length === 0) return null;

    return {
      enroute: enroute,
      departure: departure,
      arrival: arrival,
      depCode: depCode,
      destCode: arrCode,
      depMinFL: depMinFL,
      depMaxFL: depMaxFL,
      arrMinFL: arrMinFL,
      arrMaxFL: arrMaxFL
    };
  }

  function renderIcingWarning(el, result) {
    if (!result) { el.innerHTML = ''; return; }
    var fl = getFL();
    var flLabel = 'FL' + (fl < 100 ? '0' : '') + fl;
    var lines = [];
    if (result.departure.length > 0) {
      var range = result.depMinFL === result.depMaxFL
        ? 'FL' + String(result.depMinFL).padStart(3, '0')
        : 'FL' + String(result.depMinFL).padStart(3, '0') + '\u2013' + String(result.depMaxFL).padStart(3, '0');
      lines.push(escapeHtml(result.depCode) + ' ' + range + ' (climb)');
    }
    if (result.enroute.length > 0) {
      var pct = Math.round(result.enroute.length / routeWxOverlay.length * 100);
      lines.push(flLabel + ' \u2013 ~' + pct + '% of route');
    }
    if (result.arrival.length > 0) {
      var range = result.arrMinFL === result.arrMaxFL
        ? 'FL' + String(result.arrMinFL).padStart(3, '0')
        : 'FL' + String(result.arrMinFL).padStart(3, '0') + '\u2013' + String(result.arrMaxFL).padStart(3, '0');
      lines.push(escapeHtml(result.destCode) + ' ' + range + ' (descent)');
    }
    if (lines.length === 0) { el.innerHTML = ''; return; }
    el.innerHTML = '<div class="route-icing-warning">&#10052; Icing conditions: ' + lines.join(', ') + '</div>';
  }

  function cloudCoverSvgHtml(pct, size) {
    var r = size / 2;
    var svg = '<svg viewBox="' + (-r - 1) + ' ' + (-r - 1) + ' ' + (size + 2) + ' ' + (size + 2) + '" width="' + (size + 2) + '" height="' + (size + 2) + '">';
    svg += '<circle cx="0" cy="0" r="' + r + '" fill="#fff" stroke="#334" stroke-width="1.2"/>';
    if (pct >= 88) {
      svg += '<circle cx="0" cy="0" r="' + r + '" fill="#334" stroke="#334" stroke-width="1.2"/>';
    } else if (pct > 12) {
      var frac = pct / 100;
      var angle = frac * 2 * Math.PI;
      var endX = (r * Math.sin(angle)).toFixed(1);
      var endY = (-r * Math.cos(angle)).toFixed(1);
      var large = angle > Math.PI ? 1 : 0;
      svg += '<path d="M0,0 L0,' + (-r) + ' A' + r + ',' + r + ' 0 ' + large + ',1 ' + endX + ',' + endY + ' Z" fill="#334"/>';
    }
    svg += '</svg>';
    return svg;
  }

  function renderRouteWxOnMap() {
    if (!routeWxMarkers) return;
    routeWxMarkers.clearLayers();
    var wxCb = document.getElementById('route-wx-show');
    if (wxCb && !wxCb.checked) return;
    if (routeWxOverlay.length === 0) return;

    // Skip every other if dense
    var step = routeWxOverlay.length > 12 ? 2 : 1;
    var fl = getFL();
    var flLabel = 'FL' + (fl < 100 ? '0' : '') + fl;

    // Perpendicular offset in nm (to the right of route direction)
    var offsetNm = 4;

    for (var i = 0; i < routeWxOverlay.length; i += step) {
      var ow = routeWxOverlay[i];
      // Offset position perpendicular to route (90° to the right)
      var perpBrg = ((ow.routeBrg || 0) + 90) % 360;
      var perpRad = perpBrg * DEG;
      var dLat = offsetNm / 60 * Math.cos(perpRad);
      var dLon = offsetNm / 60 * Math.sin(perpRad) / Math.cos(ow.lat * DEG);
      var mLat = ow.lat + dLat;
      var mLon = ow.lon + dLon;
      // Blue color for icing points
      var barbColor = ow.icing ? '#2980b9' : '#334';
      // Build wind barb SVG (viewBox 40x40, rendered at 26px)
      var barbHtml = '';
      if (ow.windSpd < 3) {
        barbHtml = '<svg viewBox="0 0 40 40" width="26" height="26">'
          + '<circle cx="20" cy="20" r="6" fill="none" stroke="' + barbColor + '" stroke-width="2.5"/>'
          + '<circle cx="20" cy="20" r="2" fill="' + barbColor + '"/></svg>';
      } else {
        var barbs = [];
        var rem = Math.round(ow.windSpd / 5) * 5;
        var y = 4;
        while (rem >= 50) {
          barbs.push('<polygon points="20,' + y + ' 32,' + (y + 2) + ' 20,' + (y + 5) + '" fill="' + barbColor + '"/>');
          y += 6; rem -= 50;
        }
        while (rem >= 10) {
          barbs.push('<line x1="20" y1="' + y + '" x2="32" y2="' + (y - 3) + '" stroke="' + barbColor + '" stroke-width="2.5" stroke-linecap="round"/>');
          y += 4; rem -= 10;
        }
        if (rem >= 5) {
          barbs.push('<line x1="20" y1="' + y + '" x2="26" y2="' + (y - 2) + '" stroke="' + barbColor + '" stroke-width="2.5" stroke-linecap="round"/>');
        }
        barbHtml = '<svg viewBox="0 0 40 40" width="26" height="26">'
          + '<g transform="rotate(' + ow.windDir + ', 20, 20)">'
          + '<line x1="20" y1="4" x2="20" y2="36" stroke="' + barbColor + '" stroke-width="2.5" stroke-linecap="round"/>'
          + '<circle cx="20" cy="36" r="3" fill="' + barbColor + '"/>'
          + barbs.join('') + '</g></svg>';
      }

      // Cloud circle
      var cloudHtml = '';
      if (ow.cloud != null) {
        cloudHtml = cloudCoverSvgHtml(ow.cloud, 10);
      }

      // Ice crystal for icing points (4-line star)
      var iceHtml = '';
      if (ow.icing) {
        iceHtml = '<svg viewBox="0 0 12 12" width="12" height="12" style="margin-left:1px">'
          + '<line x1="6" y1="1" x2="6" y2="11" stroke="#2980b9" stroke-width="1.5"/>'
          + '<line x1="1" y1="6" x2="11" y2="6" stroke="#2980b9" stroke-width="1.5"/>'
          + '<line x1="2.5" y1="2.5" x2="9.5" y2="9.5" stroke="#2980b9" stroke-width="1.2"/>'
          + '<line x1="9.5" y1="2.5" x2="2.5" y2="9.5" stroke="#2980b9" stroke-width="1.2"/>'
          + '</svg>';
      }

      var label = ow.windSpd + 'kt';
      var html = '<div class="route-wx-barb-icon">'
        + '<div class="route-wx-barb-row">' + barbHtml + cloudHtml + iceHtml + '</div>'
        + '<span class="wind-barb-label">' + label + '</span></div>';
      var icon = L.divIcon({
        className: 'wind-barb-marker',
        html: html,
        iconSize: [ow.icing ? 56 : 42, 40],
        iconAnchor: [14, 14]
      });
      // Tooltip with wind and cloud details
      var cloudLabel = ow.cloud != null
        ? (ow.cloud <= 12 ? 'CLR' : ow.cloud <= 25 ? 'FEW' : ow.cloud <= 50 ? 'SCT' : ow.cloud <= 87 ? 'BKN' : 'OVC')
          + ' (' + ow.cloud + '%)'
        : '';
      var tip = flLabel
        + ' \u2013 Wind ' + String(Math.round(ow.windDir)).padStart(3, '0') + '\u00b0/' + ow.windSpd + 'kt'
        + (cloudLabel ? ' \u2013 Cloud ' + cloudLabel : '')
        + (ow.icing ? ' \u2013 ICING (' + ow.temp + '\u00b0C)' : '');
      L.marker([mLat, mLon], { icon: icon, interactive: true })
        .bindTooltip(tip, { direction: 'top', offset: [0, -14] })
        .addTo(routeWxMarkers);
    }
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
    } else if (tab === 'rw-briefing') {
      loadRouteBriefing();
    }
  }

  function closeRouteWxPanel() {
    var panel = document.getElementById('route-wx-panel');
    if (panel) panel.style.display = 'none';
  }

  function loadRouteBriefing() {
    var el = document.getElementById('rw-briefing');
    if (!el || !window.AirportApp.streamBriefing) return;
    if (waypoints.length < 2) {
      el.innerHTML = '<div class="briefing-content">Add at least 2 waypoints to generate a route briefing.</div>';
      return;
    }

    var app = window.AirportApp;
    var fl = getFL();
    var depEpoch = getDepEpoch();
    var depTime = depEpoch ? new Date(depEpoch * 1000).toISOString().slice(0, 16) + 'Z' : null;

    // Collect waypoints and legs
    var wpData = [];
    for (var i = 0; i < waypoints.length; i++) {
      var wp = waypoints[i];
      wpData.push({
        code: wp.code || ('WP' + (i + 1)),
        name: wp.name || '',
        elevation: wp.data ? wp.data[5] : null
      });
    }
    var legData = [];
    for (var i = 0; i < legs.length; i++) {
      legData.push({
        dist: Math.round(legs[i].dist),
        hdg: Math.round(legs[i].magHdg),
        time: legs[i].time ? legs[i].time.toFixed(2) : '?',
        fuel: legs[i].fuel ? legs[i].fuel.toFixed(1) : '?'
      });
    }

    // Departure data
    var depCode = waypoints[0].code;
    var depMetar = app.metarCache && app.metarCache[depCode] ? app.metarCache[depCode].raw : null;
    var depTaf = app.rawTafCache && app.rawTafCache[depCode] ? app.rawTafCache[depCode] : null;
    if (!depTaf) {
      var taf = routeWxCache[depCode] || (app.tafCache && app.tafCache[depCode]);
      if (taf && taf.length && taf[0].rawTAF) depTaf = taf[0].rawTAF;
    }
    var depNotams = [];
    if (app.notamCache && app.notamCache[depCode] && app.notamCache[depCode].notams) {
      for (var i = 0; i < app.notamCache[depCode].notams.length; i++) {
        var n = app.notamCache[depCode].notams[i];
        depNotams.push({ id: n.id, text: n.text });
      }
    }

    // Destination data (if alternate is set, dest is the waypoint before it)
    var destIdx = (alternateIndex >= 0 && alternateIndex < waypoints.length) ? alternateIndex - 1 : waypoints.length - 1;
    if (destIdx < 0) destIdx = waypoints.length - 1;
    var destCode = waypoints[destIdx].code;
    var destTaf = app.rawTafCache && app.rawTafCache[destCode] ? app.rawTafCache[destCode] : null;
    if (!destTaf) {
      var taf = routeWxCache[destCode] || (app.tafCache && app.tafCache[destCode]);
      if (taf && taf.length && taf[0].rawTAF) destTaf = taf[0].rawTAF;
    }
    var destNotams = [];
    if (app.notamCache && app.notamCache[destCode] && app.notamCache[destCode].notams) {
      for (var i = 0; i < app.notamCache[destCode].notams.length; i++) {
        var n = app.notamCache[destCode].notams[i];
        destNotams.push({ id: n.id, text: n.text });
      }
    }

    // Alternate data
    var altData = null;
    if (alternateIndex >= 0 && alternateIndex < waypoints.length) {
      var altCode = waypoints[alternateIndex].code;
      var altTaf = app.rawTafCache && app.rawTafCache[altCode] ? app.rawTafCache[altCode] : null;
      if (!altTaf) {
        var taf2 = routeWxCache[altCode] || (app.tafCache && app.tafCache[altCode]);
        if (taf2 && taf2.length && taf2[0].rawTAF) altTaf = taf2[0].rawTAF;
      }
      var altNotams = [];
      if (app.notamCache && app.notamCache[altCode] && app.notamCache[altCode].notams) {
        for (var i = 0; i < app.notamCache[altCode].notams.length; i++) {
          var n = app.notamCache[altCode].notams[i];
          altNotams.push({ id: n.id, text: n.text });
        }
      }
      altData = { code: altCode, taf: altTaf, notams: altNotams };
    }

    // En-route weather samples from OWM cache
    var enroute = [];
    for (var i = 0; i < routeOwmSamples.length; i++) {
      var s = routeOwmSamples[i];
      var key = owmCacheKey(s.lat, s.lon);
      var c = routeOwmCache[key];
      if (c && c.data) {
        var d = c.data;
        enroute.push({
          lat: s.lat,
          lon: s.lon,
          weather: d.weather && d.weather[0] ? d.weather[0].main : null,
          windDir: d.wind ? Math.round(d.wind.deg || 0) : null,
          windSpd: d.wind ? Math.round(d.wind.speed * 1.944) : null,
          temp: d.main ? Math.round(d.main.temp) : null,
          vis: d.visibility != null ? d.visibility : null
        });
      }
    }

    // Build FL compare and airgram data if available
    var flCompare = null;
    var airgramSummary = null;
    var profile = getProfile();
    var samples = buildRouteAirgramSamples();
    var airgramCache = app.routeAirgramCache;

    if (profile && samples.length > 0 && airgramCache && airgramCache.responses
        && airgramCache.samples === samples.map(function(s) { return s.lat + ',' + s.lon; }).join('|')
        && (Date.now() - airgramCache.timestamp) < 600000) {
      var responses = airgramCache.responses;
      var LEVELS = app.AIRGRAM_LEVELS;
      var nLevels = LEVELS.length;
      var nPoints = samples.length;
      var stdHts = [111, 762, 1457, 2164, 3012, 4206, 5574, 6344];

      // Build grid
      var grid = [];
      for (var li = 0; li < nLevels; li++) {
        grid[li] = [];
        var lev = LEVELS[li];
        var wsKey = 'wind_speed_' + lev + 'hPa';
        var wdKey = 'wind_direction_' + lev + 'hPa';
        var ghKey = 'geopotential_height_' + lev + 'hPa';
        var tKey = 'temperature_' + lev + 'hPa';
        var ccKey = 'cloud_cover_' + lev + 'hPa';
        for (var pi = 0; pi < nPoints; pi++) {
          var resp = responses[pi];
          var hourly = resp && resp.hourly;
          if (!hourly || !hourly.time) {
            grid[li][pi] = { windSpd: null, windDir: null, geoHt: stdHts[li], temp: null, cloud: null };
            continue;
          }
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
            geoHt: hourly[ghKey] ? hourly[ghKey][hi] : stdHts[li],
            temp: hourly[tKey] ? hourly[tKey][hi] : null,
            cloud: hourly[ccKey] ? hourly[ccKey][hi] : null
          };
        }
      }

      // Average geopotential heights
      var avgGeoHt = [];
      for (var li = 0; li < nLevels; li++) {
        var sum = 0, cnt = 0;
        for (var pi = 0; pi < nPoints; pi++) {
          if (grid[li][pi].geoHt != null) { sum += grid[li][pi].geoHt; cnt++; }
        }
        avgGeoHt[li] = cnt > 0 ? sum / cnt : stdHts[li];
      }

      // Airgram summary: average conditions at each pressure level
      airgramSummary = [];
      for (var li = 0; li < nLevels; li++) {
        var ws = 0, wd = 0, tp = 0, cc = 0, cnt = 0;
        for (var pi = 0; pi < nPoints; pi++) {
          var g = grid[li][pi];
          if (g.windSpd != null) { ws += g.windSpd; wd += g.windDir || 0; tp += g.temp || 0; cc += g.cloud || 0; cnt++; }
        }
        if (cnt > 0) {
          airgramSummary.push({
            level: LEVELS[li],
            altFt: Math.round(avgGeoHt[li] * 3.281),
            windSpd: Math.round(ws / cnt),
            windDir: Math.round(wd / cnt),
            temp: Math.round(tp / cnt),
            cloud: Math.round(cc / cnt)
          });
        }
      }

      // FL compare: compute for FL10-FL200
      var cumDist = [0];
      for (var i = 0; i < legs.length; i++) cumDist.push(cumDist[i] + legs[i].dist);
      var legBearings = [];
      for (var i = 0; i < legs.length; i++) legBearings.push(legs[i].trueHdg);
      var sampleLeg = [];
      for (var pi = 0; pi < nPoints; pi++) {
        var d = samples[pi].dist;
        var sli = 0;
        for (var j = 0; j < legs.length; j++) {
          if (d >= cumDist[j] && d <= cumDist[j + 1] + 0.01) { sli = j; break; }
        }
        sampleLeg[pi] = sli;
      }

      var maxLeg = (alternateIndex >= 0) ? alternateIndex - 1 : legs.length;

      function briefInterpWind(pi, targetM) {
        for (var li = 0; li < nLevels - 1; li++) {
          var h0 = avgGeoHt[li], h1 = avgGeoHt[li + 1];
          if (targetM >= h0 && targetM <= h1) {
            var frac = (targetM - h0) / (h1 - h0);
            var s0 = grid[li][pi].windSpd, s1 = grid[li + 1][pi].windSpd;
            var d0 = grid[li][pi].windDir, d1 = grid[li + 1][pi].windDir;
            var spd = (s0 != null && s1 != null) ? s0 + frac * (s1 - s0) : null;
            var dir = (d0 != null && d1 != null) ? interpAngle(d0, d1, frac) : null;
            return { spd: spd, dir: dir };
          }
        }
        if (targetM <= avgGeoHt[0]) return { spd: grid[0][pi].windSpd, dir: grid[0][pi].windDir };
        if (targetM >= avgGeoHt[nLevels - 1]) return { spd: grid[nLevels - 1][pi].windSpd, dir: grid[nLevels - 1][pi].windDir };
        return { spd: null, dir: null };
      }

      function briefComputeFL(testFL) {
        var altM = testFL * 100 * 0.3048;
        var totalTime = 0, totalFuel = 0, avgHW = 0, hwCount = 0;
        for (var legI = 0; legI < maxLeg; legI++) {
          var legDist = legs[legI].dist;
          var track = legBearings[legI];
          var hwSum = 0, hwN = 0;
          for (var pi = 0; pi < nPoints; pi++) {
            if (sampleLeg[pi] === legI) {
              var w = briefInterpWind(pi, altM);
              if (w.spd != null && w.dir != null) {
                hwSum += w.spd * Math.cos((w.dir - track) * Math.PI / 180);
                hwN++;
              }
            }
          }
          var legHW = hwN > 0 ? hwSum / hwN : 0;
          avgHW += legHW * legDist;
          hwCount += legDist;
          var gs = Math.max(50, profile.tas - legHW);
          totalTime += legDist / gs;
          totalFuel += (legDist / gs) * profile.burn;
        }
        return { time: totalTime, fuel: totalFuel, avgHW: hwCount > 0 ? avgHW / hwCount : 0 };
      }

      var selResult = briefComputeFL(fl);
      flCompare = [];
      for (var flIdx = 0; flIdx < 20; flIdx++) {
        var testFL = (flIdx + 1) * 10;
        var r = (testFL === fl) ? selResult : briefComputeFL(testFL);
        flCompare.push({
          fl: testFL,
          timeH: +r.time.toFixed(2),
          fuelGal: +r.fuel.toFixed(1),
          hwKt: Math.round(r.avgHW)
        });
      }
    }

    var routeData = {
      waypoints: wpData,
      legs: legData,
      flightLevel: fl,
      departureTime: depTime,
      departure: { metar: depMetar, taf: depTaf, notams: depNotams },
      enroute: enroute,
      destination: { taf: destTaf, notams: destNotams },
      alternate: altData,
      airgramSummary: airgramSummary,
      flCompare: flCompare
    };

    // Collect LLF areas along the route
    var llfAreas = [];
    if (app.llfAreaForCoord) {
      for (var i = 0; i < waypoints.length; i++) {
        var a = app.llfAreaForCoord(waypoints[i].latlng.lat, waypoints[i].latlng.lng);
        if (a && llfAreas.indexOf(a) === -1) llfAreas.push(a);
      }
    }
    if (llfAreas.length && app.fetchLlfForBriefing) {
      app.fetchLlfForBriefing(llfAreas).then(function (llf) {
        if (llf) routeData.llf = llf;
        app.streamBriefing(el, { type: 'route', data: routeData });
      });
    } else {
      app.streamBriefing(el, { type: 'route', data: routeData });
    }
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
    // Also extract overlay data for route map
    if (app.fetchRouteAirgramData) {
      app.fetchRouteAirgramData(samples, function (responses) {
        if (responses) extractRouteWxOverlay(responses, samples);
      });
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

    // Icing warning (read from DOM if available)
    var icingLine = '';
    var icingEl = document.getElementById('route-icing-warning');
    if (icingEl && icingEl.innerHTML.trim()) {
      icingLine = icingEl.innerHTML;
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
    var wxHtml = '<div class="section wx-section"><h2>WEATHER</h2>';
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
    var notamHtml = '<div class="section notam-section"><h2>NOTAMs</h2>';
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

    var asyncData = { grametDataUrl: null, airgramDataUrl: null, flCompHtml: '', swcUrl: null, llfHtml: '', airspaceItems: null };
    var pending = 6; // GRAMET, SWC, FL Compare, Airgram, LLF, Airspaces

    function onAsyncDone() {
      if (--pending > 0) return;
      openPrintWindow();
    }

    function openPrintWindow() {
      // --- Route map SVG ---
      var routeMapHtml = buildRouteMapSvg(asyncData.airspaceItems);

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

      var llfHtml = asyncData.llfHtml;

      // --- Build Radio Frequencies table ---
      var freqRows = '';
      if (waypoints.length >= 2) {
        // Departure airport
        var depWp = waypoints[0];
        var depFreqs = getRelevantFreqs(depWp);
        if (depFreqs.length > 0) {
          freqRows += '<tr class="freq-airport"><td class="freq-phase">DEP</td>';
          freqRows += '<td class="freq-loc">' + esc(depWp.code) + '</td>';
          freqRows += '<td class="freq-list">';
          for (var fi = 0; fi < depFreqs.length; fi++) {
            freqRows += esc(depFreqs[fi][0]) + ' <strong>' + esc(String(depFreqs[fi][1])) + '</strong>';
            if (fi < depFreqs.length - 1) freqRows += ' &nbsp; ';
          }
          freqRows += '</td></tr>';
        }

        // CTR/TMA + ACC sectors along each leg in order (altitude-aware)
        var printCumD = getCumDists();
        var seenRadio = {};
        for (var li = 0; li < legs.length; li++) {
          var sectors = getLegRadioSectors(
            waypoints[li].latlng.lat, waypoints[li].latlng.lng,
            waypoints[li + 1].latlng.lat, waypoints[li + 1].latlng.lng,
            printCumD[li], legs[li].dist);
          for (var si = 0; si < sectors.length; si++) {
            var sec = sectors[si];
            var key = sec.name + '|' + sec.freq;
            if (seenRadio[key]) continue;
            seenRadio[key] = true;
            var cls = sec.phase === 'ACC' ? 'freq-acc' : 'freq-ctr';
            freqRows += '<tr class="' + cls + '"><td class="freq-phase">' + esc(sec.phase) + '</td>';
            freqRows += '<td class="freq-loc">' + esc(sec.name) + '</td>';
            freqRows += '<td class="freq-list"><strong>' + esc(sec.freq) + '</strong></td></tr>';
          }
        }

        // Arrival airport
        var lastIdx = alternateIndex >= 0 ? alternateIndex - 1 : waypoints.length - 1;
        var arrWp = waypoints[lastIdx];
        var arrFreqs = getRelevantFreqs(arrWp);
        if (arrFreqs.length > 0) {
          freqRows += '<tr class="freq-airport"><td class="freq-phase">ARR</td>';
          freqRows += '<td class="freq-loc">' + esc(arrWp.code) + '</td>';
          freqRows += '<td class="freq-list">';
          for (var fi = 0; fi < arrFreqs.length; fi++) {
            freqRows += esc(arrFreqs[fi][0]) + ' <strong>' + esc(String(arrFreqs[fi][1])) + '</strong>';
            if (fi < arrFreqs.length - 1) freqRows += ' &nbsp; ';
          }
          freqRows += '</td></tr>';
        }

        // Alternate airport (if set)
        if (alternateIndex >= 0 && alternateIndex < waypoints.length) {
          var altWp = waypoints[waypoints.length - 1];
          var altFreqs = getRelevantFreqs(altWp);
          if (altFreqs.length > 0) {
            freqRows += '<tr class="freq-airport"><td class="freq-phase">ALT</td>';
            freqRows += '<td class="freq-loc">' + esc(altWp.code) + '</td>';
            freqRows += '<td class="freq-list">';
            for (var fi = 0; fi < altFreqs.length; fi++) {
              freqRows += esc(altFreqs[fi][0]) + ' <strong>' + esc(String(altFreqs[fi][1])) + '</strong>';
              if (fi < altFreqs.length - 1) freqRows += ' &nbsp; ';
            }
            freqRows += '</td></tr>';
          }
        }
      }
      var freqTableHtml = '';
      if (freqRows) {
        freqTableHtml = '<div class="section freq-section"><h2>RADIO FREQUENCIES</h2>'
          + '<table class="freq-table"><thead><tr><th>Phase</th><th>Station</th><th>Frequencies</th></tr></thead>'
          + '<tbody>' + freqRows + '</tbody></table></div>';
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
        + icingLine
        + '</div>'
        + freqTableHtml
        + wbHtml
        + wxHtml
        + llfHtml
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
      // Wait for images to load; SVG <image> tiles need extra time
      win.onload = function () {
        var delay = win.document.querySelectorAll('image').length > 0 ? 1500 : 200;
        setTimeout(function () { win.print(); }, delay);
      };
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

    // --- LLF: fetch low-level forecast for route areas ---
    var llfAreas = [];
    if (app.llfAreaForCoord) {
      for (var i = 0; i < waypoints.length; i++) {
        var a = app.llfAreaForCoord(waypoints[i].latlng.lat, waypoints[i].latlng.lng);
        if (a && llfAreas.indexOf(a) === -1) llfAreas.push(a);
      }
    }
    if (llfAreas.length && app.fetchLlfForBriefing) {
      app.fetchLlfForBriefing(llfAreas).then(function (llf) {
        if (llf && llf.areas) {
          var h = '<div class="section llf-section"><h2>LOW LEVEL FORECAST (LLF)</h2>';
          h += '<p class="llf-valid">Valid: ' + esc(llf.title || '') + '</p>';
          var areaKeys = Object.keys(llf.areas);
          for (var i = 0; i < areaKeys.length; i++) {
            var aKey = areaKeys[i];
            var ad = llf.areas[aKey];
            h += '<div class="llf-area-block">';
            h += '<strong>' + esc(aKey.toUpperCase()) + '</strong>';
            var details = [];
            if (ad.visibility_m != null && ad.visibility_m < 9999) details.push('VIS ' + ad.visibility_m + ' m');
            if (ad.ceiling_ft != null && ad.ceiling_ft < 9999) details.push('CLD ' + ad.ceiling_ft + ' ft');
            if (ad.weather && ad.weather.length) details.push('WX: ' + ad.weather.join(', '));
            if (ad.freezingLevel) {
              var zr = ad.freezingLevel;
              if (zr.from === 0 && zr.to === 0) details.push('0\u00b0C: SFC');
              else details.push('0\u00b0C: ' + (zr.from || 0) + '-' + (zr.to || 0) + ' ft');
            }
            if (ad.icing && ad.icing.length) {
              for (var j = 0; j < ad.icing.length; j++) {
                details.push('ICE: ' + ad.icing[j].intensity + ' ' + ad.icing[j].altitude);
              }
            }
            if (details.length) h += ' — ' + details.join(' | ');
            if (ad.overview) h += '<div class="llf-overview">' + esc(ad.overview) + '</div>';
            h += '</div>';
          }
          h += '</div>';
          asyncData.llfHtml = h;
        }
      }).catch(function () {}).finally(onAsyncDone);
    } else {
      onAsyncDone();
    }

    // --- Airspaces: fetch R/D/P areas + NOTAMs along the route ---
    var routeBbox = [];
    for (var i = 0; i < waypoints.length; i++) {
      routeBbox.push(waypoints[i].latlng);
    }
    if (routeBbox.length >= 2) {
      var bounds = L.latLngBounds(routeBbox);
      var padDeg = 0.2;
      var bbox = [
        (bounds.getWest() - padDeg).toFixed(4),
        (bounds.getSouth() - padDeg).toFixed(4),
        (bounds.getEast() + padDeg).toFixed(4),
        (bounds.getNorth() + padDeg).toFixed(4)
      ].join(',');
      var classifyActivation = app.classifyAirspaceActivation || function () { return 'potential'; };
      var extractDesig = app.extractActiveDesignators || function () { return {}; };
      var findNotam = app.findNotamForAirspace || function () { return null; };
      var countryFirs = app.COUNTRY_FIRS || {};
      fetch(OWM_PROXY + '/airspaces?bbox=' + bbox + '&type=1,2,3')
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (data) {
          if (!data || !data.items) return;
          // Collect countries to fetch NOTAMs
          var countries = {};
          data.items.forEach(function (item) {
            if (item.country) countries[item.country] = true;
          });
          var firs = [];
          Object.keys(countries).forEach(function (cc) {
            (countryFirs[cc] || []).forEach(function (f) {
              if (firs.indexOf(f) === -1) firs.push(f);
            });
          });
          // Fetch NOTAMs for all FIRs, then classify
          var notamPromise = firs.length
            ? fetch(OWM_PROXY + '/ar/area-notams?firs=' + firs.join(','))
                .then(function (r) { return r.ok ? r.json() : null; })
                .catch(function () { return null; })
            : Promise.resolve(null);
          return notamPromise.then(function (notamData) {
            var activeDesignators = {};
            if (notamData && notamData.rows) {
              activeDesignators = extractDesig(notamData.rows);
            }
            var items = [];
            for (var i = 0; i < data.items.length; i++) {
              var item = data.items[i];
              if (!item.geometry) continue;
              var act = classifyActivation(item);
              if (!act) continue;
              // Upgrade with NOTAM data
              if (findNotam(item, activeDesignators)) act = 'active';
              if (act !== 'active') continue;
              item._activation = act;
              items.push(item);
            }
            asyncData.airspaceItems = items;
          });
        })
        .catch(function () {})
        .finally(onAsyncDone);
    } else {
      onAsyncDone();
    }
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function esc(s) { return escapeHtml(s); }

  // SVG wind barb: returns <g> content centered at (0,0), rotated by wind direction
  function svgWindBarb(speedKt, dirDeg, size, color) {
    var c = color || '#334';
    if (speedKt < 3) {
      // Calm: concentric circles
      var cr = size * 0.15;
      return '<circle cx="0" cy="0" r="' + r(cr * 2) + '" fill="none" stroke="' + c + '" stroke-width="1.5"/>'
        + '<circle cx="0" cy="0" r="' + r(cr * 0.7) + '" fill="' + c + '"/>';
    }
    var half = size / 2;
    var staffTop = -half;
    var staffBot = half * 0.6;
    var barbLen = size * 0.4;
    var barbHalf = barbLen * 0.5;
    var penH = size * 0.15;

    var parts = [];
    var remaining = Math.round(speedKt / 5) * 5;
    var y = staffTop;

    // Pennants (50 kt)
    while (remaining >= 50) {
      parts.push('<polygon points="0,' + r(y) + ' ' + r(barbLen) + ',' + r(y + penH * 0.4) + ' 0,' + r(y + penH) + '" fill="' + c + '"/>');
      y += penH + 1;
      remaining -= 50;
    }
    // Full barbs (10 kt)
    while (remaining >= 10) {
      parts.push('<line x1="0" y1="' + r(y) + '" x2="' + r(barbLen) + '" y2="' + r(y - penH * 0.6) + '" stroke="' + c + '" stroke-width="1.5" stroke-linecap="round"/>');
      y += size * 0.12;
      remaining -= 10;
    }
    // Half barb (5 kt)
    if (remaining >= 5) {
      parts.push('<line x1="0" y1="' + r(y) + '" x2="' + r(barbHalf) + '" y2="' + r(y - penH * 0.4) + '" stroke="' + c + '" stroke-width="1.5" stroke-linecap="round"/>');
    }

    // Staff + dot at station end
    return '<g transform="rotate(' + r(dirDeg) + ' 0 0)">'
      + '<line x1="0" y1="' + r(staffTop) + '" x2="0" y2="' + r(staffBot) + '" stroke="' + c + '" stroke-width="1.5" stroke-linecap="round"/>'
      + '<circle cx="0" cy="' + r(staffBot) + '" r="2" fill="' + c + '"/>'
      + parts.join('')
      + '</g>';
  }

  // SVG cloud cover circle: returns elements for oktas-style symbol
  function svgCloudCircle(coverPct, cr) {
    var outline = '<circle cx="0" cy="0" r="' + cr + '" fill="#fff" stroke="#334" stroke-width="1.2"/>';
    if (coverPct <= 12) return outline; // CLR
    if (coverPct >= 88) {
      // OVC: filled circle
      return '<circle cx="0" cy="0" r="' + cr + '" fill="#334" stroke="#334" stroke-width="1.2"/>';
    }
    // Partial fill using arc
    var fillFrac = coverPct / 100;
    // Draw as a pie slice from top
    var angle = fillFrac * 2 * Math.PI;
    var startX = 0, startY = -cr;
    var endX = cr * Math.sin(angle);
    var endY = -cr * Math.cos(angle);
    var largeArc = angle > Math.PI ? 1 : 0;
    var path = 'M0,0 L' + r(startX) + ',' + r(startY)
      + ' A' + cr + ',' + cr + ' 0 ' + largeArc + ',1 ' + r(endX) + ',' + r(endY) + ' Z';
    return outline + '<path d="' + path + '" fill="#334"/>';
  }

  function buildRouteMapSvg(printAirspaceItems) {
    var app = window.AirportApp || {};
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

    var svg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ' + svgW + ' ' + svgH + '">';

    // Background fallback
    svg += '<rect width="' + svgW + '" height="' + svgH + '" fill="#f0f4f8" rx="3"/>';

    // Basemap tiles
    var basemapInfo = app.activeBasemap;
    if (basemapInfo && basemapInfo.url) {
      var tileUrl = basemapInfo.url;
      var subdomains = basemapInfo.subdomains;
      var subArr = typeof subdomains === 'string' ? subdomains.split('') : (subdomains || ['a', 'b', 'c']);

      // Choose zoom level: aim for ~4 tiles across
      var zRaw = Math.log2(4 * 360 / lonRange);
      var z = Math.max(4, Math.min(Math.round(zRaw), 12));
      var n = Math.pow(2, z);

      function lon2tile(lon) { return Math.floor((lon + 180) / 360 * n); }
      function lat2tile(lat) {
        var rad = lat * Math.PI / 180;
        return Math.floor((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n);
      }
      function tile2lon(tx) { return tx / n * 360 - 180; }
      function tile2lat(ty) { return Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / n))) * 180 / Math.PI; }

      var tileXmin = lon2tile(minLon);
      var tileXmax = lon2tile(maxLon);
      var tileYmin = lat2tile(maxLat); // tile Y increases southward
      var tileYmax = lat2tile(minLat);

      svg += '<defs><clipPath id="mapClip"><rect width="' + svgW + '" height="' + svgH + '" rx="3"/></clipPath></defs>';
      svg += '<g clip-path="url(#mapClip)">';
      var subIdx = 0;
      for (var ty = tileYmin; ty <= tileYmax; ty++) {
        for (var tx = tileXmin; tx <= tileXmax; tx++) {
          var tileLonW = tile2lon(tx);
          var tileLonE = tile2lon(tx + 1);
          var tileLatN = tile2lat(ty);
          var tileLatS = tile2lat(ty + 1);
          var imgX = px(tileLonW);
          var imgY = py(tileLatN);
          var imgW = px(tileLonE) - imgX;
          var imgH = py(tileLatS) - imgY;
          var sub = subArr[subIdx % subArr.length];
          subIdx++;
          var url = tileUrl.replace('{s}', sub).replace('{z}', z).replace('{x}', tx).replace('{y}', ty).replace('{r}', '');
          svg += '<image href="' + url + '" x="' + r(imgX) + '" y="' + r(imgY)
            + '" width="' + r(imgW) + '" height="' + r(imgH) + '" preserveAspectRatio="none"/>';
        }
      }
      svg += '</g>';
    } else {
      // Fallback: country borders from europe.geojson
      var geoJson = app.europeGeoJson;
      if (geoJson && geoJson.features) {
        svg += '<g opacity="0.6">';
        for (var fi = 0; fi < geoJson.features.length; fi++) {
          var geom = geoJson.features[fi].geometry;
          if (!geom) continue;
          var polys = geom.type === 'MultiPolygon' ? geom.coordinates : (geom.type === 'Polygon' ? [geom.coordinates] : []);
          for (var pi = 0; pi < polys.length; pi++) {
            var path = '';
            for (var ri = 0; ri < polys[pi].length; ri++) {
              var ring = polys[pi][ri];
              for (var ci = 0; ci < ring.length; ci++) {
                var cx_ = px(ring[ci][0]), cy_ = py(ring[ci][1]);
                path += (ci === 0 ? 'M' : 'L') + r(cx_) + ',' + r(cy_);
              }
              path += 'Z';
            }
            if (path) svg += '<path d="' + path + '" fill="#e8ecf0" stroke="#bcc4ce" stroke-width="0.5" stroke-linejoin="round"/>';
          }
        }
        svg += '</g>';
      }
    }

    // R/D/P airspace areas
    var airspaceItems = printAirspaceItems || app.airspaceItems;
    var AIRSPACE_TYPES = app.AIRSPACE_TYPES || {};
    var fmtLimit = app.formatAirspaceLimit || function () { return ''; };
    var asCallouts = []; // collect callout info for placement after polygons
    if (airspaceItems && airspaceItems.length) {
      svg += '<g>';
      for (var ai = 0; ai < airspaceItems.length; ai++) {
        var as = airspaceItems[ai];
        if (!as.geometry) continue;
        var typeInfo = AIRSPACE_TYPES[as.type] || { color: '#888', shortLabel: '?' };
        var isActive = as._activation === 'active';
        var asPolys = as.geometry.type === 'MultiPolygon' ? as.geometry.coordinates
          : (as.geometry.type === 'Polygon' ? [as.geometry.coordinates] : []);
        var asPath = '';
        var centX = 0, centY = 0, centN = 0;
        for (var api = 0; api < asPolys.length; api++) {
          for (var ari = 0; ari < asPolys[api].length; ari++) {
            var aRing = asPolys[api][ari];
            for (var aci = 0; aci < aRing.length; aci++) {
              var ax_ = px(aRing[aci][0]), ay_ = py(aRing[aci][1]);
              asPath += (aci === 0 ? 'M' : 'L') + r(ax_) + ',' + r(ay_);
              if (ari === 0) { centX += ax_; centY += ay_; centN++; }
            }
            asPath += 'Z';
          }
        }
        if (!asPath) continue;
        var asOpacity = isActive ? '0.25' : '0.08';
        var asStroke = isActive ? '1.5' : '0.8';
        var asDash = isActive ? '' : ' stroke-dasharray="3,3"';
        svg += '<path d="' + asPath + '" fill="' + typeInfo.color + '" fill-opacity="' + asOpacity
          + '" stroke="' + typeInfo.color + '" stroke-width="' + asStroke + '"' + asDash + ' stroke-linejoin="round"/>';
        // Collect callout data for later placement
        if (centN > 0) {
          centX /= centN; centY /= centN;
          var asLabel = (as.name || '').replace(/\s+/g, ' ');
          var altLabel = '';
          if (as.lowerLimit) altLabel += fmtLimit(as.lowerLimit);
          if (as.upperLimit) altLabel += (altLabel ? '-' : '') + fmtLimit(as.upperLimit);
          asCallouts.push({ cx: centX, cy: centY, name: asLabel, alt: altLabel, color: typeInfo.color, shortLabel: typeInfo.shortLabel || '?' });
        }
      }
      svg += '</g>';
    }

    // R/D/P callout boxes — placed outside areas with leader lines
    // Collect occupied rectangles for collision avoidance
    var occupiedRects = [];
    // Reserve waypoint positions
    for (var wi = 0; wi < waypoints.length; wi++) {
      var wpx = px(waypoints[wi].latlng.lng), wpy = py(waypoints[wi].latlng.lat);
      occupiedRects.push({ x: wpx - 20, y: wpy - 20, w: 40, h: 40 });
    }
    // Reserve route line corridors
    for (var ri = 0; ri < waypoints.length - 1; ri++) {
      var ra = waypoints[ri].latlng, rb = waypoints[ri + 1].latlng;
      var rx1 = px(ra.lng), ry1 = py(ra.lat), rx2 = px(rb.lng), ry2 = py(rb.lat);
      var segLen = Math.sqrt((rx2 - rx1) * (rx2 - rx1) + (ry2 - ry1) * (ry2 - ry1));
      var segSteps = Math.max(1, Math.floor(segLen / 30));
      for (var rs = 0; rs <= segSteps; rs++) {
        var t = rs / segSteps;
        var sx = rx1 + (rx2 - rx1) * t, sy = ry1 + (ry2 - ry1) * t;
        occupiedRects.push({ x: sx - 15, y: sy - 15, w: 30, h: 30 });
      }
    }

    function rectsOverlap(a, b) {
      return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
    }
    function rectInBounds(rect) {
      return rect.x >= 2 && rect.y >= 2 && rect.x + rect.w <= svgW - 2 && rect.y + rect.h <= svgH - 2;
    }

    if (asCallouts.length) {
      svg += '<g>';
      for (var ci = 0; ci < asCallouts.length; ci++) {
        var co = asCallouts[ci];
        var line1 = co.name.length > 22 ? co.name.substring(0, 22) + '…' : co.name;
        var line2 = co.shortLabel + (co.alt ? '  ' + co.alt : '');
        var boxW = Math.max(line1.length, line2.length) * 5.5 + 12;
        if (boxW < 60) boxW = 60;
        if (boxW > 140) boxW = 140;
        var boxH = 26;

        // Try candidate positions: 8 directions at 2 distances
        var placed = false;
        var bestX = co.cx + 20, bestY = co.cy - boxH / 2;
        var distances = [45, 70, 100];
        var angles = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2, 3 * Math.PI / 4, -3 * Math.PI / 4, Math.PI];
        for (var di = 0; di < distances.length && !placed; di++) {
          for (var aj = 0; aj < angles.length && !placed; aj++) {
            var candX = co.cx + distances[di] * Math.cos(angles[aj]) - boxW / 2;
            var candY = co.cy + distances[di] * Math.sin(angles[aj]) - boxH / 2;
            var candRect = { x: candX, y: candY, w: boxW, h: boxH };
            if (!rectInBounds(candRect)) continue;
            var collides = false;
            for (var oi = 0; oi < occupiedRects.length; oi++) {
              if (rectsOverlap(candRect, occupiedRects[oi])) { collides = true; break; }
            }
            if (!collides) {
              bestX = candX; bestY = candY;
              placed = true;
            }
          }
        }

        // Register this callout as occupied
        occupiedRects.push({ x: bestX, y: bestY, w: boxW, h: boxH });

        // Leader line from centroid to box edge
        var boxCx = bestX + boxW / 2, boxCy = bestY + boxH / 2;
        svg += '<line x1="' + r(co.cx) + '" y1="' + r(co.cy)
          + '" x2="' + r(boxCx) + '" y2="' + r(boxCy)
          + '" stroke="' + co.color + '" stroke-width="0.7" stroke-dasharray="2,2" opacity="0.6"/>';

        // Callout box
        svg += '<rect x="' + r(bestX) + '" y="' + r(bestY)
          + '" width="' + r(boxW) + '" height="' + r(boxH)
          + '" rx="3" fill="#fff" fill-opacity="0.92" stroke="' + co.color + '" stroke-width="0.8"/>';

        // Text lines
        svg += '<text x="' + r(bestX + 6) + '" y="' + r(bestY + 10)
          + '" font-size="8" fill="' + co.color + '" font-weight="700">' + esc(line1) + '</text>';
        svg += '<text x="' + r(bestX + 6) + '" y="' + r(bestY + 20)
          + '" font-size="7" fill="#555">' + esc(line2) + '</text>';
      }
      svg += '</g>';
    }

    // Lat/lon grid lines (semi-transparent white for visibility on tile backgrounds)
    var latStep = niceStep(latRange, 5);
    var lonStep = niceStep(lonRange, 5);
    var startLat = Math.ceil(minLat / latStep) * latStep;
    var startLon = Math.ceil(minLon / lonStep) * lonStep;
    for (var gl = startLat; gl <= maxLat; gl += latStep) {
      var gy = py(gl);
      svg += '<line x1="' + pad.left + '" y1="' + r(gy) + '" x2="' + (svgW - pad.right) + '" y2="' + r(gy) + '" stroke="#fff" stroke-width="1" opacity="0.4"/>';
      svg += '<text x="' + (pad.left + 3) + '" y="' + r(gy - 4) + '" font-size="9" fill="#fff" stroke="#000" stroke-width="2.5" paint-order="stroke" font-weight="600" opacity="0.7">' + gl.toFixed(0) + '\u00b0</text>';
    }
    for (var gn = startLon; gn <= maxLon; gn += lonStep) {
      var gx = px(gn);
      svg += '<line x1="' + r(gx) + '" y1="' + pad.top + '" x2="' + r(gx) + '" y2="' + (svgH - pad.bottom) + '" stroke="#fff" stroke-width="1" opacity="0.4"/>';
      svg += '<text x="' + r(gx + 3) + '" y="' + (svgH - pad.bottom - 4) + '" font-size="9" fill="#fff" stroke="#000" stroke-width="2.5" paint-order="stroke" font-weight="600" opacity="0.7">' + gn.toFixed(0) + '\u00b0</text>';
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
      svg += '<line x1="' + r(x1) + '" y1="' + r(y1) + '" x2="' + r(x2) + '" y2="' + r(y2) + '" stroke="#fff" stroke-width="5"' + dash + ' stroke-linecap="round"/>';
      svg += '<line x1="' + r(x1) + '" y1="' + r(y1) + '" x2="' + r(x2) + '" y2="' + r(y2) + '" stroke="' + color + '" stroke-width="2.5"' + dash + ' stroke-linecap="round"/>';

      // Leg annotations at midpoint
      if (legs[i]) {
        var mx = (x1 + x2) / 2;
        var my = (y1 + y2) / 2;
        var hdg = Math.round(legs[i].magHdg);
        var dist = Math.round(legs[i].dist);
        var angle = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
        // Keep text right-side up; track if we flipped so perpendicular sides stay consistent
        var flipped = false;
        if (angle > 90 || angle < -90) { angle += 180; flipped = true; }
        // Perpendicular direction (left side of travel direction in screen coords)
        var perpX = -(y2 - y1), perpY = x2 - x1;
        var perpLen = Math.sqrt(perpX * perpX + perpY * perpY) || 1;
        var offLbl = 14;
        // Heading / distance on one side
        var lx = mx + perpX / perpLen * offLbl;
        var ly = my + perpY / perpLen * offLbl;
        svg += '<text x="' + r(lx) + '" y="' + r(ly) + '" font-size="10" fill="#333" stroke="#fff" stroke-width="3" paint-order="stroke" font-weight="600" text-anchor="middle"'
          + ' transform="rotate(' + r(angle) + ' ' + r(lx) + ' ' + r(ly) + ')">'
          + hdg + '\u00b0 / ' + dist + 'nm</text>';
        // Time / fuel on the opposite side
        var timeMin = legs[i].time ? Math.round(legs[i].time * 60) : 0;
        var fuelGal = legs[i].fuel ? legs[i].fuel.toFixed(1) : '?';
        var lx2 = mx - perpX / perpLen * offLbl;
        var ly2 = my - perpY / perpLen * offLbl;
        svg += '<text x="' + r(lx2) + '" y="' + r(ly2) + '" font-size="9" fill="#666" stroke="#fff" stroke-width="3" paint-order="stroke" font-weight="600" text-anchor="middle"'
          + ' transform="rotate(' + r(angle) + ' ' + r(lx2) + ' ' + r(ly2) + ')">'
          + timeMin + 'min / ' + fuelGal + 'gal</text>';
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

    // Departure and arrival runway diagrams
    var rwyEndpoints = [0]; // departure
    var arrIdx = alternateIndex >= 0 ? alternateIndex - 1 : waypoints.length - 1;
    if (arrIdx > 0 && rwyEndpoints.indexOf(arrIdx) === -1) rwyEndpoints.push(arrIdx);
    for (var re = 0; re < rwyEndpoints.length; re++) {
      var rwp = waypoints[rwyEndpoints[re]];
      if (!rwp || !rwp.data || !rwp.data[10] || !rwp.data[10].length) continue;
      var rwys = rwp.data[10];
      var rcx = px(rwp.latlng.lng), rcy = py(rwp.latlng.lat);
      // Scale: longest runway ≈ 70px
      var maxLen = 0;
      for (var rr = 0; rr < rwys.length; rr++) {
        if (rwys[rr][1] > maxLen) maxLen = rwys[rr][1];
      }
      var rwyScale = maxLen > 0 ? 70 / maxLen : 0.005;

      // Count parallel runways per heading for lateral offset
      var pHdgCount = {};
      for (var rr = 0; rr < rwys.length; rr++) {
        var pm_ = (rwys[rr][0] || '').split('/')[0].trim().match(/^(\d{1,2})/);
        if (!pm_) continue;
        var phk = (parseInt(pm_[1], 10) * 10) % 180;
        pHdgCount[phk] = (pHdgCount[phk] || 0) + 1;
      }
      var pHdgIdx = {};

      svg += '<g>';
      for (var rr = 0; rr < rwys.length; rr++) {
        var rwy = rwys[rr];
        var desig = rwy[0] || '';
        var lenFt = rwy[1] || 0;
        var widFt = rwy[2] || 60;
        var parts = desig.split('/');
        var m0 = parts[0] ? parts[0].trim().match(/^(\d{1,2})/) : null;
        if (!m0) continue;
        var hdgDeg = parseInt(m0[1], 10) * 10;
        var rwyHdgRad = hdgDeg * Math.PI / 180;
        var halfLen = lenFt * rwyScale / 2;
        var rwyW = Math.max(widFt * rwyScale, 3);

        // Lateral offset for parallel runways
        var phk = hdgDeg % 180;
        var nPar = pHdgCount[phk] || 1;
        if (!pHdgIdx[phk]) pHdgIdx[phk] = 0;
        var pIdx = pHdgIdx[phk]++;
        var latOff = 0;
        if (nPar > 1) {
          var pSpacing = halfLen * 0.4;
          latOff = (pIdx - (nPar - 1) / 2) * pSpacing;
        }
        // Perpendicular offset in SVG coords (dx,dy is along runway)
        var dx = Math.sin(rwyHdgRad);
        var dy = -Math.cos(rwyHdgRad);
        var perpDx = -dy, perpDy = dx; // perpendicular to runway
        var ocx = rcx + perpDx * latOff;
        var ocy = rcy + perpDy * latOff;

        var rx1 = ocx - dx * halfLen, ry1 = ocy - dy * halfLen;
        var rx2 = ocx + dx * halfLen, ry2 = ocy + dy * halfLen;
        svg += '<line x1="' + r(rx1) + '" y1="' + r(ry1) + '" x2="' + r(rx2) + '" y2="' + r(ry2)
          + '" stroke="#fff" stroke-width="' + r(rwyW + 2) + '" stroke-linecap="butt"/>';
        svg += '<line x1="' + r(rx1) + '" y1="' + r(ry1) + '" x2="' + r(rx2) + '" y2="' + r(ry2)
          + '" stroke="#555" stroke-width="' + r(rwyW) + '" stroke-linecap="butt"/>';
        svg += '<line x1="' + r(rx1) + '" y1="' + r(ry1) + '" x2="' + r(rx2) + '" y2="' + r(ry2)
          + '" stroke="#ccc" stroke-width="0.5" stroke-dasharray="3,3"/>';
        // Runway designators at each end
        for (var ep = 0; ep < parts.length; ep++) {
          var endName = parts[ep].trim();
          var endM = endName.match(/^(\d{1,2})/);
          if (!endM) continue;
          var ex = ep === 0 ? rx1 : rx2;
          var ey = ep === 0 ? ry1 : ry2;
          var outDir = ep === 0 ? -1 : 1;
          var tx = ex + outDir * dx * 12;
          var ty = ey + outDir * dy * 12;
          var textAngle = hdgDeg;
          if (ep === 1) textAngle = (hdgDeg + 180) % 360;
          if (textAngle > 90 && textAngle < 270) textAngle = (textAngle + 180) % 360;
          svg += '<text x="' + r(tx) + '" y="' + r(ty) + '" font-size="8" fill="#333" stroke="#fff" stroke-width="2.5" paint-order="stroke" font-weight="700" text-anchor="middle" dominant-baseline="central"'
            + ' transform="rotate(' + r(textAngle) + ' ' + r(tx) + ' ' + r(ty) + ')">'
            + esc(endName) + '</text>';
        }
      }
      // Elevation label below the airport
      var elevFt = rwp.data[5];
      if (elevFt) {
        var maxHalf = maxLen * rwyScale / 2;
        svg += '<text x="' + r(rcx) + '" y="' + r(rcy + maxHalf + 20) + '" font-size="8" fill="#555" stroke="#fff" stroke-width="2" paint-order="stroke" font-weight="600" text-anchor="middle">'
          + Math.round(elevFt) + ' ft</text>';
      }
      svg += '</g>';
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
      svg += '<text x="' + r(labelX) + '" y="' + r(cy + 4) + '" font-size="11" fill="#333" stroke="#fff" stroke-width="3" paint-order="stroke" font-weight="700" text-anchor="' + labelAnchor + '">'
        + esc(label) + (isAlt ? ' (ALT)' : '') + '</text>';
    }

    // Wind barbs and cloud symbols from weather overlay
    if (routeWxOverlay.length > 0) {
      // Collect waypoint pixel positions to avoid overlap
      var wpPixels = [];
      for (var i = 0; i < waypoints.length; i++) {
        wpPixels.push({ x: px(waypoints[i].latlng.lng), y: py(waypoints[i].latlng.lat) });
      }
      // Skip every other sample if too many (> 12)
      var step = routeWxOverlay.length > 12 ? 2 : 1;
      var barbSize = 24;
      var cloudR = 5;
      var svgOff = 20; // pixel offset perpendicular to route
      for (var i = 0; i < routeWxOverlay.length; i += step) {
        var ow = routeWxOverlay[i];
        var bx = px(ow.lon);
        var by = py(ow.lat);
        // Offset perpendicular to route (90° to the right in screen coords)
        var brgRad = ((ow.routeBrg || 0)) * Math.PI / 180;
        // Screen Y is inverted (north=up=smaller Y), so perpendicular right = (sin, -cos) rotated
        bx += svgOff * Math.sin(brgRad + Math.PI / 2);
        by -= svgOff * Math.cos(brgRad + Math.PI / 2);
        // Skip if too close to a waypoint dot
        var tooClose = false;
        for (var w = 0; w < wpPixels.length; w++) {
          var dx = bx - wpPixels[w].x, dy = by - wpPixels[w].y;
          if (Math.sqrt(dx * dx + dy * dy) < 18) { tooClose = true; break; }
        }
        if (tooClose) continue;
        // Wind barb (blue for icing)
        var barbCol = ow.icing ? '#2980b9' : undefined;
        svg += '<g transform="translate(' + r(bx) + ',' + r(by) + ')" opacity="0.75">'
          + svgWindBarb(ow.windSpd, ow.windDir, barbSize, barbCol) + '</g>';
        // Cloud circle offset to the right of barb
        if (ow.cloud != null) {
          var cloudOffX = barbSize * 0.55;
          svg += '<g transform="translate(' + r(bx + cloudOffX) + ',' + r(by) + ')" opacity="0.75">'
            + svgCloudCircle(ow.cloud, cloudR) + '</g>';
        }
        // Ice crystal for icing points
        if (ow.icing) {
          var iceX = ow.cloud != null ? bx + cloudOffX + cloudR + 6 : bx + barbSize * 0.55;
          var iceY = by;
          svg += '<g transform="translate(' + r(iceX) + ',' + r(iceY) + ')" opacity="0.8">'
            + '<line x1="0" y1="-5" x2="0" y2="5" stroke="#2980b9" stroke-width="1.3"/>'
            + '<line x1="-5" y1="0" x2="5" y2="0" stroke="#2980b9" stroke-width="1.3"/>'
            + '<line x1="-3.5" y1="-3.5" x2="3.5" y2="3.5" stroke="#2980b9" stroke-width="1"/>'
            + '<line x1="3.5" y1="-3.5" x2="-3.5" y2="3.5" stroke="#2980b9" stroke-width="1"/>'
            + '</g>';
        }
      }
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
      + 'table.freq-table { width: 100%; border-collapse: collapse; font-size: 10px; margin-top: 4px; }'
      + 'table.freq-table th { background: #f0f0f0; font-weight: 700; text-align: left; padding: 2px 6px; border: 1px solid #bbb; }'
      + 'table.freq-table td { padding: 2px 6px; border: 1px solid #ddd; }'
      + 'table.freq-table .freq-phase { width: 36px; font-weight: 700; color: #555; }'
      + 'table.freq-table .freq-loc { width: 100px; font-weight: 700; }'
      + 'table.freq-table .freq-list { color: #333; }'
      + 'tr.freq-acc td { background: #fdf6f0; }'
      + 'tr.freq-ctr td { background: #f0f4fd; }'
      + '.freq-section { page-break-before: auto; }'
      + 'tr.leg-row td { color: #555; font-size: 9px; border-top: none; }'
      + 'tr.wp-row td { border-bottom: none; }'
      + 'tr.alt-sep td { background: #ffe0b2; font-weight: 700; text-align: center; border: 1px solid #bbb; padding: 2px; }'
      + 'tr.alt-row td { background: #fff8f0; }'
      + 'tr.totals-row td { border-top: 2px solid #333; font-weight: 700; }'
      + 'tr.totals-req td { border-top: 1px solid #aaa; }'
      + '.warn { color: #c0392b; font-weight: 700; }'
      + '.wind-adj { font-size: 10px; margin-top: 4px; color: #555; }'
      + '.route-icing-warning { color: #2980b9; font-weight: 700; margin-top: 4px; padding: 4px 6px; background: #d6eaf8; border-radius: 4px; font-size: 10px; line-height: 1.4; }'
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
      // Weather + LLF + NOTAMs: flow together, page break before the group
      + '.wx-section { page-break-before: always; }'
      + '.llf-section, .notam-section { page-break-before: auto; }'
      + '.llf-section { page-break-inside: avoid; }'
      + '.llf-valid { font-size: 9px; color: #666; margin-bottom: 4px; }'
      + '.llf-area-block { margin-bottom: 4px; font-size: 10px; }'
      + '.llf-overview { font-size: 9px; color: #444; margin: 2px 0 4px 12px; font-style: italic; }'
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

    // Lock dep/dest — if alternate is set, destination is the waypoint before it
    var dep = waypoints[0].code;
    var destIdx = (alternateIndex >= 0 && alternateIndex < waypoints.length) ? alternateIndex - 1 : waypoints.length - 1;
    if (destIdx < 1) destIdx = waypoints.length - 1;
    var dest = waypoints[destIdx].code;
    arDepCode = dep;
    arDestCode = dest;
    arDepWp = { latlng: waypoints[0].latlng, data: waypoints[0].data, code: dep, name: waypoints[0].name };
    arDestWp = { latlng: waypoints[destIdx].latlng, data: waypoints[destIdx].data, code: dest, name: waypoints[destIdx].name };
    // Save alternate waypoint to re-append after autoroute
    var savedAlternate = (alternateIndex >= 0 && alternateIndex < waypoints.length) ? {
      latlng: waypoints[alternateIndex].latlng,
      data: waypoints[alternateIndex].data,
      code: waypoints[alternateIndex].code,
      name: waypoints[alternateIndex].name
    } : null;
    arSavedAlternate = savedAlternate;

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
    routeWxOverlay = [];
    if (routeWxMarkers) routeWxMarkers.clearLayers();
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

    // Re-append saved alternate airport
    if (arSavedAlternate) {
      waypoints.push(arSavedAlternate);
      alternateIndex = waypoints.length - 1;
      arSavedAlternate = null;
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
    routeWxMarkers = L.layerGroup().addTo(map);

    // Re-render route on zoom to show/hide runway diagrams
    map.on('zoomend', function () {
      if (routeActive && waypoints.length >= 2) renderRouteOnMap();
    });

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

    // Wx overlay toggle
    var wxShowCb = document.getElementById('route-wx-show');
    if (wxShowCb) {
      wxShowCb.addEventListener('change', function () {
        if (wxShowCb.checked) {
          if (routeWxMarkers && !map.hasLayer(routeWxMarkers)) map.addLayer(routeWxMarkers);
          renderRouteWxOnMap();
        } else {
          if (routeWxMarkers && map.hasLayer(routeWxMarkers)) map.removeLayer(routeWxMarkers);
        }
      });
    }

    var freqShowCb = document.getElementById('route-freq-show');
    if (freqShowCb) {
      freqShowCb.addEventListener('change', function () {
        renderRouteOnMap();
        renderPanel();
      });
    }

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
      if (!source) return;

      if (source._airportData) {
        justAddedFromPopup = true;
        window.AirportApp.justAddedAirport = true;
        setTimeout(function () { justAddedFromPopup = false; window.AirportApp.justAddedAirport = false; }, 50);
        addWaypoint(source.getLatLng(), source._airportData);
        map.closePopup(e.popup);
      } else if (source._waypointData) {
        var wpData = source._waypointData;
        justAddedFromPopup = true;
        window.AirportApp.justAddedAirport = true;
        setTimeout(function () { justAddedFromPopup = false; window.AirportApp.justAddedAirport = false; }, 50);
        addNamedWaypoint(source.getLatLng(), wpData.code, wpData.name);
        map.closePopup(e.popup);
      }
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
        if (waypoints.length > 0) {
          renderPanel();
          renderRouteOnMap();
        }
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
    routeWxOverlay = [];
    if (routeWxMarkers) routeWxMarkers.clearLayers();
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
  window.AirportApp.addNamedWaypoint = addNamedWaypoint;

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
