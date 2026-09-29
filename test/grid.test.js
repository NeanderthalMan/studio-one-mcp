import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gridBeats } from '../src/grid.js';

test('grid names to quarter-note beats', () => {
  assert.equal(gridBeats('1/4'), 1);
  assert.equal(gridBeats('1/16'), 0.25);
  assert.equal(gridBeats('1/8T'), 1 / 3);
  assert.equal(gridBeats('1/8t'), 1 / 3);
  assert.equal(gridBeats('1/8.'), 0.75);
  assert.equal(gridBeats(0.5), 0.5);
  for (const bad of ['sixteenth', '1/0', '', undefined, -1]) assert.throws(() => gridBeats(bad), /grid must look like/);
});
