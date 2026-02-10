#!/usr/bin/env node
/**
 * Validate lentopaikat.fi URLs for Finnish airports.
 * Sends HEAD requests to verify each URL returns 200.
 * Outputs data/lentopaikat.json with ICAO → slug mapping.
 */

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'airports-eu.json');
const OUT_FILE = path.join(__dirname, '..', 'data', 'lentopaikat.json');

// Known lentopaikat.fi pages (scraped from site navigation)
const KNOWN_PAGES = [
  'aavahelukka-efaa', 'ahmosuo-efah', 'alavus-efal', 'eura-efeu',
  'forssa-effo', 'genbole-efge', 'haapavesi-efhp', 'hailuoto-efhl',
  'hameenkyro-efhm', 'hanko-efhn', 'helsinki-malmi-efhf', 'hyvinkaa-efhv',
  'iisalmi-efii', 'immola-efim', 'jamijarvi-efjm', 'kalajoki-efko',
  'kannus-efkn', 'kauhajoki-efkj', 'kauhava-efka', 'kemijarvi-efkm',
  'kiikala-efik', 'kitee-efit', 'kiuruvesi-efrv', 'kivijarvi-efkv',
  'kuhmo-efkh', 'kumlinge-efkg', 'kymi-efky', 'karsamaki-efkr',
  'lahti-vesivehmaa-efla', 'lapinlahti-efll', 'lappeenranta-eflp',
  'lieksa-nurmes-efln', 'menkijarvi-efme', 'mantsala-efmn',
  'nummela-efnu', 'pieksamaki-efpk', 'piikajarvi-efpi', 'oripaa-efop',
  'pudasjarvi-efpu', 'punkaharju-efpn', 'pyhasalmi-efpy',
  'pyhtaa-redstone-efpr', 'raahe-pattijoki-efrh', 'rantasalmi-efrn',
  'ranua-efru', 'rautavaara-efra', 'rayskala-efry', 'savikko-efns',
  'selanpaa-efse', 'sodankyla-efso', 'sulkaharju-efvt',
  'suomussalmi-efsu', 'teisko-efts', 'torbacka-efto', 'vaala-efvl',
  'vampula-efvp', 'varkaus-efvr', 'viitasaari-efvi', 'wredeby-efwb',
  'ylivieska-efyl', 'jakalapaa-efjp', 'martiniiskonpalo-efmp',
  'pokka-efpa', 'vuotso-efvu'
];

async function checkUrl(slug) {
  const url = `https://lentopaikat.fi/${slug}/`;
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  // Extract ICAO from slug (last 4 chars before end)
  const slugByIcao = {};
  for (const slug of KNOWN_PAGES) {
    const m = slug.match(/ef[a-z]{2}$/);
    if (m) {
      slugByIcao[m[0].toUpperCase()] = slug;
    }
  }

  console.log(`Found ${Object.keys(slugByIcao).length} ICAO codes from known pages`);

  // Validate URLs with HEAD requests (5 concurrent)
  const icaos = Object.keys(slugByIcao);
  const results = {};
  let ok = 0, fail = 0;

  for (let i = 0; i < icaos.length; i += 5) {
    const batch = icaos.slice(i, i + 5);
    const checks = batch.map(async (icao) => {
      const slug = slugByIcao[icao];
      const valid = await checkUrl(slug);
      if (valid) {
        results[icao] = slug;
        ok++;
        process.stdout.write('.');
      } else {
        fail++;
        console.log(`\n  FAIL: ${icao} → ${slug}`);
      }
    });
    await Promise.all(checks);
  }

  console.log(`\n\nValidated: ${ok} OK, ${fail} failed`);

  // Sort by ICAO
  const sorted = {};
  Object.keys(results).sort().forEach(k => { sorted[k] = results[k]; });

  fs.writeFileSync(OUT_FILE, JSON.stringify(sorted, null, 2) + '\n');
  console.log(`Wrote ${Object.keys(sorted).length} entries to ${OUT_FILE}`);
}

main().catch(err => { console.error(err); process.exit(1); });
