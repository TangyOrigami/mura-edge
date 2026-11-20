import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { summarise } from '../eval/run.js';

test('labelled set is well-formed and covers both ends', () => {
  const rows = readFileSync(new URL('../eval/labelled.jsonl', import.meta.url), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(rows.length >= 20);
  for (const r of rows) {
    assert.equal(typeof r.text, 'string');
    assert.ok(Number.isInteger(r.score) && r.score >= 0 && r.score <= 9, r.text);
  }
  assert.ok(rows.filter((r) => r.score >= 7).length >= 5);
  assert.ok(rows.filter((r) => r.score <= 1).length >= 5);
});

test('summarise counts catches and false flags per backend threshold', () => {
  const s = summarise([
    { label: 9, got: 9 }, { label: 7, got: 7 }, { label: 7, got: 0 },
    { label: 0, got: 7 }, { label: 0, got: 0 }, { label: 5, got: null }
  ]);
  assert.equal(s.unscored, 1);
  const [at90, at75] = s.byThreshold;
  assert.deepEqual([at90.caught, at90.falseFlags], [1, 0]);
  assert.deepEqual([at75.caught, at75.of, at75.falseFlags, at75.cleanOf], [2, 3, 1, 2]);
});
