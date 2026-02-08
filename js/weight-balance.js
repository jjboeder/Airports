/* weight-balance.js - DA62 Weight & Balance calculator */

(function () {
  'use strict';

  var DA62_WB = {
    emptyWeight: 1687,
    emptyCG: 2.374,
    maxRamp: 2308,
    mtow: 2300,
    maxLdg: 2300,
    maxZFW: 2200,
    fuelDensity: 3.043, // kg per US gallon (JET-A1)
    stations: {
      noseRH:   { arm: 0.051, maxKg: 18 },
      noseLH:   { arm: 0.47,  maxKg: 18 },
      deIce:    { arm: 0.899, maxKg: 27 },
      front:    { arm: 2.301, maxKg: 220 },
      row1:     { arm: 3.251, maxKg: 220 },
      tailA:    { arm: 4.06,  maxKg: 45 },
      tailBCD:  { arm: 4.18,  maxKg: 20 },
      fuelMain: { arm: 2.629, maxKg: 159 },
      fuelAux:  { arm: 3.2,   maxKg: 116 }
    },
    // CG envelope from POH
    envelopeFwd: [
      { wt: 1600, cg: 2.34 },
      { wt: 1800, cg: 2.34 },
      { wt: 2300, cg: 2.46 }
    ],
    envelopeAft: [
      { wt: 1600, cg: 2.46 },
      { wt: 1900, cg: 2.51 },
      { wt: 1999, cg: 2.51 },
      { wt: 2300, cg: 2.53 }
    ]
  };

  // SVG dimensions and plot area
  var SVG_W = 248, SVG_H = 140;
  var PAD = { top: 10, right: 10, bottom: 22, left: 36 };
  var PLOT_W = SVG_W - PAD.left - PAD.right;
  var PLOT_H = SVG_H - PAD.top - PAD.bottom;

  // Axis ranges
  var CG_MIN = 2.3, CG_MAX = 2.55;
  var WT_MIN = 1600, WT_MAX = 2400;

  function cgToX(cg) {
    return PAD.left + (cg - CG_MIN) / (CG_MAX - CG_MIN) * PLOT_W;
  }

  function wtToY(wt) {
    return PAD.top + (1 - (wt - WT_MIN) / (WT_MAX - WT_MIN)) * PLOT_H;
  }

  function interpolateLine(pts, wt) {
    if (wt <= pts[0].wt) return pts[0].cg;
    if (wt >= pts[pts.length - 1].wt) return pts[pts.length - 1].cg;
    for (var i = 0; i < pts.length - 1; i++) {
      if (wt >= pts[i].wt && wt <= pts[i + 1].wt) {
        var t = (wt - pts[i].wt) / (pts[i + 1].wt - pts[i].wt);
        return pts[i].cg + t * (pts[i + 1].cg - pts[i].cg);
      }
    }
    return pts[pts.length - 1].cg;
  }

  function isInEnvelope(wt, cg) {
    var minWt = Math.min(DA62_WB.envelopeFwd[0].wt, DA62_WB.envelopeAft[0].wt);
    var maxWt = Math.max(DA62_WB.envelopeFwd[DA62_WB.envelopeFwd.length - 1].wt, DA62_WB.envelopeAft[DA62_WB.envelopeAft.length - 1].wt);
    if (wt < minWt || wt > maxWt) return false;
    var fwd = interpolateLine(DA62_WB.envelopeFwd, wt);
    var aft = interpolateLine(DA62_WB.envelopeAft, wt);
    return cg >= fwd && cg <= aft;
  }

  function val(id) {
    var el = document.getElementById(id);
    var v = parseFloat(el ? el.value : '');
    return isNaN(v) ? 0 : v;
  }

  function getFuelKg() {
    var fuelEl = document.getElementById('range-fuel');
    var gal = fuelEl ? parseFloat(fuelEl.value) : 0;
    if (isNaN(gal) || gal < 0) gal = 0;
    return gal * DA62_WB.fuelDensity;
  }

  function splitFuel(totalKg) {
    var mainKg = Math.min(totalKg, DA62_WB.stations.fuelMain.maxKg);
    var auxKg = Math.max(totalKg - mainKg, 0);
    auxKg = Math.min(auxKg, DA62_WB.stations.fuelAux.maxKg);
    return { main: mainKg, aux: auxKg };
  }

  function recalculate() {
    var emptyWt = val('wb-empty-wt');
    var emptyCG = val('wb-empty-cg');
    var deIce = val('wb-deice');
    var frontL = val('wb-front-l');
    var frontR = val('wb-front-r');
    var row1L = val('wb-row1-l');
    var row1R = val('wb-row1-r');
    var noseRH = val('wb-nose-rh');
    var noseLH = val('wb-nose-lh');
    var tailA = val('wb-tail-a');
    var tailBCD = val('wb-tail-bcd');

    var fuelTotalKg = getFuelKg();
    var fuel = splitFuel(fuelTotalKg);

    var fuelEl = document.getElementById('range-fuel');
    var fuelGal = fuelEl ? parseFloat(fuelEl.value) : 0;
    if (isNaN(fuelGal) || fuelGal < 0) fuelGal = 0;

    // Update fuel display
    var fuelDisplay = document.getElementById('wb-fuel-display');
    if (fuelDisplay) {
      fuelDisplay.textContent = 'Fuel: ' + fuelGal.toFixed(1) + ' gal · ' + fuelTotalKg.toFixed(1) + ' kg';
    }

    // Build items array
    var items = [
      { w: emptyWt, arm: emptyCG },
      { w: deIce, arm: DA62_WB.stations.deIce.arm },
      { w: frontL + frontR, arm: DA62_WB.stations.front.arm },
      { w: row1L + row1R, arm: DA62_WB.stations.row1.arm },
      { w: noseRH, arm: DA62_WB.stations.noseRH.arm },
      { w: noseLH, arm: DA62_WB.stations.noseLH.arm },
      { w: tailA, arm: DA62_WB.stations.tailA.arm },
      { w: tailBCD, arm: DA62_WB.stations.tailBCD.arm },
      { w: fuel.main, arm: DA62_WB.stations.fuelMain.arm },
      { w: fuel.aux, arm: DA62_WB.stations.fuelAux.arm }
    ];

    var totalWeight = 0, totalMoment = 0;
    var fuelWeight = fuel.main + fuel.aux;
    var fuelMoment = fuel.main * DA62_WB.stations.fuelMain.arm + fuel.aux * DA62_WB.stations.fuelAux.arm;

    for (var i = 0; i < items.length; i++) {
      totalWeight += items[i].w;
      totalMoment += items[i].w * items[i].arm;
    }

    var rampWt = totalWeight;
    var rampCG = rampWt > 0 ? totalMoment / rampWt : 0;

    var zfw = rampWt - fuelWeight;
    var zfwMoment = totalMoment - fuelMoment;
    var zfwCG = zfw > 0 ? zfwMoment / zfw : 0;

    // Check limits
    var zfwWtOk = zfw <= DA62_WB.maxZFW;
    var zfwCGOk = zfw > 0 ? isInEnvelope(zfw, zfwCG) : true;
    var zfwOk = zfwWtOk && zfwCGOk;

    var rampWtOk = rampWt <= DA62_WB.maxRamp;
    var rampCGOk = rampWt > 0 ? isInEnvelope(rampWt, rampCG) : true;
    var rampOk = rampWtOk && rampCGOk;

    var towOk = rampWt <= DA62_WB.mtow;

    // Render results
    var resultsDiv = document.getElementById('wb-results');
    if (resultsDiv) {
      var zfwClass = zfwOk ? 'wb-result-ok' : 'wb-result-warn';
      var rampClass = (rampOk && towOk) ? 'wb-result-ok' : 'wb-result-warn';
      var zfwIcon = zfwOk ? ' \u2713' : ' \u26A0';
      var rampIcon = (rampOk && towOk) ? ' \u2713' : ' \u26A0';

      var warnings = [];
      if (zfw > DA62_WB.maxZFW) warnings.push('ZFW exceeds ' + DA62_WB.maxZFW + ' kg');
      if (!zfwCGOk && zfw > 0) warnings.push('ZFW CG out of envelope');
      if (rampWt > DA62_WB.maxRamp) warnings.push('Ramp exceeds ' + DA62_WB.maxRamp + ' kg');
      if (!towOk) warnings.push('Exceeds MTOW ' + DA62_WB.mtow + ' kg');
      if (!rampCGOk && rampWt > 0) warnings.push('Ramp CG out of envelope');

      var html = '<div class="' + zfwClass + '">ZFW: ' + Math.round(zfw) + ' kg \u00B7 CG ' + zfwCG.toFixed(3) + ' m' + zfwIcon + '</div>';
      html += '<div class="' + rampClass + '">Ramp: ' + Math.round(rampWt) + ' kg \u00B7 CG ' + rampCG.toFixed(3) + ' m' + rampIcon + '</div>';
      if (warnings.length > 0) {
        html += '<div class="wb-result-warn" style="font-size:11px;margin-top:2px">' + warnings.join(' \u00B7 ') + '</div>';
      }
      resultsDiv.innerHTML = html;
    }

    // Render SVG envelope
    renderEnvelope(zfw, zfwCG, rampWt, rampCG, zfwOk, rampOk && towOk);
  }

  function renderEnvelope(zfw, zfwCG, rampWt, rampCG, zfwOk, rampOk) {
    var container = document.getElementById('wb-envelope');
    if (!container) return;

    var fwdPts = DA62_WB.envelopeFwd;
    var aftPts = DA62_WB.envelopeAft;

    // Build envelope polygon points (forward edge top-to-bottom, then aft edge bottom-to-top)
    var polyPoints = [];
    for (var i = 0; i < fwdPts.length; i++) {
      polyPoints.push(cgToX(fwdPts[i].cg).toFixed(1) + ',' + wtToY(fwdPts[i].wt).toFixed(1));
    }
    for (var j = aftPts.length - 1; j >= 0; j--) {
      polyPoints.push(cgToX(aftPts[j].cg).toFixed(1) + ',' + wtToY(aftPts[j].wt).toFixed(1));
    }

    var svg = '<svg width="' + SVG_W + '" height="' + SVG_H + '" xmlns="http://www.w3.org/2000/svg">';

    // Envelope polygon
    svg += '<polygon points="' + polyPoints.join(' ') + '" fill="rgba(39,174,96,0.15)" stroke="#27ae60" stroke-width="1.5"/>';

    // X-axis labels (CG)
    for (var cx = 2.3; cx <= 2.551; cx += 0.05) {
      var x = cgToX(cx);
      svg += '<line x1="' + x.toFixed(1) + '" y1="' + (PAD.top) + '" x2="' + x.toFixed(1) + '" y2="' + (SVG_H - PAD.bottom) + '" stroke="#e0e0e0" stroke-width="0.5"/>';
      svg += '<text x="' + x.toFixed(1) + '" y="' + (SVG_H - 4) + '" text-anchor="middle" font-size="8" fill="#999">' + cx.toFixed(2) + '</text>';
    }

    // Y-axis labels (weight)
    for (var w = 1600; w <= 2400; w += 200) {
      var y = wtToY(w);
      svg += '<line x1="' + PAD.left + '" y1="' + y.toFixed(1) + '" x2="' + (SVG_W - PAD.right) + '" y2="' + y.toFixed(1) + '" stroke="#e0e0e0" stroke-width="0.5"/>';
      svg += '<text x="' + (PAD.left - 3) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end" font-size="8" fill="#999">' + w + '</text>';
    }

    // MTOW and max ramp lines
    var mtowY = wtToY(DA62_WB.mtow);
    svg += '<line x1="' + PAD.left + '" y1="' + mtowY.toFixed(1) + '" x2="' + (SVG_W - PAD.right) + '" y2="' + mtowY.toFixed(1) + '" stroke="#e74c3c" stroke-width="0.5" stroke-dasharray="3,2"/>';
    var rampMaxY = wtToY(DA62_WB.maxRamp);
    svg += '<line x1="' + PAD.left + '" y1="' + rampMaxY.toFixed(1) + '" x2="' + (SVG_W - PAD.right) + '" y2="' + rampMaxY.toFixed(1) + '" stroke="#e67e22" stroke-width="0.5" stroke-dasharray="3,2"/>';

    // ZFW point
    if (zfw > 0) {
      var zx = cgToX(zfwCG), zy = wtToY(zfw);
      var zColor = zfwOk ? '#3498db' : '#e74c3c';
      svg += '<circle cx="' + zx.toFixed(1) + '" cy="' + zy.toFixed(1) + '" r="4" fill="' + zColor + '" stroke="#fff" stroke-width="1"/>';
      svg += '<text x="' + (zx + 6).toFixed(1) + '" y="' + (zy + 3).toFixed(1) + '" font-size="8" fill="' + zColor + '">ZFW</text>';
    }

    // Ramp weight point
    if (rampWt > 0) {
      var rx = cgToX(rampCG), ry = wtToY(rampWt);
      var rColor = rampOk ? '#e67e22' : '#e74c3c';
      svg += '<circle cx="' + rx.toFixed(1) + '" cy="' + ry.toFixed(1) + '" r="4" fill="' + rColor + '" stroke="#fff" stroke-width="1"/>';
      svg += '<text x="' + (rx + 6).toFixed(1) + '" y="' + (ry + 3).toFixed(1) + '" font-size="8" fill="' + rColor + '">Ramp</text>';
    }

    // Line connecting ZFW to Ramp if both exist
    if (zfw > 0 && rampWt > 0) {
      var lzx = cgToX(zfwCG), lzy = wtToY(zfw);
      var lrx = cgToX(rampCG), lry = wtToY(rampWt);
      svg += '<line x1="' + lzx.toFixed(1) + '" y1="' + lzy.toFixed(1) + '" x2="' + lrx.toFixed(1) + '" y2="' + lry.toFixed(1) + '" stroke="#aaa" stroke-width="0.8" stroke-dasharray="2,2"/>';
    }

    svg += '</svg>';
    container.innerHTML = svg;
  }

  function init() {
    // Listen to all W&B inputs
    var inputs = [
      'wb-empty-wt', 'wb-empty-cg', 'wb-deice',
      'wb-front-l', 'wb-front-r', 'wb-row1-l', 'wb-row1-r',
      'wb-nose-rh', 'wb-nose-lh', 'wb-tail-a', 'wb-tail-bcd'
    ];
    for (var i = 0; i < inputs.length; i++) {
      var el = document.getElementById(inputs[i]);
      if (el) el.addEventListener('input', recalculate);
    }

    // Listen to fuel input from Range tab
    var fuelEl = document.getElementById('range-fuel');
    if (fuelEl) fuelEl.addEventListener('input', recalculate);

    // Initial calculation
    recalculate();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
