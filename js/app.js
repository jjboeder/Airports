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
  var OWM_KEY = 'b7d9de6ecdcc4269c7aa4b4b1d3e8608';
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
        'https://tile.openweathermap.org/map/' + l.id + '/{z}/{x}/{y}.png?appid=' + OWM_KEY,
        { opacity: 0.85, maxZoom: 18, attribution: '&copy; OpenWeatherMap' }
      );
    });
    return layers;
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

    function buildWeatherHtml(d) {
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
      html += '</div></div>';
      return html;
    }

    map.on('click', function (e) {

      var lat = e.latlng.lat.toFixed(4);
      var lon = e.latlng.lng.toFixed(4);

      weatherPopup
        .setLatLng(e.latlng)
        .setContent('<div class="wx-popup"><span class="metar-loading">Loading weather...</span></div>')
        .openOn(map);

      fetch('https://api.openweathermap.org/data/2.5/weather?lat=' + lat + '&lon=' + lon + '&appid=' + OWM_KEY + '&units=metric')
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (data.cod !== 200) {
            weatherPopup.setContent('<div class="wx-popup">Weather data unavailable</div>');
            return;
          }
          weatherPopup.setContent(buildWeatherHtml(data));
        })
        .catch(function () {
          weatherPopup.setContent('<div class="wx-popup">Failed to load weather</div>');
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
    'wb-nose-rh', 'wb-nose-lh', 'wb-tail-a', 'wb-tail-bcd'
  ];

  function saveSettings() {
    var data = {};
    for (var i = 0; i < PERSIST_IDS.length; i++) {
      var el = document.getElementById(PERSIST_IDS[i]);
      if (!el) continue;
      data[PERSIST_IDS[i]] = el.tagName === 'SELECT' ? el.selectedIndex : el.value;
    }
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) {}
  }

  function restoreSettings() {
    var data;
    try { data = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch (e) {}
    if (!data) return;
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
    // Dispatch events so recalculations fire
    for (var i = 0; i < changed.length; i++) {
      changed[i].dispatchEvent(new Event('input', { bubbles: true }));
      if (changed[i].tagName === 'SELECT') {
        changed[i].dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  }

  // Auto-save on any input/change in the panel
  var panel = document.getElementById('da62-panel');
  if (panel) {
    panel.addEventListener('input', saveSettings);
    panel.addEventListener('change', saveSettings);
  }

  // Restore after all modules have initialized (select options populated, etc.)
  setTimeout(restoreSettings, 500);
})();
