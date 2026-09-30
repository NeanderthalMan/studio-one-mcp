import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDb, dbToFader, curveAt, writeAutomation } from '../src/automation.js';
import { toSeconds, manyToSeconds } from '../src/time.js';

test('parseDb reads Studio One volume text', () => {
  assert.equal(parseDb('-6.0 dB'), -6);
  assert.equal(parseDb('+3.2 dB'), 3.2);
  assert.equal(parseDb('3.2 dB'), 3.2);
  assert.equal(parseDb('-oo dB'), -Infinity);
  assert.equal(parseDb('-10.5'), -10.5, 'as the fader shows it, without the unit');
  assert.equal(parseDb('0dB'), 0);
  assert.equal(parseDb('-oo'), -Infinity);
  assert.equal(parseDb('L25'), null);
});

test('dbToFader interpolates a rising table and clamps at the ends', () => {
  const table = [[0, -Infinity], [0.25, -30], [0.5, -12], [0.75, -3], [1, 6]];
  assert.equal(dbToFader(table, -12), 0.5);
  assert.equal(dbToFader(table, -7.5), 0.625);
  assert.equal(dbToFader(table, -80), 0.25, 'below the first finite point: the first finite fader value');
  assert.equal(dbToFader(table, 12), 1);
});

test('curveAt: straight lines between points, flat past the ends', () => {
  const c = [{ t: 0, v: 1 }, { t: 4, v: 0 }, { t: 8, v: 0.5 }];
  assert.equal(curveAt(c, -1), 1);
  assert.equal(curveAt(c, 2), 0.5);
  assert.equal(curveAt(c, 6), 0.25);
  assert.equal(curveAt(c, 9), 0.5);
});

test('positions: seconds pass through; bars visit the playhead and put it back', async () => {
  const calls = [];
  let pos = 3;
  const call = async (op, args) => {
    calls.push([op, args]);
    if (op === 'song') return { transport: { playing: false, position: { seconds: pos } } };
    if (op === 'setTransport') {
      if (args.positionBars) pos = (Number(args.positionBars.split('.')[0]) - 1) * 2;
      if (args.positionSeconds !== undefined) pos = args.positionSeconds;
      return { position: { seconds: pos } };
    }
  };
  assert.equal(await toSeconds(call, 7), 7);
  assert.equal(calls.length, 0);
  assert.deepEqual(await manyToSeconds(call, ['9.1.1.0', 1, '2']), [16, 1, 2]);
  assert.equal(pos, 3, 'playhead put back');
  await assert.rejects(toSeconds(call, 'soon'), /seconds or bars/);
  await assert.rejects(toSeconds(async () => ({ transport: { playing: true, position: { seconds: 0 } } }), '9.1.1.0'), /stop playback first/);
});

test('writeAutomation checks its input before touching anything', async () => {
  const calls = [];
  const call = async (op) => {
    calls.push(op);
    if (op === 'song') return { transport: { playing: false, position: { seconds: 0 } } };
    if (op === 'channels') return [{ label: 'Vox', automation: 'off' }];
  };
  await assert.rejects(writeAutomation(call, { channel: 'Vox', points: [{ at: 0, value: 1 }] }), /two or more/);
  await assert.rejects(writeAutomation(call, { channel: 'Vox', parameter: 'mute', points: [] }), /volume or pan/);
  await assert.rejects(writeAutomation(call, { channel: 'Bass', points: [{ at: 0, value: 1 }, { at: 1, value: 0 }] }), /no channel named Bass/);
  await assert.rejects(writeAutomation(call, { channel: 'Vox', points: [{ at: 0, value: 1 }, { at: 1 }] }), /point 2 needs db/);
  await assert.rejects(writeAutomation(call, { channel: 'Vox', points: [{ at: 2, value: 1 }, { at: 2, value: 0 }] }), /span some time/);
  assert.ok(!calls.includes('transport'), 'never started playback');
});
