// spoiler-detector — the AI half of the comment spoiler shield.
//
// POST / with X-API-Key and {"text": "..."} → {"score": 0–9, "isSpoiler": bool}
//
// A Workers AI model (SPOILER_MODEL, default Llama 3.2 1B) rates how much a
// comment gives away, on the scale in PROMPTS. The backend (internal/server/spoiler.go) calls it after a
// comment is posted, off the request path, and flags the comment when the
// score clears the `spoiler_threshold` platform flag. It replaces mura-llm,
// which was self-hosted.
//
// The key is required because every call is billed Workers AI inference: an
// open endpoint is anyone's free LLM on our account. Text is capped at the
// comment column's width, so a caller cannot buy a long generation either.

// v1 is the prompt the Worker shipped with. It let a 1B model score "the hero
// dies at the end and the villain was his father" a 0: an abstract scale with
// no worked examples is too much for a small model to apply. v2 anchors each
// band with an example and names the exact failure. Pick with SPOILER_PROMPT;
// compare both with `npm run eval:spoiler` before changing the deployed one.
export const PROMPTS = {
  v1: [
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
  ].join('\n'),
  v2: [
    'You moderate comments on a comic-reading site. Rate how much one comment',
    'reveals about what HAPPENS in the story, from 0 to 9. You do not know the',
    'comic; judge only the words. A comment that names an event, death,',
    'betrayal, identity or ending is a spoiler even if it is short or casual.',
    '',
    '0 — no story events: opinions, art, pacing, questions, jokes.',
    '    "The art in this chapter is gorgeous." → 0',
    '    "Who else thinks the villain will win?" → 1 (a guess, not a fact)',
    '3 — a minor event or detail from a later chapter.',
    '    "Wait until you meet the cat in chapter 9." → 3',
    '5 — a significant development: a new alliance, a battle won or lost.',
    '    "They lose the capital halfway through." → 5',
    '7 — a major reveal or twist: a death, a traitor, a secret identity.',
    '    "Mara is the traitor all along." → 7',
    '    "RIP Kenji, did not expect him to die." → 7',
    '9 — the ending or final resolution.',
    '    "The hero dies at the end and the villain was his father." → 9',
    '',
    'Reply with one digit and nothing else.'
  ].join('\n')
};

export const DEFAULT_MODEL = '@cf/meta/llama-3.2-1b-instruct';

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

/**
 * Parse the model's reply to a 0–9 score: the first number in it, clamped, so
 * "7", " 7." and "Score: 7" all read 7. Null when there is none — the caller says
 * so (`unscored`) rather than passing off a non-answer as "not a spoiler".
 * @returns {number | null}
 */
export function parseScore(raw) {
  const m = /-?\d+/.exec(String(raw ?? ''));
  return m ? Math.min(9, Math.max(0, Number(m[0]))) : null;
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

    const result = await env.AI.run(env.SPOILER_MODEL || DEFAULT_MODEL, {
      messages: [
        { role: 'system', content: PROMPTS[env.SPOILER_PROMPT] ?? PROMPTS.v2 },
        { role: 'user', content: text }
      ],
      // A few tokens, not two: larger models open with a space or "Score:".
      max_tokens: 6,
      temperature: 0
    });

    // The backend decodes `score` as an int, so an unscored comment still
    // sends 0 (fail open, as before) but now says it was not judged.
    const score = parseScore(result?.response);
    if (score === null) return Response.json({ score: 0, isSpoiler: false, unscored: true });
    return Response.json({ score, isSpoiler: score >= SPOILER_AT });
  }
};
