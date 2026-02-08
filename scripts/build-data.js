#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const Papa = require('papaparse');

const DATA_DIR = path.join(__dirname, '..', 'data');
const AIRPORTS_CSV_URL = 'https://davidmegginson.github.io/ourairports-data/airports.csv';
const RUNWAYS_CSV_URL = 'https://davidmegginson.github.io/ourairports-data/runways.csv';
const FREQUENCIES_CSV_URL = 'https://davidmegginson.github.io/ourairports-data/airport-frequencies.csv';

function download(url) {
  return new Promise((resolve, reject) => {
    const get = (u) => {
      https.get(u, { headers: { 'User-Agent': 'airports-data-build/1.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          get(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${u}`));
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        res.on('error', reject);
      }).on('error', reject);
    };
    get(url);
  });
}

async function buildRunwayIndex() {
  console.log('Downloading runways.csv from OurAirports...');
  const csv = await download(RUNWAYS_CSV_URL);
  console.log(`Downloaded runways ${(csv.length / 1024 / 1024).toFixed(1)} MB`);

  const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true });
  console.log(`Parsed ${parsed.data.length} total runways`);

  const index = {};
  for (const row of parsed.data) {
    if (row.closed === '1') continue;
    const ident = row.airport_ident;
    if (!ident) continue;

    const designator = [row.le_ident, row.he_ident].filter(Boolean).join('/') || 'Unknown';
    const lengthFt = row.length_ft ? parseInt(row.length_ft, 10) : null;
    const widthFt = row.width_ft ? parseInt(row.width_ft, 10) : null;
    const surface = row.surface || 'Unknown';

    if (!index[ident]) index[ident] = [];
    index[ident].push([designator, lengthFt, widthFt, surface]);
  }

  console.log(`Indexed runways for ${Object.keys(index).length} airports`);
  return index;
}

async function buildFrequencyIndex() {
  console.log('Downloading airport-frequencies.csv from OurAirports...');
  const csv = await download(FREQUENCIES_CSV_URL);
  console.log(`Downloaded frequencies ${(csv.length / 1024 / 1024).toFixed(1)} MB`);

  const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true });
  console.log(`Parsed ${parsed.data.length} total frequency entries`);

  // Group frequencies by airport_ident
  // Each entry: [type, description, frequency_mhz]
  const index = {};
  for (const row of parsed.data) {
    const ident = row.airport_ident;
    if (!ident) continue;

    const type = (row.type || '').toUpperCase();
    const desc = row.description || '';
    const freq = row.frequency_mhz || '';

    if (!index[ident]) index[ident] = [];
    index[ident].push([type, desc, freq]);
  }

  console.log(`Indexed frequencies for ${Object.keys(index).length} airports`);
  return index;
}

// Derive ATC level from frequency types
function deriveAtcLevel(freqs) {
  if (!freqs || freqs.length === 0) return 'UNCONTROLLED';

  const types = new Set(freqs.map(f => f[0]));

  if (types.has('APP') || types.has('DEP') || types.has('APPROACH') || types.has('DEPARTURE')) {
    return 'APP/TWR';
  }
  if (types.has('TWR') || types.has('TOWER')) {
    return 'TWR';
  }
  if (types.has('AFIS') || types.has('A/G') || types.has('AG') || types.has('RDO')) {
    return 'AFIS/Radio';
  }
  if (types.has('CTAF') || types.has('UNICOM') || types.has('MULTICOM')) {
    return 'CTAF/UNICOM';
  }
  // Has some frequency but none of the above
  return 'UNCONTROLLED';
}

// Derive a compact list of frequency entries for the popup: [type, freq_mhz]
function compactFreqs(freqs) {
  if (!freqs || freqs.length === 0) return [];
  return freqs.map(f => [f[0] || f[1], f[2]]).filter(f => f[1]);
}

async function buildAirports() {
  const runwayIndex = await buildRunwayIndex();
  const freqIndex = await buildFrequencyIndex();

  console.log('Downloading airports.csv from OurAirports...');
  const csv = await download(AIRPORTS_CSV_URL);
  console.log(`Downloaded ${(csv.length / 1024 / 1024).toFixed(1)} MB`);

  const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true });
  console.log(`Parsed ${parsed.data.length} total airports`);

  const filtered = parsed.data.filter(
    (row) => row.continent === 'EU' && row.type !== 'closed' && row.iso_country !== 'RU'
  );
  console.log(`Filtered to ${filtered.length} European airports (excluding closed)`);

  // Column order for array-of-arrays format:
  // [0] ident, [1] type, [2] name, [3] latitude_deg, [4] longitude_deg,
  // [5] elevation_ft, [6] iso_country, [7] municipality,
  // [8] iata_code, [9] gps_code, [10] runways,
  // [11] atc_level, [12] frequencies
  const columns = [
    'ident', 'type', 'name', 'latitude_deg', 'longitude_deg',
    'elevation_ft', 'iso_country', 'municipality',
    'iata_code', 'gps_code', 'runways',
    'atc_level', 'frequencies'
  ];

  const rows = filtered.map((row) => {
    const ident = row.ident || '';
    const freqs = freqIndex[ident] || [];
    return [
      ident,
      row.type || '',
      row.name || '',
      parseFloat(row.latitude_deg) || 0,
      parseFloat(row.longitude_deg) || 0,
      row.elevation_ft ? parseInt(row.elevation_ft, 10) : null,
      row.iso_country || '',
      row.municipality || '',
      row.iata_code || '',
      row.gps_code || '',
      runwayIndex[ident] || [],
      deriveAtcLevel(freqs),
      compactFreqs(freqs)
    ];
  });

  const output = { columns, data: rows };
  const outPath = path.join(DATA_DIR, 'airports-eu.json');
  fs.writeFileSync(outPath, JSON.stringify(output));
  const sizeMB = (fs.statSync(outPath).size / 1024 / 1024).toFixed(2);
  console.log(`Wrote ${outPath} (${sizeMB} MB, ${rows.length} airports)`);

  const withRunways = rows.filter(r => r[10].length > 0).length;
  const withFreqs = rows.filter(r => r[12].length > 0).length;
  const atcCounts = {};
  rows.forEach(r => { atcCounts[r[11]] = (atcCounts[r[11]] || 0) + 1; });
  console.log(`  ${withRunways} airports have runway data`);
  console.log(`  ${withFreqs} airports have frequency data`);
  console.log('  ATC levels:', atcCounts);
}

async function buildEuropeGeoJSON() {
  const outPath = path.join(DATA_DIR, 'europe.geojson');
  if (fs.existsSync(outPath)) {
    console.log('europe.geojson already exists, skipping download.');
    return;
  }

  console.log('Downloading Europe GeoJSON...');
  const url = 'https://raw.githubusercontent.com/leakyMirror/map-of-europe/master/GeoJSON/europe.geojson';

  const geojsonStr = await download(url);
  const geojson = JSON.parse(geojsonStr);
  console.log(`Downloaded GeoJSON with ${geojson.features.length} features`);
  fs.writeFileSync(outPath, JSON.stringify(geojson));
  const sizeMB = (fs.statSync(outPath).size / 1024 / 1024).toFixed(2);
  console.log(`Wrote ${outPath} (${sizeMB} MB)`);
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
