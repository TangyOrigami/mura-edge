import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { parseScore } from '../src/index.js';

function env(reply = '7') {
  const calls = [];
  return {
    calls,
    API_KEY: 'k-123',
    AI: { run: async (model, input) => (calls.push({ model, input }), { response: reply }) }
  };
}

const post = (body, key = 'k-123', method = 'POST') =>
  new Request('https://spoiler.example/', {
    method,
    headers: { 'Content-Type': 'application/json', ...(key ? { 'X-API-Key': key } : {}) },
    body: method === 'POST' ? JSON.stringify(body) : undefined
  });

test('scores a comment', async () => {
  const e = env('7');
  const res = await worker.fetch(post({ text: 'the captain dies at the end' }), e);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { score: 7, isSpoiler: true });
  assert.equal(e.calls.length, 1);
});

test('refuses without the key, and never runs the model', async () => {
  for (const key of [null, 'wrong']) {
    const e = env();
    const res = await worker.fetch(post({ text: 'x' }, key), e);
    assert.equal(res.status, 401);
    assert.equal(e.calls.length, 0);
  }
});

test('a Worker deployed without its secret refuses everything', async () => {
  const e = { ...env(), API_KEY: undefined };
  assert.equal((await worker.fetch(post({ text: 'x' }, ''), e)).status, 401);
});

test('rejects bad input before inference', async () => {
  const e = env();
  assert.equal((await worker.fetch(post({ text: '' }), e)).status, 400);
  assert.equal((await worker.fetch(post({ nope: 1 }), e)).status, 400);
  assert.equal((await worker.fetch(post({ text: 'x'.repeat(2001) }), e)).status, 413);
  assert.equal((await worker.fetch(post(null, 'k-123', 'GET'), e)).status, 405);
  assert.equal(e.calls.length, 0);
});

test('parseScore clamps and defaults', () => {
  assert.equal(parseScore(' 5'), 5);
  assert.equal(parseScore('12'), 9);
  assert.equal(parseScore('-1'), 0);
  assert.equal(parseScore('maybe'), 0);
  assert.equal(parseScore(undefined), 0);
});
