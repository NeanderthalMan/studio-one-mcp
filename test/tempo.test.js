// live_tempo over a fake bridge with a tempo map (points: [{ at, bpm }]).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempo } from '../src/tempo.js';

function bridge({ playing = false } = {}) {
  const points = [{ at: 0, bpm: 120 }];
  let pos = 1;
  const segment = () => points.filter((p) => p.at <= pos).at(-1);
  const transport = () => ({ playing, tempo: segment().bpm, position: { seconds: pos, display: `bar@${pos}` } });
  const call = async (op, args) => {
    if (op === 'song') return { transport: transport() };
    if (op === 'setTransport') {
      if (args.positionSeconds !== undefined) pos = args.positionSeconds;
      if (args.positionBars !== undefined) pos = (parseInt(args.positionBars, 10) - 1) * 2;
      if (args.tempo !== undefined) segment().bpm = args.tempo;
      return transport();
    }
    if (op === 'command' && args.name === 'Insert') {
      points.push({ at: pos, bpm: segment().bpm });
      points.sort((a, b) => a.at - b.at);
      return { executed: true };
    }
    throw new Error(`unexpected ${op}`);
  };
  return { call, points, pos: () => pos };
}

test('at: samples positions (seconds or bars) and puts the playhead back', async () => {
  const b = bridge();
  b.points.push({ at: 4, bpm: 90 });
  const r = await tempo(b.call, { action: 'at', at: [2, 6, '3.1.1.0'] });
  assert.deepEqual(r.tempo.map((x) => x.bpm), [120, 90, 90]);
  assert.equal(b.pos(), 1);
  assert.deepEqual((await tempo(b.call, { action: 'at' })).tempo.map((x) => [x.at, x.bpm]), [[1, 120]]);
});

test('insert adds a point at the position with its bpm; set changes the containing segment', async () => {
  const b = bridge();
  const r = await tempo(b.call, { action: 'insert', at: 4, bpm: 90 });
  assert.equal(r.inserted.bpm, 90);
  assert.deepEqual(b.points, [{ at: 0, bpm: 120 }, { at: 4, bpm: 90 }]);
  const s = await tempo(b.call, { action: 'set', at: 6, bpm: 100 });
  assert.deepEqual([s.before.bpm, s.after.bpm], [90, 100]);
  assert.equal(b.points[0].bpm, 120);
  assert.equal(b.pos(), 1);
});

test('refuses while playing, and without bpm', async () => {
  await assert.rejects(tempo(bridge({ playing: true }).call, { action: 'at' }), /stop playback first/);
  await assert.rejects(tempo(bridge().call, { action: 'insert', at: 4 }), /needs bpm/);
  await assert.rejects(tempo(bridge().call, { action: 'insert', at: [1, 2], bpm: 90 }), /one position/);
});
