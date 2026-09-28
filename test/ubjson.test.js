// UBJSON decoding, round-tripped through the test encoder, plus the exact
// bytes of an empty envelope as Studio One 5.5.2 wrote it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeUbjson } from '../src/ubjson.js';
import { encodeUbjson } from './helpers/fixtures.js';

test('round trip: objects, arrays, ints, doubles, booleans, null', () => {
  const v = { timeFormat: 2, events: [{ start: 4.558901160722598, pitch: 64, big: 70000, neg: -3, on: true, none: null }], envelopes: [] };
  assert.deepEqual(decodeUbjson(encodeUbjson(v)), v);
});

test('an empty envelope exactly as saved by Studio One', () => {
  const bytes = Buffer.from('7b690762697 06f6c617269016906657665 6e74735b5d7d'.replace(/ /g, ''), 'hex');
  assert.deepEqual(decodeUbjson(bytes), { bipolar: 1, events: [] });
});

test('bad input is an error, not garbage', () => {
  assert.throws(() => decodeUbjson(Buffer.from([0x7b, 0x69, 0x01, 0x61, 0x51])), /unknown marker/);
});
