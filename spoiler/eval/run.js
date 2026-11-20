// Spoiler model eval: every candidate model × prompt against labelled.jsonl,
// through the Workers AI REST API (the same models the Worker binds).
//
//   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… npm run eval:spoiler
//   … npm run eval:spoiler -- --models @cf/meta/llama-3.1-8b-instruct-fast --prompts v2
//
// The token needs "Workers AI: Read". Each run costs a few hundred small
// inferences. Prints, per pair: mean absolute error, how many of the true
// spoilers (label ≥ 7) it would flag at each backend threshold, and how many
// clean comments (label ≤ 1) it would wrongly flag — pick the pair and the
// `spoiler_threshold` from that table, then deploy with SPOILER_MODEL /
// SPOILER_PROMPT set in spoiler/wrangler.toml.
import { readFileSync } from 'node:fs';
import { PROMPTS, parseScore } from '../src/index.js';

export const CANDIDATES = [
  '@cf/meta/llama-3.2-3b-instruct',
  '@cf/meta/llama-3.1-8b-instruct-fast',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/mistralai/mistral-small-3.1-24b-instruct'
];

// The backend flags when score/9 ≥ spoiler_threshold%. These are the scores
// each threshold admits: 90 → 9 only, 75 → 7+, 55 → 5+.
export const THRESHOLDS = [
  { pct: 90, min: 9 },
  { pct: 75, min: 7 },
  { pct: 55, min: 5 }
];

/** @param {{label:number, got:number|null}[]} rows */
export function summarise(rows) {
  const scored = rows.filter((r) => r.got !== null);
  const mae = scored.length ? scored.reduce((a, r) => a + Math.abs(r.got - r.label), 0) / scored.length : NaN;
  const spoilers = rows.filter((r) => r.label >= 7);
  const clean = rows.filter((r) => r.label <= 1);
  return {
    mae,
    unscored: rows.length - scored.length,
    byThreshold: THRESHOLDS.map(({ pct, min }) => ({
      pct,
      caught: spoilers.filter((r) => r.got !== null && r.got >= min).length,
      of: spoilers.length,
      falseFlags: clean.filter((r) => r.got !== null && r.got >= min).length,
      cleanOf: clean.length
    }))
  };
}

async function score(model, prompt, text, { account, token }) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'system', content: prompt }, { role: 'user', content: text }],
      max_tokens: 6,
      temperature: 0
    })
  });
  if (!res.ok) throw new Error(`${model}: HTTP ${res.status} ${await res.text()}`);
  const body = await res.json();
  return parseScore(body?.result?.response);
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1].split(',') : fallback;
}

async function main() {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) {
    console.error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Workers AI: Read).');
    process.exit(2);
  }
  const set = readFileSync(new URL('./labelled.jsonl', import.meta.url), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const models = arg('models', CANDIDATES);
  const prompts = arg('prompts', Object.keys(PROMPTS));

  console.log(`${set.length} labelled comments\n`);
  console.log('model | prompt | MAE | unscored | caught@90 | caught@75 | caught@55 | false flags @90/75/55');
  for (const model of models) {
    for (const p of prompts) {
      const rows = [];
      try {
        for (const { text, score: label } of set) {
          rows.push({ text, label, got: await score(model, PROMPTS[p], text, { account, token }) });
        }
      } catch (err) {
        console.log(`${model} | ${p} | error: ${err.message.slice(0, 120)}`);
        continue;
      }
      const s = summarise(rows);
      const t = s.byThreshold;
      console.log(
        `${model} | ${p} | ${s.mae.toFixed(2)} | ${s.unscored} | ` +
          t.map((x) => `${x.caught}/${x.of}`).join(' | ') +
          ` | ${t.map((x) => x.falseFlags).join('/')} of ${t[0].cleanOf}`
      );
      if (process.argv.includes('--verbose')) {
        for (const r of rows) if (r.got !== r.label) console.log(`    ${r.label} → ${r.got}  ${r.text}`);
      }
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
