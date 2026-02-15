/* da62-perf.js - DA62 takeoff & landing performance calculator */
/* Performance data from DA62 AFM Doc. No. 11.01.05-E */

(function () {
  'use strict';

  // --- Performance tables from AFM ---
  // Indexed: data[weightIdx][pressAltIdx][oatIdx] = value
  // Interpolation between points is trilinear

  var DA62_PERF = {
    // Takeoff ground roll (meters) — AFM Section 5.3.6, Normal Procedure, Flaps T/O, Power MAX
    takeoffRoll: {
      weights:   [1800, 1900, 1999, 2100, 2200, 2300],
      pressAlts: [0, 2000, 4000, 6000, 8000, 10000],
      oats:      [0, 10, 20, 30, 40, 50],
      data: [
        // 1800 kg
        [
          [320, 340, 360, 380, 430, 490],
          [360, 380, 400, 440, 500, 570],
          [400, 430, 450, 510, 580, 660],
          [460, 490, 520, 600, 680, null],
          [540, 580, 630, 720, 820, null],
          [640, 690, 780, 890, null, null]
        ],
        // 1900 kg
        [
          [340, 360, 380, 410, 460, 520],
          [380, 400, 430, 460, 530, 600],
          [430, 450, 480, 530, 610, 700],
          [490, 520, 560, 640, 730, null],
          [570, 610, 670, 750, 870, null],
          [680, 730, 820, 950, null, null]
        ],
        // 1999 kg
        [
          [360, 380, 400, 430, 490, 550],
          [400, 420, 450, 490, 560, 640],
          [450, 480, 510, 570, 650, 740],
          [520, 550, 590, 670, 760, null],
          [610, 650, 710, 810, 930, null],
          [720, 770, 870, 1000, null, null]
        ],
        // 2100 kg
        [
          [400, 430, 450, 490, 550, 620],
          [450, 480, 510, 550, 630, 720],
          [510, 540, 570, 640, 730, 830],
          [580, 620, 660, 760, 860, null],
          [680, 730, 800, 920, 1050, null],
          [810, 870, 990, 1130, null, null]
        ],
        // 2200 kg
        [
          [420, 450, 480, 510, 570, 660],
          [480, 510, 540, 580, 660, 750],
          [540, 570, 610, 670, 770, 880],
          [620, 650, 700, 800, 910, null],
          [720, 770, 850, 970, 1100, null],
          [860, 920, 1040, 1190, null, null]
        ],
        // 2300 kg
        [
          [450, 470, 500, 540, 600, 690],
          [500, 530, 560, 610, 700, 790],
          [560, 600, 640, 710, 810, 920],
          [650, 690, 730, 840, 960, null],
          [760, 810, 890, 1020, 1160, null],
          [900, 970, 1090, 1260, null, null]
        ]
      ]
    },

    // Takeoff distance over 50 ft/15 m obstacle (meters) — AFM Section 5.3.6
    takeoff50ft: {
      weights:   [1800, 1900, 1999, 2100, 2200, 2300],
      pressAlts: [0, 2000, 4000, 6000, 8000, 10000],
      oats:      [0, 10, 20, 30, 40, 50],
      data: [
        // 1800 kg
        [
          [490, 510, 550, 590, 670, 770],
          [540, 570, 600, 670, 770, 890],
          [610, 650, 690, 780, 900, 1050],
          [710, 750, 800, 930, 1070, null],
          [830, 890, 990, 1130, 1290, null],
          [1000, 1080, 1210, 1390, null, null]
        ],
        // 1900 kg
        [
          [540, 570, 600, 650, 740, 860],
          [600, 640, 680, 750, 850, 970],
          [680, 720, 770, 860, 980, 1120],
          [780, 830, 880, 1010, 1150, null],
          [910, 970, 1080, 1230, 1390, null],
          [1070, 1150, 1300, 1490, null, null]
        ],
        // 1999 kg
        [
          [590, 630, 660, 710, 800, 910],
          [660, 700, 740, 800, 910, 1040],
          [730, 770, 820, 900, 1050, 1200],
          [840, 880, 940, 1080, 1230, null],
          [970, 1030, 1140, 1300, 1480, null],
          [1150, 1230, 1390, 1600, null, null]
        ],
        // 2100 kg
        [
          [680, 720, 760, 810, 910, 1060],
          [760, 800, 840, 910, 1060, 1210],
          [850, 900, 960, 1060, 1220, 1400],
          [970, 1030, 1100, 1260, 1430, null],
          [1130, 1200, 1330, 1520, 1740, null],
          [1340, 1440, 1630, 1880, null, null]
        ],
        // 2200 kg
        [
          [730, 770, 820, 870, 980, 1130],
          [810, 860, 910, 990, 1130, 1290],
          [910, 960, 1020, 1110, 1300, 1490],
          [1040, 1100, 1170, 1340, 1530, null],
          [1200, 1280, 1420, 1630, 1860, null],
          [1430, 1540, 1740, 2020, null, null]
        ],
        // 2300 kg
        [
          [780, 820, 860, 930, 1050, 1200],
          [860, 910, 970, 1050, 1200, 1370],
          [960, 1020, 1080, 1210, 1390, 1590],
          [1100, 1160, 1250, 1430, 1640, null],
          [1280, 1370, 1520, 1740, 1990, null],
          [1530, 1650, 1870, 2170, null, null]
        ]
      ]
    },

    // Landing ground roll (meters) — AFM Section 5.3.12, Flaps LDG, Power IDLE
    landingRoll: {
      weights:   [1800, 1900, 1999, 2100, 2200, 2300],
      pressAlts: [0, 2000, 4000, 6000, 8000, 10000],
      oats:      [0, 10, 20, 30, 40, 50],
      data: [
        // 1800 kg
        [
          [330, 350, 360, 370, 400, 440],
          [360, 370, 380, 400, 440, 490],
          [440, 460, 470, 510, 560, 610],
          [510, 520, 540, 600, 660, null],
          [650, 670, 720, 790, 870, null],
          [950, 980, 1060, 1170, null, null]
        ],
        // 1900 kg
        [
          [350, 360, 380, 390, 420, 460],
          [380, 390, 410, 420, 470, 510],
          [470, 490, 500, 530, 590, 650],
          [540, 560, 580, 640, 700, null],
          [680, 710, 750, 830, 910, null],
          [980, 1000, 1090, 1200, null, null]
        ],
        // 1999 kg
        [
          [370, 390, 390, 410, 440, 490],
          [400, 410, 420, 440, 490, 540],
          [490, 510, 530, 560, 620, 680],
          [570, 590, 610, 670, 740, null],
          [710, 740, 790, 870, 960, null],
          [1010, 1030, 1120, 1230, null, null]
        ],
        // 2100 kg
        [
          [390, 400, 410, 430, 470, 510],
          [420, 430, 450, 470, 510, 560],
          [520, 540, 550, 590, 660, 720],
          [600, 620, 640, 710, 780, null],
          [740, 770, 820, 910, 1000, null],
          [1030, 1060, 1160, 1270, null, null]
        ],
        // 2200 kg
        [
          [410, 420, 430, 450, 490, 540],
          [440, 450, 470, 490, 540, 590],
          [540, 560, 580, 630, 690, 760],
          [630, 650, 670, 740, 810, null],
          [780, 800, 850, 940, 1040, null],
          [1060, 1100, 1190, 1310, null, null]
        ],
        // 2300 kg
        [
          [420, 440, 450, 470, 510, 560],
          [460, 470, 490, 510, 560, 620],
          [570, 590, 610, 650, 720, 790],
          [660, 680, 700, 770, 850, null],
          [810, 840, 890, 980, 1080, null],
          [1090, 1130, 1220, 1350, null, null]
        ]
      ]
    },

    // Landing distance over 50 ft/15 m obstacle (meters) — AFM Section 5.3.12, Flaps LDG
    landing50ft: {
      weights:   [1800, 1900, 1999, 2100, 2200, 2300],
      pressAlts: [0, 2000, 4000, 6000, 8000, 10000],
      oats:      [0, 10, 20, 30, 40, 50],
      data: [
        // 1800 kg
        [
          [660, 680, 700, 720, 770, 850],
          [700, 720, 740, 770, 840, 920],
          [800, 820, 840, 900, 1000, 1080],
          [880, 910, 930, 1020, 1120, null],
          [1040, 1070, 1130, 1240, 1360, null],
          [1360, 1400, 1510, 1660, null, null]
        ],
        // 1900 kg
        [
          [670, 690, 710, 730, 790, 860],
          [710, 730, 750, 780, 860, 930],
          [820, 840, 860, 930, 1010, 1100],
          [900, 930, 950, 1040, 1140, null],
          [1060, 1090, 1150, 1270, 1390, null],
          [1370, 1400, 1510, 1670, null, null]
        ],
        // 1999 kg
        [
          [680, 700, 720, 740, 800, 870],
          [720, 740, 760, 790, 870, 950],
          [830, 850, 880, 940, 1030, 1120],
          [920, 950, 970, 1070, 1170, null],
          [1080, 1110, 1170, 1290, 1410, null],
          [1390, 1420, 1540, 1690, null, null]
        ],
        // 2100 kg
        [
          [730, 750, 770, 790, 860, 940],
          [780, 800, 820, 850, 930, 1020],
          [890, 920, 940, 1010, 1100, 1200],
          [990, 1020, 1040, 1150, 1260, null],
          [1150, 1190, 1250, 1380, 1510, null],
          [1460, 1500, 1620, 1780, null, null]
        ],
        // 2200 kg
        [
          [740, 760, 780, 800, 870, 950],
          [790, 810, 830, 860, 950, 1030],
          [910, 930, 960, 1020, 1120, 1230],
          [1010, 1040, 1070, 1170, 1280, null],
          [1170, 1210, 1270, 1400, 1530, null],
          [1470, 1520, 1640, 1800, null, null]
        ],
        // 2300 kg
        [
          [750, 770, 790, 810, 880, 960],
          [800, 820, 840, 870, 960, 1050],
          [920, 950, 970, 1040, 1140, 1250],
          [1020, 1050, 1080, 1190, 1300, null],
          [1190, 1230, 1290, 1420, 1560, null],
          [1490, 1530, 1660, 1820, null, null]
        ]
      ]
    },

    // Rate of climb — all engines (ft/min) — approximate
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

    // OEI (One Engine Inoperative) rate of climb (ft/min) — AFM Section 5.3.9
    // Flaps UP, gear retracted, dead engine feathered & secured, remaining engine 95% load
    // Vyse: 89 KIAS for 2200-2300 kg, 87 KIAS for 1800-2100 kg
    // Gradient [%] = ROC [fpm] / TAS [KIAS] * 0.98
    oeiVyse: 88, // KIAS (average between 87 and 89)
    oeiROC: {
      weights:   [1800, 1900, 1999, 2100, 2200, 2300],
      pressAlts: [0, 2000, 4000, 6000, 8000, 10000, 12000, 14000, 16000, 18000, 20000],
      oats:      [-20, -10, 0, 10, 20, 30, 40, 50],
      data: [
        // 1800 kg (Vyse 87 KIAS)
        [
          [425, 415, 410, 400, 390, 380, 350, 300],
          [410, 400, 390, 380, 370, 360, 320, 270],
          [390, 380, 365, 355, 345, 330, 290, 235],
          [365, 355, 345, 335, 325, 295, 250, null],
          [345, 335, 320, 310, 295, 250, 200, null],
          [320, 305, 295, 280, 245, 195, null, null],
          [290, 275, 260, 235, 180, 125, null, null],
          [240, 220, 195, 150, 85, 20, null, null],
          [170, 150, 115, 60, 0, null, null, null],
          [90, 70, 40, -20, -75, null, null, null],
          [20, 0, -40, -100, null, null, null, null]
        ],
        // 1900 kg (Vyse 87 KIAS)
        [
          [375, 365, 355, 345, 335, 330, 300, 255],
          [360, 345, 335, 325, 315, 305, 275, 225],
          [335, 325, 315, 305, 295, 280, 240, 190],
          [315, 305, 295, 285, 270, 245, 205, null],
          [295, 280, 270, 255, 240, 205, 155, null],
          [270, 255, 240, 225, 195, 150, null, null],
          [240, 225, 210, 185, 135, 80, null, null],
          [190, 170, 145, 100, 40, -15, null, null],
          [120, 100, 70, 15, -40, null, null, null],
          [45, 25, -5, -60, -110, null, null, null],
          [-25, -45, -80, -140, null, null, null, null]
        ],
        // 1999 kg (Vyse 87 KIAS)
        [
          [325, 320, 310, 300, 290, 280, 255, 210],
          [310, 300, 290, 280, 270, 260, 225, 185],
          [290, 280, 265, 255, 245, 230, 195, 150],
          [265, 255, 245, 235, 225, 200, 160, null],
          [245, 235, 220, 210, 195, 160, 115, null],
          [220, 205, 190, 180, 150, 105, null, null],
          [190, 175, 160, 135, 90, 40, null, null],
          [140, 120, 95, 55, 0, -55, null, null],
          [75, 55, 25, -25, -75, null, null, null],
          [0, -20, -50, -100, -145, null, null, null],
          [-65, -85, -120, -175, null, null, null, null]
        ],
        // 2100 kg (Vyse 87 KIAS)
        [
          [280, 275, 260, 250, 245, 235, 210, 170],
          [265, 250, 240, 230, 220, 210, 185, 145],
          [245, 230, 220, 210, 200, 185, 155, 110],
          [220, 210, 200, 185, 175, 150, 120, null],
          [200, 185, 175, 160, 145, 115, 75, null],
          [175, 160, 145, 130, 105, 60, null, null],
          [145, 130, 115, 90, 45, -5, null, null],
          [95, 75, 50, 10, -45, -95, null, null],
          [30, 5, -20, -70, -120, null, null, null],
          [-45, -65, -95, -140, -185, null, null, null],
          [-115, -130, -165, -220, null, null, null, null]
        ],
        // 2200 kg (Vyse 89 KIAS)
        [
          [240, 230, 220, 210, 200, 190, 170, 130],
          [220, 210, 200, 190, 180, 170, 145, 105],
          [200, 190, 175, 165, 155, 140, 110, 75],
          [175, 165, 155, 145, 130, 110, 80, null],
          [155, 140, 130, 115, 100, 75, 35, null],
          [130, 115, 100, 85, 60, 25, null, null],
          [100, 85, 70, 45, 5, -40, null, null],
          [50, 30, 5, -30, -80, -130, null, null],
          [-15, -35, -65, -110, -155, null, null, null],
          [-85, -105, -135, -180, -225, null, null, null],
          [-150, -170, -205, -250, null, null, null, null]
        ],
        // 2300 kg (Vyse 89 KIAS)
        [
          [200, 190, 180, 170, 160, 150, 130, 95],
          [180, 170, 160, 145, 135, 125, 105, 70],
          [160, 145, 135, 125, 115, 100, 75, 40],
          [135, 125, 115, 100, 90, 70, 40, null],
          [115, 100, 85, 75, 60, 35, 0, null],
          [85, 70, 60, 45, 20, -15, null, null],
          [55, 40, 25, 0, -35, -75, null, null],
          [10, -10, -35, -70, -120, -160, null, null],
          [-55, -75, -105, -145, -190, null, null, null],
          [-125, -145, -175, -215, -255, null, null, null],
          [-190, -210, -240, -285, null, null, null, null]
        ]
      ]
    },

    // Wind correction factors (per knot of wind component)
    // AFM: TO headwind -10% per 12kt, tailwind +10% per 3kt
    // AFM: LDG headwind -10% per 20kt, tailwind +10% per 3kt
    windCorrection: { headwindPerKt: -0.00833, tailwindPerKt: 0.0333 },

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
    // Approximate: TAS = IAS x sqrt(rho0/rho)
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
    // ft/NM = ROC (ft/min) / GS (NM/min) = ROC x 60 / GS
    var gradFtNm = roc * 60 / gs;
    // Gradient as percentage: rise/run
    // 1 NM = 6076.12 ft, so gradient % = (gradFtNm / 6076.12) x 100
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
  // Uses bisection search between 0 and 20000 ft
  function calcOeiCeiling(weightKg, oatC) {
    var oat = (oatC != null) ? oatC : 15;
    var lo = 0, hi = 20000;

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
