export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(request) });
    }

    // Route: /tile/:layer/:z/:x/:y.png (OWM 1.0 tiles)
    const tileMatch = path.match(/^\/tile\/([a-z_]+)\/(\d+)\/(\d+)\/(\d+)\.png$/);
    if (tileMatch) {
      const [, layer, z, x, y] = tileMatch;
      const upstream = `https://tile.openweathermap.org/map/${layer}/${z}/${x}/${y}.png?appid=${env.OWM_KEY}`;
      const resp = await fetch(upstream, {
        cf: { cacheTtl: 600, cacheEverything: true }
      });
      const headers = new Headers(resp.headers);
      Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
      return new Response(resp.body, { status: resp.status, headers });
    }

    // Route: /tile2/:layer/:z/:x/:y.png (OWM 2.0 weather maps with arrows)
    const tile2Match = path.match(/^\/tile2\/([A-Z_]+)\/(\d+)\/(\d+)\/(\d+)\.png$/);
    if (tile2Match) {
      const [, layer, z, x, y] = tile2Match;
      const arrowStep = url.searchParams.get('arrow_step') || '16';
      const useNorm = url.searchParams.get('use_norm') || 'true';
      const date = url.searchParams.get('date') || '';
      let upstream = `https://maps.openweathermap.org/maps/2.0/weather/${layer}/${z}/${x}/${y}?appid=${env.OWM_KEY}&arrow_step=${arrowStep}&use_norm=${useNorm}`;
      if (date) upstream += `&date=${date}`;
      const resp = await fetch(upstream, {
        cf: { cacheTtl: 600, cacheEverything: true }
      });
      const headers = new Headers(resp.headers);
      Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
      return new Response(resp.body, { status: resp.status, headers });
    }

    // Route: /taf?ids=EFHK,ESSA
    if (path === '/taf') {
      const ids = url.searchParams.get('ids') || '';
      const icaoList = ids.split(',').filter(Boolean);
      if (icaoList.length === 0 || icaoList.length > 10 || !icaoList.every(id => /^[A-Z]{4}$/.test(id))) {
        return jsonError('ids must be 1-10 valid 4-letter ICAO codes', 400, request);
      }
      const upstream = `https://aviationweather.gov/api/data/taf?ids=${icaoList.join(',')}&format=json`;
      const resp = await fetch(upstream, {
        cf: { cacheTtl: 600, cacheEverything: true }
      });
      const headers = new Headers(resp.headers);
      Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
      headers.set('Content-Type', 'application/json');
      return new Response(resp.body, { status: resp.status, headers });
    }

    // Route: /metar?ids=EFHK,ESSA
    if (path === '/metar') {
      const ids = url.searchParams.get('ids') || '';
      const icaoList = ids.split(',').filter(Boolean);
      if (icaoList.length === 0 || icaoList.length > 50 || !icaoList.every(id => /^[A-Z]{4}$/.test(id))) {
        return jsonError('ids must be 1-50 valid 4-letter ICAO codes', 400, request);
      }
      const cache = caches.default;
      const cacheKey = new Request('https://metar-cache/' + icaoList.join(','));
      let cached = await cache.match(cacheKey);
      if (cached) {
        const headers = new Headers(cached.headers);
        Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
        return new Response(cached.body, { status: cached.status, headers });
      }
      const upstream = `https://metar.vatsim.net/metar.php?id=${icaoList.join(',')}`;
      const resp = await fetch(upstream);
      const body = await resp.text();
      const cacheResp = new Response(body, {
        headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'max-age=300' }
      });
      await cache.put(cacheKey, cacheResp.clone());
      const headers = new Headers(cacheResp.headers);
      Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
      return new Response(body, { status: 200, headers });
    }

    // Route: /notams?icao=EFHK
    if (path === '/notams') {
      const icao = url.searchParams.get('icao') || '';
      if (!/^[A-Z]{4}$/.test(icao)) {
        return jsonError('icao must be a single 4-letter ICAO code', 400, request);
      }
      const cache = caches.default;
      const cacheKey = new Request('https://notam-cache/' + icao);
      let cached = await cache.match(cacheKey);
      if (cached) {
        const headers = new Headers(cached.headers);
        Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
        return new Response(cached.body, { status: cached.status, headers });
      }
      const upstream = 'https://notams.aim.faa.gov/notamSearch/search';
      const resp = await fetch(upstream, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'searchType=0&designatorsForLocation=' + icao
      });
      const body = await resp.text();
      const cacheResp = new Response(body, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=1800' }
      });
      await cache.put(cacheKey, cacheResp.clone());
      const headers = new Headers(cacheResp.headers);
      Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
      return new Response(body, { status: 200, headers });
    }

    // Route: /route-wx?points=60.32,24.97,59.65,17.94,...
    if (path === '/route-wx') {
      const raw = url.searchParams.get('points') || '';
      const nums = raw.split(',').map(Number);
      if (nums.length < 2 || nums.length % 2 !== 0 || nums.some(isNaN)) {
        return jsonError('points must be comma-separated lat,lon pairs', 400, request);
      }
      const points = [];
      for (let i = 0; i < nums.length; i += 2) {
        points.push({ lat: nums[i], lon: nums[i + 1] });
      }
      if (points.length > 10) {
        return jsonError('max 10 points', 400, request);
      }
      const cache = caches.default;
      const results = await Promise.all(points.map(async (pt) => {
        const cacheKey = new Request('https://wind-cache/' + pt.lat + '/' + pt.lon);
        let resp = await cache.match(cacheKey);
        if (!resp) {
          const upstream = `https://api.openweathermap.org/data/2.5/weather?lat=${pt.lat}&lon=${pt.lon}&appid=${env.OWM_KEY}&units=metric`;
          resp = await fetch(upstream);
          const body = await resp.text();
          resp = new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=600' } });
          await cache.put(cacheKey, resp.clone());
        }
        return resp.json();
      }));
      return new Response(JSON.stringify(results), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
      });
    }

    // Route: /wind-grid?bbox=south,west,north,east&step=2&latStep=0.67
    if (path === '/wind-grid') {
      const bbox = (url.searchParams.get('bbox') || '').split(',').map(Number);
      const step = parseFloat(url.searchParams.get('step')) || 2;
      const latStep = parseFloat(url.searchParams.get('latStep')) || step;
      if (bbox.length !== 4 || bbox.some(isNaN)) {
        return jsonError('bbox=south,west,north,east required', 400, request);
      }
      const [south, west, north, east] = bbox;
      const points = [];
      for (let lat = Math.ceil(south / latStep) * latStep; lat <= north; lat += latStep) {
        for (let lon = Math.ceil(west / step) * step; lon <= east; lon += step) {
          points.push({ lat: Math.round(lat * 1000) / 1000, lon: Math.round(lon * 1000) / 1000 });
        }
      }
      if (points.length > 120) {
        return jsonError('Too many grid points (' + points.length + '), increase step', 400, request);
      }

      // Fetch all points in parallel (no per-point caching to save subrequests)
      const results = await Promise.all(points.map(async (pt) => {
        const upstream = `https://api.openweathermap.org/data/2.5/weather?lat=${pt.lat}&lon=${pt.lon}&appid=${env.OWM_KEY}&units=metric`;
        try {
          const resp = await fetch(upstream, { cf: { cacheTtl: 600, cacheEverything: true } });
          const data = await resp.json();
          if (!data.wind) return null;
          return {
            lat: pt.lat, lon: pt.lon,
            wind_speed: data.wind.speed,
            wind_deg: data.wind.deg || 0,
            wind_gust: data.wind.gust || null
          };
        } catch { return null; }
      }));

      return new Response(JSON.stringify(results.filter(Boolean)), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=600', ...corsHeaders(request) }
      });
    }

    // Route: /weather?lat=...&lon=...
    if (path === '/weather') {
      const lat = url.searchParams.get('lat');
      const lon = url.searchParams.get('lon');
      if (!lat || !lon || isNaN(lat) || isNaN(lon)) {
        return jsonError('lat and lon required', 400, request);
      }
      const upstream = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${env.OWM_KEY}&units=metric`;
      const resp = await fetch(upstream);
      const headers = new Headers(resp.headers);
      Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
      headers.set('Content-Type', 'application/json');
      return new Response(resp.body, { status: resp.status, headers });
    }

    // Route: /onecall?lat=...&lon=... (One Call 3.0 — current + hourly)
    if (path === '/onecall') {
      const lat = url.searchParams.get('lat');
      const lon = url.searchParams.get('lon');
      if (!lat || !lon || isNaN(lat) || isNaN(lon)) {
        return jsonError('lat and lon required', 400, request);
      }
      const upstream = `https://api.openweathermap.org/data/3.0/onecall?lat=${lat}&lon=${lon}&appid=${env.OWM_KEY}&units=metric&exclude=minutely,daily,alerts`;
      const resp = await fetch(upstream, { cf: { cacheTtl: 600, cacheEverything: true } });
      const headers = new Headers(resp.headers);
      Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
      headers.set('Content-Type', 'application/json');
      return new Response(resp.body, { status: resp.status, headers });
    }

    // Route: /wx-overview?lat=...&lon=... (One Call 3.0 weather overview)
    if (path === '/wx-overview') {
      const lat = url.searchParams.get('lat');
      const lon = url.searchParams.get('lon');
      if (!lat || !lon || isNaN(lat) || isNaN(lon)) {
        return jsonError('lat and lon required', 400, request);
      }
      const upstream = `https://api.openweathermap.org/data/3.0/onecall/overview?lat=${lat}&lon=${lon}&appid=${env.OWM_KEY}&units=metric`;
      const resp = await fetch(upstream, { cf: { cacheTtl: 1800, cacheEverything: true } });
      const headers = new Headers(resp.headers);
      Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
      headers.set('Content-Type', 'application/json');
      return new Response(resp.body, { status: resp.status, headers });
    }

    // --- Autorouter.aero API proxy routes ---

    // Route: /ar/metartaf/:icao (GET)
    const arMetarMatch = path.match(/^\/ar\/metartaf\/([A-Z]{4})$/);
    if (arMetarMatch && request.method === 'GET') {
      const icao = arMetarMatch[1];
      try {
        const token = await getArToken(env);
        const resp = await fetch(`https://api.autorouter.aero/v1.0/met/metartaf/${icao}`, {
          headers: { 'Authorization': 'Bearer ' + token }
        });
        const body = await resp.text();
        return new Response(body, {
          status: resp.status,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
        });
      } catch (e) {
        return jsonError('autorouter metartaf error: ' + e.message, 502, request);
      }
    }

    // Route: /ar/gramet (GET)
    if (path === '/ar/gramet' && request.method === 'GET') {
      const waypoints = url.searchParams.get('waypoints') || '';
      const departuretime = url.searchParams.get('departuretime') || '';
      const totaleet = url.searchParams.get('totaleet') || '';
      const altitude = url.searchParams.get('altitude') || '';
      if (!waypoints || !departuretime || !totaleet || !altitude) {
        return jsonError('waypoints, departuretime, totaleet, altitude required', 400, request);
      }
      try {
        const token = await getArToken(env);
        const qs = new URLSearchParams({ waypoints, departuretime, totaleet, altitude, format: 'png' });
        const resp = await fetch('https://api.autorouter.aero/v1.0/met/gramet?' + qs.toString(), {
          headers: { 'Authorization': 'Bearer ' + token }
        });
        if (!resp.ok) {
          const errBody = await resp.text();
          return new Response(errBody, { status: resp.status, headers: corsHeaders(request) });
        }
        const headers = new Headers(resp.headers);
        Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
        headers.set('Cache-Control', 'max-age=600');
        return new Response(resp.body, { status: 200, headers });
      } catch (e) {
        return jsonError('autorouter gramet error: ' + e.message, 502, request);
      }
    }

    // Route: /ar/route (POST) — create a route
    if (path === '/ar/route' && request.method === 'POST') {
      const blocked = requireOrigin(request);
      if (blocked) return blocked;
      try {
        const body = await request.json();
        const token = await getArToken(env);
        const resp = await fetch('https://api.autorouter.aero/v1.0/router', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body)
        });
        const respBody = await resp.text();
        // Autorouter returns plain-text route ID; wrap in JSON for the client
        if (resp.ok) {
          return new Response(JSON.stringify({ id: respBody.trim() }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
          });
        }
        return new Response(respBody, {
          status: resp.status,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
        });
      } catch (e) {
        return jsonError('autorouter route error: ' + e.message, 502, request);
      }
    }

    // Route: /ar/route/:id/poll (PUT) — longpoll for route result
    const arPollMatch = path.match(/^\/ar\/route\/([a-zA-Z0-9-]+)\/poll$/);
    if (arPollMatch && request.method === 'PUT') {
      const blocked = requireOrigin(request);
      if (blocked) return blocked;
      const routeId = arPollMatch[1];
      try {
        const token = await getArToken(env);
        const resp = await fetch(`https://api.autorouter.aero/v1.0/router/${routeId}/longpoll`, {
          method: 'PUT',
          headers: { 'Authorization': 'Bearer ' + token }
        });
        const respBody = await resp.text();
        return new Response(respBody, {
          status: resp.status,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
        });
      } catch (e) {
        return jsonError('autorouter poll error: ' + e.message, 502, request);
      }
    }

    // Route: /ar/route/:id/stop (PUT)
    const arStopMatch = path.match(/^\/ar\/route\/([a-zA-Z0-9-]+)\/stop$/);
    if (arStopMatch && request.method === 'PUT') {
      const blocked = requireOrigin(request);
      if (blocked) return blocked;
      const routeId = arStopMatch[1];
      try {
        const token = await getArToken(env);
        const resp = await fetch(`https://api.autorouter.aero/v1.0/router/${routeId}/stop`, {
          method: 'PUT',
          headers: { 'Authorization': 'Bearer ' + token }
        });
        const respBody = await resp.text();
        return new Response(respBody, {
          status: resp.status,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
        });
      } catch (e) {
        return jsonError('autorouter stop error: ' + e.message, 502, request);
      }
    }

    // Route: /ar/route/:id/close (PUT)
    const arCloseMatch = path.match(/^\/ar\/route\/([a-zA-Z0-9-]+)\/close$/);
    if (arCloseMatch && request.method === 'PUT') {
      const blocked = requireOrigin(request);
      if (blocked) return blocked;
      const routeId = arCloseMatch[1];
      try {
        const token = await getArToken(env);
        const resp = await fetch(`https://api.autorouter.aero/v1.0/router/${routeId}/close`, {
          method: 'PUT',
          headers: { 'Authorization': 'Bearer ' + token }
        });
        const respBody = await resp.text();
        return new Response(respBody, {
          status: resp.status,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
        });
      } catch (e) {
        return jsonError('autorouter close error: ' + e.message, 502, request);
      }
    }

    // Route: /ar/airport-docs/:icao (GET) — airport document list by category
    const arDocsMatch = path.match(/^\/ar\/airport-docs\/([A-Z]{4})$/);
    if (arDocsMatch && request.method === 'GET') {
      const icao = arDocsMatch[1];
      try {
        const token = await getArToken(env);
        const cache = caches.default;
        const cacheKey = new Request('https://ar-docs-cache/' + icao);
        let cached = await cache.match(cacheKey);
        if (cached) {
          const headers = new Headers(cached.headers);
          Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
          return new Response(cached.body, { status: 200, headers });
        }
        const resp = await fetch(`https://api.autorouter.aero/v1.0/pams/airport/${icao}`, {
          headers: { 'Authorization': 'Bearer ' + token }
        });
        const body = await resp.text();
        if (resp.ok) {
          const cacheResp = new Response(body, {
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=86400' }
          });
          await cache.put(cacheKey, cacheResp.clone());
        }
        return new Response(body, {
          status: resp.status,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
        });
      } catch (e) {
        return jsonError('autorouter airport-docs error: ' + e.message, 502, request);
      }
    }

    // Route: /ar/airport-doc/:id (GET) — single document PDF
    const arDocMatch = path.match(/^\/ar\/airport-doc\/([a-zA-Z0-9_-]+)$/);
    if (arDocMatch && request.method === 'GET') {
      const docId = arDocMatch[1];
      try {
        const token = await getArToken(env);
        const resp = await fetch(`https://api.autorouter.aero/v1.0/pams/id/${docId}`, {
          headers: { 'Authorization': 'Bearer ' + token }
        });
        if (!resp.ok) {
          const errBody = await resp.text();
          return new Response(errBody, { status: resp.status, headers: corsHeaders(request) });
        }
        const headers = new Headers(resp.headers);
        Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
        return new Response(resp.body, { status: 200, headers });
      } catch (e) {
        return jsonError('autorouter airport-doc error: ' + e.message, 502, request);
      }
    }

    // Route: /ar/airport-pdf/:icao (GET) — airport document PDF package
    const arPdfMatch = path.match(/^\/ar\/airport-pdf\/([A-Z]{4})$/);
    if (arPdfMatch && request.method === 'GET') {
      const icao = arPdfMatch[1];
      try {
        const token = await getArToken(env);
        const resp = await fetch(`https://api.autorouter.aero/v1.0/pams/airport/${icao}/package`, {
          headers: { 'Authorization': 'Bearer ' + token }
        });
        if (!resp.ok) {
          const errBody = await resp.text();
          return new Response(errBody, { status: resp.status, headers: corsHeaders(request) });
        }
        const headers = new Headers(resp.headers);
        Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
        headers.set('Content-Disposition', `inline; filename="${icao}_charts.pdf"`);
        return new Response(resp.body, { status: 200, headers });
      } catch (e) {
        return jsonError('autorouter airport-pdf error: ' + e.message, 502, request);
      }
    }

    // Route: /ar/aircraft (GET) — list aircraft
    if (path === '/ar/aircraft' && request.method === 'GET') {
      try {
        const token = await getArToken(env);
        const page = url.searchParams.get('page') || '1';
        const rows = url.searchParams.get('rows') || '50';
        const resp = await fetch(`https://api.autorouter.aero/v1.0/aircraft?page=${page}&rows=${rows}`, {
          headers: { 'Authorization': 'Bearer ' + token }
        });
        const body = await resp.text();
        return new Response(body, {
          status: resp.status,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
        });
      } catch (e) {
        return jsonError('autorouter aircraft error: ' + e.message, 502, request);
      }
    }

    // Route: /briefing (POST) — AI weather briefing via Anthropic API
    if (path === '/briefing' && request.method === 'POST') {
      const blocked = requireOrigin(request);
      if (blocked) return blocked;
      try {
        const body = await request.json();
        if (!body || !body.type || !body.data) {
          return jsonError('type and data required', 400, request);
        }

        const systemPrompt = `You are an aviation weather briefing assistant for a DA62 pilot operating in Europe. Generate concise, structured pilot weather briefings from the provided data.

Format your briefing with these sections (use ## headings):
## Current Conditions (for airport briefings) or ## Departure (for route briefings)
## Forecast
## En-Route Weather (route briefings only)
## Destination (route briefings only)
## Alternate (route briefings only, if alternate airport designated)
## NOTAMs (if any provided)
## Flight Level Recommendation (route briefings only, if FL compare data provided)
## Summary & Recommendations

Guidelines:
- Use standard aviation terminology
- Use metric units (meters visibility, hPa pressure) plus feet for altitude/ceiling
- Flag: icing risk, strong winds (>15kt) or gusts (>20kt), crosswind components, low visibility (<5km), thunderstorms, turbulence
- Note runway suitability concerns if runway data is available
- When FL compare data is provided, identify the optimal flight level for time/fuel and compare against the selected FL. Note headwind/tailwind differences. Recommend an FL if a significantly better option exists (>5 min or >2 gal savings)
- Keep concise: 200-350 words
- If insufficient data is provided, state what's missing and brief on what you can`;

        let userContent;
        if (body.type === 'airport') {
          const d = body.data;
          userContent = `Generate a weather briefing for ${d.icao || 'unknown'} (${d.name || 'unknown'}).
Elevation: ${d.elevation || 'unknown'} ft

METAR: ${d.metar || 'Not available'}

TAF: ${d.taf || 'Not available'}

NOTAMs: ${d.notams && d.notams.length > 0 ? d.notams.map(n => n.id + ': ' + n.text).join('\n') : 'None available'}`;
        } else if (body.type === 'route') {
          const d = body.data;
          const wpList = (d.waypoints || []).map((wp, i) => {
            const leg = d.legs && d.legs[i] ? ` → next leg: ${d.legs[i].dist}nm, hdg ${d.legs[i].hdg}°, ${d.legs[i].time}h, ${d.legs[i].fuel}gal` : '';
            return `${wp.code} (${wp.name || ''}, elev ${wp.elevation || '?'} ft)${leg}`;
          }).join('\n');

          const enrouteWx = (d.enroute || []).map(s =>
            `(${s.lat.toFixed(1)},${s.lon.toFixed(1)}): wind ${s.windDir || '?'}°/${s.windSpd || '?'}kt, ${s.weather || '?'}, temp ${s.temp || '?'}°C, vis ${s.vis || '?'}m`
          ).join('\n');

          const flCompStr = d.flCompare && d.flCompare.length > 0
            ? d.flCompare.map(f => `FL${f.fl < 100 ? '0' : ''}${f.fl}: ${f.timeH}h, ${f.fuelGal}gal, avg HW ${f.hwKt > 0 ? '+' : ''}${f.hwKt}kt`).join('\n')
            : 'Not available';

          userContent = `Generate a route weather briefing.

Flight Level: FL${d.flightLevel || '?'}
Departure Time: ${d.departureTime || 'Not set'}

Waypoints:
${wpList}

Departure Weather:
METAR: ${(d.departure && d.departure.metar) || 'Not available'}
TAF: ${(d.departure && d.departure.taf) || 'Not available'}
NOTAMs: ${d.departure && d.departure.notams && d.departure.notams.length > 0 ? d.departure.notams.map(n => n.id + ': ' + n.text).join('\n') : 'None'}

En-Route Weather Samples (surface):
${enrouteWx || 'Not available'}

FL Compare (time/fuel/headwind for FL10-FL200, selected FL${d.flightLevel || '?'}):
${flCompStr}

Destination:
TAF: ${(d.destination && d.destination.taf) || 'Not available'}
NOTAMs: ${d.destination && d.destination.notams && d.destination.notams.length > 0 ? d.destination.notams.map(n => n.id + ': ' + n.text).join('\n') : 'None'}

Alternate Airport: ${d.alternate ? d.alternate.code : 'None designated'}${d.alternate ? `
Alternate TAF: ${d.alternate.taf || 'Not available'}
Alternate NOTAMs: ${d.alternate.notams && d.alternate.notams.length > 0 ? d.alternate.notams.map(n => n.id + ': ' + n.text).join('\n') : 'None'}` : ''}`;
        } else {
          return jsonError('type must be "airport" or "route"', 400, request);
        }

        const anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 1024,
            stream: true,
            system: systemPrompt,
            messages: [{ role: 'user', content: userContent }]
          })
        });

        if (!anthropicResp.ok) {
          const errText = await anthropicResp.text();
          return jsonError('Anthropic API error: ' + anthropicResp.status + ' ' + errText, 502, request);
        }

        // Pipe the SSE stream through to the client
        const headers = new Headers({
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          ...corsHeaders(request)
        });

        return new Response(anthropicResp.body, { status: 200, headers });
      } catch (e) {
        return jsonError('briefing error: ' + e.message, 500, request);
      }
    }

    // Route: /ar/area-notams?firs=EFIN,ESAA (Autorouter NOTAM by FIR — airspace activation)
    if (path === '/ar/area-notams' && request.method === 'GET') {
      const firs = url.searchParams.get('firs') || '';
      const firList = firs.split(',').filter(Boolean);
      if (firList.length === 0 || firList.length > 5 || !firList.every(f => /^[A-Z]{4}$/.test(f))) {
        return jsonError('firs must be 1-5 valid 4-letter FIR codes', 400, request);
      }

      const cache = caches.default;
      const cacheKey = new Request('https://area-notams-cache/' + firList.join(','));
      let cached = await cache.match(cacheKey);
      if (cached) {
        const headers = new Headers(cached.headers);
        Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
        return new Response(cached.body, { status: cached.status, headers });
      }

      try {
        const token = await getArToken(env);
        const now = Math.floor(Date.now() / 1000);
        const in24h = now + 86400;
        const itemas = JSON.stringify(firList);
        // Fetch NOTAMs relevant to airspace activation (Q-code starts with QR, QD, QP for restricted/danger/prohibited)
        let allRows = [];
        let offset = 0;
        let total = Infinity;
        while (offset < total && offset < 500) {
          const qs = new URLSearchParams({
            itemas,
            offset: String(offset),
            limit: '100',
            startvalidity: String(now),
            endvalidity: String(in24h)
          });
          const resp = await fetch('https://api.autorouter.aero/v1.0/notam?' + qs.toString(), {
            headers: { 'Authorization': 'Bearer ' + token }
          });
          if (!resp.ok) {
            const errText = await resp.text();
            return jsonError('autorouter notam error: ' + resp.status + ' ' + errText, 502, request);
          }
          const data = await resp.json();
          total = data.total || 0;
          if (data.rows) allRows = allRows.concat(data.rows);
          offset += 100;
        }

        // Filter to NOTAMs mentioning R/D/P area designators (e.g. EFD117C, EFR93A)
        const areaNotams = allRows.filter(n => {
          return /\b[A-Z]{2}[DRP]\d{2,}/i.test(n.iteme || '');
        });

        const body = JSON.stringify({ total: areaNotams.length, rows: areaNotams });
        const cacheResp = new Response(body, {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=1800' }
        });
        await cache.put(cacheKey, cacheResp.clone());
        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
        });
      } catch (e) {
        return jsonError('area-notams error: ' + e.message, 502, request);
      }
    }

    // Route: /airspace-tiles/:z/:x/:y.png (OpenAIP tile proxy)
    const airspaceTileMatch = path.match(/^\/airspace-tiles\/(\d+)\/(\d+)\/(\d+)\.png$/);
    if (airspaceTileMatch) {
      const [, z, x, y] = airspaceTileMatch;
      const upstream = `https://a.api.tiles.openaip.net/api/data/openaip/${z}/${x}/${y}.png?apiKey=${env.OPENAIP_KEY}`;
      const resp = await fetch(upstream, {
        cf: { cacheTtl: 86400, cacheEverything: true }
      });
      const headers = new Headers(resp.headers);
      Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
      return new Response(resp.body, { status: resp.status, headers });
    }

    // Route: /airspaces?bbox=...&type=1,2,3 (OpenAIP vector airspace proxy)
    if (path === '/airspaces') {
      const bbox = url.searchParams.get('bbox') || '';
      const type = url.searchParams.get('type') || '1,2,3';
      if (!bbox || bbox.split(',').length !== 4) {
        return jsonError('bbox=west,south,east,north required', 400, request);
      }
      // Validate type codes
      const typeCodes = type.split(',').filter(Boolean);
      if (!typeCodes.every(t => /^\d+$/.test(t))) {
        return jsonError('type must be comma-separated integers', 400, request);
      }

      const cache = caches.default;
      const cacheKey = new Request('https://airspace-cache/' + bbox + '/' + type);
      let cached = await cache.match(cacheKey);
      if (cached) {
        const headers = new Headers(cached.headers);
        Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
        return new Response(cached.body, { status: cached.status, headers });
      }

      try {
        // Fetch all pages from OpenAIP
        let allItems = [];
        let page = 1;
        let totalPages = 1;
        while (page <= totalPages) {
          const qs = new URLSearchParams({ page: String(page), limit: '1000' });
          // Add each type code separately as the API expects repeated params
          typeCodes.forEach(t => qs.append('type', t));
          // bbox format for OpenAIP: west,south,east,north (same as our param)
          const upstream = `https://api.core.openaip.net/api/airspaces?${qs.toString()}&bbox=${bbox}`;
          const resp = await fetch(upstream, {
            headers: { 'x-openaip-api-key': env.OPENAIP_KEY }
          });
          if (!resp.ok) {
            const errText = await resp.text();
            return jsonError('OpenAIP API error: ' + resp.status + ' ' + errText, 502, request);
          }
          const data = await resp.json();
          if (data.items) allItems = allItems.concat(data.items);
          totalPages = data.totalPages || 1;
          page++;
          if (page > 20) break; // safety limit
        }

        const body = JSON.stringify({ items: allItems });
        const cacheResp = new Response(body, {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=86400' }
        });
        await cache.put(cacheKey, cacheResp.clone());
        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
        });
      } catch (e) {
        return jsonError('airspace fetch error: ' + e.message, 502, request);
      }
    }

    // Route: /navaids?bbox=west,south,east,north (OpenAIP navaids proxy)
    if (path === '/navaids') {
      const bbox = url.searchParams.get('bbox') || '';
      if (!bbox || bbox.split(',').length !== 4) {
        return jsonError('bbox=west,south,east,north required', 400, request);
      }

      const cache = caches.default;
      const cacheKey = new Request('https://navaids-cache/' + bbox);
      let cached = await cache.match(cacheKey);
      if (cached) {
        const headers = new Headers(cached.headers);
        Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
        return new Response(cached.body, { status: cached.status, headers });
      }

      try {
        let allItems = [];
        let page = 1;
        let totalPages = 1;
        while (page <= totalPages) {
          const upstream = `https://api.core.openaip.net/api/navaids?page=${page}&limit=1000&bbox=${bbox}`;
          const resp = await fetch(upstream, {
            headers: { 'x-openaip-api-key': env.OPENAIP_KEY }
          });
          if (!resp.ok) {
            const errText = await resp.text();
            return jsonError('OpenAIP navaids error: ' + resp.status + ' ' + errText, 502, request);
          }
          const data = await resp.json();
          if (data.items) allItems = allItems.concat(data.items);
          totalPages = data.totalPages || 1;
          page++;
          if (page > 20) break;
        }

        const body = JSON.stringify({ items: allItems });
        const cacheResp = new Response(body, {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=86400' }
        });
        await cache.put(cacheKey, cacheResp.clone());
        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
        });
      } catch (e) {
        return jsonError('navaids fetch error: ' + e.message, 502, request);
      }
    }

    // Route: /airport?icao=EFHK (OpenAIP single airport lookup)
    if (path === '/airport') {
      const icao = (url.searchParams.get('icao') || '').toUpperCase();
      if (!/^[A-Z]{4}$/.test(icao)) {
        return jsonError('icao must be a 4-letter ICAO code', 400, request);
      }

      const cache = caches.default;
      const cacheKey = new Request('https://openaip-airport-cache/' + icao);
      let cached = await cache.match(cacheKey);
      if (cached) {
        const headers = new Headers(cached.headers);
        Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
        return new Response(cached.body, { status: cached.status, headers });
      }

      try {
        const upstream = `https://api.core.openaip.net/api/airports?search=${icao}&limit=5`;
        const resp = await fetch(upstream, {
          headers: { 'x-openaip-api-key': env.OPENAIP_KEY }
        });
        if (!resp.ok) {
          const errText = await resp.text();
          return jsonError('OpenAIP airport error: ' + resp.status + ' ' + errText, 502, request);
        }
        const data = await resp.json();
        const match = (data.items || []).find(a => a.icaoCode === icao);
        const body = JSON.stringify(match || null);
        const cacheResp = new Response(body, {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=86400' }
        });
        await cache.put(cacheKey, cacheResp.clone());
        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
        });
      } catch (e) {
        return jsonError('OpenAIP airport error: ' + e.message, 502, request);
      }
    }

    // Route: /reporting-points?bbox=west,south,east,north (OpenAIP fixes proxy)
    if (path === '/reporting-points') {
      const bbox = url.searchParams.get('bbox') || '';
      if (!bbox || bbox.split(',').length !== 4) {
        return jsonError('bbox=west,south,east,north required', 400, request);
      }

      const cache = caches.default;
      const cacheKey = new Request('https://reporting-points-cache/' + bbox);
      let cached = await cache.match(cacheKey);
      if (cached) {
        const headers = new Headers(cached.headers);
        Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
        return new Response(cached.body, { status: cached.status, headers });
      }

      try {
        let allItems = [];
        let page = 1;
        let totalPages = 1;
        while (page <= totalPages) {
          const upstream = `https://api.core.openaip.net/api/reporting-points?page=${page}&limit=1000&bbox=${bbox}`;
          const resp = await fetch(upstream, {
            headers: { 'x-openaip-api-key': env.OPENAIP_KEY }
          });
          if (!resp.ok) {
            const errText = await resp.text();
            return jsonError('OpenAIP reporting-points error: ' + resp.status + ' ' + errText, 502, request);
          }
          const data = await resp.json();
          if (data.items) allItems = allItems.concat(data.items);
          totalPages = data.totalPages || 1;
          page++;
          if (page > 20) break;
        }

        const body = JSON.stringify({ items: allItems });
        const cacheResp = new Response(body, {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=86400' }
        });
        await cache.put(cacheKey, cacheResp.clone());
        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
        });
      } catch (e) {
        return jsonError('reporting-points fetch error: ' + e.message, 502, request);
      }
    }

    // Route: /swc-europe (WAFC London EUR SIGWX chart proxy)
    if (path === '/swc-europe') {
      const time = (url.searchParams.get('time') || '1200').replace(/\D/g, '').padStart(4, '0');
      const upstream = `https://www.vedur.is/photos/flugkort/PGDE14_EGRR_${time}.png`;
      const cache = caches.default;
      const cacheKey = new Request('https://swc-europe-cache/' + time);
      let cached = await cache.match(cacheKey);
      if (cached) {
        const headers = new Headers(cached.headers);
        Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
        return new Response(cached.body, { status: cached.status, headers });
      }
      try {
        const resp = await fetch(upstream);
        if (!resp.ok) return jsonError('SWC Europe fetch failed: ' + resp.status, 502, request);
        const body = await resp.arrayBuffer();
        const cacheResp = new Response(body, {
          headers: { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=3600' }
        });
        await cache.put(cacheKey, cacheResp.clone());
        return new Response(body, {
          headers: { 'Content-Type': 'image/png', ...corsHeaders(request) }
        });
      } catch (e) {
        return jsonError('SWC Europe error: ' + e.message, 502, request);
      }
    }

    // Route: /sigmet (international SIGMETs as GeoJSON)
    if (path === '/sigmet') {
      const cache = caches.default;
      const cacheKey = new Request('https://sigmet-cache/isigmet');
      let cached = await cache.match(cacheKey);
      if (cached) {
        const headers = new Headers(cached.headers);
        Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
        return new Response(cached.body, { status: cached.status, headers });
      }
      const upstream = 'https://aviationweather.gov/api/data/isigmet?format=geojson';
      const resp = await fetch(upstream);
      const body = await resp.text();
      const cacheResp = new Response(body, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=300' }
      });
      await cache.put(cacheKey, cacheResp.clone());
      const headers = new Headers(cacheResp.headers);
      Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
      return new Response(body, { status: 200, headers });
    }

    return new Response('Not found', { status: 404, headers: corsHeaders(request) });
  }
};

// --- Autorouter OAuth2 token helper ---
async function getArToken(env) {
  const cache = caches.default;
  const cacheKey = new Request('https://ar-token-cache/token');
  const cached = await cache.match(cacheKey);
  if (cached) {
    const data = await cached.json();
    return data.access_token;
  }

  const resp = await fetch('https://api.autorouter.aero/v1.0/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${encodeURIComponent(env.AR_EMAIL)}&client_secret=${encodeURIComponent(env.AR_PASSWORD)}`
  });

  if (!resp.ok) {
    throw new Error('OAuth token request failed: HTTP ' + resp.status);
  }

  const data = await resp.json();
  const token = data.access_token;
  if (!token) throw new Error('No access_token in OAuth response');

  // Cache for 3500s (token expires at 3600s)
  const cacheResp = new Response(JSON.stringify({ access_token: token }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=3500' }
  });
  await cache.put(cacheKey, cacheResp);

  return token;
}

const ALLOWED_ORIGINS = [
  'https://jjboeder.github.io',
  'http://localhost',
  'http://127.0.0.1'
];

function getAllowedOrigin(request) {
  const origin = request.headers.get('Origin') || '';
  return ALLOWED_ORIGINS.some(o => origin === o || origin.startsWith(o + ':')) ? origin : null;
}

function corsHeaders(request) {
  const origin = request ? getAllowedOrigin(request) : null;
  return {
    'Access-Control-Allow-Origin': origin || 'https://jjboeder.github.io',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function requireOrigin(request) {
  const origin = request.headers.get('Origin') || '';
  const referer = request.headers.get('Referer') || '';
  const originOk = ALLOWED_ORIGINS.some(o => origin === o || origin.startsWith(o + ':'));
  const refererOk = ALLOWED_ORIGINS.some(o => referer.startsWith(o));
  if (!originOk && !refererOk) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
    });
  }
  return null;
}

function jsonError(message, status, request) {
  return new Response(JSON.stringify({ error: message }), {
    status: status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(request)
    }
  });
}
