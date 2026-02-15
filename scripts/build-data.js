#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = path.join(__dirname, '..', 'data');

// Load .env file if present
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim();
  });
}

const OPENAIP_KEY = process.env.OPENAIP_KEY;
if (!OPENAIP_KEY) {
  console.error('ERROR: OPENAIP_KEY environment variable is required.');
  console.error('Set it in scripts/.env or as env var. Get a key from https://www.openaip.net/');
  process.exit(1);
}

// European countries (ISO-2) — 51 countries, excluding Russia
const EU_COUNTRIES = [
  'AL','AD','AT','AX','BY','BE','BA','BG','HR','CY','CZ',
  'DK','EE','FI','FR','DE','GR','HU','IS','IE','IT',
  'XK','LV','LI','LT','LU','MT','MD','MC','ME','NL',
  'MK','NO','PL','PT','RO','SM','RS','SK','SI','ES',
  'SE','CH','TR','UA','GB','VA','GG','JE','IM','FO','GI'
];

// OpenAIP airport type → our type string
// Types: 0=other, 1=glider, 2=airstrip, 3=airfield, 4=heliport, 5=military,
//        6=ultralight, 7=parachute, 8=airstrip, 9=intl_airport
const SKIP_TYPES = new Set([1, 6, 7]);

// Surface mapping: OpenAIP numeric → string code
const SURFACE_MAP = {
  0: 'ASP', 1: 'CON', 2: 'GRS', 3: 'SND', 4: 'GRE',
  5: 'WAT', 6: 'BIT', 8: 'TRF'
};

// OpenAIP frequency type → ATC level priority
// 0=APP/RADAR, 3=A/G, 4=CTAF, 12=UNICOM, 14=TWR, 16=AFIS
const FREQ_TYPE_ATC = {
  0: 'APP/TWR', 14: 'TWR', 3: 'AFIS/Radio', 16: 'AFIS/Radio',
  4: 'CTAF/UNICOM', 12: 'CTAF/UNICOM'
};
const ATC_PRIORITY = { 'APP/TWR': 4, 'TWR': 3, 'AFIS/Radio': 2, 'CTAF/UNICOM': 1 };

// Frequency type → label
const OAIP_FREQ_TYPE_MAP = {
  0: 'APP', 1: 'ATIS', 2: 'GND', 3: 'A/G', 4: 'CTAF',
  5: 'INFO', 6: 'CLR', 7: 'MISC', 8: 'FIS', 9: 'RADAR',
  10: 'DEP', 11: 'EMRG', 12: 'UNIC', 13: 'MULTI', 14: 'TWR',
  15: 'APRON', 16: 'AFIS'
};

function apiGet(urlPath) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.core.openaip.net',
      path: urlPath,
      headers: {
        'x-openaip-api-key': OPENAIP_KEY,
        'Accept': 'application/json'
      }
    };
    https.get(options, (res) => {
      if (res.statusCode === 429) {
        reject(new Error('Rate limited (429). Try again later.'));
        return;
      }
      if (res.statusCode !== 200) {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString()}`)));
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
        catch (e) { reject(e); }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Title-case: "HELSINKI-VANTAA" → "Helsinki-Vantaa"
function titleCase(str) {
  if (!str) return '';
  return str.replace(/[A-Za-z]+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

// Derive airport type from OpenAIP type + runway length + traffic type
function deriveType(apt) {
  var t = apt.type;
  if (t === 4) return 'heliport';

  // Find longest runway in meters
  var maxLen = 0;
  if (apt.runways) {
    for (var i = 0; i < apt.runways.length; i++) {
      var dim = apt.runways[i].dimension;
      if (dim && dim.length && dim.length.value > maxLen) {
        maxLen = dim.length.value;
      }
    }
  }

  var hasIFR = false;
  if (apt.trafficType) {
    for (var i = 0; i < apt.trafficType.length; i++) {
      if (apt.trafficType[i] === 1) hasIFR = true;
    }
  }

  if (t === 3 && maxLen >= 3000) return 'large_airport';
  if (t === 3) return 'medium_airport';
  if (t === 9 && hasIFR) return 'medium_airport';
  // t === 9 VFR only, 2, 8, 0 → small
  return 'small_airport';
}

// Derive ATC level from OpenAIP frequency types
function deriveAtcLevel(frequencies) {
  if (!frequencies || frequencies.length === 0) return 'UNCONTROLLED';
  var best = 'UNCONTROLLED';
  var bestPri = 0;
  for (var i = 0; i < frequencies.length; i++) {
    var level = FREQ_TYPE_ATC[frequencies[i].type];
    if (level && (ATC_PRIORITY[level] || 0) > bestPri) {
      best = level;
      bestPri = ATC_PRIORITY[level];
    }
  }
  return best;
}

// Build compact freq list: [label, mhz]
function compactFreqs(frequencies) {
  if (!frequencies || frequencies.length === 0) return [];
  return frequencies.map(f => {
    var label = '';
    var name = (f.name || '').toUpperCase();
    // Try to derive better label from name
    if (name.indexOf('TOWER') >= 0 || name.indexOf(' TWR') >= 0) label = 'TWR';
    else if (name.indexOf('GROUND') >= 0 || name.indexOf(' GND') >= 0) label = 'GND';
    else if (name.indexOf('ATIS') >= 0) label = 'ATIS';
    else if (name.indexOf('RADAR') >= 0) label = 'RADAR';
    else if (name.indexOf('APPROACH') >= 0 || name.indexOf(' APP') >= 0) label = 'APP';
    else if (name.indexOf('DEPARTURE') >= 0 || name.indexOf(' DEP') >= 0) label = 'DEP';
    else if (name.indexOf('AFIS') >= 0) label = 'AFIS';
    else if (name.indexOf('APRON') >= 0) label = 'APRON';
    else if (name.indexOf('INFO') >= 0) label = 'INFO';
    else label = OAIP_FREQ_TYPE_MAP[f.type] || f.name || 'COMM';
    return [label, f.value];
  }).filter(f => f[1]);
}

// Pair runway ends: "18" + "36" → "18/36"
function pairRunways(runways) {
  if (!runways || runways.length === 0) return [];

  var used = new Set();
  var paired = [];

  for (var i = 0; i < runways.length; i++) {
    if (used.has(i)) continue;
    var a = runways[i];
    var aDesig = a.designator || '';
    var aBearing = (a.trueHeading != null) ? a.trueHeading : null;
    var dim = a.dimension || {};
    var lenM = dim.length ? dim.length.value : 0;
    var widM = dim.width ? dim.width.value : 0;
    var lenFt = lenM ? Math.round(lenM / 0.3048) : null;
    var widFt = widM ? Math.round(widM / 0.3048) : null;
    var surfCode = (a.surface && a.surface.mainComposite != null) ? a.surface.mainComposite : -1;
    var surface = SURFACE_MAP[surfCode] || 'Unknown';

    // Find reciprocal end
    var bestJ = -1;
    for (var j = i + 1; j < runways.length; j++) {
      if (used.has(j)) continue;
      var b = runways[j];
      var bBearing = (b.trueHeading != null) ? b.trueHeading : null;

      // Check heading reciprocal (±10° from 180° apart)
      if (aBearing != null && bBearing != null) {
        var angleDiff = Math.abs(aBearing - bBearing) % 360;
        if (angleDiff > 180) angleDiff = 360 - angleDiff;
        if (Math.abs(angleDiff - 180) > 10) continue;
      }

      // Check suffix match: L↔R, C↔C
      var aSuf = aDesig.replace(/[0-9]/g, '');
      var bSuf = b.designator ? b.designator.replace(/[0-9]/g, '') : '';
      if (aSuf === 'L' && bSuf !== 'R') continue;
      if (aSuf === 'R' && bSuf !== 'L') continue;
      if (aSuf === 'C' && bSuf !== 'C') continue;

      bestJ = j;
      break;
    }

    var designator;
    if (bestJ >= 0) {
      used.add(bestJ);
      designator = aDesig + '/' + runways[bestJ].designator;
    } else {
      designator = aDesig;
    }
    used.add(i);

    paired.push([designator, lenFt, widFt, surface]);
  }
  return paired;
}

// Fetch all airports for a country with pagination
async function fetchCountry(country) {
  var airports = [];
  var page = 1;
  var maxPages = 20;

  while (page <= maxPages) {
    var url = '/api/airports?page=' + page + '&limit=200&country=' + country;
    var resp = await apiGet(url);

    if (!resp.items || resp.items.length === 0) break;
    airports = airports.concat(resp.items);

    if (resp.items.length < 200 || (resp.totalCount && airports.length >= resp.totalCount)) break;
    page++;
  }
  return airports;
}

async function buildAirports() {
  console.log('Fetching airports from OpenAIP for ' + EU_COUNTRIES.length + ' countries...');

  var allAirports = [];
  var skippedNoIcao = 0;
  var skippedType = 0;

  for (var i = 0; i < EU_COUNTRIES.length; i++) {
    var country = EU_COUNTRIES[i];
    try {
      var airports = await fetchCountry(country);
      var countBefore = allAirports.length;

      for (var j = 0; j < airports.length; j++) {
        var apt = airports[j];

        // Skip types we don't want
        if (SKIP_TYPES.has(apt.type)) {
          skippedType++;
          continue;
        }

        // Skip airports without ICAO code
        var icao = apt.icaoCode;
        if (!icao) {
          skippedNoIcao++;
          continue;
        }

        allAirports.push(apt);
      }

      var added = allAirports.length - countBefore;
      if (added > 0) {
        process.stdout.write('  ' + country + ': ' + added + ' airports (total: ' + allAirports.length + ')\n');
      }
    } catch (err) {
      console.error('  ' + country + ': ERROR - ' + err.message);
    }

    // Rate limiting
    if (i < EU_COUNTRIES.length - 1) await sleep(200);
  }

  console.log('\nFetched ' + allAirports.length + ' airports (' + skippedNoIcao + ' skipped: no ICAO, ' + skippedType + ' skipped: type)');

  // Deduplicate by ICAO (some border airports may appear in multiple countries)
  var seen = new Set();
  var unique = [];
  for (var i = 0; i < allAirports.length; i++) {
    var icao = allAirports[i].icaoCode;
    if (seen.has(icao)) continue;
    seen.add(icao);
    unique.push(allAirports[i]);
  }
  if (unique.length < allAirports.length) {
    console.log('Deduplicated: ' + allAirports.length + ' → ' + unique.length);
  }

  // Column order (same as before)
  var columns = [
    'ident', 'type', 'name', 'latitude_deg', 'longitude_deg',
    'elevation_ft', 'iso_country', 'municipality',
    'iata_code', 'gps_code', 'runways',
    'atc_level', 'frequencies'
  ];

  var rows = unique.map(function (apt) {
    var coords = apt.geometry && apt.geometry.coordinates;
    var lat = coords ? coords[1] : 0;
    var lon = coords ? coords[0] : 0;
    var elevFt = (apt.elevation && apt.elevation.value != null)
      ? Math.round(apt.elevation.value * 3.28084)
      : null;

    return [
      apt.icaoCode,
      deriveType(apt),
      titleCase(apt.name || ''),
      parseFloat(lat.toFixed(6)),
      parseFloat(lon.toFixed(6)),
      elevFt,
      apt.country || '',
      '',  // municipality — not available in OpenAIP
      apt.iataCode || '',
      apt.icaoCode,
      pairRunways(apt.runways),
      deriveAtcLevel(apt.frequencies),
      compactFreqs(apt.frequencies)
    ];
  });

  var output = { columns: columns, data: rows };
  var outPath = path.join(DATA_DIR, 'airports-eu.json');
  fs.writeFileSync(outPath, JSON.stringify(output));
  var sizeMB = (fs.statSync(outPath).size / 1024 / 1024).toFixed(2);
  console.log('Wrote ' + outPath + ' (' + sizeMB + ' MB, ' + rows.length + ' airports)');

  // Stats
  var withRunways = rows.filter(r => r[10].length > 0).length;
  var withFreqs = rows.filter(r => r[12].length > 0).length;
  var atcCounts = {};
  rows.forEach(r => { atcCounts[r[11]] = (atcCounts[r[11]] || 0) + 1; });
  var typeCounts = {};
  rows.forEach(r => { typeCounts[r[1]] = (typeCounts[r[1]] || 0) + 1; });
  console.log('  ' + withRunways + ' airports have runway data');
  console.log('  ' + withFreqs + ' airports have frequency data');
  console.log('  ATC levels:', atcCounts);
  console.log('  Types:', typeCounts);
}

async function buildEuropeGeoJSON() {
  var outPath = path.join(DATA_DIR, 'europe.geojson');
  if (fs.existsSync(outPath)) {
    console.log('europe.geojson already exists, skipping download.');
    return;
  }

  console.log('Downloading Europe GeoJSON...');
  var url = 'https://raw.githubusercontent.com/leakyMirror/map-of-europe/master/GeoJSON/europe.geojson';

  var geojsonStr = await new Promise((resolve, reject) => {
    var get = (u) => {
      https.get(u, { headers: { 'User-Agent': 'airports-data-build/1.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          get(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error('HTTP ' + res.statusCode + ' for ' + u));
          return;
        }
        var chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        res.on('error', reject);
      }).on('error', reject);
    };
    get(url);
  });
  var geojson = JSON.parse(geojsonStr);
  console.log('Downloaded GeoJSON with ' + geojson.features.length + ' features');
  fs.writeFileSync(outPath, JSON.stringify(geojson));
  var sizeMB = (fs.statSync(outPath).size / 1024 / 1024).toFixed(2);
  console.log('Wrote ' + outPath + ' (' + sizeMB + ' MB)');
}

async function main() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  await buildAirports();
  await buildEuropeGeoJSON();

  console.log('\nDone! Data files are ready in data/');
}

main().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
