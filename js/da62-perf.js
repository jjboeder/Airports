/* da62-perf.js - DA62 takeoff & landing performance calculator */

(function () {
  'use strict';

  // --- Performance tables (approximate — replace with actual AFM values) ---
  // Indexed: data[weightIdx][pressAltIdx][oatIdx] = distance in meters
  // Interpolation between points is trilinear

  var DA62_PERF = {
    // Takeoff ground roll
    takeoffRoll: {
      weights:   [1900, 2100, 2300],
      pressAlts: [0, 2000, 4000, 6000, 8000],
      oats:      [-10, 0, 10, 20, 30, 40],
      data: [
        // 1900 kg
        [
          [370, 400, 440, 475, 520, 565],
          [430, 470, 510, 555, 600, 660],
          [505, 545, 595, 650, 710, 780],
          [595, 645, 705, 770, 840, 925],
          [710, 770, 840, 920, 1010, null]
        ],
        // 2100 kg
        [
          [430, 465, 505, 550, 600, 655],
          [500, 545, 590, 645, 700, 770],
          [585, 635, 690, 755, 825, 910],
          [690, 750, 820, 895, 980, 1080],
          [825, 895, 980, 1070, 1175, null]
        ],
        // 2300 kg
        [
          [490, 530, 575, 625, 680, 745],
          [570, 620, 675, 735, 800, 880],
          [665, 725, 790, 860, 940, 1040],
          [790, 855, 935, 1020, 1120, 1235],
          [940, 1025, 1120, 1225, 1345, null]
        ]
      ]
    },

    // Takeoff distance over 50 ft obstacle
    takeoff50ft: {
      weights:   [1900, 2100, 2300],
      pressAlts: [0, 2000, 4000, 6000, 8000],
      oats:      [-10, 0, 10, 20, 30, 40],
      data: [
        // 1900 kg
        [
          [470, 510, 555, 600, 655, 715],
          [545, 595, 645, 700, 760, 835],
          [640, 695, 755, 820, 895, 990],
          [755, 815, 890, 975, 1065, 1175],
          [900, 975, 1065, 1165, 1280, null]
        ],
        // 2100 kg
        [
          [545, 590, 640, 695, 755, 825],
          [630, 685, 745, 810, 880, 970],
          [740, 805, 875, 955, 1040, 1150],
          [875, 945, 1035, 1130, 1235, 1360],
          [1045, 1130, 1235, 1350, 1480, null]
        ],
        // 2300 kg
        [
          [620, 670, 730, 790, 860, 940],
          [720, 780, 850, 920, 1000, 1100],
          [840, 910, 990, 1080, 1180, 1300],
          [990, 1070, 1170, 1280, 1400, 1540],
          [1180, 1280, 1400, 1530, 1680, null]
        ]
      ]
    },

    // Landing ground roll
    landingRoll: {
      weights:   [1900, 2100, 2300],
      pressAlts: [0, 2000, 4000, 6000, 8000],
      oats:      [-10, 0, 10, 20, 30, 40],
      data: [
        // 1900 kg
        [
          [280, 295, 310, 325, 340, 360],
          [305, 320, 335, 355, 370, 390],
          [330, 345, 365, 385, 405, 425],
          [360, 380, 400, 420, 440, 465],
          [395, 415, 435, 460, 485, null]
        ],
        // 2100 kg
        [
          [315, 330, 350, 365, 385, 405],
          [340, 360, 380, 400, 420, 440],
          [370, 390, 410, 430, 455, 480],
          [405, 425, 450, 470, 495, 525],
          [445, 465, 490, 520, 545, null]
        ],
        // 2300 kg
        [
          [350, 370, 390, 410, 430, 450],
          [380, 400, 420, 445, 465, 490],
          [415, 435, 460, 485, 510, 535],
          [455, 475, 500, 530, 555, 585],
          [495, 520, 550, 580, 610, null]
        ]
      ]
    },

    // Landing distance over 50 ft obstacle
    landing50ft: {
      weights:   [1900, 2100, 2300],
      pressAlts: [0, 2000, 4000, 6000, 8000],
      oats:      [-10, 0, 10, 20, 30, 40],
      data: [
        // 1900 kg
        [
          [470, 490, 510, 535, 560, 590],
          [510, 530, 555, 580, 610, 640],
          [550, 575, 605, 635, 665, 700],
          [600, 630, 660, 690, 725, 765],
          [655, 690, 720, 755, 795, null]
        ],
        // 2100 kg
        [
          [520, 545, 570, 595, 625, 655],
          [565, 590, 620, 650, 680, 715],
          [615, 645, 675, 710, 745, 785],
          [670, 705, 740, 775, 815, 855],
          [735, 770, 810, 850, 895, null]
        ],
        // 2300 kg
        [
          [570, 600, 630, 660, 690, 725],
          [620, 650, 685, 720, 755, 790],
          [680, 715, 750, 785, 825, 870],
          [745, 780, 820, 860, 905, 950],
          [815, 855, 900, 945, 995, null]
        ]
      ]
    },

    // Rate of climb (ft/min) — approximate, replace with AFM values
    // Vy ~88 KIAS for DA62
    climbVy: 88, // KIAS
    climbROC: {
      weights:   [1900, 2100, 2300],
      pressAlts: [0, 2000, 4000, 6000, 8000],
      oats:      [-10, 0, 10, 20, 30, 40],
      data: [
        // 1900 kg
        [
          [1450, 1380, 1310, 1240, 1170, 1100],
          [1250, 1180, 1110, 1040, 970, 900],
          [1050, 985, 915, 850, 780, 710],
          [860, 795, 730, 660, 590, 520],
          [680, 615, 550, 480, 410, null]
        ],
        // 2100 kg
        [
          [1250, 1180, 1110, 1040, 970, 900],
          [1050, 985, 915, 850, 780, 710],
          [860, 795, 730, 660, 590, 520],
          [680, 615, 550, 480, 410, 340],
          [510, 445, 380, 310, 240, null]
        ],
        // 2300 kg
        [
          [1080, 1010, 940, 870, 800, 730],
          [880, 815, 750, 680, 610, 540],
          [695, 630, 565, 500, 430, 360],
          [520, 455, 390, 325, 255, 185],
          [360, 295, 230, 165, 95, null]
        ]
      ]
    },

    // OEI (One Engine Inoperative) rate of climb (ft/min) — approximate, replace with AFM
    // Gear up, prop feathered, Vyse (blue line) ~88 KIAS
    // Service ceiling = altitude at 50 ft/min ROC
    oeiVyse: 88, // KIAS
    oeiROC: {
      weights:   [1900, 2100, 2300],
      pressAlts: [0, 2000, 4000, 6000, 8000, 10000, 12000],
      oats:      [-10, 0, 10, 20, 30, 40],
      data: [
        // 1900 kg — service ceiling ~11,000 ft ISA
        [
          [530, 490, 450, 405, 360, 315],
          [440, 400, 360, 315, 270, 225],
          [355, 315, 275, 230, 185, 140],
          [270, 230, 190, 150, 105, 60],
          [190, 150, 110, 70, 25, -20],
          [115, 75, 35, -5, -50, null],
          [40, 0, -40, -80, -120, null]
        ],
        // 2100 kg — service ceiling ~9,000 ft ISA
        [
          [420, 380, 340, 295, 250, 205],
          [335, 295, 255, 210, 165, 120],
          [250, 210, 170, 130, 85, 40],
          [170, 130, 90, 50, 5, -40],
          [95, 55, 15, -25, -70, -115],
          [20, -20, -60, -100, -145, null],
          [-50, -90, -130, -170, -215, null]
        ],
        // 2300 kg — service ceiling ~7,500 ft ISA
        [
          [320, 280, 240, 200, 155, 110],
          [240, 200, 160, 120, 75, 30],
          [160, 120, 80, 40, -5, -50],
          [85, 45, 5, -35, -80, -125],
          [10, -30, -70, -110, -155, -200],
          [-60, -100, -140, -180, -225, null],
          [-130, -170, -210, -250, -295, null]
        ]
      ]
    },

    // Wind correction factors (per knot)
    windCorrection: { headwindPerKt: -0.01, tailwindPerKt: 0.05 },

    // Surface factors
    surfaceFactors: {
      'Asphalt': 1.0, 'Concrete': 1.0, 'Macadam': 1.0,
      'Grass': 1.2, 'Gravel': 1.2, 'Sand': 1.3,
      'Earth': 1.2, 'Clay': 1.2, 'Snow': 1.25, 'Ice': 1.05
    }
  };

  // --- Calculation functions ---

  function calcPressureAlt(elevFt, qnhHpa) {
    if (qnhHpa == null) return elevFt;
    return elevFt + (1013.25 - qnhHpa) * 30;
  }

  function calcDensityAlt(pressAltFt, oatC) {
    if (oatC == null) return pressAltFt;
    // ISA temp at pressure altitude
    var isaTemp = 15 - (pressAltFt * 0.001981);
    var isaDev = oatC - isaTemp;
    return pressAltFt + (120 * isaDev);
  }

  // Linear interpolation helper
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  // Find bracketing index and fraction for value in sorted array
  function findBracket(arr, val) {
    if (val <= arr[0]) return { lo: 0, hi: 0, t: 0 };
    if (val >= arr[arr.length - 1]) return { lo: arr.length - 1, hi: arr.length - 1, t: 0 };
    for (var i = 0; i < arr.length - 1; i++) {
      if (val >= arr[i] && val <= arr[i + 1]) {
        var span = arr[i + 1] - arr[i];
        return { lo: i, hi: i + 1, t: span > 0 ? (val - arr[i]) / span : 0 };
      }
    }
    return { lo: arr.length - 1, hi: arr.length - 1, t: 0 };
  }

  // Trilinear interpolation: table.data[weight][pressAlt][oat]
  function interpolate3D(table, weight, pressAlt, oat) {
    var wb = findBracket(table.weights, weight);
    var pb = findBracket(table.pressAlts, pressAlt);
    var ob = findBracket(table.oats, oat);

    // Get 8 corner values
    function getVal(wi, pi, oi) {
      var row = table.data[wi];
      if (!row) return null;
      var pRow = row[pi];
      if (!pRow) return null;
      return pRow[oi];
    }

    var c000 = getVal(wb.lo, pb.lo, ob.lo);
    var c001 = getVal(wb.lo, pb.lo, ob.hi);
    var c010 = getVal(wb.lo, pb.hi, ob.lo);
    var c011 = getVal(wb.lo, pb.hi, ob.hi);
    var c100 = getVal(wb.hi, pb.lo, ob.lo);
    var c101 = getVal(wb.hi, pb.lo, ob.hi);
    var c110 = getVal(wb.hi, pb.hi, ob.lo);
    var c111 = getVal(wb.hi, pb.hi, ob.hi);

    // If any corner is null, try to extrapolate from available data
    var corners = [c000, c001, c010, c011, c100, c101, c110, c111];
    var validCorners = corners.filter(function (v) { return v != null; });
    if (validCorners.length === 0) return null;

    // Replace nulls with nearest valid value for graceful degradation
    function fallback(v, alternatives) {
      if (v != null) return v;
      for (var i = 0; i < alternatives.length; i++) {
        if (alternatives[i] != null) return alternatives[i];
      }
      return validCorners[0];
    }

    c000 = fallback(c000, [c001, c010, c100]);
    c001 = fallback(c001, [c000, c011, c101]);
    c010 = fallback(c010, [c011, c000, c110]);
    c011 = fallback(c011, [c010, c001, c111]);
    c100 = fallback(c100, [c101, c110, c000]);
    c101 = fallback(c101, [c100, c111, c001]);
    c110 = fallback(c110, [c111, c100, c010]);
    c111 = fallback(c111, [c110, c101, c011]);

    // Trilinear interpolation
    var c00 = lerp(c000, c001, ob.t);
    var c01 = lerp(c010, c011, ob.t);
    var c10 = lerp(c100, c101, ob.t);
    var c11 = lerp(c110, c111, ob.t);

    var c0 = lerp(c00, c01, pb.t);
    var c1 = lerp(c10, c11, pb.t);

    return lerp(c0, c1, wb.t);
  }

  // Wind component calculation
  function calcWindComponent(windDir, windSpd, rwyHdg) {
    if (windDir == null || windDir === 'VRB' || windSpd == null) {
      return { headwind: 0, crosswind: 0 };
    }
    var angle = (windDir - rwyHdg) * Math.PI / 180;
    return {
      headwind: Math.round(windSpd * Math.cos(angle)),
      crosswind: Math.round(Math.abs(windSpd * Math.sin(angle)))
    };
  }

  // Surface factor lookup
  function getSurfaceFactor(surface) {
    if (!surface) return 1.0;
    // Try exact match first, then substring
    if (DA62_PERF.surfaceFactors[surface] != null) return DA62_PERF.surfaceFactors[surface];
    var s = surface.toUpperCase();
    if (s.indexOf('ASPHALT') >= 0 || s.indexOf('CONCRETE') >= 0) return 1.0;
    if (s.indexOf('GRASS') >= 0 || s.indexOf('TURF') >= 0) return 1.2;
    if (s.indexOf('GRAVEL') >= 0) return 1.2;
    if (s.indexOf('SAND') >= 0) return 1.3;
    return 1.1; // unknown surface
  }

  // Calculate TAS from IAS given pressure altitude and OAT
  function iasToTas(iasKt, pressAltFt, oatC) {
    // Approximate: TAS = IAS × sqrt(rho0/rho)
    // Using density ratio from ISA deviation
    var isaTemp = 15 - (pressAltFt * 0.001981);
    var tempK = (oatC != null ? oatC : isaTemp) + 273.15;
    var isaTempK = isaTemp + 273.15;
    // Pressure ratio from altitude
    var pressRatio = Math.pow(1 - 0.0000068756 * pressAltFt, 5.2559);
    // Density ratio
    var densRatio = pressRatio * (isaTempK / tempK);
    return iasKt / Math.sqrt(densRatio);
  }

  // Calculate climb performance for one runway end
  function calcClimbPerf(pressAlt, oat, weightKg, headwindKt) {
    var roc = interpolate3D(DA62_PERF.climbROC, weightKg, pressAlt, oat);
    if (roc == null || roc <= 0) return null;

    var vyTas = iasToTas(DA62_PERF.climbVy, pressAlt, oat);
    // Ground speed in climb = TAS - headwind (positive HW reduces GS)
    var gs = vyTas - headwindKt;
    if (gs < 30) gs = 30; // floor at 30kt to avoid extreme gradients

    // Gradient: ft gained per NM over ground
    // ft/NM = ROC (ft/min) / GS (NM/min) = ROC × 60 / GS
    var gradFtNm = roc * 60 / gs;
    // Gradient as percentage: rise/run
    // 1 NM = 6076.12 ft, so gradient % = (gradFtNm / 6076.12) × 100
    var gradPct = (gradFtNm / 6076.12) * 100;

    return {
      roc: Math.round(roc),
      gradPct: gradPct,
      gradFtNm: Math.round(gradFtNm),
      tas: Math.round(vyTas),
      gs: Math.round(gs)
    };
  }

  // OEI ceiling: find the pressure altitude where OEI ROC drops to 0 ft/min
  // Uses bisection search between 0 and 15000 ft
  function calcOeiCeiling(weightKg, oatC) {
    var oat = (oatC != null) ? oatC : 15;
    var lo = 0, hi = 15000;

    // Check if we have positive ROC at sea level
    var rocAtSL = interpolate3D(DA62_PERF.oeiROC, weightKg, 0, oat);
    if (rocAtSL == null || rocAtSL <= 0) return 0; // can't climb even at sea level

    // Bisection: find altitude where ROC = 0
    for (var iter = 0; iter < 30; iter++) {
      var mid = (lo + hi) / 2;
      var roc = interpolate3D(DA62_PERF.oeiROC, weightKg, mid, oat);
      if (roc == null) { hi = mid; continue; }
      if (roc > 0) {
        lo = mid;
      } else {
        hi = mid;
      }
      if (hi - lo < 10) break;
    }
    return Math.round(lo / 100) * 100; // round to nearest 100 ft
  }

  // OEI performance summary for display
  function calcOeiPerf(pressAlt, oat, weightKg) {
    var roc = interpolate3D(DA62_PERF.oeiROC, weightKg, pressAlt, oat);
    var ceiling = calcOeiCeiling(weightKg, oat);
    return {
      roc: roc != null ? Math.round(roc) : null,
      ceiling: ceiling
    };
  }

  // Calculate performance for one runway end
  function calcRunwayPerf(rwyLenM, rwyHdg, surface, elevFt, metar, weightKg) {
    var qnh = metar ? metar.altim : 1013;
    var oat = metar ? metar.temp : 15;
    var wdir = metar ? metar.wdir : null;
    var wspd = metar ? metar.wspd : 0;

    var pressAlt = calcPressureAlt(elevFt, qnh);
    var densAlt = calcDensityAlt(pressAlt, oat);

    // Base distances from tables
    var toRoll = interpolate3D(DA62_PERF.takeoffRoll, weightKg, pressAlt, oat);
    var to50 = interpolate3D(DA62_PERF.takeoff50ft, weightKg, pressAlt, oat);
    var ldgRoll = interpolate3D(DA62_PERF.landingRoll, weightKg, pressAlt, oat);
    var ldg50 = interpolate3D(DA62_PERF.landing50ft, weightKg, pressAlt, oat);

    if (toRoll == null || to50 == null || ldgRoll == null || ldg50 == null) {
      return null; // outside table range
    }

    // Wind correction
    var wind = calcWindComponent(wdir, wspd, rwyHdg);
    var windFactor;
    if (wind.headwind >= 0) {
      windFactor = 1 + wind.headwind * DA62_PERF.windCorrection.headwindPerKt;
    } else {
      windFactor = 1 + Math.abs(wind.headwind) * DA62_PERF.windCorrection.tailwindPerKt;
    }
    // Clamp wind factor to reasonable range
    windFactor = Math.max(0.5, Math.min(2.0, windFactor));

    // Surface factor
    var surfFactor = getSurfaceFactor(surface);

    toRoll = Math.round(toRoll * windFactor * surfFactor);
    to50 = Math.round(to50 * windFactor * surfFactor);
    // Landing: only ground roll affected by surface, 50ft distance includes air segment
    ldgRoll = Math.round(ldgRoll * windFactor * surfFactor);
    ldg50 = Math.round(ldg50 * windFactor);

    // Climb performance (wind-adjusted ground gradient)
    var climb = calcClimbPerf(pressAlt, oat, weightKg, wind.headwind);

    return {
      toRoll: toRoll,
      to50: to50,
      ldgRoll: ldgRoll,
      ldg50: ldg50,
      rwyLen: rwyLenM,
      toMargin: rwyLenM - to50,
      ldgMargin: rwyLenM - ldg50,
      headwind: wind.headwind,
      crosswind: wind.crosswind,
      pressAlt: Math.round(pressAlt),
      densAlt: Math.round(densAlt),
      oat: oat,
      qnh: qnh,
      tailwind: wind.headwind < 0,
      surfFactor: surfFactor,
      climb: climb
    };
  }

  // Read ramp weight from W&B results DOM
  function getRampWeight() {
    var resultsDiv = document.getElementById('wb-results');
    if (!resultsDiv) return 2300;
    var text = resultsDiv.textContent || '';
    var m = text.match(/Ramp:\s*(\d+)\s*kg/);
    return m ? parseInt(m[1], 10) : 2300;
  }

  // --- Rendering ---

  function renderPerfInPopup(el, icao, runways, elevation) {
    var app = window.AirportApp;
    var metar = app.metarCache ? app.metarCache[icao] : null;

    var weightKg = getRampWeight();
    var elevFt = parseFloat(elevation) || 0;

    var qnh = metar ? metar.altim : null;
    var oat = metar ? metar.temp : null;
    var pressAlt = calcPressureAlt(elevFt, qnh || 1013);
    var densAlt = calcDensityAlt(pressAlt, oat != null ? oat : 15);
    var wdir = metar ? metar.wdir : null;
    var wspd = metar ? metar.wspd : null;

    var html = '<div class="perf-container">';

    // Header with weight input
    html += '<div class="perf-header">';
    html += '<span class="perf-title">Performance (DA62)</span>';
    html += '<span class="perf-weight-box">Weight: <input type="number" class="perf-weight-input" value="' + weightKg + '" min="1600" max="2400" step="10"> kg</span>';
    html += '</div>';

    // Atmospheric conditions
    if (metar) {
      html += '<div class="perf-atmo">';
      html += 'PA: ' + Math.round(pressAlt) + ' ft';
      if (oat != null) html += ' · OAT: ' + oat + '°C';
      html += ' · DA: ' + Math.round(densAlt) + ' ft';
      if (qnh != null) html += ' · QNH: ' + qnh + ' hPa';
      html += '</div>';
    } else {
      html += '<div class="perf-atmo perf-atmo-manual">';
      html += '<span class="perf-no-metar">No METAR</span> ';
      html += 'OAT: <input type="number" class="perf-manual-input" data-field="oat" value="15" step="1"> °C ';
      html += 'QNH: <input type="number" class="perf-manual-input" data-field="qnh" value="1013" step="1"> hPa';
      html += '</div>';
    }

    // Build runway results
    html += '<div class="perf-table-wrap">';
    html += buildRunwayTable(runways, elevFt, metar, weightKg);
    html += '</div>';

    // Wind info
    if (metar && wdir != null && wspd != null) {
      var windStr = (wdir === 'VRB' ? 'VRB' : String(wdir).padStart(3, '0') + '°');
      windStr += '/' + wspd + 'kt';
      if (metar.wgst) windStr += ' G' + metar.wgst + 'kt';
      html += '<div class="perf-wind">Wind: ' + windStr + '</div>';
    }

    // OEI (single engine) performance
    var oeiOat = oat != null ? oat : 15;
    var oeiQnh = qnh || 1013;
    var oei = calcOeiPerf(pressAlt, oeiOat, weightKg);
    // Convert PA ceiling to MSL for display (AMA comparison uses MSL)
    var oeiCeilMsl = Math.round(oei.ceiling - (1013.25 - oeiQnh) * 30);
    html += '<div class="perf-oei">';
    html += '<span class="perf-oei-title">Single Engine (OEI)</span>';
    html += '<span class="perf-oei-data">';
    html += 'Ceiling: <span class="' + (oeiCeilMsl < 5000 ? 'perf-warn' : '') + '">' + oeiCeilMsl + ' ft MSL</span>';
    if (oei.roc != null) {
      html += ' · ROC at field: <span class="' + (oei.roc <= 0 ? 'perf-warn' : '') + '">' + oei.roc + ' ft/min</span>';
    }
    html += '</span></div>';

    html += '</div>';
    el.innerHTML = html;

    // Wire up weight input
    var weightInput = el.querySelector('.perf-weight-input');
    if (weightInput) {
      weightInput.addEventListener('input', function () {
        var w = parseInt(this.value, 10);
        if (isNaN(w) || w < 1000) return;
        var tableDiv = el.querySelector('.perf-table-wrap');
        if (tableDiv) {
          tableDiv.innerHTML = buildRunwayTable(runways, elevFt, metar, w);
        }
      });
    }

    // Wire up manual OAT/QNH inputs (no-METAR mode)
    var manualInputs = el.querySelectorAll('.perf-manual-input');
    if (manualInputs.length > 0) {
      manualInputs.forEach(function (inp) {
        inp.addEventListener('input', function () {
          var oatInput = el.querySelector('.perf-manual-input[data-field="oat"]');
          var qnhInput = el.querySelector('.perf-manual-input[data-field="qnh"]');
          var manualOat = oatInput ? parseInt(oatInput.value, 10) : 15;
          var manualQnh = qnhInput ? parseInt(qnhInput.value, 10) : 1013;
          if (isNaN(manualOat)) manualOat = 15;
          if (isNaN(manualQnh)) manualQnh = 1013;
          var fakeMet = { temp: manualOat, altim: manualQnh, wdir: null, wspd: null };
          var w = parseInt(weightInput.value, 10) || 2300;

          // Update atmosphere line
          var pa = calcPressureAlt(elevFt, manualQnh);
          var da = calcDensityAlt(pa, manualOat);
          var atmoEl = el.querySelector('.perf-atmo');
          if (atmoEl) {
            var atmoHtml = '<span class="perf-no-metar">No METAR</span> ';
            atmoHtml += 'OAT: <input type="number" class="perf-manual-input" data-field="oat" value="' + manualOat + '" step="1"> °C ';
            atmoHtml += 'QNH: <input type="number" class="perf-manual-input" data-field="qnh" value="' + manualQnh + '" step="1"> hPa';
            atmoHtml += '<br>PA: ' + Math.round(pa) + ' ft · DA: ' + Math.round(da) + ' ft';
            atmoEl.innerHTML = atmoHtml;
            // Re-bind manual inputs after re-render
            bindManualInputs(el, runways, elevFt, weightInput);
          }

          var tableDiv = el.querySelector('.perf-table-wrap');
          if (tableDiv) {
            tableDiv.innerHTML = buildRunwayTable(runways, elevFt, fakeMet, w);
          }
        });
      });
    }
  }

  // Helper to (re)bind manual input listeners
  function bindManualInputs(el, runways, elevFt, weightInput) {
    var manualInputs = el.querySelectorAll('.perf-manual-input');
    manualInputs.forEach(function (inp) {
      inp.addEventListener('input', function () {
        var oatInput = el.querySelector('.perf-manual-input[data-field="oat"]');
        var qnhInput = el.querySelector('.perf-manual-input[data-field="qnh"]');
        var manualOat = oatInput ? parseInt(oatInput.value, 10) : 15;
        var manualQnh = qnhInput ? parseInt(qnhInput.value, 10) : 1013;
        if (isNaN(manualOat)) manualOat = 15;
        if (isNaN(manualQnh)) manualQnh = 1013;
        var fakeMet = { temp: manualOat, altim: manualQnh, wdir: null, wspd: null };
        var w = parseInt(weightInput.value, 10) || 2300;

        var pa = calcPressureAlt(elevFt, manualQnh);
        var da = calcDensityAlt(pa, manualOat);
        var atmoEl = el.querySelector('.perf-atmo');
        if (atmoEl) {
          var atmoHtml = '<span class="perf-no-metar">No METAR</span> ';
          atmoHtml += 'OAT: <input type="number" class="perf-manual-input" data-field="oat" value="' + manualOat + '" step="1"> °C ';
          atmoHtml += 'QNH: <input type="number" class="perf-manual-input" data-field="qnh" value="' + manualQnh + '" step="1"> hPa';
          atmoHtml += '<br>PA: ' + Math.round(pa) + ' ft · DA: ' + Math.round(da) + ' ft';
          atmoEl.innerHTML = atmoHtml;
          bindManualInputs(el, runways, elevFt, weightInput);
        }

        var tableDiv = el.querySelector('.perf-table-wrap');
        if (tableDiv) {
          tableDiv.innerHTML = buildRunwayTable(runways, elevFt, fakeMet, w);
        }
      });
    });
  }

  function buildRunwayTable(runways, elevFt, metar, weightKg) {
    if (!runways || runways.length === 0) {
      return '<div class="perf-no-data">No runway data available</div>';
    }

    // Parse all runway ends and compute performance
    var results = [];
    for (var i = 0; i < runways.length; i++) {
      var rwy = runways[i];
      var designator = rwy[0]; // designator
      var lengthFt = rwy[1];   // length in ft
      var surface = rwy[3];    // surface type
      var lenM = Math.round(lengthFt * 0.3048);

      var parts = designator.split('/');
      for (var j = 0; j < parts.length; j++) {
        var p = parts[j].trim();
        var m = p.match(/^(\d{1,2})/);
        if (m) {
          var hdg = parseInt(m[1], 10) * 10;
          var perf = calcRunwayPerf(lenM, hdg, surface, elevFt, metar, weightKg);
          if (perf) {
            perf.name = p;
            perf.surface = surface;
            results.push(perf);
          }
        }
      }
    }

    if (results.length === 0) {
      return '<div class="perf-no-data">Cannot calculate performance for these conditions</div>';
    }

    // Find best runway (highest TO margin, headwind preferred)
    var bestIdx = 0;
    var bestMargin = -Infinity;
    for (var i = 0; i < results.length; i++) {
      if (results[i].toMargin > bestMargin) {
        bestMargin = results[i].toMargin;
        bestIdx = i;
      }
    }

    var html = '<table class="perf-table">';
    html += '<thead><tr>';
    html += '<th>RWY</th>';
    html += '<th>Avail</th>';
    html += '<th>TO 50ft</th>';
    html += '<th>LDG 50ft</th>';
    html += '<th>TO mgn</th>';
    html += '<th>LDG mgn</th>';
    html += '<th title="Climb gradient over ground">Climb</th>';
    html += '</tr></thead><tbody>';

    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      var isBest = (i === bestIdx);
      var toMgnCls = r.toMargin >= 0 ? 'perf-ok' : 'perf-warn';
      var ldgMgnCls = r.ldgMargin >= 0 ? 'perf-ok' : 'perf-warn';
      var rowCls = isBest ? ' class="perf-best"' : '';
      var twFlag = r.tailwind ? ' <span class="perf-tw" title="Tailwind">TW</span>' : '';
      var bestLabel = isBest ? ' <span class="perf-best-label">BEST</span>' : '';

      // Climb gradient cell
      var climbHtml = '';
      var climbCls = '';
      if (r.climb) {
        climbCls = r.climb.gradPct >= 3.3 ? 'perf-ok' : 'perf-climb-low';
        climbHtml = r.climb.gradPct.toFixed(1) + '%';
      } else {
        climbHtml = '—';
      }

      html += '<tr' + rowCls + '>';
      html += '<td class="perf-rwy">' + escapeHtml(r.name) + bestLabel + twFlag + '</td>';
      html += '<td>' + r.rwyLen + ' m</td>';
      html += '<td>' + r.to50 + ' m</td>';
      html += '<td>' + r.ldg50 + ' m</td>';
      html += '<td class="' + toMgnCls + '">' + formatMargin(r.toMargin) + '</td>';
      html += '<td class="' + ldgMgnCls + '">' + formatMargin(r.ldgMargin) + '</td>';
      html += '<td class="' + climbCls + '" title="' + (r.climb ? r.climb.gradFtNm + ' ft/NM · ROC ' + r.climb.roc + ' ft/min · GS ' + r.climb.gs + 'kt' : '') + '">' + climbHtml + '</td>';
      html += '</tr>';

      // Detail row: headwind/crosswind + surface factor + climb detail
      var details = [];
      if (r.headwind !== 0) {
        details.push((r.headwind > 0 ? 'HW ' : 'TW ') + Math.abs(r.headwind) + 'kt');
      }
      if (r.crosswind > 0) {
        details.push('XW ' + r.crosswind + 'kt');
      }
      if (r.surfFactor > 1.0) {
        details.push(escapeHtml(r.surface || '?') + ' ×' + r.surfFactor.toFixed(1));
      }
      if (r.climb) {
        details.push('ROC ' + r.climb.roc + ' ft/min · ' + r.climb.gradFtNm + ' ft/NM');
      }
      if (details.length > 0) {
        html += '<tr class="perf-detail-row' + (isBest ? ' perf-best' : '') + '">';
        html += '<td colspan="7" class="perf-detail">' + details.join(' · ') + '</td>';
        html += '</tr>';
      }
    }

    html += '</tbody></table>';
    return html;
  }

  function formatMargin(m) {
    if (m >= 0) return '+' + m + ' m';
    return m + ' m';
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;');
  }

  // Expose on window.AirportApp
  window.AirportApp = window.AirportApp || {};
  window.AirportApp.renderPerfInPopup = renderPerfInPopup;
  window.AirportApp.DA62_PERF = DA62_PERF;
  window.AirportApp.calcOeiCeiling = calcOeiCeiling;

})();
