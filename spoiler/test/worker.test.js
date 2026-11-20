import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { parseScore, PROMPTS, DEFAULT_MODEL } from '../src/index.js';

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

test('parseScore takes the first number, clamped; null when there is none', () => {
  assert.equal(parseScore(' 5'), 5);
  assert.equal(parseScore('Score: 7.'), 7);
  assert.equal(parseScore('12'), 9);
  assert.equal(parseScore('-1'), 0);
  assert.equal(parseScore('maybe'), null);
  assert.equal(parseScore(undefined), null);
});

test('an unparseable reply is sent as unscored, not as a clean 0', async () => {
  const res = await worker.fetch(post({ text: 'hmm' }), env('I cannot rate that'));
  assert.deepEqual(await res.json(), { score: 0, isSpoiler: false, unscored: true });
});

test('SPOILER_MODEL and SPOILER_PROMPT pick the model and prompt; v2 is the default prompt', async () => {
  const e = env('9');
  await worker.fetch(post({ text: 'x' }), e);
  assert.equal(e.calls[0].model, DEFAULT_MODEL);
  assert.equal(e.calls[0].input.messages[0].content, PROMPTS.v2);

  const e2 = { ...env('9'), SPOILER_MODEL: '@cf/meta/llama-3.1-8b-instruct-fast', SPOILER_PROMPT: 'v1' };
  await worker.fetch(post({ text: 'x' }), e2);
  assert.equal(e2.calls[0].model, '@cf/meta/llama-3.1-8b-instruct-fast');
  assert.equal(e2.calls[0].input.messages[0].content, PROMPTS.v1);
});
