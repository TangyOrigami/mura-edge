// MURA tile gatekeeper — the production path for episode page tiles.
//
// GET /t/{episode uuid}/{32 hex}?tok=…
//
// Tiles are not stored anywhere: the API renders one from the original page
// the first time it is asked for. This Worker is what keeps that rare. It
// checks the delivery token with one HMAC and answers from Cloudflare's cache;
// only a miss goes to the API, which renders the tile and is then not asked
// again for it at this location. A tile's bytes never change under its id (a
// re-upload changes the id), so it is cached for a year.
//
// The cache key is the path without the token: every reader served variant
// A of a tile shares one cached object, which is what makes per-reader
// watermarking free at the edge. The token is checked on every request,
// cached or not.
//
// Decoys (honeytokens) are recognised by their own HMAC, before the token, so
// a scraper replaying an expired manifest is still caught. The hit is reported
// to the API in the background and answered as an ordinary 404.
//
// Bindings (wrangler.toml): EDGE_KEY (secret, hex — the API's
// protect.Keys.EdgeKey), API_ORIGIN (renders tiles on a miss, receives
// honeytoken reports).

import { importEdgeKey, verifyDeliveryToken, isDecoy, edgeReportSig, hexToBytes } from './protect.js';

const PATH = /^\/t\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([0-9a-f]{32})$/;

let keyPromise;
function edgeKey(env) {
  keyPromise ??= importEdgeKey(hexToBytes(env.EDGE_KEY));
  return keyPromise;
}

function corsHeaders(env, req) {
  const origin = req.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (origin && allowed.includes(origin)) {
    return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  }
  return {};
}

export default {
  async fetch(req, env, ctx) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return new Response(null, { status: 405 });
    }
    const url = new URL(req.url);
    const m = PATH.exec(url.pathname);
    if (!m) return new Response(null, { status: 404 });
    const [, episode, tile] = m;
    const key = await edgeKey(env);
    const cors = corsHeaders(env, req);

    if (await isDecoy(key, tile)) {
      ctx.waitUntil(report(env, key, tile, req));
      return new Response(null, { status: 404, headers: cors });
    }

    const now = Math.floor(Date.now() / 1000);
    if (!(await verifyDeliveryToken(key, episode, url.searchParams.get('tok'), now))) {
      return new Response(null, { status: 403, headers: cors });
    }

    const cacheKey = new Request(`${url.origin}/t/${episode}/${tile}`, { method: 'GET' });
    const cache = caches.default;
    let res = await cache.match(cacheKey);
    if (!res) {
      // Miss: the API renders it. The token goes along — the API checks it
      // too, so the origin route is never an open renderer.
      const origin = await fetch(`${env.API_ORIGIN}/v1/media/t/${episode}/${tile}?tok=${encodeURIComponent(url.searchParams.get('tok'))}`);
      if (!origin.ok) return new Response(null, { status: origin.status === 404 ? 404 : 502, headers: cors });
      res = new Response(origin.body, {
        headers: {
          'Content-Type': 'image/jpeg',
          // Edge copy: shared, a year. Rewritten below for the browser.
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
    }

    // To the browser: private, so no shared proxy keyed on the full URL
    // serves it on; immutable, so the reader's own cache never revalidates.
    const out = new Response(req.method === 'HEAD' ? null : res.body, res);
    out.headers.set('Cache-Control', 'private, max-age=31536000, immutable');
    out.headers.set('X-Content-Type-Options', 'nosniff');
    out.headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  },
};

async function report(env, key, tile, req) {
  if (!env.API_ORIGIN) return;
  const ip = req.headers.get('CF-Connecting-IP') || '';
  const ua = (req.headers.get('User-Agent') || '').slice(0, 300);
  try {
    await fetch(`${env.API_ORIGIN}/v1/media/h`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tile, ip, ua, sig: await edgeReportSig(key, tile, ip) }),
    });
  } catch {
    // A lost report loses one data point; the reader is not affected.
  }
}
