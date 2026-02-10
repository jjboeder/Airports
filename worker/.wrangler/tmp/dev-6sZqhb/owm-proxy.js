var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// owm-proxy.js
var owm_proxy_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(request) });
    }
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
    const tile2Match = path.match(/^\/tile2\/([A-Z_]+)\/(\d+)\/(\d+)\/(\d+)\.png$/);
    if (tile2Match) {
      const [, layer, z, x, y] = tile2Match;
      const arrowStep = url.searchParams.get("arrow_step") || "16";
      const useNorm = url.searchParams.get("use_norm") || "true";
      const date = url.searchParams.get("date") || "";
      let upstream = `https://maps.openweathermap.org/maps/2.0/weather/${layer}/${z}/${x}/${y}?appid=${env.OWM_KEY}&arrow_step=${arrowStep}&use_norm=${useNorm}`;
      if (date) upstream += `&date=${date}`;
      const resp = await fetch(upstream, {
        cf: { cacheTtl: 600, cacheEverything: true }
      });
      const headers = new Headers(resp.headers);
      Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
      return new Response(resp.body, { status: resp.status, headers });
    }
    if (path === "/taf") {
      const ids = url.searchParams.get("ids") || "";
      const icaoList = ids.split(",").filter(Boolean);
      if (icaoList.length === 0 || icaoList.length > 10 || !icaoList.every((id) => /^[A-Z]{4}$/.test(id))) {
        return jsonError("ids must be 1-10 valid 4-letter ICAO codes", 400);
      }
      const upstream = `https://aviationweather.gov/api/data/taf?ids=${icaoList.join(",")}&format=json`;
      const resp = await fetch(upstream, {
        cf: { cacheTtl: 600, cacheEverything: true }
      });
      const headers = new Headers(resp.headers);
      Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
      headers.set("Content-Type", "application/json");
      return new Response(resp.body, { status: resp.status, headers });
    }
    if (path === "/metar") {
      const ids = url.searchParams.get("ids") || "";
      const icaoList = ids.split(",").filter(Boolean);
      if (icaoList.length === 0 || icaoList.length > 50 || !icaoList.every((id) => /^[A-Z]{4}$/.test(id))) {
        return jsonError("ids must be 1-50 valid 4-letter ICAO codes", 400);
      }
      const cache = caches.default;
      const cacheKey = new Request("https://metar-cache/" + icaoList.join(","));
      let cached = await cache.match(cacheKey);
      if (cached) {
        const headers2 = new Headers(cached.headers);
        Object.entries(corsHeaders(request)).forEach(([k, v]) => headers2.set(k, v));
        return new Response(cached.body, { status: cached.status, headers: headers2 });
      }
      const upstream = `https://metar.vatsim.net/metar.php?id=${icaoList.join(",")}`;
      const resp = await fetch(upstream);
      const body = await resp.text();
      const cacheResp = new Response(body, {
        headers: { "Content-Type": "text/plain", "Cache-Control": "max-age=300" }
      });
      await cache.put(cacheKey, cacheResp.clone());
      const headers = new Headers(cacheResp.headers);
      Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
      return new Response(body, { status: 200, headers });
    }
    if (path === "/notams") {
      const icao = url.searchParams.get("icao") || "";
      if (!/^[A-Z]{4}$/.test(icao)) {
        return jsonError("icao must be a single 4-letter ICAO code", 400);
      }
      const cache = caches.default;
      const cacheKey = new Request("https://notam-cache/" + icao);
      let cached = await cache.match(cacheKey);
      if (cached) {
        const headers2 = new Headers(cached.headers);
        Object.entries(corsHeaders(request)).forEach(([k, v]) => headers2.set(k, v));
        return new Response(cached.body, { status: cached.status, headers: headers2 });
      }
      const upstream = "https://notams.aim.faa.gov/notamSearch/search";
      const resp = await fetch(upstream, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "searchType=0&designatorsForLocation=" + icao
      });
      const body = await resp.text();
      const cacheResp = new Response(body, {
        headers: { "Content-Type": "application/json", "Cache-Control": "max-age=1800" }
      });
      await cache.put(cacheKey, cacheResp.clone());
      const headers = new Headers(cacheResp.headers);
      Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
      return new Response(body, { status: 200, headers });
    }
    if (path === "/route-wx") {
      const raw = url.searchParams.get("points") || "";
      const nums = raw.split(",").map(Number);
      if (nums.length < 2 || nums.length % 2 !== 0 || nums.some(isNaN)) {
        return jsonError("points must be comma-separated lat,lon pairs", 400);
      }
      const points = [];
      for (let i = 0; i < nums.length; i += 2) {
        points.push({ lat: nums[i], lon: nums[i + 1] });
      }
      if (points.length > 10) {
        return jsonError("max 10 points", 400);
      }
      const cache = caches.default;
      const results = await Promise.all(points.map(async (pt) => {
        const cacheKey = new Request("https://wind-cache/" + pt.lat + "/" + pt.lon);
        let resp = await cache.match(cacheKey);
        if (!resp) {
          const upstream = `https://api.openweathermap.org/data/2.5/weather?lat=${pt.lat}&lon=${pt.lon}&appid=${env.OWM_KEY}&units=metric`;
          resp = await fetch(upstream);
          const body = await resp.text();
          resp = new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=600" } });
          await cache.put(cacheKey, resp.clone());
        }
        return resp.json();
      }));
      return new Response(JSON.stringify(results), {
        headers: { "Content-Type": "application/json", ...corsHeaders(request) }
      });
    }
    if (path === "/wind-grid") {
      const bbox = (url.searchParams.get("bbox") || "").split(",").map(Number);
      const step = parseFloat(url.searchParams.get("step")) || 2;
      const latStep = parseFloat(url.searchParams.get("latStep")) || step;
      if (bbox.length !== 4 || bbox.some(isNaN)) {
        return jsonError("bbox=south,west,north,east required", 400);
      }
      const [south, west, north, east] = bbox;
      const points = [];
      for (let lat = Math.ceil(south / latStep) * latStep; lat <= north; lat += latStep) {
        for (let lon = Math.ceil(west / step) * step; lon <= east; lon += step) {
          points.push({ lat: Math.round(lat * 1e3) / 1e3, lon: Math.round(lon * 1e3) / 1e3 });
        }
      }
      if (points.length > 120) {
        return jsonError("Too many grid points (" + points.length + "), increase step", 400);
      }
      const results = await Promise.all(points.map(async (pt) => {
        const upstream = `https://api.openweathermap.org/data/2.5/weather?lat=${pt.lat}&lon=${pt.lon}&appid=${env.OWM_KEY}&units=metric`;
        try {
          const resp = await fetch(upstream, { cf: { cacheTtl: 600, cacheEverything: true } });
          const data = await resp.json();
          if (!data.wind) return null;
          return {
            lat: pt.lat,
            lon: pt.lon,
            wind_speed: data.wind.speed,
            wind_deg: data.wind.deg || 0,
            wind_gust: data.wind.gust || null
          };
        } catch {
          return null;
        }
      }));
      return new Response(JSON.stringify(results.filter(Boolean)), {
        headers: { "Content-Type": "application/json", "Cache-Control": "max-age=600", ...corsHeaders(request) }
      });
    }
    if (path === "/weather") {
      const lat = url.searchParams.get("lat");
      const lon = url.searchParams.get("lon");
      if (!lat || !lon || isNaN(lat) || isNaN(lon)) {
        return jsonError("lat and lon required", 400);
      }
      const upstream = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${env.OWM_KEY}&units=metric`;
      const resp = await fetch(upstream);
      const headers = new Headers(resp.headers);
      Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
      headers.set("Content-Type", "application/json");
      return new Response(resp.body, { status: resp.status, headers });
    }
    if (path === "/onecall") {
      const lat = url.searchParams.get("lat");
      const lon = url.searchParams.get("lon");
      if (!lat || !lon || isNaN(lat) || isNaN(lon)) {
        return jsonError("lat and lon required", 400);
      }
      const upstream = `https://api.openweathermap.org/data/3.0/onecall?lat=${lat}&lon=${lon}&appid=${env.OWM_KEY}&units=metric&exclude=minutely,daily,alerts`;
      const resp = await fetch(upstream, { cf: { cacheTtl: 600, cacheEverything: true } });
      const headers = new Headers(resp.headers);
      Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
      headers.set("Content-Type", "application/json");
      return new Response(resp.body, { status: resp.status, headers });
    }
    if (path === "/wx-overview") {
      const lat = url.searchParams.get("lat");
      const lon = url.searchParams.get("lon");
      if (!lat || !lon || isNaN(lat) || isNaN(lon)) {
        return jsonError("lat and lon required", 400);
      }
      const upstream = `https://api.openweathermap.org/data/3.0/onecall/overview?lat=${lat}&lon=${lon}&appid=${env.OWM_KEY}&units=metric`;
      const resp = await fetch(upstream, { cf: { cacheTtl: 1800, cacheEverything: true } });
      const headers = new Headers(resp.headers);
      Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
      headers.set("Content-Type", "application/json");
      return new Response(resp.body, { status: resp.status, headers });
    }
    const arMetarMatch = path.match(/^\/ar\/metartaf\/([A-Z]{4})$/);
    if (arMetarMatch && request.method === "GET") {
      const icao = arMetarMatch[1];
      try {
        const token = await getArToken(env);
        const resp = await fetch(`https://api.autorouter.aero/v1.0/met/metartaf/${icao}`, {
          headers: { "Authorization": "Bearer " + token }
        });
        const body = await resp.text();
        return new Response(body, {
          status: resp.status,
          headers: { "Content-Type": "application/json", ...corsHeaders(request) }
        });
      } catch (e) {
        return jsonError("autorouter metartaf error: " + e.message, 502);
      }
    }
    if (path === "/ar/gramet" && request.method === "GET") {
      const waypoints = url.searchParams.get("waypoints") || "";
      const departuretime = url.searchParams.get("departuretime") || "";
      const totaleet = url.searchParams.get("totaleet") || "";
      const altitude = url.searchParams.get("altitude") || "";
      if (!waypoints || !departuretime || !totaleet || !altitude) {
        return jsonError("waypoints, departuretime, totaleet, altitude required", 400);
      }
      try {
        const token = await getArToken(env);
        const qs = new URLSearchParams({ waypoints, departuretime, totaleet, altitude, format: "png" });
        const resp = await fetch("https://api.autorouter.aero/v1.0/met/gramet?" + qs.toString(), {
          headers: { "Authorization": "Bearer " + token }
        });
        if (!resp.ok) {
          const errBody = await resp.text();
          return new Response(errBody, { status: resp.status, headers: corsHeaders(request) });
        }
        const headers = new Headers(resp.headers);
        Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
        headers.set("Cache-Control", "max-age=600");
        return new Response(resp.body, { status: 200, headers });
      } catch (e) {
        return jsonError("autorouter gramet error: " + e.message, 502);
      }
    }
    if (path === "/ar/route" && request.method === "POST") {
      const blocked = requireOrigin(request);
      if (blocked) return blocked;
      try {
        const body = await request.json();
        const token = await getArToken(env);
        const resp = await fetch("https://api.autorouter.aero/v1.0/router", {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body)
        });
        const respBody = await resp.text();
        if (resp.ok) {
          return new Response(JSON.stringify({ id: respBody.trim() }), {
            status: 200,
            headers: { "Content-Type": "application/json", ...corsHeaders(request) }
          });
        }
        return new Response(respBody, {
          status: resp.status,
          headers: { "Content-Type": "application/json", ...corsHeaders(request) }
        });
      } catch (e) {
        return jsonError("autorouter route error: " + e.message, 502);
      }
    }
    const arPollMatch = path.match(/^\/ar\/route\/([a-zA-Z0-9-]+)\/poll$/);
    if (arPollMatch && request.method === "PUT") {
      const blocked = requireOrigin(request);
      if (blocked) return blocked;
      const routeId = arPollMatch[1];
      try {
        const token = await getArToken(env);
        const resp = await fetch(`https://api.autorouter.aero/v1.0/router/${routeId}/longpoll`, {
          method: "PUT",
          headers: { "Authorization": "Bearer " + token }
        });
        const respBody = await resp.text();
        return new Response(respBody, {
          status: resp.status,
          headers: { "Content-Type": "application/json", ...corsHeaders(request) }
        });
      } catch (e) {
        return jsonError("autorouter poll error: " + e.message, 502);
      }
    }
    const arStopMatch = path.match(/^\/ar\/route\/([a-zA-Z0-9-]+)\/stop$/);
    if (arStopMatch && request.method === "PUT") {
      const blocked = requireOrigin(request);
      if (blocked) return blocked;
      const routeId = arStopMatch[1];
      try {
        const token = await getArToken(env);
        const resp = await fetch(`https://api.autorouter.aero/v1.0/router/${routeId}/stop`, {
          method: "PUT",
          headers: { "Authorization": "Bearer " + token }
        });
        const respBody = await resp.text();
        return new Response(respBody, {
          status: resp.status,
          headers: { "Content-Type": "application/json", ...corsHeaders(request) }
        });
      } catch (e) {
        return jsonError("autorouter stop error: " + e.message, 502);
      }
    }
    const arCloseMatch = path.match(/^\/ar\/route\/([a-zA-Z0-9-]+)\/close$/);
    if (arCloseMatch && request.method === "PUT") {
      const blocked = requireOrigin(request);
      if (blocked) return blocked;
      const routeId = arCloseMatch[1];
      try {
        const token = await getArToken(env);
        const resp = await fetch(`https://api.autorouter.aero/v1.0/router/${routeId}/close`, {
          method: "PUT",
          headers: { "Authorization": "Bearer " + token }
        });
        const respBody = await resp.text();
        return new Response(respBody, {
          status: resp.status,
          headers: { "Content-Type": "application/json", ...corsHeaders(request) }
        });
      } catch (e) {
        return jsonError("autorouter close error: " + e.message, 502);
      }
    }
    const arDocsMatch = path.match(/^\/ar\/airport-docs\/([A-Z]{4})$/);
    if (arDocsMatch && request.method === "GET") {
      const icao = arDocsMatch[1];
      try {
        const token = await getArToken(env);
        const cache = caches.default;
        const cacheKey = new Request("https://ar-docs-cache/" + icao);
        let cached = await cache.match(cacheKey);
        if (cached) {
          const headers = new Headers(cached.headers);
          Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
          return new Response(cached.body, { status: 200, headers });
        }
        const resp = await fetch(`https://api.autorouter.aero/v1.0/pams/airport/${icao}`, {
          headers: { "Authorization": "Bearer " + token }
        });
        const body = await resp.text();
        if (resp.ok) {
          const cacheResp = new Response(body, {
            headers: { "Content-Type": "application/json", "Cache-Control": "max-age=86400" }
          });
          await cache.put(cacheKey, cacheResp.clone());
        }
        return new Response(body, {
          status: resp.status,
          headers: { "Content-Type": "application/json", ...corsHeaders(request) }
        });
      } catch (e) {
        return jsonError("autorouter airport-docs error: " + e.message, 502);
      }
    }
    const arDocMatch = path.match(/^\/ar\/airport-doc\/([a-zA-Z0-9_-]+)$/);
    if (arDocMatch && request.method === "GET") {
      const docId = arDocMatch[1];
      try {
        const token = await getArToken(env);
        const resp = await fetch(`https://api.autorouter.aero/v1.0/pams/id/${docId}`, {
          headers: { "Authorization": "Bearer " + token }
        });
        if (!resp.ok) {
          const errBody = await resp.text();
          return new Response(errBody, { status: resp.status, headers: corsHeaders(request) });
        }
        const headers = new Headers(resp.headers);
        Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
        return new Response(resp.body, { status: 200, headers });
      } catch (e) {
        return jsonError("autorouter airport-doc error: " + e.message, 502);
      }
    }
    const arPdfMatch = path.match(/^\/ar\/airport-pdf\/([A-Z]{4})$/);
    if (arPdfMatch && request.method === "GET") {
      const icao = arPdfMatch[1];
      try {
        const token = await getArToken(env);
        const resp = await fetch(`https://api.autorouter.aero/v1.0/pams/airport/${icao}/package`, {
          headers: { "Authorization": "Bearer " + token }
        });
        if (!resp.ok) {
          const errBody = await resp.text();
          return new Response(errBody, { status: resp.status, headers: corsHeaders(request) });
        }
        const headers = new Headers(resp.headers);
        Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
        headers.set("Content-Disposition", `inline; filename="${icao}_charts.pdf"`);
        return new Response(resp.body, { status: 200, headers });
      } catch (e) {
        return jsonError("autorouter airport-pdf error: " + e.message, 502);
      }
    }
    if (path === "/ar/aircraft" && request.method === "GET") {
      try {
        const token = await getArToken(env);
        const page = url.searchParams.get("page") || "1";
        const rows = url.searchParams.get("rows") || "50";
        const resp = await fetch(`https://api.autorouter.aero/v1.0/aircraft?page=${page}&rows=${rows}`, {
          headers: { "Authorization": "Bearer " + token }
        });
        const body = await resp.text();
        return new Response(body, {
          status: resp.status,
          headers: { "Content-Type": "application/json", ...corsHeaders(request) }
        });
      } catch (e) {
        return jsonError("autorouter aircraft error: " + e.message, 502);
      }
    }
    if (path === "/briefing" && request.method === "POST") {
      const blocked = requireOrigin(request);
      if (blocked) return blocked;
      try {
        const body = await request.json();
        if (!body || !body.type || !body.data) {
          return jsonError("type and data required", 400);
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
        if (body.type === "airport") {
          const d = body.data;
          userContent = `Generate a weather briefing for ${d.icao || "unknown"} (${d.name || "unknown"}).
Elevation: ${d.elevation || "unknown"} ft

METAR: ${d.metar || "Not available"}

TAF: ${d.taf || "Not available"}

NOTAMs: ${d.notams && d.notams.length > 0 ? d.notams.map((n) => n.id + ": " + n.text).join("\n") : "None available"}`;
        } else if (body.type === "route") {
          const d = body.data;
          const wpList = (d.waypoints || []).map((wp, i) => {
            const leg = d.legs && d.legs[i] ? ` \u2192 next leg: ${d.legs[i].dist}nm, hdg ${d.legs[i].hdg}\xB0, ${d.legs[i].time}h, ${d.legs[i].fuel}gal` : "";
            return `${wp.code} (${wp.name || ""}, elev ${wp.elevation || "?"} ft)${leg}`;
          }).join("\n");
          const enrouteWx = (d.enroute || []).map(
            (s) => `(${s.lat.toFixed(1)},${s.lon.toFixed(1)}): wind ${s.windDir || "?"}\xB0/${s.windSpd || "?"}kt, ${s.weather || "?"}, temp ${s.temp || "?"}\xB0C, vis ${s.vis || "?"}m`
          ).join("\n");
          const flCompStr = d.flCompare && d.flCompare.length > 0 ? d.flCompare.map((f) => `FL${f.fl < 100 ? "0" : ""}${f.fl}: ${f.timeH}h, ${f.fuelGal}gal, avg HW ${f.hwKt > 0 ? "+" : ""}${f.hwKt}kt`).join("\n") : "Not available";
          userContent = `Generate a route weather briefing.

Flight Level: FL${d.flightLevel || "?"}
Departure Time: ${d.departureTime || "Not set"}

Waypoints:
${wpList}

Departure Weather:
METAR: ${d.departure && d.departure.metar || "Not available"}
TAF: ${d.departure && d.departure.taf || "Not available"}
NOTAMs: ${d.departure && d.departure.notams && d.departure.notams.length > 0 ? d.departure.notams.map((n) => n.id + ": " + n.text).join("\n") : "None"}

En-Route Weather Samples (surface):
${enrouteWx || "Not available"}

FL Compare (time/fuel/headwind for FL10-FL200, selected FL${d.flightLevel || "?"}):
${flCompStr}

Destination:
TAF: ${d.destination && d.destination.taf || "Not available"}
NOTAMs: ${d.destination && d.destination.notams && d.destination.notams.length > 0 ? d.destination.notams.map((n) => n.id + ": " + n.text).join("\n") : "None"}

Alternate Airport: ${d.alternate ? d.alternate.code : "None designated"}${d.alternate ? `
Alternate TAF: ${d.alternate.taf || "Not available"}
Alternate NOTAMs: ${d.alternate.notams && d.alternate.notams.length > 0 ? d.alternate.notams.map((n) => n.id + ": " + n.text).join("\n") : "None"}` : ""}`;
        } else {
          return jsonError('type must be "airport" or "route"', 400);
        }
        const anthropicResp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 1024,
            stream: true,
            system: systemPrompt,
            messages: [{ role: "user", content: userContent }]
          })
        });
        if (!anthropicResp.ok) {
          const errText = await anthropicResp.text();
          return jsonError("Anthropic API error: " + anthropicResp.status + " " + errText, 502);
        }
        const headers = new Headers({
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          ...corsHeaders(request)
        });
        return new Response(anthropicResp.body, { status: 200, headers });
      } catch (e) {
        return jsonError("briefing error: " + e.message, 500);
      }
    }
    if (path === "/ar/area-notams" && request.method === "GET") {
      const firs = url.searchParams.get("firs") || "";
      const firList = firs.split(",").filter(Boolean);
      if (firList.length === 0 || firList.length > 5 || !firList.every((f) => /^[A-Z]{4}$/.test(f))) {
        return jsonError("firs must be 1-5 valid 4-letter FIR codes", 400);
      }
      const cache = caches.default;
      const cacheKey = new Request("https://area-notams-cache/" + firList.join(","));
      let cached = await cache.match(cacheKey);
      if (cached) {
        const headers = new Headers(cached.headers);
        Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
        return new Response(cached.body, { status: cached.status, headers });
      }
      try {
        const token = await getArToken(env);
        const now = Math.floor(Date.now() / 1e3);
        const in24h = now + 86400;
        const itemas = JSON.stringify(firList);
        let allRows = [];
        let offset = 0;
        let total = Infinity;
        while (offset < total && offset < 500) {
          const qs = new URLSearchParams({
            itemas,
            offset: String(offset),
            limit: "100",
            startvalidity: String(now),
            endvalidity: String(in24h)
          });
          const resp = await fetch("https://api.autorouter.aero/v1.0/notam?" + qs.toString(), {
            headers: { "Authorization": "Bearer " + token }
          });
          if (!resp.ok) {
            const errText = await resp.text();
            return jsonError("autorouter notam error: " + resp.status + " " + errText, 502);
          }
          const data = await resp.json();
          total = data.total || 0;
          if (data.rows) allRows = allRows.concat(data.rows);
          offset += 100;
        }
        const areaNotams = allRows.filter((n) => {
          return /\b[A-Z]{2}[DRP]\d{2,}/i.test(n.iteme || "");
        });
        const body = JSON.stringify({ total: areaNotams.length, rows: areaNotams });
        const cacheResp = new Response(body, {
          headers: { "Content-Type": "application/json", "Cache-Control": "max-age=1800" }
        });
        await cache.put(cacheKey, cacheResp.clone());
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders(request) }
        });
      } catch (e) {
        return jsonError("area-notams error: " + e.message, 502);
      }
    }
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
    if (path === "/airspaces") {
      const bbox = url.searchParams.get("bbox") || "";
      const type = url.searchParams.get("type") || "1,2,3";
      if (!bbox || bbox.split(",").length !== 4) {
        return jsonError("bbox=west,south,east,north required", 400);
      }
      const typeCodes = type.split(",").filter(Boolean);
      if (!typeCodes.every((t) => /^\d+$/.test(t))) {
        return jsonError("type must be comma-separated integers", 400);
      }
      const cache = caches.default;
      const cacheKey = new Request("https://airspace-cache/" + bbox + "/" + type);
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
          const qs = new URLSearchParams({ page: String(page), limit: "1000" });
          typeCodes.forEach((t) => qs.append("type", t));
          const upstream = `https://api.core.openaip.net/api/airspaces?${qs.toString()}&bbox=${bbox}`;
          const resp = await fetch(upstream, {
            headers: { "x-openaip-api-key": env.OPENAIP_KEY }
          });
          if (!resp.ok) {
            const errText = await resp.text();
            return jsonError("OpenAIP API error: " + resp.status + " " + errText, 502);
          }
          const data = await resp.json();
          if (data.items) allItems = allItems.concat(data.items);
          totalPages = data.totalPages || 1;
          page++;
          if (page > 20) break;
        }
        const body = JSON.stringify({ items: allItems });
        const cacheResp = new Response(body, {
          headers: { "Content-Type": "application/json", "Cache-Control": "max-age=86400" }
        });
        await cache.put(cacheKey, cacheResp.clone());
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders(request) }
        });
      } catch (e) {
        return jsonError("airspace fetch error: " + e.message, 502);
      }
    }
    if (path === "/navaids") {
      const bbox = url.searchParams.get("bbox") || "";
      if (!bbox || bbox.split(",").length !== 4) {
        return jsonError("bbox=west,south,east,north required", 400);
      }
      const cache = caches.default;
      const cacheKey = new Request("https://navaids-cache/" + bbox);
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
            headers: { "x-openaip-api-key": env.OPENAIP_KEY }
          });
          if (!resp.ok) {
            const errText = await resp.text();
            return jsonError("OpenAIP navaids error: " + resp.status + " " + errText, 502);
          }
          const data = await resp.json();
          if (data.items) allItems = allItems.concat(data.items);
          totalPages = data.totalPages || 1;
          page++;
          if (page > 20) break;
        }
        const body = JSON.stringify({ items: allItems });
        const cacheResp = new Response(body, {
          headers: { "Content-Type": "application/json", "Cache-Control": "max-age=86400" }
        });
        await cache.put(cacheKey, cacheResp.clone());
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders(request) }
        });
      } catch (e) {
        return jsonError("navaids fetch error: " + e.message, 502);
      }
    }
    if (path === "/airport") {
      const icao = (url.searchParams.get("icao") || "").toUpperCase();
      if (!/^[A-Z]{4}$/.test(icao)) {
        return jsonError("icao must be a 4-letter ICAO code", 400);
      }
      const cache = caches.default;
      const cacheKey = new Request("https://openaip-airport-cache/" + icao);
      let cached = await cache.match(cacheKey);
      if (cached) {
        const headers = new Headers(cached.headers);
        Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
        return new Response(cached.body, { status: cached.status, headers });
      }
      try {
        const upstream = `https://api.core.openaip.net/api/airports?search=${icao}&limit=5`;
        const resp = await fetch(upstream, {
          headers: { "x-openaip-api-key": env.OPENAIP_KEY }
        });
        if (!resp.ok) {
          const errText = await resp.text();
          return jsonError("OpenAIP airport error: " + resp.status + " " + errText, 502);
        }
        const data = await resp.json();
        const match = (data.items || []).find((a) => a.icaoCode === icao);
        const body = JSON.stringify(match || null);
        const cacheResp = new Response(body, {
          headers: { "Content-Type": "application/json", "Cache-Control": "max-age=86400" }
        });
        await cache.put(cacheKey, cacheResp.clone());
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders(request) }
        });
      } catch (e) {
        return jsonError("OpenAIP airport error: " + e.message, 502);
      }
    }
    if (path === "/reporting-points") {
      const bbox = url.searchParams.get("bbox") || "";
      if (!bbox || bbox.split(",").length !== 4) {
        return jsonError("bbox=west,south,east,north required", 400);
      }
      const cache = caches.default;
      const cacheKey = new Request("https://reporting-points-cache/" + bbox);
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
            headers: { "x-openaip-api-key": env.OPENAIP_KEY }
          });
          if (!resp.ok) {
            const errText = await resp.text();
            return jsonError("OpenAIP reporting-points error: " + resp.status + " " + errText, 502);
          }
          const data = await resp.json();
          if (data.items) allItems = allItems.concat(data.items);
          totalPages = data.totalPages || 1;
          page++;
          if (page > 20) break;
        }
        const body = JSON.stringify({ items: allItems });
        const cacheResp = new Response(body, {
          headers: { "Content-Type": "application/json", "Cache-Control": "max-age=86400" }
        });
        await cache.put(cacheKey, cacheResp.clone());
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders(request) }
        });
      } catch (e) {
        return jsonError("reporting-points fetch error: " + e.message, 502);
      }
    }
    if (path === "/sigmet") {
      const cache = caches.default;
      const cacheKey = new Request("https://sigmet-cache/isigmet");
      let cached = await cache.match(cacheKey);
      if (cached) {
        const headers2 = new Headers(cached.headers);
        Object.entries(corsHeaders(request)).forEach(([k, v]) => headers2.set(k, v));
        return new Response(cached.body, { status: cached.status, headers: headers2 });
      }
      const upstream = "https://aviationweather.gov/api/data/isigmet?format=geojson";
      const resp = await fetch(upstream);
      const body = await resp.text();
      const cacheResp = new Response(body, {
        headers: { "Content-Type": "application/json", "Cache-Control": "max-age=300" }
      });
      await cache.put(cacheKey, cacheResp.clone());
      const headers = new Headers(cacheResp.headers);
      Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
      return new Response(body, { status: 200, headers });
    }
    return new Response("Not found", { status: 404, headers: corsHeaders(request) });
  }
};
async function getArToken(env) {
  const cache = caches.default;
  const cacheKey = new Request("https://ar-token-cache/token");
  const cached = await cache.match(cacheKey);
  if (cached) {
    const data2 = await cached.json();
    return data2.access_token;
  }
  const resp = await fetch("https://api.autorouter.aero/v1.0/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=client_credentials&client_id=${encodeURIComponent(env.AR_EMAIL)}&client_secret=${encodeURIComponent(env.AR_PASSWORD)}`
  });
  if (!resp.ok) {
    throw new Error("OAuth token request failed: HTTP " + resp.status);
  }
  const data = await resp.json();
  const token = data.access_token;
  if (!token) throw new Error("No access_token in OAuth response");
  const cacheResp = new Response(JSON.stringify({ access_token: token }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "max-age=3500" }
  });
  await cache.put(cacheKey, cacheResp);
  return token;
}
__name(getArToken, "getArToken");
var ALLOWED_ORIGINS = [
  "https://jjboeder.github.io",
  "http://localhost",
  "http://127.0.0.1"
];
function getAllowedOrigin(request) {
  const origin = request.headers.get("Origin") || "";
  return ALLOWED_ORIGINS.some((o) => origin === o || origin.startsWith(o + ":")) ? origin : null;
}
__name(getAllowedOrigin, "getAllowedOrigin");
function corsHeaders(request) {
  const origin = request ? getAllowedOrigin(request) : null;
  return {
    "Access-Control-Allow-Origin": origin || "https://jjboeder.github.io",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}
__name(corsHeaders, "corsHeaders");
function requireOrigin(request) {
  const origin = request.headers.get("Origin") || "";
  const referer = request.headers.get("Referer") || "";
  const originOk = ALLOWED_ORIGINS.some((o) => origin === o || origin.startsWith(o + ":"));
  const refererOk = ALLOWED_ORIGINS.some((o) => referer.startsWith(o));
  if (!originOk && !refererOk) {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) }
    });
  }
  return null;
}
__name(requireOrigin, "requireOrigin");
function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "https://jjboeder.github.io",
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}
__name(jsonError, "jsonError");

// ../../../.npm/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../.npm/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError2 = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError2;

// .wrangler/tmp/bundle-z9upNm/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = owm_proxy_default;

// ../../../.npm/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-z9upNm/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=owm-proxy.js.map
