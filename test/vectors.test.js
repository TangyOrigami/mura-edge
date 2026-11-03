// The same golden vectors as mura-backend/internal/protect/golden_test.go.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importEdgeKey, deliveryToken, verifyDeliveryToken, isDecoy } from '../src/protect.js';

const edge = await importEdgeKey(new TextEncoder().encode('golden-edge-key'));
const EP = '019a0000-0000-7000-8000-000000000001';

test('delivery token matches Go', async () => {
  assert.equal(await deliveryToken(edge, EP, 1_900_000_000), '1900000000.QgcxxWS2KAM86CTqqwGjuKRcFDq5AXI112iMYKZ2Kg4');
});

test('token verification', async () => {
  const tok = await deliveryToken(edge, EP, 1_900_000_000);
  assert.ok(await verifyDeliveryToken(edge, EP, tok, 1_899_999_999));
  assert.ok(!(await verifyDeliveryToken(edge, EP, tok, 1_900_000_000)), 'expired');
  assert.ok(!(await verifyDeliveryToken(edge, '019a0000-0000-7000-8000-000000000002', tok, 1_800_000_000)), 'other episode');
  assert.ok(!(await verifyDeliveryToken(edge, EP, '1999999999' + tok.slice(10), 1_800_000_000)), 'edited expiry');
  assert.ok(!(await verifyDeliveryToken(edge, EP, null, 1_800_000_000)));
});

test('decoy matches Go', async () => {
  assert.ok(await isDecoy(edge, '00112233445566ff225bc216fec6ed68'));
  assert.ok(!(await isDecoy(edge, '00112233445566ff225bc216fec6ed69')));
});
