export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    // Route: /tile/:layer/:z/:x/:y.png
    const tileMatch = path.match(/^\/tile\/([a-z_]+)\/(\d+)\/(\d+)\/(\d+)\.png$/);
    if (tileMatch) {
      const [, layer, z, x, y] = tileMatch;
      const upstream = `https://tile.openweathermap.org/map/${layer}/${z}/${x}/${y}.png?appid=${env.OWM_KEY}`;
      const resp = await fetch(upstream, {
        cf: { cacheTtl: 600, cacheEverything: true }
      });
      const headers = new Headers(resp.headers);
      Object.entries(corsHeaders()).forEach(([k, v]) => headers.set(k, v));
      return new Response(resp.body, { status: resp.status, headers });
    }

    // Route: /wind-grid?bbox=south,west,north,east&step=2
    if (path === '/wind-grid') {
      const bbox = (url.searchParams.get('bbox') || '').split(',').map(Number);
      const step = parseFloat(url.searchParams.get('step')) || 2;
      if (bbox.length !== 4 || bbox.some(isNaN)) {
        return new Response(JSON.stringify({ error: 'bbox=south,west,north,east required' }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      }
      const [south, west, north, east] = bbox;
      const points = [];
      for (let lat = Math.ceil(south / step) * step; lat <= north; lat += step) {
        for (let lon = Math.ceil(west / step) * step; lon <= east; lon += step) {
          points.push({ lat: Math.round(lat * 1000) / 1000, lon: Math.round(lon * 1000) / 1000 });
        }
      }
      if (points.length > 50) {
        return new Response(JSON.stringify({ error: 'Too many grid points (' + points.length + '), increase step' }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
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
        const data = await resp.json();
        if (!data.wind) return null;
        return {
          lat: pt.lat, lon: pt.lon,
          wind_speed: data.wind.speed,
          wind_deg: data.wind.deg || 0,
          wind_gust: data.wind.gust || null
        };
      }));

      return new Response(JSON.stringify(results.filter(Boolean)), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }

    // Route: /weather?lat=...&lon=...
    if (path === '/weather') {
      const lat = url.searchParams.get('lat');
      const lon = url.searchParams.get('lon');
      if (!lat || !lon || isNaN(lat) || isNaN(lon)) {
        return new Response(JSON.stringify({ error: 'lat and lon required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      }
      const upstream = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${env.OWM_KEY}&units=metric`;
      const resp = await fetch(upstream);
      const headers = new Headers(resp.headers);
      Object.entries(corsHeaders()).forEach(([k, v]) => headers.set(k, v));
      headers.set('Content-Type', 'application/json');
      return new Response(resp.body, { status: resp.status, headers });
    }

    return new Response('Not found', { status: 404, headers: corsHeaders() });
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}
