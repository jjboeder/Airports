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

  // Basemap tile layers
  var osmAttr = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
  var basemaps = {
    'Light': L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution: osmAttr + ' &copy; <a href="https://carto.com/">CARTO</a>', maxZoom: 20, subdomains: 'abcd'
    }),
    'Dark': L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: osmAttr + ' &copy; <a href="https://carto.com/">CARTO</a>', maxZoom: 20, subdomains: 'abcd'
    }),
    'OpenStreetMap': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: osmAttr, maxZoom: 19
    }),
    'Topo': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      attribution: osmAttr + ' &copy; <a href="https://opentopomap.org">OpenTopoMap</a>', maxZoom: 17
    }),
    'Satellite': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: '&copy; Esri', maxZoom: 19
    }),
    'Stadia Smooth': L.tileLayer('https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png', {
      attribution: osmAttr + ' &copy; <a href="https://stadiamaps.com/">Stadia</a>', maxZoom: 20
    })
  };
  basemaps['Light'].addTo(map);

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
      fillColor: 'transparent',
      fillOpacity: 0,
      color: '#666',
      weight: 1.5,
      opacity: 0.7
    };
  }

  function highlightCountry(e) {
    const layer = e.target;
    layer.setStyle({
      weight: 3,
      fillOpacity: 0,
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

  // OpenWeatherMap weather tile layers (all 2.0 API with time support)
  var OWM_PROXY = 'https://owm-proxy.jjboeder.workers.dev';
  // OWM 1.0 layers (free tier)
  var OWM_LAYERS = [
    { id: 'wind_new', label: 'Wind' },
    { id: 'clouds_new', label: 'Clouds' },
    { id: 'precipitation_new', label: 'Precipitation' },
    { id: 'pressure_new', label: 'Pressure' },
    { id: 'temp_new', label: 'Temperature' }
  ];

  var wxActiveLayerGroups = [];

  function createWeatherLayers() {
    var layers = {};
    OWM_LAYERS.forEach(function (l) {
      var url = OWM_PROXY + '/tile/' + l.id + '/{z}/{x}/{y}.png';
      var tileLayer = L.tileLayer(url, { opacity: 1.0, maxZoom: 18, attribution: '&copy; OpenWeatherMap' });
      var group = L.layerGroup([tileLayer]);
      layers[l.label] = group;
      wxActiveLayerGroups.push(group);
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

  // --- SIGMET overlay ---
  var SIGMET_COLORS = {
    TS: '#e74c3c',
    CONVECTIVE: '#e74c3c',
    TURB: '#e67e22',
    ICE: '#2980b9',
    VA: '#8e44ad',
    MTW: '#795548',
    DEFAULT: '#888'
  };

  function sigmetColor(hazard) {
    if (!hazard) return SIGMET_COLORS.DEFAULT;
    var h = hazard.toUpperCase();
    return SIGMET_COLORS[h] || SIGMET_COLORS.DEFAULT;
  }

  function sigmetPopupHtml(props) {
    var hazard = props.hazard || 'Unknown';
    var qualifier = props.qualifier ? ' (' + props.qualifier + ')' : '';
    var color = sigmetColor(hazard);

    var html = '<div class="sigmet-popup">';
    html += '<span class="sigmet-hazard-badge" style="background:' + color + ';">' + hazard + qualifier + '</span>';

    if (props.base != null || props.top != null) {
      var base = props.base != null ? 'FL' + Math.round(props.base / 100) : 'SFC';
      var top = props.top != null ? 'FL' + Math.round(props.top / 100) : '???';
      html += '<div class="sigmet-alt">' + base + ' \u2013 ' + top + '</div>';
    }

    if (props.validTimeFrom || props.validTimeTo) {
      var from = props.validTimeFrom ? new Date(props.validTimeFrom).toISOString().slice(11, 16) + 'Z' : '?';
      var to = props.validTimeTo ? new Date(props.validTimeTo).toISOString().slice(11, 16) + 'Z' : '?';
      html += '<div class="sigmet-valid">Valid ' + from + ' \u2013 ' + to + '</div>';
    }

    if (props.firName) {
      html += '<div class="sigmet-fir">FIR: ' + props.firName + '</div>';
    }

    if (props.rawSigmet) {
      html += '<pre class="sigmet-raw">' + props.rawSigmet + '</pre>';
    }

    html += '</div>';
    return html;
  }

  function setupSigmetLayer(layerGroup) {
    function loadSigmets() {
      fetch(OWM_PROXY + '/sigmet')
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(function (geojson) {
          layerGroup.clearLayers();
          if (!geojson || !geojson.features) return;

          var now = Date.now();

          L.geoJSON(geojson, {
            filter: function (feature) {
              var p = feature.properties || {};
              // Filter to currently valid
              if (p.validTimeTo && new Date(p.validTimeTo).getTime() < now) return false;
              // Filter to European bbox (lat 30-72, lon -25 to 45)
              var geom = feature.geometry;
              if (!geom || !geom.coordinates) return false;
              var coords = JSON.stringify(geom.coordinates);
              // Quick bbox check: extract all numbers and check if any lon/lat falls in Europe
              // For polygons, check the first coordinate pair
              try {
                var ring = geom.type === 'Polygon' ? geom.coordinates[0] : (geom.type === 'MultiPolygon' ? geom.coordinates[0][0] : null);
                if (!ring) return false;
                var inEurope = false;
                for (var i = 0; i < ring.length; i++) {
                  var lon = ring[i][0], lat = ring[i][1];
                  if (lat >= 30 && lat <= 72 && lon >= -25 && lon <= 45) {
                    inEurope = true;
                    break;
                  }
                }
                return inEurope;
              } catch (e) { return false; }
            },
            style: function (feature) {
              var color = sigmetColor(feature.properties && feature.properties.hazard);
              return {
                color: color,
                weight: 2,
                opacity: 0.8,
                fillColor: color,
                fillOpacity: 0.2
              };
            },
            onEachFeature: function (feature, layer) {
              layer.bindPopup(sigmetPopupHtml(feature.properties || {}), {
                maxWidth: 500,
                minWidth: 360,
                className: 'sigmet-popup-wrapper'
              });
            }
          }).addTo(layerGroup);
        })
        .catch(function (err) {
          console.error('SIGMET load error:', err);
        });
    }

    loadSigmets();
    setInterval(loadSigmets, 300000); // refresh every 5 minutes
  }

  // --- Airspace R/D/P overlay ---
  var AIRSPACE_TYPES = {
    1: { label: 'Restricted', color: '#e74c3c', shortLabel: 'R' },
    2: { label: 'Danger', color: '#e67e22', shortLabel: 'D' },
    3: { label: 'Prohibited', color: '#8b0000', shortLabel: 'P' }
  };

  var DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  // OpenAIP dayOfWeek: 0=Mon..6=Sun; JS getUTCDay(): 0=Sun..6=Sat
  function jsToOpenaipDay(jsDay) {
    return (jsDay + 6) % 7;
  }

  // Classify airspace activation: 'active' | 'potential' | false
  //  - 'active': confirmed active now (specific hours match, or Prohibited)
  //  - 'potential': H24/unknown schedule, could be active (shown faintly)
  //  - false: definitely inactive (outside validity, or today not in schedule)
  function classifyAirspaceActivation(item) {
    // Prohibited areas are always active
    if (item.type === 3) return 'active';

    var now = new Date();

    // Outside validity period → definitely inactive
    if (item.activeUntil && new Date(item.activeUntil).getTime() < now.getTime()) return false;
    if (item.activeFrom && new Date(item.activeFrom).getTime() > now.getTime()) return false;

    var hrs = item.hoursOfOperation && item.hoursOfOperation.operatingHours;
    if (!hrs || hrs.length === 0) return 'potential'; // no schedule data

    var todayOA = jsToOpenaipDay(now.getUTCDay());
    var nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();

    // Find entries for today
    var todayEntries = hrs.filter(function (h) { return h.dayOfWeek === todayOA; });
    if (todayEntries.length === 0) return false; // no entry for today

    var hasH24 = false;
    for (var i = 0; i < todayEntries.length; i++) {
      var h = todayEntries[i];
      var startParts = (h.startTime || '00:00').split(':');
      var endParts = (h.endTime || '00:00').split(':');
      var startMin = parseInt(startParts[0], 10) * 60 + parseInt(startParts[1], 10);
      var endMin = parseInt(endParts[0], 10) * 60 + parseInt(endParts[1], 10);

      if (startMin === 0 && endMin === 0) {
        hasH24 = true; // H24 = potentially active, not confirmed
      } else if (nowMinutes >= startMin && nowMinutes < endMin) {
        return 'active'; // specific hours and we're within them
      }
    }

    return hasH24 ? 'potential' : false;
  }

  // Format operating hours for today for the popup
  function formatTodayHours(item) {
    var hrs = item.hoursOfOperation && item.hoursOfOperation.operatingHours;
    if (!hrs || hrs.length === 0) return 'Hours unknown';

    var now = new Date();
    var todayOA = jsToOpenaipDay(now.getUTCDay());
    var todayEntries = hrs.filter(function (h) { return h.dayOfWeek === todayOA; });

    if (todayEntries.length === 0) return 'Inactive today (' + DAY_NAMES[todayOA] + ')';

    var times = todayEntries.map(function (h) {
      var st = h.startTime || '00:00';
      var et = h.endTime || '00:00';
      if (st === '00:00' && et === '00:00') return 'H24';
      return st + '\u2013' + et + ' UTC';
    });

    return DAY_NAMES[todayOA] + ': ' + times.join(', ');
  }

  // Build a compact weekly schedule string
  function formatWeeklySchedule(item) {
    var hrs = item.hoursOfOperation && item.hoursOfOperation.operatingHours;
    if (!hrs || hrs.length === 0) return '';

    // Group by time window
    var daysByTime = {};
    for (var i = 0; i < hrs.length; i++) {
      var h = hrs[i];
      var st = h.startTime || '00:00';
      var et = h.endTime || '00:00';
      var key = (st === '00:00' && et === '00:00') ? 'H24' : st + '\u2013' + et;
      if (!daysByTime[key]) daysByTime[key] = [];
      daysByTime[key].push(h.dayOfWeek);
    }

    var keys = Object.keys(daysByTime);
    // If all 7 days with same time → simplify
    if (keys.length === 1 && daysByTime[keys[0]].length === 7) {
      return keys[0] === 'H24' ? 'H24' : 'Daily ' + keys[0] + ' UTC';
    }

    var parts = [];
    keys.forEach(function (k) {
      var days = daysByTime[k].sort();
      var dayStr = days.map(function (d) { return DAY_NAMES[d]; }).join(',');
      parts.push(dayStr + ' ' + k);
    });
    return parts.join('; ');
  }

  function formatAirspaceLimit(limit) {
    if (!limit) return '?';
    var val = limit.value;
    var unit = limit.unit; // 0=Meter, 1=Feet, 6=FL
    var ref = limit.referenceDatum; // 0=GND, 1=MSL, 2=STD
    if (unit === 6) return 'FL' + val;
    if (ref === 0 && val === 0) return 'GND';
    var ft = unit === 0 ? Math.round(val * 3.281) : val;
    var refStr = ref === 0 ? ' AGL' : ref === 1 ? ' AMSL' : '';
    return ft + ' ft' + refStr;
  }

  function formatUtcDate(iso) {
    if (!iso) return '?';
    var d = new Date(iso);
    var dd = String(d.getUTCDate()).padStart(2, '0');
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return dd + ' ' + months[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }

  function airspacePopupHtml(item) {
    var typeInfo = AIRSPACE_TYPES[item.type] || { label: 'Airspace', color: '#888', shortLabel: '?' };
    var html = '<div class="airspace-popup">';
    html += '<span class="airspace-type-badge" style="background:' + typeInfo.color + ';">' + typeInfo.label + '</span>';
    var notam = item._activatingNotam;
    var activation = classifyAirspaceActivation(item);
    if (notam) activation = 'active';
    if (activation === 'active') {
      html += ' <span class="airspace-status-badge airspace-status-active">ACTIVE</span>';
    } else {
      html += ' <span class="airspace-status-badge airspace-status-potential">POTENTIALLY ACTIVE</span>';
    }
    if (item.byNotam) {
      html += ' <span class="airspace-bynotam-badge">BY NOTAM</span>';
    }
    html += '<div class="airspace-name">' + (item.name || 'Unknown') + '</div>';

    // Country
    if (item.country) {
      html += '<div class="airspace-country">' + item.country + '</div>';
    }

    // Vertical limits
    var lower = formatAirspaceLimit(item.lowerLimit);
    var upper = formatAirspaceLimit(item.upperLimit);
    html += '<div class="airspace-limits">' + lower + ' \u2013 ' + upper + '</div>';

    // Validity period
    if (item.activeFrom || item.activeUntil) {
      var from = formatUtcDate(item.activeFrom);
      var until = formatUtcDate(item.activeUntil);
      html += '<div class="airspace-validity">Valid: ' + from + ' \u2013 ' + until + '</div>';
    }

    // Today's hours
    var todayStr = formatTodayHours(item);
    html += '<div class="airspace-hours-today">' + todayStr + '</div>';

    // Full weekly schedule
    var weeklyStr = formatWeeklySchedule(item);
    if (weeklyStr && weeklyStr !== todayStr) {
      html += '<div class="airspace-hours-weekly">' + weeklyStr + '</div>';
    }

    // Frequencies
    if (item.frequencies && item.frequencies.length > 0) {
      var freqs = item.frequencies.map(function (f) {
        var label = f.name || '';
        return '<span class="airspace-freq">' + f.value + (label ? ' <span class="airspace-freq-name">' + label + '</span>' : '') + '</span>';
      });
      html += '<div class="airspace-frequencies">' + freqs.join(' ') + '</div>';
    }

    // Remarks
    if (item.remarks) {
      html += '<div class="airspace-remarks">' + item.remarks + '</div>';
    }

    // Activating NOTAM
    if (notam) {
      var nid = (notam.series || '') + (notam.number || '') + '/' + (notam.year || '');
      var ntext = (notam.iteme || '').replace(/</g, '&lt;');
      html += '<div class="airspace-notam">';
      html += '<div class="airspace-notam-hdr">NOTAM ' + nid + '</div>';
      if (notam.itemd) {
        html += '<div class="airspace-notam-schedule">' + notam.itemd + '</div>';
      }
      if (notam.startvalidity || notam.endvalidity) {
        var sv = notam.startvalidity ? formatUtcDate(new Date(notam.startvalidity * 1000).toISOString()) : '?';
        var ev = notam.endvalidity ? formatUtcDate(new Date(notam.endvalidity * 1000).toISOString()) : '?';
        html += '<div class="airspace-notam-validity">' + sv + ' \u2013 ' + ev + '</div>';
      }
      html += '<div class="airspace-notam-text">' + ntext + '</div>';
      if (notam.upper != null || notam.lower != null) {
        var lo = notam.lower != null ? (notam.lower === 0 ? 'GND' : 'FL' + notam.lower) : '?';
        var hi = notam.upper != null ? 'FL' + notam.upper : '?';
        html += '<div class="airspace-notam-alt">' + lo + ' \u2013 ' + hi + '</div>';
      }
      html += '</div>';
    }

    html += '</div>';
    return html;
  }

  // European FIR codes by country ISO2 (main FIRs for airspace activation NOTAMs)
  var COUNTRY_FIRS = {
    FI: ['EFIN'], EE: ['EETT'], LV: ['EVRR'], LT: ['EYVL'],
    SE: ['ESAA'], NO: ['ENOR','ENOB'], DK: ['EKDK'],
    DE: ['EDGG','EDMM','EDWW'], PL: ['EPWW'], CZ: ['LKAA'],
    AT: ['LOVV'], CH: ['LSAS'], FR: ['LFFF','LFBB','LFEE','LFRR','LFMM'],
    GB: ['EGTT','EGPX'], IE: ['EISN'], NL: ['EHAA'], BE: ['EBBU'],
    LU: ['ELLX'], IT: ['LIMM','LIRR','LIBB'], ES: ['LECM','LECB'],
    PT: ['LPPC'], GR: ['LGGG'], TR: ['LTAA'], HU: ['LHCC'],
    RO: ['LRBB'], BG: ['LBSR'], SK: ['LZBB'], HR: ['LDZO'],
    SI: ['LJLA'], RS: ['LYBA'], IS: ['BIRD']
  };

  // Extract area designators activated by NOTAM from NOTAM text
  function extractActiveDesignators(notamRows) {
    var active = {};
    var designatorRe = /\b([A-Z]{2}[DRP]\d+[A-Z]?\d*)\b/g;
    notamRows.forEach(function (n) {
      var text = n.iteme || '';
      var match;
      while ((match = designatorRe.exec(text)) !== null) {
        active[match[1]] = n;
      }
      designatorRe.lastIndex = 0;
    });
    return active;
  }

  // Check if an airspace name contains any of the active designators
  function findNotamForAirspace(item, activeDesignators) {
    var name = item.name || '';
    // The OpenAIP name is like "EFD117C PAROLA" — extract the designator part
    var designatorRe = /\b([A-Z]{2}[DRP]\d+[A-Z]?\d*)\b/g;
    var match;
    while ((match = designatorRe.exec(name)) !== null) {
      if (activeDesignators[match[1]]) return activeDesignators[match[1]];
    }
    return null;
  }

  function setupAirspaceLayer(layerGroup) {
    var loadedIds = {};
    var debounceTimer = null;
    var MIN_ZOOM = 7;
    var activeDesignators = {}; // populated from NOTAMs
    var notamFetchedFirs = {}; // track which FIRs we've already fetched

    function fetchAreaNotams(countries) {
      // Determine which FIRs to query based on visible countries
      var firs = [];
      var seen = {};
      countries.forEach(function (cc) {
        var firList = COUNTRY_FIRS[cc] || [];
        firList.forEach(function (f) {
          if (!seen[f] && !notamFetchedFirs[f]) {
            firs.push(f);
            seen[f] = true;
          }
        });
      });
      if (firs.length === 0) return Promise.resolve();

      // Batch into groups of 5
      var batches = [];
      for (var i = 0; i < firs.length; i += 5) {
        batches.push(firs.slice(i, i + 5));
      }

      return Promise.all(batches.map(function (batch) {
        return fetch(OWM_PROXY + '/ar/area-notams?firs=' + batch.join(','))
          .then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          })
          .then(function (data) {
            if (data && data.rows) {
              var newDesignators = extractActiveDesignators(data.rows);
              Object.keys(newDesignators).forEach(function (k) {
                activeDesignators[k] = newDesignators[k];
              });
            }
            batch.forEach(function (f) { notamFetchedFirs[f] = true; });
          })
          .catch(function (err) {
            console.error('Area NOTAM fetch error:', err);
          });
      }));
    }

    function renderAirspaces(items) {
      items.forEach(function (item) {
        var id = item._id || item.id;
        if (loadedIds[id]) return;
        loadedIds[id] = true;

        if (!item.geometry) return;

        // Classify: check schedule, then upgrade with NOTAM data
        var activation = classifyAirspaceActivation(item);
        if (!activation) return; // outside validity or not today

        var notam = findNotamForAirspace(item, activeDesignators);
        if (notam) activation = 'active';
        // Store NOTAM ref for popup
        item._activatingNotam = notam;

        var typeInfo = AIRSPACE_TYPES[item.type] || { label: 'Airspace', color: '#888' };
        var isActive = activation === 'active';

        var polygon = L.geoJSON(item.geometry, {
          style: {
            color: typeInfo.color,
            weight: isActive ? 2 : 1,
            opacity: isActive ? 0.8 : 0.35,
            fillColor: typeInfo.color,
            fillOpacity: isActive ? 0.2 : 0.05,
            dashArray: isActive ? null : '4,6'
          }
        });

        polygon.bindPopup(airspacePopupHtml(item), {
          maxWidth: 420,
          minWidth: 280,
          className: 'airspace-popup-wrapper'
        });

        polygon.addTo(layerGroup);
      });
    }

    function loadAirspaces() {
      if (map.getZoom() < MIN_ZOOM) {
        layerGroup.clearLayers();
        loadedIds = {};
        return;
      }

      var bounds = map.getBounds();
      var bbox = [
        bounds.getWest().toFixed(4),
        bounds.getSouth().toFixed(4),
        bounds.getEast().toFixed(4),
        bounds.getNorth().toFixed(4)
      ].join(',');

      fetch(OWM_PROXY + '/airspaces?bbox=' + bbox + '&type=1,2,3')
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(function (data) {
          if (!data || !data.items || data.items.length === 0) return;

          // Collect unique countries from returned items
          var countries = {};
          data.items.forEach(function (item) {
            if (item.country) countries[item.country] = true;
          });

          // Fetch NOTAMs for new FIRs, then render
          fetchAreaNotams(Object.keys(countries)).then(function () {
            renderAirspaces(data.items);
          });
        })
        .catch(function (err) {
          console.error('Airspace load error:', err);
        });
    }

    map.on('moveend', function () {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(loadAirspaces, 500);
    });

    // Also clear dedup cache when layer is removed from map
    map.on('overlayremove', function (e) {
      if (e.layer === layerGroup) {
        layerGroup.clearLayers();
        loadedIds = {};
      }
    });

    // Load if already on map at sufficient zoom
    if (map.hasLayer(layerGroup)) {
      loadAirspaces();
    }

    // Load when layer is added
    map.on('overlayadd', function (e) {
      if (e.layer === layerGroup) {
        loadAirspaces();
      }
    });
  }

  // --- Navaids + VFR Reporting Points overlay (OpenAIP) ---

  var NAVAID_TYPES = {
    0: { label: 'DME', css: 'dme' },
    1: { label: 'TACAN', css: 'dme' },
    2: { label: 'NDB', css: 'ndb' },
    3: { label: 'VOR', css: 'vor' },
    4: { label: 'VOR-DME', css: 'vor' },
    5: { label: 'VORTAC', css: 'vor' },
    6: { label: 'DVOR', css: 'vor' },
    7: { label: 'DVOR-DME', css: 'vor' },
    8: { label: 'DVORTAC', css: 'vor' }
  };

  function setupWaypointsLayer(layerGroup) {
    var loadedIds = {};
    var debounceTimer = null;
    var MIN_ZOOM = 7;
    var LABEL_ZOOM = 7;

    function navaidPopupHtml(item) {
      var typeInfo = NAVAID_TYPES[item.type] || { label: 'Navaid', css: 'vor' };
      var html = '<div class="wp-popup-name">' + (item.name || 'Unknown') + '</div>';
      html += '<div class="wp-popup-ident">' + (item.identifier || '') + '</div>';
      html += '<div class="wp-popup-type">' + typeInfo.label + '</div>';
      if (item.frequency && item.frequency.value) {
        var unit = item.frequency.unit === 1 ? ' kHz' : ' MHz';
        html += '<div class="wp-popup-freq">' + item.frequency.value + unit + '</div>';
      }
      if (item.elevation && item.elevation.value != null) {
        var ft = item.elevation.unit === 0 ? Math.round(item.elevation.value * 3.281) : item.elevation.value;
        html += '<div class="wp-popup-elev">Elev: ' + ft + ' ft</div>';
      }
      return html;
    }

    function fixPopupHtml(item) {
      var html = '<div class="wp-popup-name">' + (item.name || 'Unknown') + '</div>';
      html += '<div class="wp-popup-type">' + (item.compulsory ? 'Compulsory Reporting Point' : 'Reporting Point') + '</div>';
      if (item.elevation && item.elevation.value != null) {
        var ft = item.elevation.unit === 0 ? Math.round(item.elevation.value * 3.281) : item.elevation.value;
        html += '<div class="wp-popup-elev">Elev: ' + ft + ' ft</div>';
      }
      return html;
    }

    function createNavaidMarker(item, showLabel) {
      var coords = item.geometry && item.geometry.coordinates;
      if (!coords) return null;
      var lat = coords[1], lon = coords[0];
      var typeInfo = NAVAID_TYPES[item.type] || { label: 'Navaid', css: 'vor' };
      var ident = item.identifier || '';

      var iconHtml = '<div class="wp-icon"><div class="wp-icon-' + typeInfo.css + '"></div>';
      if (showLabel && ident) {
        iconHtml += '<span class="wp-label">' + ident + '</span>';
      }
      iconHtml += '</div>';

      var marker = L.marker([lat, lon], {
        icon: L.divIcon({
          className: 'wp-marker',
          html: iconHtml,
          iconSize: [showLabel ? 60 : 12, 12],
          iconAnchor: [showLabel ? 6 : 5, 6]
        })
      });

      marker.bindPopup(navaidPopupHtml(item), {
        maxWidth: 280,
        className: 'waypoint-popup'
      });

      var tooltipText = ident + (item.name && item.name !== ident ? ' ' + item.name : '');
      marker.bindTooltip(tooltipText, { direction: 'top', offset: [0, -6] });

      marker._waypointData = { code: ident, name: item.name || ident };

      return marker;
    }

    function createFixMarker(item, showLabel) {
      var coords = item.geometry && item.geometry.coordinates;
      if (!coords) return null;
      var lat = coords[1], lon = coords[0];
      var name = item.name || '';
      var cssClass = item.compulsory ? 'wp-icon-fix-compulsory' : 'wp-icon-fix';

      var iconHtml = '<div class="wp-icon"><div class="' + cssClass + '"></div>';
      if (showLabel && name) {
        iconHtml += '<span class="wp-label">' + name + '</span>';
      }
      iconHtml += '</div>';

      var marker = L.marker([lat, lon], {
        icon: L.divIcon({
          className: 'wp-marker',
          html: iconHtml,
          iconSize: [showLabel ? 56 : 10, 10],
          iconAnchor: [showLabel ? 4 : 4, 7]
        })
      });

      marker.bindPopup(fixPopupHtml(item), {
        maxWidth: 280,
        className: 'waypoint-popup'
      });

      marker.bindTooltip(name, { direction: 'top', offset: [0, -4] });

      marker._waypointData = { code: name, name: name };

      return marker;
    }

    function loadWaypoints() {
      if (map.getZoom() < MIN_ZOOM) {
        layerGroup.clearLayers();
        loadedIds = {};
        return;
      }

      var bounds = map.getBounds();
      var bbox = [
        bounds.getWest().toFixed(4),
        bounds.getSouth().toFixed(4),
        bounds.getEast().toFixed(4),
        bounds.getNorth().toFixed(4)
      ].join(',');

      var showLabels = map.getZoom() >= LABEL_ZOOM;

      Promise.all([
        fetch(OWM_PROXY + '/navaids?bbox=' + bbox).then(function (r) { return r.ok ? r.json() : { items: [] }; }),
        fetch(OWM_PROXY + '/reporting-points?bbox=' + bbox).then(function (r) { return r.ok ? r.json() : { items: [] }; })
      ]).then(function (results) {
        var navaids = results[0].items || [];
        var fixes = results[1].items || [];

        navaids.forEach(function (item) {
          var id = 'nav_' + (item._id || item.id);
          if (loadedIds[id]) return;
          loadedIds[id] = true;
          var marker = createNavaidMarker(item, showLabels);
          if (marker) marker.addTo(layerGroup);
        });

        fixes.forEach(function (item) {
          var id = 'fix_' + (item._id || item.id);
          if (loadedIds[id]) return;
          loadedIds[id] = true;
          var marker = createFixMarker(item, showLabels);
          if (marker) marker.addTo(layerGroup);
        });
      }).catch(function (err) {
        console.error('Waypoints load error:', err);
      });
    }

    // Debounced load on moveend
    map.on('moveend', function () {
      if (!map.hasLayer(layerGroup)) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(loadWaypoints, 500);
    });

    // Re-render labels when crossing the label zoom threshold
    map.on('zoomend', function () {
      if (!map.hasLayer(layerGroup)) return;
      var showLabels = map.getZoom() >= LABEL_ZOOM;
      var prevShowLabels = layerGroup._wpLabelsShown;
      if (showLabels !== prevShowLabels) {
        // Must clear and reload to rebuild markers with/without labels
        layerGroup.clearLayers();
        loadedIds = {};
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(loadWaypoints, 200);
      }
      layerGroup._wpLabelsShown = showLabels;
    });

    // Clear when layer is removed
    map.on('overlayremove', function (e) {
      if (e.layer === layerGroup) {
        layerGroup.clearLayers();
        loadedIds = {};
      }
    });

    // Load when layer is added
    map.on('overlayadd', function (e) {
      if (e.layer === layerGroup) {
        loadWaypoints();
      }
    });

    // Load immediately if already on map
    if (map.hasLayer(layerGroup)) {
      loadWaypoints();
    }
  }

  function setupLayerControl() {
    const overlays = {};

    if (countriesLayer) {
      overlays['Country boundaries'] = countriesLayer;
    }

    // Weather layers as radio buttons (separate control)
    var weatherLayers = createWeatherLayers();
    var wxBasemaps = { 'No weather': L.layerGroup() };
    Object.keys(weatherLayers).forEach(function (name) {
      wxBasemaps[name] = weatherLayers[name];
    });
    wxBasemaps['No weather'].addTo(map); // default selection

    // AMA grid overlay
    var amaLayer = L.layerGroup();
    var obsLayer = L.layerGroup();
    overlays['AMA Grid'] = amaLayer;
    overlays['Obstacles'] = obsLayer;
    loadAMAGrid(amaLayer, obsLayer);

    // SIGMET overlay
    var sigmetLayer = L.layerGroup();
    overlays['SIGMETs'] = sigmetLayer;
    setupSigmetLayer(sigmetLayer);

    // OpenAIP airspace tile overlay
    var airspaceTileLayer = L.tileLayer(OWM_PROXY + '/airspace-tiles/{z}/{x}/{y}.png', {
      opacity: 1,
      maxZoom: 14,
      attribution: '&copy; <a href="https://www.openaip.net">OpenAIP</a>'
    });
    overlays['Airspace'] = airspaceTileLayer;

    // R/D/P interactive polygon overlay
    var airspaceVectorLayer = L.layerGroup();
    overlays['R/D/P Areas'] = airspaceVectorLayer;
    setupAirspaceLayer(airspaceVectorLayer);

    // Navaids + VFR Reporting Points overlay (OpenAIP)
    var waypointsLayer = L.layerGroup();
    overlays['Reporting Points'] = waypointsLayer;
    setupWaypointsLayer(waypointsLayer);

    // Airport layers will be added by airports.js via window.AirportApp
    window.AirportApp = window.AirportApp || {};
    window.AirportApp.map = map;
    window.AirportApp.overlays = overlays;
    window.AirportApp.layerControl = L.control.layers(basemaps, overlays, {
      collapsed: true,
      position: 'topright'
    }).addTo(map);

    // Weather radio-button control (below main control)
    L.control.layers(wxBasemaps, null, {
      collapsed: true,
      position: 'topright'
    }).addTo(map);

    // SWC button control
    var SwcControl = L.Control.extend({
      options: { position: 'topright' },
      onAdd: function () {
        var btn = L.DomUtil.create('div', 'leaflet-bar swc-control');
        btn.innerHTML = '<a href="#" title="Significant Weather Chart">SWC</a>';
        L.DomEvent.disableClickPropagation(btn);
        L.DomEvent.on(btn, 'click', function (e) {
          L.DomEvent.preventDefault(e);
          toggleSwcPanel();
        });
        return btn;
      }
    });
    new SwcControl().addTo(map);

    // Weather detail popup on map click when a weather layer is active
    setupWeatherPopup();

    // Trigger airport loading
    if (typeof window.AirportApp.loadAirports === 'function') {
      window.AirportApp.loadAirports();
    }
  }

  // --- Shared weather helpers (One Call 3.0) ---
  function degToDir(deg) {
    var dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return dirs[Math.round(deg / 22.5) % 16];
  }

  function msToKts(ms) {
    return Math.round(ms * 1.944);
  }

  function owmIcon(code, size) {
    return 'https://openweathermap.org/img/wn/' + code + (size === 2 ? '@2x' : '') + '.png';
  }

  function utcHH(epoch) {
    var d = new Date(epoch * 1000);
    var h = d.getUTCHours();
    return (h < 10 ? '0' : '') + h;
  }

  function buildOneCallHtml(data, extraRows) {
    var c = data.current;
    var w = c.weather && c.weather[0];
    var html = '<div class="wx-popup">';

    // Header: icon + temp + description
    html += '<div class="wx-header">';
    if (w) html += '<img src="' + owmIcon(w.icon, 2) + '" class="wx-icon" title="' + w.description + '" alt="' + w.description + '">';
    html += '<div>';
    html += '<div class="wx-temp-big">' + Math.round(c.temp) + '\u00B0C</div>';
    if (w) html += '<div class="wx-desc">' + w.description + '</div>';
    html += '</div></div>';

    // Current details as horizontal chips
    html += '<div class="wx-chips">';
    html += '<span class="wx-chip">Feels ' + Math.round(c.feels_like) + '\u00B0C</span>';
    var windStr = msToKts(c.wind_speed) + 'kt';
    if (c.wind_deg != null) windStr = degToDir(c.wind_deg) + ' ' + windStr;
    if (c.wind_gust) windStr += ' G' + msToKts(c.wind_gust);
    html += '<span class="wx-chip">' + windStr + '</span>';
    if (c.visibility != null) {
      var vis = c.visibility >= 10000 ? '10+km' : (c.visibility / 1000).toFixed(1) + 'km';
      html += '<span class="wx-chip">Vis ' + vis + '</span>';
    }
    html += '<span class="wx-chip">QNH ' + c.pressure + '</span>';
    if (extraRows) html += extraRows;
    html += '</div>';

    // 3-hourly horizontal timeline (every 3 hours)
    var hourly = data.hourly;
    if (hourly && hourly.length > 0) {
      html += '<div class="wx-hourly">';
      for (var i = 0; i < hourly.length && i < 18; i += 3) {
        var h = hourly[i];
        var hw = h.weather && h.weather[0];
        var hWind = msToKts(h.wind_speed);
        var hDir = h.wind_deg != null ? degToDir(h.wind_deg) : '';
        var hGust = h.wind_gust ? msToKts(h.wind_gust) : 0;
        var windLine = hDir + ' ' + hWind;
        if (hGust > hWind) windLine += 'G' + hGust;
        html += '<div class="wx-hour">';
        html += '<div class="wx-hour-time">' + utcHH(h.dt) + 'Z</div>';
        if (hw) html += '<img src="' + owmIcon(hw.icon, 2) + '" class="wx-hour-icon" title="' + hw.description + '" alt="' + hw.description + '">';
        html += '<div class="wx-hour-temp">' + Math.round(h.temp) + '\u00B0</div>';
        html += '<div class="wx-hour-wind">' + windLine + '</div>';
        if (h.pop > 0.05) html += '<div class="wx-hour-pop">' + Math.round(h.pop * 100) + '%</div>';
        html += '</div>';
      }
      html += '</div>';
    }

    html += '</div>';
    return html;
  }

  function amaHtml(lat, lon) {
    var idx = window._amaIndex;
    if (!idx) return '';
    var key = Math.floor(lat) + ',' + Math.floor(lon);
    var val = idx[key];
    if (val == null) return '';
    return '<span class="wx-chip">AMA ' + val + ' ft</span>';
  }

  // Fetch One Call 3.0 + overview, render into a target element
  function fetchWeatherInto(el, lat, lon) {
    var ama = amaHtml(lat, lon);
    el.innerHTML = '<span class="metar-loading">Loading weather...</span>';

    Promise.all([
      fetch(OWM_PROXY + '/onecall?lat=' + lat + '&lon=' + lon).then(function (r) { return r.json(); }),
      fetch(OWM_PROXY + '/wx-overview?lat=' + lat + '&lon=' + lon).then(function (r) { return r.json(); })
    ]).then(function (results) {
      var oneCall = results[0];
      var overview = results[1];
      if (!oneCall.current) { el.innerHTML = '<span class="info-unknown">Weather unavailable</span>'; return; }
      var html = buildOneCallHtml(oneCall, ama);
      if (overview && overview.weather_overview) {
        var text = overview.weather_overview.replace(/(\d+(?:\.\d+)?)\s*meter(?:s)?(?:\s*per\s*second|\/s(?:ec)?)/gi, function (m, v) {
          return Math.round(parseFloat(v) * 1.944) + ' knots';
        });
        html += '<div class="wx-overview">' + text + '</div>';
      }
      el.innerHTML = html;
    }).catch(function () {
      el.innerHTML = '<span class="info-unknown">Failed to load weather</span>';
    });
  }

  function setupWeatherPopup() {
    var weatherPopup = L.popup({ maxWidth: 400, minWidth: 340, className: 'weather-popup' });

    map.on('click', function (e) {
      // In route mode, add map click as a waypoint (but not if an airport marker was just clicked)
      if (window.AirportApp && window.AirportApp.routeMode) {
        if (window.AirportApp.addMapWaypoint && !window.AirportApp.justAddedAirport) {
          window.AirportApp.addMapWaypoint(e.latlng);
        }
        return;
      }
      var lat = e.latlng.lat.toFixed(4);
      var lon = e.latlng.lng.toFixed(4);

      var container = document.createElement('div');
      container.innerHTML = '<span class="metar-loading">Loading weather...</span>';
      weatherPopup
        .setLatLng(e.latlng)
        .setContent(container)
        .openOn(map);

      fetchWeatherInto(container, lat, lon);
    });
  }

  // --- Airgram: Vertical profile chart (clouds + wind at altitude) ---

  var AIRGRAM_LEVELS = [1000, 925, 850, 775, 700, 600, 500, 450];
  var AIRGRAM_VARS = ['temperature', 'wind_speed', 'wind_direction', 'cloud_cover', 'geopotential_height', 'relative_humidity'];
  var AIRGRAM_MIN_FT = 0;
  var AIRGRAM_MAX_FT = 20000;
  var AIRGRAM_MIN_M = 0;
  var AIRGRAM_MAX_M = 6096; // 20000 ft in meters
  // Default FL labels for route airgram (FL000 to FL200)
  var AIRGRAM_FL_LABELS = [
    { label: 'FL000', ft: 0 },
    { label: 'FL025', ft: 2500 },
    { label: 'FL050', ft: 5000 },
    { label: 'FL075', ft: 7500 },
    { label: 'FL100', ft: 10000 },
    { label: 'FL125', ft: 12500 },
    { label: 'FL150', ft: 15000 },
    { label: 'FL175', ft: 17500 },
    { label: 'FL200', ft: 20000 }
  ];

  // Build FL labels from airport elevation up to FL200 (absolute FLs)
  function buildFlLabels(elevFt) {
    var labels = [];
    // First label is the airport elevation itself
    var elevRounded = Math.round(elevFt);
    labels.push({ label: elevRounded + ' ft', ft: elevRounded });
    // Then FL025, FL050, FL075, ... FL200
    for (var fl = 25; fl <= 200; fl += 25) {
      var ft = fl * 100;
      if (ft > elevRounded) {
        var flStr = fl < 100 ? '0' + fl : '' + fl;
        labels.push({ label: 'FL' + flStr, ft: ft });
      }
    }
    return labels;
  }

  function buildAirgramUrl(lat, lon) {
    var params = [];
    for (var v = 0; v < AIRGRAM_VARS.length; v++) {
      for (var l = 0; l < AIRGRAM_LEVELS.length; l++) {
        params.push(AIRGRAM_VARS[v] + '_' + AIRGRAM_LEVELS[l] + 'hPa');
      }
    }
    return 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon
      + '&hourly=' + params.join(',')
      + '&wind_speed_unit=kn&forecast_hours=24&timezone=UTC';
  }

  function tempToColor(t) {
    // Map temperature to RGB: -40C=deep blue, -10C=cyan, 5C=green, 20C=yellow, 35C+=red
    var r, g, b;
    if (t <= -40) { r = 30; g = 30; b = 180; }
    else if (t <= -10) { var f = (t + 40) / 30; r = Math.round(30 + f * 0); g = Math.round(30 + f * 190); b = Math.round(180 + f * (220 - 180)); }
    else if (t <= 5) { var f = (t + 10) / 15; r = Math.round(30 + f * (50 - 30)); g = Math.round(220 - f * 40); b = Math.round(220 - f * 140); }
    else if (t <= 20) { var f = (t - 5) / 15; r = Math.round(50 + f * (230 - 50)); g = Math.round(180 + f * (220 - 180)); b = Math.round(80 - f * 40); }
    else if (t <= 35) { var f = (t - 20) / 15; r = Math.round(230 + f * 25); g = Math.round(220 - f * 170); b = Math.round(40 - f * 10); }
    else { r = 255; g = 50; b = 30; }
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  function drawMiniBarb(ctx, cx, cy, speedKt, dirDeg, size) {
    if (speedKt < 3) {
      // Calm: small circle
      ctx.beginPath();
      ctx.arc(cx, cy, size * 0.15, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      return;
    }
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((dirDeg + 180) * Math.PI / 180);

    var halfLen = size * 0.45;
    var barbLen = size * 0.3;

    // Staff
    ctx.beginPath();
    ctx.moveTo(0, -halfLen);
    ctx.lineTo(0, halfLen);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.2;
    ctx.lineCap = 'round';
    ctx.stroke();

    // Circle at bottom (wind end)
    ctx.beginPath();
    ctx.arc(0, halfLen, 1.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fill();

    var remaining = Math.round(speedKt / 5) * 5;
    var y = -halfLen;
    var step = size * 0.15;

    // Pennants (50 kt)
    while (remaining >= 50) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(barbLen, y + step * 0.4);
      ctx.lineTo(0, y + step * 0.8);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fill();
      y += step;
      remaining -= 50;
    }
    // Full barbs (10 kt)
    while (remaining >= 10) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(barbLen, y - step * 0.5);
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      y += step * 0.7;
      remaining -= 10;
    }
    // Half barb (5 kt)
    if (remaining >= 5) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(barbLen * 0.5, y - step * 0.35);
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
    ctx.restore();
  }

  function renderAirgram(el, data, elevFt) {
    var hourly = data.hourly;
    if (!hourly || !hourly.time) {
      el.innerHTML = '<span class="info-unknown">No airgram data</span>';
      return;
    }
    elevFt = elevFt || 0;
    var flLabels = buildFlLabels(elevFt);

    var nHours = Math.min(hourly.time.length, 24);
    var nLevels = AIRGRAM_LEVELS.length;

    // Parse into grid[levelIdx][hourIdx]
    var grid = [];
    for (var li = 0; li < nLevels; li++) {
      grid[li] = [];
      var lev = AIRGRAM_LEVELS[li];
      var tempKey = 'temperature_' + lev + 'hPa';
      var wsKey = 'wind_speed_' + lev + 'hPa';
      var wdKey = 'wind_direction_' + lev + 'hPa';
      var ccKey = 'cloud_cover_' + lev + 'hPa';
      var ghKey = 'geopotential_height_' + lev + 'hPa';
      var rhKey = 'relative_humidity_' + lev + 'hPa';
      for (var hi = 0; hi < nHours; hi++) {
        grid[li][hi] = {
          temp: hourly[tempKey] ? hourly[tempKey][hi] : null,
          windSpd: hourly[wsKey] ? hourly[wsKey][hi] : null,
          windDir: hourly[wdKey] ? hourly[wdKey][hi] : null,
          cloud: hourly[ccKey] ? hourly[ccKey][hi] : null,
          geoHt: hourly[ghKey] ? hourly[ghKey][hi] : null,
          rh: hourly[rhKey] ? hourly[rhKey][hi] : null
        };
      }
    }

    // Canvas sizing
    var containerWidth = el.clientWidth || 360;
    var dpr = window.devicePixelRatio || 1;
    var leftMargin = 48;
    var rightMargin = 8;
    var topMargin = 16;
    var bottomMargin = 22;
    var chartW = containerWidth - leftMargin - rightMargin;
    var chartH = 240;
    var canvasW = containerWidth;
    var canvasH = chartH + topMargin + bottomMargin;

    var canvas = document.createElement('canvas');
    canvas.width = canvasW * dpr;
    canvas.height = canvasH * dpr;
    canvas.style.width = canvasW + 'px';
    canvas.style.height = canvasH + 'px';
    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    // Y positions for each level (0=top=300hPa, 7=bottom=1000hPa)
    // Use geopotential height to space levels proportionally
    var geoHts = [];
    for (var li = 0; li < nLevels; li++) {
      var avg = 0;
      var cnt = 0;
      for (var hi = 0; hi < nHours; hi++) {
        if (grid[li][hi].geoHt != null) { avg += grid[li][hi].geoHt; cnt++; }
      }
      geoHts[li] = cnt > 0 ? avg / cnt : null;
    }

    // Fallback: standard atmosphere heights (meters) for [1000,925,850,775,700,600,500,450] hPa
    var stdHts = [111, 762, 1457, 2164, 3012, 4206, 5574, 6344];
    for (var li = 0; li < nLevels; li++) {
      if (geoHts[li] == null) geoHts[li] = stdHts[li];
    }

    // Y range: airport elevation to FL200
    var minHt = elevFt * 0.3048;
    var maxHt = AIRGRAM_MAX_M;
    function htToY(ht) {
      var frac = (ht - minHt) / (maxHt - minHt);
      return topMargin + chartH * (1 - frac);
    }

    var levelY = [];
    for (var li = 0; li < nLevels; li++) {
      levelY[li] = htToY(geoHts[li]);
    }

    // X position for each hour
    var cellW = chartW / nHours;
    function hourX(hi) { return leftMargin + hi * cellW; }

    // Helper: interpolate value between adjacent levels at a fractional level position
    function interpLevel(hi, valKey, targetHt) {
      for (var li = 0; li < nLevels - 1; li++) {
        var h0 = geoHts[li], h1 = geoHts[li + 1];
        if (targetHt >= h0 && targetHt <= h1) {
          var frac = (targetHt - h0) / (h1 - h0);
          var v0 = grid[li][hi][valKey];
          var v1 = grid[li + 1][hi][valKey];
          if (v0 != null && v1 != null) return v0 + frac * (v1 - v0);
        }
      }
      return null;
    }

    // 1. Draw temperature background (smooth gradient)
    var tempRows = 60;
    for (var r = 0; r < tempRows; r++) {
      var frac = r / tempRows;
      var ht = maxHt - frac * (maxHt - minHt);
      var y = topMargin + frac * chartH;
      var rowH = chartH / tempRows + 1;
      for (var hi = 0; hi < nHours; hi++) {
        var t = interpLevel(hi, 'temp', ht);
        if (t == null) continue;
        ctx.fillStyle = tempToColor(t);
        ctx.globalAlpha = 0.35;
        ctx.fillRect(hourX(hi), y, cellW + 0.5, rowH);
      }
    }
    ctx.globalAlpha = 1;

    // 2. Overlay cloud cover as semi-transparent grey
    for (var li = 0; li < nLevels; li++) {
      for (var hi = 0; hi < nHours; hi++) {
        var cc = grid[li][hi].cloud;
        if (cc == null || cc < 5) continue;
        // Determine cell height: span between midpoints to adjacent levels
        var yTop, yBot;
        if (li === nLevels - 1) {
          yTop = (li > 0) ? (levelY[li] + levelY[li - 1]) / 2 : topMargin;
          yBot = levelY[li] + (levelY[li] - yTop);
        } else if (li === 0) {
          yBot = (levelY[li] + levelY[li + 1]) / 2;
          yTop = levelY[li] - (yBot - levelY[li]);
        } else {
          yTop = (levelY[li] + levelY[li - 1]) / 2;
          yBot = (levelY[li] + levelY[li + 1]) / 2;
        }
        // Clamp to chart area
        yTop = Math.max(yTop, topMargin);
        yBot = Math.min(yBot, topMargin + chartH);

        var alpha = (cc / 100) * 0.75;
        ctx.fillStyle = 'rgba(170,170,170,' + alpha.toFixed(2) + ')';
        ctx.fillRect(hourX(hi), yTop, cellW + 0.5, yBot - yTop);
      }
    }

    // 2b. Icing zones overlay (temp -20..+2°C AND cloud>50% or rh>80%)
    for (var li = 0; li < nLevels; li++) {
      for (var hi = 0; hi < nHours; hi++) {
        var ic = grid[li][hi];
        if (ic.temp == null || ic.cloud == null || ic.rh == null) continue;
        if (ic.temp < -20 || ic.temp > 2) continue;
        if (ic.cloud <= 50 && ic.rh <= 80) continue;
        var yTop, yBot;
        if (li === nLevels - 1) {
          yTop = (li > 0) ? (levelY[li] + levelY[li - 1]) / 2 : topMargin;
          yBot = levelY[li] + (levelY[li] - yTop);
        } else if (li === 0) {
          yBot = (levelY[li] + levelY[li + 1]) / 2;
          yTop = levelY[li] - (yBot - levelY[li]);
        } else {
          yTop = (levelY[li] + levelY[li - 1]) / 2;
          yBot = (levelY[li] + levelY[li + 1]) / 2;
        }
        yTop = Math.max(yTop, topMargin);
        yBot = Math.min(yBot, topMargin + chartH);
        var ix = hourX(hi), iw = cellW + 0.5, ih = yBot - yTop;
        ctx.fillStyle = 'rgba(41,128,185,0.18)';
        ctx.fillRect(ix, yTop, iw, ih);
        ctx.save();
        ctx.beginPath();
        ctx.rect(ix, yTop, iw, ih);
        ctx.clip();
        ctx.strokeStyle = 'rgba(41,128,185,0.35)';
        ctx.lineWidth = 0.8;
        var spacing = 6;
        for (var d = -ih; d < iw + ih; d += spacing) {
          ctx.beginPath();
          ctx.moveTo(ix + d, yTop);
          ctx.lineTo(ix + d + ih, yBot);
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    // 3. Draw freezing level line (0C isotherm)
    ctx.beginPath();
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = '#00e5ff';
    ctx.lineWidth = 1.5;
    var started = false;
    for (var hi = 0; hi < nHours; hi++) {
      // Find height where temp crosses 0C
      var fzHt = null;
      for (var li = 0; li < nLevels - 1; li++) {
        var t0 = grid[li][hi].temp;
        var t1 = grid[li + 1][hi].temp;
        if (t0 == null || t1 == null) continue;
        if ((t0 >= 0 && t1 <= 0) || (t0 <= 0 && t1 >= 0)) {
          var frac = Math.abs(t0) / (Math.abs(t0) + Math.abs(t1));
          fzHt = geoHts[li] + frac * (geoHts[li + 1] - geoHts[li]);
          break;
        }
      }
      if (fzHt != null) {
        var x = hourX(hi) + cellW / 2;
        var y = htToY(fzHt);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // 4. Draw grid lines at FL label positions
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 0.5;
    for (var fi = 0; fi < flLabels.length; fi++) {
      var gy = htToY(flLabels[fi].ft * 0.3048);
      ctx.beginPath();
      ctx.moveTo(leftMargin, gy);
      ctx.lineTo(leftMargin + chartW, gy);
      ctx.stroke();
    }
    // Vertical (every 3 hours)
    for (var hi = 0; hi < nHours; hi++) {
      if (hi % 3 === 0) {
        ctx.beginPath();
        ctx.moveTo(hourX(hi), topMargin);
        ctx.lineTo(hourX(hi), topMargin + chartH);
        ctx.stroke();
      }
    }

    // 5. Draw mini wind barbs
    for (var li = 0; li < nLevels; li++) {
      for (var hi = 0; hi < nHours; hi++) {
        // Draw barb every 2 hours to avoid clutter
        if (hi % 2 !== 0) continue;
        var cell = grid[li][hi];
        if (cell.windSpd == null || cell.windDir == null) continue;
        var x = hourX(hi) + cellW / 2;
        var y = levelY[li];
        drawMiniBarb(ctx, x, y, cell.windSpd, cell.windDir, 20);
      }
    }

    // 6. Axis labels
    ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textBaseline = 'middle';

    // Left: FL labels (airport elevation + FL025, FL050, ... FL200)
    ctx.textAlign = 'right';
    ctx.fillStyle = '#444';
    for (var fi = 0; fi < flLabels.length; fi++) {
      var flY = htToY(flLabels[fi].ft * 0.3048);
      ctx.fillText(flLabels[fi].label, leftMargin - 4, flY);
    }

    // Bottom: UTC hours
    ctx.textAlign = 'center';
    ctx.fillStyle = '#555';
    ctx.textBaseline = 'top';
    for (var hi = 0; hi < nHours; hi++) {
      if (hi % 3 === 0) {
        var dt = new Date(hourly.time[hi]);
        var hh = dt.getUTCHours();
        var label = (hh < 10 ? '0' : '') + hh + 'Z';
        ctx.fillText(label, hourX(hi) + cellW / 2, topMargin + chartH + 4);
      }
    }

    // Chart border
    ctx.strokeStyle = 'rgba(0,0,0,0.2)';
    ctx.lineWidth = 1;
    ctx.strokeRect(leftMargin, topMargin, chartW, chartH);

    // Build container
    var container = document.createElement('div');
    container.className = 'airgram-container';
    container.appendChild(canvas);

    // Tooltip
    var tip = document.createElement('div');
    tip.className = 'airgram-tip';
    tip.style.display = 'none';
    container.appendChild(tip);

    canvas.addEventListener('mousemove', function (e) {
      var rect = canvas.getBoundingClientRect();
      var scaleX = canvasW / rect.width;
      var scaleY = canvasH / rect.height;
      var mx = (e.clientX - rect.left) * scaleX;
      var my = (e.clientY - rect.top) * scaleY;
      var hi = Math.floor((mx - leftMargin) / cellW);
      if (hi < 0 || hi >= nHours || mx < leftMargin || mx > leftMargin + chartW || my < topMargin || my > topMargin + chartH) {
        tip.style.display = 'none'; return;
      }
      var bestLi = 0, bestDist = Infinity;
      for (var li = 0; li < nLevels; li++) {
        var d = Math.abs(my - levelY[li]);
        if (d < bestDist) { bestDist = d; bestLi = li; }
      }
      var cell = grid[bestLi][hi];
      var parts = [];
      var curFt = (minHt + (maxHt - minHt) * (1 - (my - topMargin) / chartH)) * 3.28084;
      var bandLo = flLabels[0].ft, bandHi = flLabels[flLabels.length - 1].ft;
      for (var fi = 0; fi < flLabels.length - 1; fi++) {
        if (curFt >= flLabels[fi].ft && curFt < flLabels[fi + 1].ft) {
          bandLo = flLabels[fi].ft; bandHi = flLabels[fi + 1].ft; break;
        }
      }
      function fmtFL(ft) { var v = Math.round(ft / 100); return 'FL' + (v < 100 ? (v < 10 ? '00' : '0') : '') + v; }
      parts.push(fmtFL(bandLo) + '\u2013' + fmtFL(bandHi));
      if (cell.windSpd != null && cell.windDir != null) {
        parts.push(Math.round(cell.windDir) + '\u00B0 / ' + Math.round(cell.windSpd) + ' kt');
      }
      if (cell.temp != null) parts.push(Math.round(cell.temp) + '\u00B0C');
      if (cell.cloud != null) parts.push(Math.round(cell.cloud) + '% cloud');
      if (cell.temp != null && cell.cloud != null && cell.rh != null
          && cell.temp >= -20 && cell.temp <= 2 && (cell.cloud > 50 || cell.rh > 80)) {
        parts.push('\u2744 ICING');
      }
      tip.textContent = parts.join('  ');
      tip.style.display = 'block';
      var cssMx = e.clientX - rect.left;
      var cssMy = e.clientY - rect.top;
      var tx = cssMx + 12, ty = cssMy - 20;
      if (tx + tip.offsetWidth > container.offsetWidth) tx = cssMx - tip.offsetWidth - 8;
      tip.style.left = tx + 'px';
      tip.style.top = ty + 'px';
    });
    canvas.addEventListener('mouseleave', function () { tip.style.display = 'none'; });

    // Legend
    var legend = document.createElement('div');
    legend.className = 'airgram-legend';
    legend.innerHTML = '<div class="airgram-legend-item"><div class="airgram-legend-swatch" style="background:rgba(170,170,170,0.75);"></div>Cloud</div>'
      + '<div class="airgram-legend-item"><div class="airgram-legend-swatch" style="background:#00e5ff;border-style:dashed;"></div>0\u00B0C</div>'
      + '<div class="airgram-legend-item"><div class="airgram-legend-swatch airgram-legend-icing"></div>Icing</div>'
      + '<div class="airgram-legend-item"><div class="airgram-legend-swatch" style="background:' + tempToColor(-20) + ';opacity:0.5;"></div>-20\u00B0C</div>'
      + '<div class="airgram-legend-item"><div class="airgram-legend-swatch" style="background:' + tempToColor(0) + ';opacity:0.5;"></div>0\u00B0C</div>'
      + '<div class="airgram-legend-item"><div class="airgram-legend-swatch" style="background:' + tempToColor(20) + ';opacity:0.5;"></div>20\u00B0C</div>'
      + '<div class="airgram-legend-item"><div class="airgram-legend-swatch" style="background:' + tempToColor(35) + ';opacity:0.5;"></div>35\u00B0C</div>';
    container.appendChild(legend);

    el.innerHTML = '';
    el.appendChild(container);
  }

  function fetchAirgramInto(el, lat, lon, elevFt) {
    if (el._airgramLoaded) return;
    el._airgramLoaded = true;
    el.innerHTML = '<span class="metar-loading">Loading Airgram...</span>';

    var url = buildAirgramUrl(lat, lon);
    fetch(url)
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        renderAirgram(el, data, elevFt);
      })
      .catch(function (err) {
        el.innerHTML = '<span class="info-unknown">Airgram unavailable</span>';
        console.error('Airgram fetch error:', err);
      });
  }

  // --- Route Airgram: cross-section along route ---
  // samples: [{lat, lon, dist, timeH, etaEpoch, label}]

  function buildRouteAirgramUrl(samples) {
    var lats = [], lons = [];
    for (var i = 0; i < samples.length; i++) {
      lats.push(samples[i].lat);
      lons.push(samples[i].lon);
    }
    var params = [];
    for (var v = 0; v < AIRGRAM_VARS.length; v++) {
      for (var l = 0; l < AIRGRAM_LEVELS.length; l++) {
        params.push(AIRGRAM_VARS[v] + '_' + AIRGRAM_LEVELS[l] + 'hPa');
      }
    }
    return 'https://api.open-meteo.com/v1/forecast?latitude=' + lats.join(',')
      + '&longitude=' + lons.join(',')
      + '&hourly=' + params.join(',')
      + '&wind_speed_unit=kn&forecast_hours=24&timezone=UTC';
  }

  function renderRouteAirgram(el, responses, samples) {
    var nPoints = samples.length;
    var nLevels = AIRGRAM_LEVELS.length;

    // For each sample point, pick the hour closest to etaEpoch
    var grid = []; // grid[levelIdx][pointIdx]
    for (var li = 0; li < nLevels; li++) {
      grid[li] = [];
      var lev = AIRGRAM_LEVELS[li];
      var tempKey = 'temperature_' + lev + 'hPa';
      var wsKey = 'wind_speed_' + lev + 'hPa';
      var wdKey = 'wind_direction_' + lev + 'hPa';
      var ccKey = 'cloud_cover_' + lev + 'hPa';
      var ghKey = 'geopotential_height_' + lev + 'hPa';
      var rhKey = 'relative_humidity_' + lev + 'hPa';

      for (var pi = 0; pi < nPoints; pi++) {
        var resp = responses[pi];
        var hourly = resp && resp.hourly;
        if (!hourly || !hourly.time) {
          grid[li][pi] = { temp: null, windSpd: null, windDir: null, cloud: null, geoHt: null, rh: null };
          continue;
        }

        // Find closest hour to eta
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
          temp: hourly[tempKey] ? hourly[tempKey][hi] : null,
          windSpd: hourly[wsKey] ? hourly[wsKey][hi] : null,
          windDir: hourly[wdKey] ? hourly[wdKey][hi] : null,
          cloud: hourly[ccKey] ? hourly[ccKey][hi] : null,
          geoHt: hourly[ghKey] ? hourly[ghKey][hi] : null,
          rh: hourly[rhKey] ? hourly[rhKey][hi] : null
        };
      }
    }

    // Canvas sizing
    var containerWidth = el.clientWidth || 500;
    var dpr = window.devicePixelRatio || 1;
    var leftMargin = 48;
    var rightMargin = 8;
    var topMargin = 16;
    var bottomMargin = 36;
    var chartW = containerWidth - leftMargin - rightMargin;
    var chartH = 260;
    var canvasW = containerWidth;
    var canvasH = chartH + topMargin + bottomMargin;

    var canvas = document.createElement('canvas');
    canvas.width = canvasW * dpr;
    canvas.height = canvasH * dpr;
    canvas.style.width = canvasW + 'px';
    canvas.style.height = canvasH + 'px';
    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    // Y positions from geopotential height
    var geoHts = [];
    for (var li = 0; li < nLevels; li++) {
      var avg = 0, cnt = 0;
      for (var pi = 0; pi < nPoints; pi++) {
        if (grid[li][pi].geoHt != null) { avg += grid[li][pi].geoHt; cnt++; }
      }
      geoHts[li] = cnt > 0 ? avg / cnt : null;
    }
    // Fallback: standard atmosphere heights (meters) for [1000,925,850,775,700,600,500,450] hPa
    var stdHts = [111, 762, 1457, 2164, 3012, 4206, 5574, 6344];
    for (var li = 0; li < nLevels; li++) {
      if (geoHts[li] == null) geoHts[li] = stdHts[li];
    }
    // Fixed Y range: 0 to FL200 (0 to 6096 m)
    var minHt = AIRGRAM_MIN_M, maxHt = AIRGRAM_MAX_M;
    function htToY(ht) {
      var frac = (ht - minHt) / (maxHt - minHt);
      return topMargin + chartH * (1 - frac);
    }
    var levelY = [];
    for (var li = 0; li < nLevels; li++) { levelY[li] = htToY(geoHts[li]); }

    // X position for each sample point
    var totalDist = samples[nPoints - 1].dist || 1;
    var cellW = chartW / nPoints;
    function ptX(pi) { return leftMargin + pi * cellW; }

    // Helper: interpolate between levels
    function interpLevel(pi, valKey, targetHt) {
      for (var li = 0; li < nLevels - 1; li++) {
        var h0 = geoHts[li], h1 = geoHts[li + 1];
        if (targetHt >= h0 && targetHt <= h1) {
          var frac = (targetHt - h0) / (h1 - h0);
          var v0 = grid[li][pi][valKey];
          var v1 = grid[li + 1][pi][valKey];
          if (v0 != null && v1 != null) return v0 + frac * (v1 - v0);
        }
      }
      return null;
    }

    // 1. Temperature background
    var tempRows = 60;
    for (var r = 0; r < tempRows; r++) {
      var frac = r / tempRows;
      var ht = maxHt - frac * (maxHt - minHt);
      var y = topMargin + frac * chartH;
      var rowH = chartH / tempRows + 1;
      for (var pi = 0; pi < nPoints; pi++) {
        var t = interpLevel(pi, 'temp', ht);
        if (t == null) continue;
        ctx.fillStyle = tempToColor(t);
        ctx.globalAlpha = 0.35;
        ctx.fillRect(ptX(pi), y, cellW + 0.5, rowH);
      }
    }
    ctx.globalAlpha = 1;

    // 2. Cloud cover overlay
    for (var li = 0; li < nLevels; li++) {
      for (var pi = 0; pi < nPoints; pi++) {
        var cc = grid[li][pi].cloud;
        if (cc == null || cc < 5) continue;
        var yTop, yBot;
        if (li === nLevels - 1) {
          yTop = (li > 0) ? (levelY[li] + levelY[li - 1]) / 2 : topMargin;
          yBot = levelY[li] + (levelY[li] - yTop);
        } else if (li === 0) {
          yBot = (levelY[li] + levelY[li + 1]) / 2;
          yTop = levelY[li] - (yBot - levelY[li]);
        } else {
          yTop = (levelY[li] + levelY[li - 1]) / 2;
          yBot = (levelY[li] + levelY[li + 1]) / 2;
        }
        yTop = Math.max(yTop, topMargin);
        yBot = Math.min(yBot, topMargin + chartH);
        var alpha = (cc / 100) * 0.75;
        ctx.fillStyle = 'rgba(170,170,170,' + alpha.toFixed(2) + ')';
        ctx.fillRect(ptX(pi), yTop, cellW + 0.5, yBot - yTop);
      }
    }

    // 2b. Icing zones overlay (temp -20..+2°C AND cloud>50% or rh>80%)
    for (var li = 0; li < nLevels; li++) {
      for (var pi = 0; pi < nPoints; pi++) {
        var ic = grid[li][pi];
        if (ic.temp == null || ic.cloud == null || ic.rh == null) continue;
        if (ic.temp < -20 || ic.temp > 2) continue;
        if (ic.cloud <= 50 && ic.rh <= 80) continue;
        // Icing condition met — draw blue hatched zone
        var yTop, yBot;
        if (li === nLevels - 1) {
          yTop = (li > 0) ? (levelY[li] + levelY[li - 1]) / 2 : topMargin;
          yBot = levelY[li] + (levelY[li] - yTop);
        } else if (li === 0) {
          yBot = (levelY[li] + levelY[li + 1]) / 2;
          yTop = levelY[li] - (yBot - levelY[li]);
        } else {
          yTop = (levelY[li] + levelY[li - 1]) / 2;
          yBot = (levelY[li] + levelY[li + 1]) / 2;
        }
        yTop = Math.max(yTop, topMargin);
        yBot = Math.min(yBot, topMargin + chartH);
        var ix = ptX(pi), iw = cellW + 0.5, ih = yBot - yTop;
        // Blue tint
        ctx.fillStyle = 'rgba(41,128,185,0.18)';
        ctx.fillRect(ix, yTop, iw, ih);
        // Diagonal hatching
        ctx.save();
        ctx.beginPath();
        ctx.rect(ix, yTop, iw, ih);
        ctx.clip();
        ctx.strokeStyle = 'rgba(41,128,185,0.35)';
        ctx.lineWidth = 0.8;
        var spacing = 6;
        for (var d = -ih; d < iw + ih; d += spacing) {
          ctx.beginPath();
          ctx.moveTo(ix + d, yTop);
          ctx.lineTo(ix + d + ih, yBot);
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    // 3. Freezing level line
    ctx.beginPath();
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = '#00e5ff';
    ctx.lineWidth = 1.5;
    var started = false;
    for (var pi = 0; pi < nPoints; pi++) {
      var fzHt = null;
      for (var li = 0; li < nLevels - 1; li++) {
        var t0 = grid[li][pi].temp;
        var t1 = grid[li + 1][pi].temp;
        if (t0 == null || t1 == null) continue;
        if ((t0 >= 0 && t1 <= 0) || (t0 <= 0 && t1 >= 0)) {
          var fr = Math.abs(t0) / (Math.abs(t0) + Math.abs(t1));
          fzHt = geoHts[li] + fr * (geoHts[li + 1] - geoHts[li]);
          break;
        }
      }
      if (fzHt != null) {
        var x = ptX(pi) + cellW / 2;
        var y = htToY(fzHt);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // 4. Grid lines at FL label positions
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 0.5;
    for (var fi = 0; fi < AIRGRAM_FL_LABELS.length; fi++) {
      var gy = htToY(AIRGRAM_FL_LABELS[fi].ft * 0.3048);
      ctx.beginPath();
      ctx.moveTo(leftMargin, gy);
      ctx.lineTo(leftMargin + chartW, gy);
      ctx.stroke();
    }
    // Vertical lines at waypoints
    for (var pi = 0; pi < nPoints; pi++) {
      if (samples[pi].label) {
        ctx.strokeStyle = 'rgba(0,0,0,0.25)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(ptX(pi) + cellW / 2, topMargin);
        ctx.lineTo(ptX(pi) + cellW / 2, topMargin + chartH);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(0,0,0,0.12)';
        ctx.lineWidth = 0.5;
      }
    }

    // 5. Wind barbs (every other column)
    for (var li = 0; li < nLevels; li++) {
      for (var pi = 0; pi < nPoints; pi++) {
        if (pi % 2 !== 0 && !samples[pi].label) continue;
        var cell = grid[li][pi];
        if (cell.windSpd == null || cell.windDir == null) continue;
        var x = ptX(pi) + cellW / 2;
        var y = levelY[li];
        drawMiniBarb(ctx, x, y, cell.windSpd, cell.windDir, 20);
      }
    }

    // 6. Axis labels
    ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textBaseline = 'middle';

    // Left: fixed FL labels
    ctx.textAlign = 'right';
    ctx.fillStyle = '#444';
    for (var fi = 0; fi < AIRGRAM_FL_LABELS.length; fi++) {
      var flY = htToY(AIRGRAM_FL_LABELS[fi].ft * 0.3048);
      ctx.fillText(AIRGRAM_FL_LABELS[fi].label, leftMargin - 4, flY);
    }

    // Bottom: waypoint labels and ETA
    ctx.textAlign = 'center';
    ctx.fillStyle = '#555';
    ctx.textBaseline = 'top';
    for (var pi = 0; pi < nPoints; pi++) {
      if (samples[pi].label) {
        ctx.font = 'bold 10px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillStyle = '#2980b9';
        ctx.fillText(samples[pi].label, ptX(pi) + cellW / 2, topMargin + chartH + 4);
        // ETA below
        if (samples[pi].etaEpoch) {
          var d = new Date(samples[pi].etaEpoch * 1000);
          var hh = d.getUTCHours();
          var mm = d.getUTCMinutes();
          var eta = (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm + 'Z';
          ctx.font = '9px -apple-system, BlinkMacSystemFont, sans-serif';
          ctx.fillStyle = '#888';
          ctx.fillText(eta, ptX(pi) + cellW / 2, topMargin + chartH + 16);
        }
      } else {
        // Show distance marker every ~3 columns
        if (pi > 0 && pi < nPoints - 1 && pi % 3 === 0) {
          ctx.font = '9px -apple-system, BlinkMacSystemFont, sans-serif';
          ctx.fillStyle = '#aaa';
          ctx.fillText(Math.round(samples[pi].dist) + 'nm', ptX(pi) + cellW / 2, topMargin + chartH + 4);
        }
      }
    }

    // Chart border
    ctx.strokeStyle = 'rgba(0,0,0,0.2)';
    ctx.lineWidth = 1;
    ctx.strokeRect(leftMargin, topMargin, chartW, chartH);

    // Build container
    var container = document.createElement('div');
    container.className = 'airgram-container';
    container.appendChild(canvas);

    // Tooltip
    var tip = document.createElement('div');
    tip.className = 'airgram-tip';
    tip.style.display = 'none';
    container.appendChild(tip);

    canvas.addEventListener('mousemove', function (e) {
      var rect = canvas.getBoundingClientRect();
      var scaleX = canvasW / rect.width;
      var scaleY = canvasH / rect.height;
      var mx = (e.clientX - rect.left) * scaleX;
      var my = (e.clientY - rect.top) * scaleY;
      var pi = Math.floor((mx - leftMargin) / cellW);
      if (pi < 0 || pi >= nPoints || mx < leftMargin || mx > leftMargin + chartW || my < topMargin || my > topMargin + chartH) {
        tip.style.display = 'none'; return;
      }
      var bestLi = 0, bestDist = Infinity;
      for (var li = 0; li < nLevels; li++) {
        var d = Math.abs(my - levelY[li]);
        if (d < bestDist) { bestDist = d; bestLi = li; }
      }
      var cell = grid[bestLi][pi];
      var parts = [];
      var curFt = (minHt + (maxHt - minHt) * (1 - (my - topMargin) / chartH)) * 3.28084;
      var bandLo = AIRGRAM_FL_LABELS[0].ft, bandHi = AIRGRAM_FL_LABELS[AIRGRAM_FL_LABELS.length - 1].ft;
      for (var fi = 0; fi < AIRGRAM_FL_LABELS.length - 1; fi++) {
        if (curFt >= AIRGRAM_FL_LABELS[fi].ft && curFt < AIRGRAM_FL_LABELS[fi + 1].ft) {
          bandLo = AIRGRAM_FL_LABELS[fi].ft; bandHi = AIRGRAM_FL_LABELS[fi + 1].ft; break;
        }
      }
      function fmtFL(ft) { var v = Math.round(ft / 100); return 'FL' + (v < 100 ? (v < 10 ? '00' : '0') : '') + v; }
      parts.push(fmtFL(bandLo) + '\u2013' + fmtFL(bandHi));
      if (cell.windSpd != null && cell.windDir != null) {
        parts.push(Math.round(cell.windDir) + '\u00B0 / ' + Math.round(cell.windSpd) + ' kt');
      }
      if (cell.temp != null) parts.push(Math.round(cell.temp) + '\u00B0C');
      if (cell.cloud != null) parts.push(Math.round(cell.cloud) + '% cloud');
      if (cell.temp != null && cell.cloud != null && cell.rh != null
          && cell.temp >= -20 && cell.temp <= 2 && (cell.cloud > 50 || cell.rh > 80)) {
        parts.push('\u2744 ICING');
      }
      tip.textContent = parts.join('  ');
      tip.style.display = 'block';
      var cssMx = e.clientX - rect.left;
      var cssMy = e.clientY - rect.top;
      var tx = cssMx + 12, ty = cssMy - 20;
      if (tx + tip.offsetWidth > container.offsetWidth) tx = cssMx - tip.offsetWidth - 8;
      tip.style.left = tx + 'px';
      tip.style.top = ty + 'px';
    });
    canvas.addEventListener('mouseleave', function () { tip.style.display = 'none'; });

    // Legend
    var legend = document.createElement('div');
    legend.className = 'airgram-legend';
    legend.innerHTML = '<div class="airgram-legend-item"><div class="airgram-legend-swatch" style="background:rgba(170,170,170,0.75);"></div>Cloud</div>'
      + '<div class="airgram-legend-item"><div class="airgram-legend-swatch" style="background:#00e5ff;border-style:dashed;"></div>0\u00B0C</div>'
      + '<div class="airgram-legend-item"><div class="airgram-legend-swatch airgram-legend-icing"></div>Icing</div>'
      + '<div class="airgram-legend-item"><div class="airgram-legend-swatch" style="background:' + tempToColor(-20) + ';opacity:0.5;"></div>Cold</div>'
      + '<div class="airgram-legend-item"><div class="airgram-legend-swatch" style="background:' + tempToColor(20) + ';opacity:0.5;"></div>Warm</div>';
    container.appendChild(legend);

    el.innerHTML = '';
    el.appendChild(container);
  }

  // Cache for route airgram data (shared between airgram chart and FL compare)
  var routeAirgramCache = { samples: null, responses: null, timestamp: 0 };

  function samplesCacheKey(samples) {
    return samples.map(function (s) { return s.lat + ',' + s.lon; }).join('|');
  }

  function fetchRouteAirgramInto(el, samples) {
    if (!samples || samples.length < 2) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = '<span class="metar-loading">Loading route profile...</span>';

    var url = buildRouteAirgramUrl(samples);
    fetch(url)
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        // Open-Meteo returns array for multi-location, single object for one location
        var responses = Array.isArray(data) ? data : [data];
        // Cache for reuse by FL Compare
        routeAirgramCache.samples = samplesCacheKey(samples);
        routeAirgramCache.responses = responses;
        routeAirgramCache.timestamp = Date.now();
        renderRouteAirgram(el, responses, samples);
      })
      .catch(function (err) {
        el.innerHTML = '<span class="info-unknown">Route profile unavailable</span>';
        console.error('Route airgram error:', err);
      });
  }

  function fetchRouteAirgramData(samples, callback) {
    if (!samples || samples.length < 2) { callback(null); return; }
    var key = samplesCacheKey(samples);
    // Use cache if same samples and less than 10 minutes old
    if (routeAirgramCache.responses && routeAirgramCache.samples === key
        && (Date.now() - routeAirgramCache.timestamp) < 600000) {
      callback(routeAirgramCache.responses);
      return;
    }
    var url = buildRouteAirgramUrl(samples);
    fetch(url)
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        var responses = Array.isArray(data) ? data : [data];
        routeAirgramCache.samples = key;
        routeAirgramCache.responses = responses;
        routeAirgramCache.timestamp = Date.now();
        callback(responses);
      })
      .catch(function (err) {
        console.error('Route airgram data error:', err);
        callback(null);
      });
  }

  // --- AI Weather Briefing stream reader ---
  function streamBriefing(el, requestBody) {
    el.innerHTML = '<div class="briefing-content"><span class="briefing-cursor"></span></div>';
    var contentEl = el.querySelector('.briefing-content');
    var cursor = el.querySelector('.briefing-cursor');
    var buffer = '';

    fetch(OWM_PROXY + '/briefing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    }).then(function (resp) {
      if (!resp.ok) {
        contentEl.textContent = 'Briefing unavailable (HTTP ' + resp.status + ')';
        if (cursor) cursor.remove();
        return;
      }
      var reader = resp.body.getReader();
      var decoder = new TextDecoder();
      var partial = '';

      function read() {
        reader.read().then(function (result) {
          if (result.done) {
            if (cursor) cursor.remove();
            // Convert markdown-style headings to styled HTML
            formatBriefing(contentEl);
            return;
          }
          partial += decoder.decode(result.value, { stream: true });
          var lines = partial.split('\n');
          partial = lines.pop(); // keep incomplete line

          for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (line.indexOf('data: ') !== 0) continue;
            var payload = line.slice(6);
            if (payload === '[DONE]') continue;
            try {
              var evt = JSON.parse(payload);
              if (evt.type === 'content_block_delta' && evt.delta && evt.delta.text) {
                buffer += evt.delta.text;
                // Update display: insert text before cursor
                if (cursor && cursor.parentNode) {
                  cursor.parentNode.insertBefore(document.createTextNode(evt.delta.text), cursor);
                } else {
                  contentEl.appendChild(document.createTextNode(evt.delta.text));
                }
              }
            } catch (e) { /* skip non-JSON lines */ }
          }
          read();
        }).catch(function () {
          if (cursor) cursor.remove();
          if (!buffer) contentEl.textContent = 'Briefing stream error';
        });
      }
      read();
    }).catch(function () {
      contentEl.textContent = 'Failed to connect to briefing service';
      if (cursor) cursor.remove();
    });
  }

  function formatBriefing(el) {
    var text = el.textContent || '';
    // Convert ## headings and basic markdown to HTML
    var html = text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/^## (.+)$/gm, '<h4 class="briefing-heading">$1</h4>')
      .replace(/^### (.+)$/gm, '<h5 class="briefing-subheading">$1</h5>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
    el.innerHTML = html;
  }

  // Expose map and helpers for other modules
  window.AirportApp = window.AirportApp || {};
  window.AirportApp.map = map;
  window.AirportApp.fetchWeatherInto = fetchWeatherInto;
  window.AirportApp.fetchAirgramInto = fetchAirgramInto;
  window.AirportApp.fetchRouteAirgramInto = fetchRouteAirgramInto;
  window.AirportApp.fetchRouteAirgramData = fetchRouteAirgramData;
  window.AirportApp.AIRGRAM_LEVELS = AIRGRAM_LEVELS;
  window.AirportApp.routeAirgramCache = routeAirgramCache;
  window.AirportApp.streamBriefing = streamBriefing;

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

  // --- SWC panel ---

  var swcLoaded = false;

  function toggleSwcPanel() {
    var panel = document.getElementById('swc-panel');
    if (!panel) return;
    if (panel.style.display === 'none') {
      panel.style.display = '';
      if (!swcLoaded) loadSwc();
    } else {
      panel.style.display = 'none';
    }
  }

  function loadSwc() {
    var body = document.querySelector('.swc-panel-body');
    var timeEl = document.querySelector('.swc-panel-time');
    var pdfEl = document.querySelector('.swc-panel-pdf');
    if (!body) return;

    body.innerHTML = '<span class="metar-loading">Loading SWC...</span>';

    fetch('https://www.ilmailusaa.fi/weatheranim.php?region=scandinavia&id=swc&level=SWC&time=')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.images || data.images.length === 0) {
          body.innerHTML = '<span class="info-unknown">No SWC available</span>';
          return;
        }
        var img = data.images[0];
        var imageUrl = 'https://www.ilmailusaa.fi/' + img.src.replace('../', '');

        body.innerHTML = '<img class="swc-chart-img" src="' + imageUrl + '" alt="SWC">';

        if (img.time && timeEl) {
          timeEl.textContent = img.time;
        }
        if (data.pdf && pdfEl) {
          pdfEl.href = 'https://www.ilmailusaa.fi/' + data.pdf.replace('./', '');
          pdfEl.style.display = '';
        }
        swcLoaded = true;
      })
      .catch(function () {
        body.innerHTML = '<span class="info-unknown">Failed to load SWC</span>';
      });
  }

  // Close button
  document.addEventListener('DOMContentLoaded', function () {
    var closeBtn = document.querySelector('.swc-panel-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', function () {
        var panel = document.getElementById('swc-panel');
        if (panel) panel.style.display = 'none';
      });
    }

    // Panel minimize/restore
    document.querySelectorAll('.panel-minimize').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var panel = document.getElementById(btn.getAttribute('data-target'));
        var mini = document.getElementById(btn.getAttribute('data-mini'));
        if (panel) panel.classList.add('minimized');
        if (mini) mini.classList.add('visible');
      });
    });
    document.querySelectorAll('.panel-mini').forEach(function (mini) {
      mini.addEventListener('click', function () {
        var panels = document.querySelectorAll('.panel.minimized');
        panels.forEach(function (p) {
          if (p.id && document.querySelector('[data-target="' + p.id + '"][data-mini="' + mini.id + '"]')) {
            p.classList.remove('minimized');
          }
        });
        mini.classList.remove('visible');
      });
    });
  });
})();
