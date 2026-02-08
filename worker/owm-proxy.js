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
