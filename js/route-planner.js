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
  var routeLayerGroup = null;
  var map = null;
  var routeWxCache = {}; // icao → taf json, local to route planner
  var wxRefreshTimer = null;
  var WX_REFRESH_INTERVAL = 10 * 60 * 1000; // 10 minutes

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

    fetch(app.METAR_API + '?id=' + encodeURIComponent(icao))
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

  function fetchRouteWeather() {
    if (waypoints.length === 0) return;

    var app = window.AirportApp;
    var TAF_API = app.TAF_API;
    if (!TAF_API) return;

    // Fetch METAR for departure airport
    fetchDepMetar();

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
        var url = TAF_API + '?ids=' + encodeURIComponent(icao) + '&format=json';
        app.fetchWithProxyFallback(url)
          .then(function (res) { return res.json(); })
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

  function addWaypoint(latlng, airportData) {
    var code = getCode(airportData);
    // Prevent adding the same airport consecutively
    if (waypoints.length > 0 && waypoints[waypoints.length - 1].code === code) return;

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
    routeLayerGroup.clearLayers();
    renderPanel();
    updateButtons();
    stopWxRefresh();
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

    // Numbered waypoint markers
    for (var i = 0; i < waypoints.length; i++) {
      var isAlt = (i === alternateIndex);
      var markerClass = isAlt ? 'route-number-marker route-number-marker-alt' : 'route-number-marker';
      var icon = L.divIcon({
        className: markerClass,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
        html: '' + (i + 1)
      });
      L.marker(waypoints[i].latlng, { icon: icon, interactive: false }).addTo(routeLayerGroup);
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
      html += '<span class="route-wp-name"><span class="route-wp-code">' + escapeHtml(wp.code) + '</span>';

      // Weather badge: use METAR for departure, TAF for en-route
      if (depEpoch && i < cumTime.length) {
        var arrEpoch = depEpoch + cumTime[i] * 3600;
        var wxCat = null;
        var wxStrongWind = false;
        if (i === 0 && app.metarCache && app.metarCache[wp.code]) {
          var metar = app.metarCache[wp.code];
          wxCat = metar.fltCat;
          if (app.isStrongWind) wxStrongWind = app.isStrongWind(metar.wspd, metar.wgst);
        }
        if (!wxCat) {
          var wpWx = getWpWeather(wp.code, arrEpoch);
          if (wpWx) {
            wxCat = wpWx.cat;
            wxStrongWind = wpWx.strongWind;
          }
        }
        if (wxCat) {
          var catCfg = METAR_CAT[wxCat] || { color: '#888' };
          var letter = METAR_LETTER[wxCat] || '?';
          html += ' <span class="route-wp-wx" style="background:' + catCfg.color + ';">' + letter + '</span>';
          if (wxStrongWind) {
            html += '<span class="wind-badge">' + (app.WIND_SVG || 'W') + '</span>';
          }
        } else {
          html += ' <span class="route-wp-wx route-wp-wx-none">-</span>';
        }
      }

      html += '  ' + escapeHtml(wp.name) + '</span>';
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

      // GRAMET link (when 2+ waypoints)
      if (waypoints.length >= 2 && depEpoch) {
        var icaoStr = waypoints.map(function (wp) { return wp.code; }).join('_');
        var totalFlightHours = cumTime[cumTime.length - 1] || 1;
        var hfin = Math.ceil(totalFlightHours);
        if (hfin < 1) hfin = 1;
        var fl = getFL();
        var grametUrl = 'https://www.ogimet.com/display_gramet.php?lang=en'
          + '&icao=' + encodeURIComponent(icaoStr)
          + '&hini=0'
          + '&tref=' + depEpoch
          + '&hfin=' + hfin
          + '&fl=' + fl
          + '&enviar=Enviar';
        thtml += '<div><a href="' + escapeHtml(grametUrl) + '" target="_blank" rel="noopener" class="route-gramet-link">GRAMET</a></div>';
      }

      totalsDiv.innerHTML = thtml;
    } else {
      totalsDiv.innerHTML = '';
    }
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
    map.on('popupopen', function (e) {
      if (!routeActive) return;
      var source = e.popup._source;
      if (!source || !source._airportData) return;
      addWaypoint(source.getLatLng(), source._airportData);
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
