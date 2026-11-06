// spoiler-detector — the AI half of the comment spoiler shield.
//
// POST / with X-API-Key and {"text": "..."} → {"score": 0–9, "isSpoiler": bool}
//
// Llama 3.2 1B on Workers AI rates how much a comment gives away, on the scale
// in SYSTEM_PROMPT. The backend (internal/server/spoiler.go) calls it after a
// comment is posted, off the request path, and flags the comment when the
// score clears the `spoiler_threshold` platform flag. It replaces mura-llm,
// which was self-hosted.
//
// The key is required because every call is billed Workers AI inference: an
// open endpoint is anyone's free LLM on our account. Text is capped at the
// comment column's width, so a caller cannot buy a long generation either.

const SYSTEM_PROMPT = [
  'Rate how much this text spoils media (film, book, show, game).',
  "You don't know the title — judge only by content.",
  '',
  '0 = no plot info (review, opinion, genre, premise)',
  '3 = minor plot details',
  '5 = significant plot developments',
  '7 = major reveal or twist',
  '9 = explicit ending or climactic resolution',
  '',
  'Spoiler signals: specific outcomes (who dies, the villain, the twist),',
  "resolution language ('at the end', 'final scene'), pivotal moments.",
  '',
  'Respond with ONLY the digit.'
].join('\n');

// comments.body is VARCHAR(2000); anything longer did not come from us.
const MAX_TEXT = 2000;

// Score at or above which the model itself calls it a spoiler ("minor plot
// details"). The backend applies its own, adjustable threshold to the score.
const SPOILER_AT = 3;

const enc = new TextEncoder();

// Constant-time comparison of two strings, without leaking which byte differed.
async function sameKey(a, b) {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b))
  ]);
  return crypto.subtle.timingSafeEqual
    ? crypto.subtle.timingSafeEqual(ha, hb)
    : new Uint8Array(ha).every((x, i) => x === new Uint8Array(hb)[i]);
}

/** Parse the model's reply to a 0–9 score; anything unparseable is 0. */
export function parseScore(raw) {
  const n = parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(n) ? Math.min(9, Math.max(0, n)) : 0;
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });

    // Fail closed: a Worker deployed without its secret refuses everything
    // rather than running open.
    const key = request.headers.get('X-API-Key') ?? '';
    if (!env.API_KEY || !key || !(await sameKey(key, env.API_KEY))) {
      return new Response(null, { status: 401 });
    }

    let text;
    try {
      ({ text } = await request.json());
    } catch {
      return Response.json({ error: 'body must be JSON {"text": "..."}' }, { status: 400 });
    }
    if (typeof text !== 'string' || text.trim() === '') {
      return Response.json({ error: 'text is required' }, { status: 400 });
    }
    if (text.length > MAX_TEXT) {
      return Response.json({ error: `text is limited to ${MAX_TEXT} characters` }, { status: 413 });
    }

    const result = await env.AI.run('@cf/meta/llama-3.2-1b-instruct', {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text }
      ],
      max_tokens: 2
    });

    const score = parseScore(result?.response);
    return Response.json({ score, isSpoiler: score >= SPOILER_AT });
  }
};
