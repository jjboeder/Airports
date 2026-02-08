#!/usr/bin/env node

/**
 * build-ama.js - Generate Area Minimum Altitude grid data
 *
 * Combines two data sources:
 *   1. Terrain: Mapzen Terrarium PNG tiles (AWS S3, zoom 7)
 *   2. Obstacles: OpenAIP obstacle GeoJSON (Google Storage)
 *
 * For each 1x1 degree cell: max(terrain_max, obstacle_max) in feet,
 * then applies MORA buffer (+1000 ft if <=5000 ft, +2000 ft if >5000 ft),
 * rounded up to nearest 100 ft.
 *
 * Output: data/ama-grid.json as [[lat, lon, ama_ft], ...]
 *
 * Usage:
 *   node scripts/build-ama.js              # full build
 *   node scripts/build-ama.js --skip-terrain  # obstacles only (uses cached terrain)
 *   node scripts/build-ama.js --clear-cache   # wipe cache and rebuild
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const zlib = require('zlib');

// --- Configuration ---

const CACHE_DIR = path.join(__dirname, '.ama-cache');
const TERRAIN_CACHE = path.join(CACHE_DIR, 'terrain');
const OBSTACLE_CACHE = path.join(CACHE_DIR, 'obstacles');
const DATA_DIR = path.join(__dirname, '..', 'data');
const OUTPUT_FILE = path.join(DATA_DIR, 'ama-grid.json');

// European bounding box (lat/lon)
const LAT_MIN = 35; // Southern tip of Europe (Crete ~35N)
const LAT_MAX = 71; // Northern Norway ~71N
const LON_MIN = -25; // Iceland/Azores ~-25W
const LON_MAX = 45;  // Eastern Europe/Turkey ~45E

const ZOOM = 7;
const MAX_CONCURRENT = 15;

// Terrarium tile URL
const TERRAIN_URL = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium';

// OpenAIP obstacle GeoJSON URL template
const OBSTACLE_URL = 'https://storage.googleapis.com/29f98e10-a489-4c82-ae5e-489dbcd4912f';

// European country codes for obstacle data
const EURO_COUNTRIES = [
  'at', 'be', 'bg', 'ch', 'cy', 'cz', 'de', 'dk', 'ee', 'es',
  'fi', 'fr', 'gb', 'gr', 'hr', 'hu', 'ie', 'is', 'it', 'lt',
  'lu', 'lv', 'me', 'mk', 'mt', 'nl', 'no', 'pl', 'pt', 'ro',
  'rs', 'se', 'si', 'sk', 'tr', 'ua', 'ba', 'al'
];

const M_TO_FT = 3.28084;

// --- CLI flags ---
const args = process.argv.slice(2);
const skipTerrain = args.includes('--skip-terrain');
const clearCache = args.includes('--clear-cache');

// --- Helpers ---

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function download(url) {
  return new Promise((resolve, reject) => {
    const get = (u) => {
      const mod = u.startsWith('https') ? https : http;
      mod.get(u, { headers: { 'User-Agent': 'airports-ama-build/1.0' } }, (res) => {
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
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    };
    get(url);
  });
}

// Run up to `limit` async tasks concurrently
function pooled(tasks, limit) {
  return new Promise((resolve, reject) => {
    const results = new Array(tasks.length);
    let next = 0;
    let running = 0;
    let done = 0;

    function launch() {
      while (running < limit && next < tasks.length) {
        const idx = next++;
        running++;
        tasks[idx]()
          .then((val) => { results[idx] = val; })
          .catch((err) => { results[idx] = err; })
          .finally(() => {
            running--;
            done++;
            if (done === tasks.length) resolve(results);
            else launch();
          });
      }
    }
    if (tasks.length === 0) resolve([]);
    else launch();
  });
}

// --- PNG decoding (Terrarium tiles, pure Node.js) ---

// Minimal PNG parser: extract IDAT chunks, decompress, unfilter to get raw RGBA/RGB pixels
function decodePNG(buf) {
  // Validate PNG signature
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buf.compare(sig, 0, 8, 0, 8) !== 0) {
    throw new Error('Not a valid PNG');
  }

  let offset = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idatChunks = [];

  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.slice(offset + 8, offset + 8 + length);
    offset += 12 + length; // 4 length + 4 type + data + 4 crc

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (width === 0 || height === 0) throw new Error('No IHDR found');

  // Bytes per pixel
  let bpp;
  if (colorType === 2) bpp = 3;       // RGB
  else if (colorType === 6) bpp = 4;   // RGBA
  else if (colorType === 0) bpp = 1;   // Grayscale
  else if (colorType === 4) bpp = 2;   // Grayscale+Alpha
  else throw new Error('Unsupported color type: ' + colorType);

  if (bitDepth !== 8) throw new Error('Unsupported bit depth: ' + bitDepth);

  // Decompress all IDAT data
  const compressed = Buffer.concat(idatChunks);
  const raw = zlib.inflateSync(compressed);

  // Un-filter scanlines
  const stride = width * bpp;
  const pixels = Buffer.alloc(height * stride);

  for (let y = 0; y < height; y++) {
    const filterType = raw[y * (stride + 1)];
    const scanStart = y * (stride + 1) + 1;
    const outStart = y * stride;

    for (let x = 0; x < stride; x++) {
      const rawByte = raw[scanStart + x];
      let a = x >= bpp ? pixels[outStart + x - bpp] : 0;
      let b = y > 0 ? pixels[outStart - stride + x] : 0;
      let c = (x >= bpp && y > 0) ? pixels[outStart - stride + x - bpp] : 0;

      let val;
      switch (filterType) {
        case 0: val = rawByte; break;                              // None
        case 1: val = (rawByte + a) & 0xFF; break;                // Sub
        case 2: val = (rawByte + b) & 0xFF; break;                // Up
        case 3: val = (rawByte + ((a + b) >> 1)) & 0xFF; break;   // Average
        case 4: val = (rawByte + paethPredictor(a, b, c)) & 0xFF; break; // Paeth
        default: val = rawByte;
      }
      pixels[outStart + x] = val;
    }
  }

  return { width, height, bpp, pixels };
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// Terrarium encoding: elevation_m = R*256 + G + B/256 - 32768
function terrariumElevation(r, g, b) {
  return r * 256 + g + b / 256 - 32768;
}

// --- Tile coordinate math (Web Mercator) ---

function lonToTileX(lon, z) {
  return Math.floor((lon + 180) / 360 * (1 << z));
}

function latToTileY(lat, z) {
  const latRad = lat * Math.PI / 180;
  return Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * (1 << z));
}

function tileXToLon(x, z) {
  return x / (1 << z) * 360 - 180;
}

function tileYToLat(y, z) {
  const n = Math.PI - 2 * Math.PI * y / (1 << z);
  return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

// --- Step 1: Terrain processing ---

async function downloadTerrainTiles() {
  ensureDir(TERRAIN_CACHE);

  // Compute tile ranges for Europe at zoom 7
  const xMin = lonToTileX(LON_MIN, ZOOM);
  const xMax = lonToTileX(LON_MAX, ZOOM);
  const yMin = latToTileY(LAT_MAX, ZOOM); // note: y is inverted
  const yMax = latToTileY(LAT_MIN, ZOOM);

  const tiles = [];
  for (let x = xMin; x <= xMax; x++) {
    for (let y = yMin; y <= yMax; y++) {
      tiles.push({ x, y });
    }
  }

  console.log(`Terrain: ${tiles.length} tiles at zoom ${ZOOM} (x: ${xMin}-${xMax}, y: ${yMin}-${yMax})`);

  let downloaded = 0;
  let cached = 0;

  const tasks = tiles.map((tile) => async () => {
    const file = path.join(TERRAIN_CACHE, `${ZOOM}_${tile.x}_${tile.y}.png`);
    if (fs.existsSync(file)) {
      cached++;
      return;
    }
    const url = `${TERRAIN_URL}/${ZOOM}/${tile.x}/${tile.y}.png`;
    try {
      const data = await download(url);
      fs.writeFileSync(file, data);
      downloaded++;
      if ((downloaded + cached) % 50 === 0) {
        process.stdout.write(`\r  Terrain tiles: ${downloaded} downloaded, ${cached} cached / ${tiles.length}`);
      }
    } catch (err) {
      // Some tiles may be ocean-only, skip silently
    }
  });

  await pooled(tasks, MAX_CONCURRENT);
  console.log(`\r  Terrain tiles: ${downloaded} downloaded, ${cached} cached / ${tiles.length}`);
  return tiles;
}

function processTerrainTiles() {
  // For each 1x1 degree cell, find the max elevation from terrain tiles
  const terrainMax = {}; // "lat,lon" -> max elevation in meters

  const xMin = lonToTileX(LON_MIN, ZOOM);
  const xMax = lonToTileX(LON_MAX, ZOOM);
  const yMin = latToTileY(LAT_MAX, ZOOM);
  const yMax = latToTileY(LAT_MIN, ZOOM);

  let tilesProcessed = 0;
  const totalTiles = (xMax - xMin + 1) * (yMax - yMin + 1);

  for (let tx = xMin; tx <= xMax; tx++) {
    for (let ty = yMin; ty <= yMax; ty++) {
      const file = path.join(TERRAIN_CACHE, `${ZOOM}_${tx}_${ty}.png`);
      if (!fs.existsSync(file)) continue;

      try {
        const buf = fs.readFileSync(file);
        const img = decodePNG(buf);
        const { width, height, bpp, pixels } = img;

        // Geographic bounds of this tile
        const tileLonMin = tileXToLon(tx, ZOOM);
        const tileLonMax = tileXToLon(tx + 1, ZOOM);
        const tileLatMax = tileYToLat(ty, ZOOM);     // top
        const tileLatMin = tileYToLat(ty + 1, ZOOM); // bottom

        // Sample every pixel
        for (let py = 0; py < height; py++) {
          const lat = tileLatMax - (py / height) * (tileLatMax - tileLatMin);
          const cellLat = Math.floor(lat);

          for (let px = 0; px < width; px++) {
            const lon = tileLonMin + (px / width) * (tileLonMax - tileLonMin);
            const cellLon = Math.floor(lon);

            // Skip cells outside our bounds
            if (cellLat < LAT_MIN || cellLat >= LAT_MAX || cellLon < LON_MIN || cellLon >= LON_MAX) continue;

            const i = (py * width + px) * bpp;
            const r = pixels[i];
            const g = pixels[i + 1];
            const b = pixels[i + 2];
            const elev = terrariumElevation(r, g, b);

            // Skip below sea level / ocean
            if (elev <= 0) continue;

            const key = `${cellLat},${cellLon}`;
            if (!terrainMax[key] || elev > terrainMax[key]) {
              terrainMax[key] = elev;
            }
          }
        }
      } catch (err) {
        // Skip corrupt tiles
      }

      tilesProcessed++;
      if (tilesProcessed % 50 === 0) {
        process.stdout.write(`\r  Processing terrain: ${tilesProcessed}/${totalTiles} tiles`);
      }
    }
  }

  console.log(`\r  Processing terrain: ${tilesProcessed}/${totalTiles} tiles — ${Object.keys(terrainMax).length} cells with terrain data`);
  return terrainMax;
}

// --- Step 2: Obstacle processing ---

async function downloadObstacles() {
  ensureDir(OBSTACLE_CACHE);

  let downloaded = 0;
  let cached = 0;
  let failed = 0;

  const tasks = EURO_COUNTRIES.map((cc) => async () => {
    const file = path.join(OBSTACLE_CACHE, `${cc}_obs.geojson`);
    if (fs.existsSync(file)) {
      cached++;
      return;
    }
    const url = `${OBSTACLE_URL}/${cc}_obs.geojson`;
    try {
      const data = await download(url);
      fs.writeFileSync(file, data);
      downloaded++;
    } catch (err) {
      failed++;
    }
  });

  await pooled(tasks, MAX_CONCURRENT);
  console.log(`Obstacles: ${downloaded} downloaded, ${cached} cached, ${failed} failed / ${EURO_COUNTRIES.length} countries`);
}

function processObstacles() {
  const obstacleMax = {}; // "lat,lon" -> max obstacle top AMSL in meters
  const cellObstacles = {}; // "lat,lon" -> [[lat, lon, topFt, heightFt, name], ...]
  let totalObstacles = 0;

  for (const cc of EURO_COUNTRIES) {
    const file = path.join(OBSTACLE_CACHE, `${cc}_obs.geojson`);
    if (!fs.existsSync(file)) continue;

    try {
      const geojson = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const features = geojson.features || [];

      for (const f of features) {
        if (!f.geometry || !f.geometry.coordinates) continue;
        if (!f.properties) continue;

        const [lon, lat] = f.geometry.coordinates;
        const cellLat = Math.floor(lat);
        const cellLon = Math.floor(lon);

        // Skip outside Europe bounds
        if (cellLat < LAT_MIN || cellLat >= LAT_MAX || cellLon < LON_MIN || cellLon >= LON_MAX) continue;

        // Obstacle top AMSL = ground elevation + obstacle height
        const elev = (f.properties.elevation && f.properties.elevation.value) || 0;
        let height = (f.properties.height && f.properties.height.value) || 0;
        const tags = f.properties.osmTags || {};

        // Fallback 1: extract height from osmTags when height property is missing
        if (height === 0) {
          const rawH = tags.height || (tags.key === 'height' ? tags.value : null);
          if (rawH) {
            const parsed = parseFloat(rawH);
            if (!isNaN(parsed) && parsed > 0) height = parsed;
          }
        }

        // Fallback 2: default heights for known obstacle types with missing data
        if (height === 0) {
          const isWind = (tags.key === 'generator:method' && tags.value === 'wind_turbine')
            || (tags.power === 'generator' && tags['generator:source'] === 'wind');
          const isComms = tags.man_made === 'communications_tower'
            || tags.value === 'communications_tower'
            || tags.man_made === 'tower' || tags.value === 'tower';
          const isMast = tags.man_made === 'mast' || tags.value === 'mast';
          const isChimney = tags.man_made === 'chimney' || tags.value === 'chimney';

          if (isWind) height = 200;          // modern turbines 150-230m, conservative safety estimate
          else if (isComms) height = 100;    // median 117m for comms towers
          else if (isMast) height = 90;      // median 90m
          else if (isChimney) height = 100;  // median 112m
        }

        const topM = elev + height;

        if (topM <= 0) continue;

        // Determine obstacle label for output
        let obsName = f.properties.name || '';
        if (obsName === 'Obstacle' || !obsName) {
          const isWind = (tags.key === 'generator:method' && tags.value === 'wind_turbine')
            || (tags.power === 'generator' && tags['generator:source'] === 'wind');
          if (isWind) obsName = 'Wind turbine';
          else if (tags.man_made) obsName = tags.man_made;
          else if (tags.value) obsName = tags.value;
        }

        const key = `${cellLat},${cellLon}`;
        if (!obstacleMax[key] || topM > obstacleMax[key]) {
          obstacleMax[key] = topM;
        }

        // Track per-cell obstacles for map overlay (keep top N per cell later)
        if (height >= 50) {
          const topFt = Math.round(topM * M_TO_FT);
          const heightFt = Math.round(height * M_TO_FT);
          if (!cellObstacles[key]) cellObstacles[key] = [];
          cellObstacles[key].push([
            Math.round(lat * 10000) / 10000,
            Math.round(lon * 10000) / 10000,
            topFt, heightFt, obsName
          ]);
        }

        totalObstacles++;
      }
    } catch (err) {
      // Skip malformed files
    }
  }

  // Keep top 5 obstacles per cell for map overlay
  const TOP_N = 5;
  const allObstacles = [];
  for (const key of Object.keys(cellObstacles)) {
    const sorted = cellObstacles[key].sort((a, b) => b[2] - a[2]);
    for (let i = 0; i < Math.min(TOP_N, sorted.length); i++) {
      allObstacles.push(sorted[i]);
    }
  }

  console.log(`  Processed ${totalObstacles} obstacles — ${Object.keys(obstacleMax).length} cells with obstacle data`);
  console.log(`  ${allObstacles.length} top obstacles for map overlay (top ${TOP_N} per cell)`);
  return { obstacleMax, allObstacles };
}

// --- Step 3: Combine and apply MORA buffer ---

function computeAMAGrid(terrainMax, obstacleMax) {
  const cells = [];
  const allKeys = new Set([...Object.keys(terrainMax), ...Object.keys(obstacleMax)]);

  for (const key of allKeys) {
    const [latStr, lonStr] = key.split(',');
    const lat = parseInt(latStr, 10);
    const lon = parseInt(lonStr, 10);

    const terrainM = terrainMax[key] || 0;
    const obstacleM = obstacleMax[key] || 0;
    const highestM = Math.max(terrainM, obstacleM);
    const highestFt = highestM * M_TO_FT;

    // MORA buffer: +1000 ft if <=5000 ft, +2000 ft if >5000 ft
    let ama;
    if (highestFt <= 5000) {
      ama = highestFt + 1000;
    } else {
      ama = highestFt + 2000;
    }

    // Round up to nearest 100 ft
    ama = Math.ceil(ama / 100) * 100;

    cells.push([lat, lon, ama]);
  }

  // Sort by lat desc, lon asc for consistent output
  cells.sort((a, b) => b[0] - a[0] || a[1] - b[1]);

  return cells;
}

// --- Main ---

async function main() {
  const startTime = Date.now();

  if (clearCache) {
    console.log('Clearing cache...');
    if (fs.existsSync(CACHE_DIR)) {
      fs.rmSync(CACHE_DIR, { recursive: true });
    }
  }

  ensureDir(CACHE_DIR);
  ensureDir(DATA_DIR);

  // Step 1: Terrain
  let terrainMax = {};
  if (!skipTerrain) {
    console.log('\n=== Step 1: Terrain (Mapzen Terrarium tiles) ===');
    await downloadTerrainTiles();
    terrainMax = processTerrainTiles();
  } else {
    console.log('\n=== Step 1: Terrain (skipped, using cached data) ===');
    // Try to process existing cached tiles
    if (fs.existsSync(TERRAIN_CACHE)) {
      terrainMax = processTerrainTiles();
    }
  }

  // Step 2: Obstacles
  console.log('\n=== Step 2: Obstacles (OpenAIP) ===');
  await downloadObstacles();
  const { obstacleMax, allObstacles } = processObstacles();

  // Step 3: Compute AMA grid
  console.log('\n=== Step 3: Computing AMA grid ===');
  const grid = computeAMAGrid(terrainMax, obstacleMax);
  console.log(`  ${grid.length} cells total`);

  // Write output
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(grid));
  const sizeMB = (fs.statSync(OUTPUT_FILE).size / 1024).toFixed(1);
  console.log(`  Wrote ${OUTPUT_FILE} (${sizeMB} KB)`);

  // Write obstacles file for map overlay
  const obsFile = path.join(DATA_DIR, 'ama-obstacles.json');
  fs.writeFileSync(obsFile, JSON.stringify(allObstacles));
  const obsSizeKB = (fs.statSync(obsFile).size / 1024).toFixed(1);
  console.log(`  Wrote ${obsFile} (${obsSizeKB} KB, ${allObstacles.length} obstacles)`);

  // Spot checks
  console.log('\n=== Spot checks ===');
  const alps = grid.find(c => c[0] === 45 && c[1] === 6); // Mont Blanc area
  const netherlands = grid.find(c => c[0] === 52 && c[1] === 5); // Netherlands
  const norway = grid.find(c => c[0] === 61 && c[1] === 7); // Norway mountains
  if (alps) console.log(`  Alps (45N, 6E): ${alps[2]} ft (expect ~17000-18000)`);
  if (netherlands) console.log(`  Netherlands (52N, 5E): ${netherlands[2]} ft (expect ~2000-3000)`);
  if (norway) console.log(`  Norway (61N, 7E): ${norway[2]} ft`);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s`);
}

main().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
