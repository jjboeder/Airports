/* app.js - Map initialization, country boundaries, layer coordination */

(function () {
  'use strict';

  // Initialize map centered on Europe
  const map = L.map('map', {
    center: [64.0, 26.0],
    zoom: 5,
    minZoom: 3,
    maxZoom: 18
  });

  // OpenStreetMap tile layer
  const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19
  }).addTo(map);

  // Generate a pastel color from a string (country ISO code)
  function countryColor(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const h = Math.abs(hash) % 360;
    return 'hsl(' + h + ', 55%, 80%)';
  }

  // Country boundaries layer
  let countriesLayer = null;

  function styleCountry(feature) {
    const iso = feature.properties.ISO3
      || feature.properties.ISO_A3
      || feature.properties.ISO2
      || feature.properties.NAME
      || '';
    return {
      fillColor: countryColor(iso),
      fillOpacity: 0.25,
      color: '#666',
      weight: 1.5,
      opacity: 0.7
    };
  }

  function highlightCountry(e) {
    const layer = e.target;
    layer.setStyle({
      weight: 3,
      fillOpacity: 0.4,
      opacity: 1
    });
    layer.bringToFront();
  }

  function resetCountryHighlight(e) {
    if (countriesLayer) {
      countriesLayer.resetStyle(e.target);
    }
  }

  function onEachCountry(feature, layer) {
    layer.on({
      mouseover: highlightCountry,
      mouseout: resetCountryHighlight
    });
  }

  // Load Europe GeoJSON
  fetch('data/europe.geojson')
    .then(function (res) {
      if (!res.ok) throw new Error('Failed to load europe.geojson: ' + res.status);
      return res.json();
    })
    .then(function (geojson) {
      countriesLayer = L.geoJSON(geojson, {
        style: styleCountry,
        onEachFeature: onEachCountry
      });

      // After countries load, set up layer control with airport layers
      setupLayerControl();
    })
    .catch(function (err) {
      console.error('Error loading country boundaries:', err);
      // Still set up layer control even without countries
      setupLayerControl();
    });

  // OpenWeatherMap weather tile layers
  var OWM_PROXY = 'https://owm-proxy.jjboeder.workers.dev';
  var OWM_LAYERS = [
    { id: 'wind_new', label: 'Wind' },
    { id: 'clouds_new', label: 'Clouds' },
    { id: 'precipitation_new', label: 'Precipitation' },
    { id: 'pressure_new', label: 'Pressure' },
    { id: 'temp_new', label: 'Temperature' }
  ];

  function createWeatherLayers() {
    var layers = {};
    OWM_LAYERS.forEach(function (l) {
      layers[l.label] = L.tileLayer(
        OWM_PROXY + '/tile/' + l.id + '/{z}/{x}/{y}.png',
        { opacity: 0.85, maxZoom: 18, attribution: '&copy; OpenWeatherMap' }
      );
    });
    return layers;
  }

  // AMA grid: transparent cells with visible borders
  function amaBorderColor(ama) {
    if (ama < 2000) return 'rgba(76, 175, 80, 0.5)';
    if (ama < 5000) return 'rgba(180, 180, 0, 0.5)';
    if (ama < 10000) return 'rgba(200, 120, 0, 0.5)';
    return 'rgba(200, 50, 40, 0.5)';
  }

  // Format AMA label: e.g. 17400 → "174<sup>0</sup>", 2400 → "24<sup>0</sup>"
  function amaLabelHtml(ama) {
    var hundreds = String(Math.round(ama / 100));
    var main = hundreds.slice(0, -1) || '0';
    var last = hundreds.slice(-1);
    return main + '<sup>' + last + '</sup>';
  }

  function loadAMAGrid(layerGroup, obsGroup) {
    fetch('data/ama-grid.json')
      .then(function (res) {
        if (!res.ok) throw new Error('Failed to load ama-grid.json: ' + res.status);
        return res.json();
      })
      .then(function (cells) {
        // Build lookup for AMA values by cell
        var amaIndex = {};
        for (var i = 0; i < cells.length; i++) {
          amaIndex[cells[i][0] + ',' + cells[i][1]] = cells[i][2];
        }
        window._amaIndex = amaIndex;

        for (var i = 0; i < cells.length; i++) {
          var lat = cells[i][0];
          var lon = cells[i][1];
          var ama = cells[i][2];

          // Transparent rectangle with border only
          var bounds = [[lat, lon], [lat + 1, lon + 1]];
          var rect = L.rectangle(bounds, {
            color: amaBorderColor(ama),
            weight: 2,
            fillColor: 'transparent',
            fillOpacity: 0,
            interactive: true
          });
          rect._amaValue = ama;
          rect.on('click', function (e) {
            L.popup({ maxWidth: 200, className: 'ama-popup' })
              .setLatLng(e.latlng)
              .setContent('<div class="ama-popup-content"><strong>AMA:</strong> ' + e.target._amaValue + ' ft</div>')
              .openOn(map);
          });
          rect.addTo(layerGroup);

          // Italic label with superscript hundreds
          L.marker([lat + 0.5, lon + 0.5], {
            icon: L.divIcon({
              className: 'ama-label',
              html: amaLabelHtml(ama),
              iconSize: [44, 20],
              iconAnchor: [22, 10]
            }),
            interactive: false
          }).addTo(layerGroup);
        }

        // Load obstacle markers
        return fetch('data/ama-obstacles.json');
      })
      .then(function (res) {
        if (!res.ok) throw new Error('Failed to load ama-obstacles.json: ' + res.status);
        return res.json();
      })
      .then(function (obstacles) {
        // obstacles: [lat, lon, topFt, heightFt, name]
        for (var i = 0; i < obstacles.length; i++) {
          var o = obstacles[i];
          var tip = o[4] + ' — ' + o[3] + ' ft AGL / ' + o[2] + ' ft AMSL';
          var marker = L.marker([o[0], o[1]], {
            icon: L.divIcon({
              className: 'obs-marker',
              html: '<svg viewBox="0 0 12 24" width="12" height="24"><line x1="6" y1="2" x2="6" y2="24" stroke="#222" stroke-width="2"/><line x1="2" y1="6" x2="10" y2="6" stroke="#222" stroke-width="1.5"/><line x1="3" y1="10" x2="9" y2="10" stroke="#222" stroke-width="1.5"/><line x1="4" y1="14" x2="8" y2="14" stroke="#222" stroke-width="1.5"/><circle cx="6" cy="2" r="2" fill="#222"/></svg>',
              iconSize: [12, 24],
              iconAnchor: [6, 24]
            }),
            interactive: true
          });
          marker.bindTooltip(tip, { direction: 'top', offset: [0, -24] });
          marker.addTo(obsGroup);
        }
        console.log('AMA: loaded ' + obstacles.length + ' obstacle markers');
      })
      .catch(function (err) {
        console.error('Error loading AMA grid:', err);
      });

    // Show/hide and scale labels based on zoom level
    function amaFontSize(zoom) {
      if (zoom <= 5) return 13;
      return Math.round(13 + (zoom - 5) * 3);
    }

    map.on('zoomend', function () {
      var zoom = map.getZoom();
      var fs = amaFontSize(zoom) + 'px';
      layerGroup.eachLayer(function (layer) {
        if (layer instanceof L.Marker) {
          var el = layer.getElement && layer.getElement();
          if (el) {
            el.style.display = zoom >= 5 ? '' : 'none';
            el.style.fontSize = fs;
          }
        }
      });
    });
  }

  function setupLayerControl() {
    const overlays = {};

    if (countriesLayer) {
      overlays['Country boundaries'] = countriesLayer;
    }

    // Add weather overlays
    var weatherLayers = createWeatherLayers();
    var weatherLayerSet = [];
    Object.keys(weatherLayers).forEach(function (name) {
      overlays[name] = weatherLayers[name];
      weatherLayerSet.push(weatherLayers[name]);
    });

    // AMA grid overlay
    var amaLayer = L.layerGroup();
    var obsLayer = L.layerGroup();
    overlays['AMA Grid'] = amaLayer;
    overlays['Obstacles'] = obsLayer;
    loadAMAGrid(amaLayer, obsLayer);

    // Airport layers will be added by airports.js via window.AirportApp
    window.AirportApp = window.AirportApp || {};
    window.AirportApp.map = map;
    window.AirportApp.overlays = overlays;
    window.AirportApp.layerControl = L.control.layers(null, overlays, {
      collapsed: true,
      position: 'topright'
    }).addTo(map);

    // Weather detail popup on map click when a weather layer is active
    setupWeatherPopup(weatherLayerSet);

    // Trigger airport loading
    if (typeof window.AirportApp.loadAirports === 'function') {
      window.AirportApp.loadAirports();
    }
  }

  function setupWeatherPopup(weatherLayerSet) {
    var weatherPopup = L.popup({ maxWidth: 300, className: 'weather-popup' });

    function isAnyWeatherActive() {
      for (var i = 0; i < weatherLayerSet.length; i++) {
        if (map.hasLayer(weatherLayerSet[i])) return true;
      }
      return false;
    }

    function degToDir(deg) {
      var dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
      return dirs[Math.round(deg / 22.5) % 16];
    }

    function msToKts(ms) {
      return Math.round(ms * 1.944);
    }

    function buildWeatherHtml(d, extraRows) {
      var w = d.weather && d.weather[0];
      var icon = w ? 'https://openweathermap.org/img/wn/' + w.icon + '@2x.png' : '';
      var html = '<div class="wx-popup">';
      html += '<div class="wx-header">';
      if (icon) html += '<img src="' + icon + '" class="wx-icon" alt="">';
      html += '<div>';
      html += '<div class="wx-location">' + (d.name || '') + (d.sys && d.sys.country ? ', ' + d.sys.country : '') + '</div>';
      if (w) html += '<div class="wx-desc">' + w.description + '</div>';
      html += '</div></div>';
      html += '<div class="wx-details">';
      if (d.main) {
        html += '<div class="wx-row"><span class="wx-label">Temp</span><span>' + Math.round(d.main.temp) + ' °C (feels ' + Math.round(d.main.feels_like) + ' °C)</span></div>';
        html += '<div class="wx-row"><span class="wx-label">Humidity</span><span>' + d.main.humidity + '%</span></div>';
        html += '<div class="wx-row"><span class="wx-label">Pressure</span><span>' + d.main.pressure + ' hPa</span></div>';
      }
      if (d.wind) {
        var windStr = msToKts(d.wind.speed) + ' kts';
        if (d.wind.deg != null) windStr += ' from ' + degToDir(d.wind.deg) + ' (' + d.wind.deg + '°)';
        if (d.wind.gust) windStr += ', gusts ' + msToKts(d.wind.gust) + ' kts';
        html += '<div class="wx-row"><span class="wx-label">Wind</span><span>' + windStr + '</span></div>';
      }
      if (d.visibility != null) {
        var vis = d.visibility >= 10000 ? '10+ km' : (d.visibility / 1000).toFixed(1) + ' km';
        html += '<div class="wx-row"><span class="wx-label">Visibility</span><span>' + vis + '</span></div>';
      }
      if (d.clouds) {
        html += '<div class="wx-row"><span class="wx-label">Clouds</span><span>' + d.clouds.all + '%</span></div>';
      }
      if (extraRows) html += extraRows;
      html += '</div></div>';
      return html;
    }

    function amaHtml(lat, lon) {
      var idx = window._amaIndex;
      if (!idx) return '';
      var key = Math.floor(lat) + ',' + Math.floor(lon);
      var val = idx[key];
      if (val == null) return '';
      return '<div class="wx-row"><span class="wx-label">AMA</span><span style="font-style:italic;font-weight:600;">' + val + ' ft</span></div>';
    }

    map.on('click', function (e) {

      var lat = e.latlng.lat.toFixed(4);
      var lon = e.latlng.lng.toFixed(4);
      var amaRow = amaHtml(e.latlng.lat, e.latlng.lng);

      weatherPopup
        .setLatLng(e.latlng)
        .setContent('<div class="wx-popup"><span class="metar-loading">Loading weather...</span>' + amaRow + '</div>')
        .openOn(map);

      fetch(OWM_PROXY + '/weather?lat=' + lat + '&lon=' + lon)
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (data.cod !== 200) {
            weatherPopup.setContent('<div class="wx-popup">Weather data unavailable' + amaRow + '</div>');
            return;
          }
          weatherPopup.setContent(buildWeatherHtml(data, amaRow));
        })
        .catch(function () {
          weatherPopup.setContent('<div class="wx-popup">Failed to load weather' + amaRow + '</div>');
        });
    });
  }

  // Expose map for other modules
  window.AirportApp = window.AirportApp || {};
  window.AirportApp.map = map;

  // --- Settings persistence (localStorage) ---
  var STORAGE_KEY = 'airports-panel-settings';
  var PERSIST_IDS = [
    'range-fuel', 'range-power', 'route-fl',
    'wb-empty-wt', 'wb-empty-cg', 'wb-deice',
    'wb-front-l', 'wb-front-r', 'wb-row1-l', 'wb-row1-r',
    'wb-nose-rh', 'wb-nose-lh', 'wb-tail-a', 'wb-tail-b', 'wb-tail-c', 'wb-tail-d'
  ];

  function saveSettings() {
    var data = gatherAll();
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) {}
  }

  function restoreSettings() {
    var data;
    try { data = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch (e) {}
    if (!data) return;
    applyAll(data);
  }

  // Auto-save on any input/change in the panel
  var panel = document.getElementById('da62-panel');
  if (panel) {
    panel.addEventListener('input', saveSettings);
    panel.addEventListener('change', saveSettings);
  }

  // Timestamp for filenames: YYYYMMDDHHMMZ
  function fileTimestamp() {
    var d = new Date();
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    return '' + d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate())
      + pad(d.getUTCHours()) + pad(d.getUTCMinutes());
  }

  // Gather all settings + route into one object
  function gatherAll() {
    var data = {};
    for (var i = 0; i < PERSIST_IDS.length; i++) {
      var el = document.getElementById(PERSIST_IDS[i]);
      if (!el) continue;
      data[PERSIST_IDS[i]] = el.tagName === 'SELECT' ? el.selectedIndex : el.value;
    }
    var app = window.AirportApp;
    if (app.getRouteState) {
      var route = app.getRouteState();
      if (route) data.route = route;
    }
    return data;
  }

  // Apply settings + route from an object
  function applyAll(data) {
    var changed = [];
    for (var i = 0; i < PERSIST_IDS.length; i++) {
      var id = PERSIST_IDS[i];
      if (data[id] == null) continue;
      var el = document.getElementById(id);
      if (!el) continue;
      if (el.tagName === 'SELECT') {
        if (data[id] < el.options.length) el.selectedIndex = data[id];
      } else {
        el.value = data[id];
      }
      changed.push(el);
    }
    for (var i = 0; i < changed.length; i++) {
      changed[i].dispatchEvent(new Event('input', { bubbles: true }));
      if (changed[i].tagName === 'SELECT') {
        changed[i].dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    // Restore route
    var app = window.AirportApp;
    if (data.route && app.loadRoute) {
      app.loadRoute(data.route);
    }
  }

  // Save settings to file
  function exportSettings() {
    var data = gatherAll();
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'plan-' + fileTimestamp() + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // Load settings from file
  function importSettings(file) {
    var reader = new FileReader();
    reader.onload = function (e) {
      var data;
      try { data = JSON.parse(e.target.result); } catch (err) { return; }
      applyAll(data);
    };
    reader.readAsText(file);
  }

  // Wire up save/load buttons
  var saveBtn = document.getElementById('settings-save');
  var loadBtn = document.getElementById('settings-load');
  var fileInput = document.getElementById('settings-file');
  if (saveBtn) saveBtn.addEventListener('click', exportSettings);
  if (loadBtn) loadBtn.addEventListener('click', function () { fileInput.click(); });
  if (fileInput) fileInput.addEventListener('change', function () {
    if (fileInput.files.length > 0) {
      importSettings(fileInput.files[0]);
      fileInput.value = '';
    }
  });

  // Restore after all modules have initialized (select options populated, etc.)
  setTimeout(restoreSettings, 500);

  // --- Airport search ---
  var searchInput = document.getElementById('search-input');
  var searchResults = document.getElementById('search-results');
  var searchTimer = null;

  // Type priority for sorting (lower = better)
  var TYPE_RANK = { large_airport: 0, medium_airport: 1, small_airport: 2 };

  function doSearch(query) {
    searchResults.innerHTML = '';
    searchResults.classList.remove('visible');
    if (!query || query.length < 2) return;

    var app = window.AirportApp;
    var data = app.airportData;
    var COL = app.COL;
    if (!data || !COL) return;

    var q = query.toLowerCase();
    var results = [];

    for (var i = 0; i < data.length; i++) {
      var row = data[i];
      var icao = (row[COL.gps_code] || row[COL.ident] || '').toLowerCase();
      var iata = (row[COL.iata] || '').toLowerCase();
      var name = (row[COL.name] || '').toLowerCase();
      var city = (row[COL.municipality] || '').toLowerCase();
      var code = row[COL.gps_code] || row[COL.ident] || '';

      // Skip if no marker exists for this airport
      if (!app.markersByIcao || !app.markersByIcao[code]) continue;

      var priority = 99;
      if (icao.indexOf(q) === 0) priority = 0;          // ICAO prefix
      else if (iata && iata.indexOf(q) === 0) priority = 1; // IATA prefix
      else if (name.indexOf(q) >= 0) priority = 2;      // Name substring
      else if (city.indexOf(q) >= 0) priority = 3;       // City substring
      else continue;

      var typeRank = TYPE_RANK[row[COL.type]] != null ? TYPE_RANK[row[COL.type]] : 9;
      results.push({ row: row, code: code, priority: priority, typeRank: typeRank });
    }

    // Sort: match priority first, then type rank
    results.sort(function (a, b) {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.typeRank - b.typeRank;
    });

    // Limit to 8
    results = results.slice(0, 8);

    if (results.length === 0) return;

    for (var j = 0; j < results.length; j++) {
      var r = results[j];
      var row = r.row;
      var iataStr = row[COL.iata] ? ' / ' + row[COL.iata] : '';
      var div = document.createElement('div');
      div.className = 'search-item';
      div.setAttribute('data-code', r.code);
      div.innerHTML = '<span class="search-item-code">' + r.code + '</span>'
        + '<div class="search-item-info">'
        + '<div class="search-item-name">' + (row[COL.name] || '') + '</div>'
        + '<div class="search-item-city">' + (row[COL.municipality] || '') + iataStr + '</div>'
        + '</div>';
      searchResults.appendChild(div);
    }
    searchResults.classList.add('visible');
  }

  function selectResult(code) {
    var app = window.AirportApp;
    var marker = app.markersByIcao && app.markersByIcao[code];
    if (!marker) return;
    map.setView(marker.getLatLng(), 10);
    marker.openPopup();
    searchInput.value = '';
    searchResults.innerHTML = '';
    searchResults.classList.remove('visible');
    searchInput.blur();
  }

  if (searchInput && searchResults) {
    searchInput.addEventListener('input', function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        doSearch(searchInput.value.trim());
      }, 150);
    });

    searchResults.addEventListener('click', function (e) {
      var item = e.target.closest('.search-item');
      if (item) selectResult(item.getAttribute('data-code'));
    });

    searchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        searchInput.value = '';
        searchResults.innerHTML = '';
        searchResults.classList.remove('visible');
        searchInput.blur();
      } else if (e.key === 'Enter') {
        var active = searchResults.querySelector('.search-item.active');
        var target = active || searchResults.querySelector('.search-item');
        if (target) {
          e.preventDefault();
          selectResult(target.getAttribute('data-code'));
        }
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        var items = searchResults.querySelectorAll('.search-item');
        if (items.length === 0) return;
        var active = searchResults.querySelector('.search-item.active');
        var idx = -1;
        for (var i = 0; i < items.length; i++) {
          if (items[i] === active) { idx = i; break; }
        }
        if (active) active.classList.remove('active');
        if (e.key === 'ArrowDown') idx = (idx + 1) % items.length;
        else idx = idx <= 0 ? items.length - 1 : idx - 1;
        items[idx].classList.add('active');
        items[idx].scrollIntoView({ block: 'nearest' });
      }
    });

    // Click outside closes results
    document.addEventListener('click', function (e) {
      if (!e.target.closest('#airport-search')) {
        searchResults.classList.remove('visible');
      }
    });

    // Re-show results when focusing back if there's text
    searchInput.addEventListener('focus', function () {
      if (searchInput.value.trim().length >= 2 && searchResults.children.length > 0) {
        searchResults.classList.add('visible');
      }
    });
  }
})();
