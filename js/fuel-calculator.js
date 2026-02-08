/* fuel-calculator.js - DA62 range circle calculator */

(function () {
  'use strict';

  var DA62_PROFILES = [
    { label: '45% — 140 kts, 8.4 gal/hr', burn: 8.4, tas: 140 },
    { label: '55% — 152 kts, 10.0 gal/hr', burn: 10.0, tas: 152 },
    { label: '65% — 163 kts, 12.0 gal/hr', burn: 12.0, tas: 163 },
    { label: '75% — 172 kts, 14.0 gal/hr', burn: 14.0, tas: 172 },
    { label: '85% — 183 kts, 16.5 gal/hr', burn: 16.5, tas: 183 },
    { label: '95% — 195 kts, 18.8 gal/hr', burn: 18.8, tas: 195 }
  ];

  var MAX_FUEL = 86;
  var NM_TO_METERS = 1852;
  var RESERVE_HOURS = 0.75; // 45-min IFR reserve

  var map = null;
  var marker = null;
  var circleGroup = null;
  var fuelInput = null;
  var powerSelect = null;
  var summaryDiv = null;
  var showToggle = null;

  function isEnabled() {
    return showToggle && showToggle.checked;
  }

  function getProfile() {
    return DA62_PROFILES[powerSelect.selectedIndex];
  }

  function calcRange(fuel, profile) {
    var maxHours = fuel / profile.burn;
    var maxRange = maxHours * profile.tas;
    var reserveFuel = profile.burn * RESERVE_HOURS;
    var safeFuel = Math.max(fuel - reserveFuel, 0);
    var safeHours = safeFuel / profile.burn;
    var safeRange = safeHours * profile.tas;
    return { maxRange: maxRange, safeRange: safeRange, maxHours: maxHours, safeHours: safeHours };
  }

  function formatTime(hours) {
    var h = Math.floor(hours);
    var m = Math.round((hours - h) * 60);
    if (m === 60) { h++; m = 0; }
    return h + ':' + (m < 10 ? '0' : '') + m;
  }

  function updateCircles() {
    if (!marker || !isEnabled()) {
      circleGroup.clearLayers();
      summaryDiv.textContent = '';
      return;
    }

    var fuel = parseFloat(fuelInput.value);
    if (isNaN(fuel) || fuel <= 0) {
      circleGroup.clearLayers();
      summaryDiv.textContent = '';
      return;
    }

    var profile = getProfile();
    var result = calcRange(fuel, profile);

    circleGroup.clearLayers();

    var latlng = marker.getLatLng();

    // Max range circle (red dashed)
    L.circle(latlng, {
      radius: result.maxRange * NM_TO_METERS,
      color: '#e74c3c',
      dashArray: '8,6',
      weight: 2,
      fillOpacity: 0.05,
      interactive: false
    }).addTo(circleGroup);

    // Safe range circle (green solid)
    L.circle(latlng, {
      radius: result.safeRange * NM_TO_METERS,
      color: '#27ae60',
      weight: 2,
      fillOpacity: 0.08,
      interactive: false
    }).addTo(circleGroup);

    summaryDiv.innerHTML =
      '<span class="range-max">Max: ' + Math.round(result.maxRange) + ' nm · ' + formatTime(result.maxHours) + '</span>' +
      '<span class="range-safe">Reserve: ' + Math.round(result.safeRange) + ' nm · ' + formatTime(result.safeHours) + '</span>';
  }

  function placeMarker(latlng) {
    if (!isEnabled()) return;

    if (marker) {
      marker.setLatLng(latlng);
    } else {
      marker = L.marker(latlng, {
        draggable: true,
        title: 'DA62 departure'
      }).addTo(map);

      marker.on('dragend', updateCircles);
    }
    updateCircles();
  }

  function clearAll() {
    if (marker) {
      map.removeLayer(marker);
      marker = null;
    }
    circleGroup.clearLayers();
    summaryDiv.textContent = '';
  }

  function onToggleChange() {
    if (isEnabled()) {
      updateCircles();
    } else {
      circleGroup.clearLayers();
      summaryDiv.textContent = '';
    }
  }

  function setupRangeControl() {
    map = window.AirportApp.map;
    if (!map) return;

    fuelInput = document.getElementById('range-fuel');
    powerSelect = document.getElementById('range-power');
    summaryDiv = document.getElementById('range-summary');
    showToggle = document.getElementById('range-toggle');
    var clearBtn = document.getElementById('range-clear');

    // Populate power select
    DA62_PROFILES.forEach(function (p, i) {
      var opt = document.createElement('option');
      opt.value = i;
      opt.textContent = p.label;
      if (i === 2) opt.selected = true; // Default 65%
      powerSelect.appendChild(opt);
    });

    circleGroup = L.layerGroup().addTo(map);

    // Map click handler
    map.on('click', function (e) {
      placeMarker(e.latlng);
    });

    // Input change handlers
    fuelInput.addEventListener('input', updateCircles);
    powerSelect.addEventListener('change', updateCircles);
    showToggle.addEventListener('change', onToggleChange);
    clearBtn.addEventListener('click', clearAll);

    // Expose setRangeOrigin for airport clicks
    window.AirportApp.setRangeOrigin = function (latlng) {
      placeMarker(latlng);
    };

    // Expose shared utilities for route planner
    window.AirportApp.DA62_PROFILES = DA62_PROFILES;
    window.AirportApp.formatTime = formatTime;
    window.AirportApp.RESERVE_HOURS = RESERVE_HOURS;
  }

  // Initialize when DOM and map are ready
  function init() {
    if (window.AirportApp && window.AirportApp.map) {
      setupRangeControl();
    } else {
      // Wait for map to be available
      var check = setInterval(function () {
        if (window.AirportApp && window.AirportApp.map) {
          clearInterval(check);
          setupRangeControl();
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
