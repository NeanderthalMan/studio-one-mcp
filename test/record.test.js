// live_record_setup over a fake bridge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordSetup } from '../src/record.js';

function bridge() {
  const calls = [];
  // Autopunch as 5.5.2 showed it: punchIn follows punch-in; "any" is on with either.
  const punch = { in: false, out: false };
  let loopRange = { start: { seconds: 0 }, end: { seconds: 16 } };
  const call = async (op, args) => {
    calls.push([op, args]);
    if (op === 'command') {
      const on = args.args?.[1] === 1;
      if (args.name === 'Autopunch') punch.in = punch.out = on;
      if (args.name === 'Autopunch In') punch.in = on;
      if (args.name === 'Autopunch Out') punch.out = on;
      return { executed: true };
    }
    if (op === 'metronome') return { click: args.click ?? true, precount: false, preroll: false, precountBars: 1 };
    if (op === 'song') return { transport: { autopunch: { punchIn: punch.in, any: punch.in || punch.out }, loopRange } };
    if (op === 'setLoop') { loopRange = { start: { seconds: args.start }, end: { seconds: args.end } }; return {}; }
    throw new Error(`unexpected ${op}`);
  };
  return { call, calls };
}

test('reads the metronome without touching record modes', async () => {
  const b = bridge();
  assert.deepEqual(await recordSetup(b.call, {}), {
    metronome: { click: true, precount: false, preroll: false, precountBars: 1 },
    punch: { autopunch: { punchIn: false, any: false } },
  });
  assert.ok(!b.calls.some(([op]) => op === 'command'));
});

test('punch: in / out / both / off via the Autopunch commands; range goes to the loop locators', async () => {
  const b = bridge();
  const r = await recordSetup(b.call, { punch: 'in', punchFrom: 8, punchTo: 12 });
  assert.deepEqual(r.punch, { autopunch: { punchIn: true, any: true }, range: { start: { seconds: 8 }, end: { seconds: 12 } } });
  assert.deepEqual((await recordSetup(b.call, { punch: 'out' })).punch.autopunch, { punchIn: false, any: true });
  assert.deepEqual((await recordSetup(b.call, { punch: 'both' })).punch.autopunch, { punchIn: true, any: true });
  assert.deepEqual((await recordSetup(b.call, { punch: 'off' })).punch.autopunch, { punchIn: false, any: false });
  const n = b.calls.length;
  await assert.rejects(recordSetup(b.call, { punch: 'sideways' }), /punch must be one of/);
  await assert.rejects(recordSetup(b.call, { punchFrom: 8 }), /give both punchFrom and punchTo/);
  assert.equal(b.calls.length, n, 'bad punch arguments change nothing');
});

test('record modes are set with a State argument and reported as unconfirmed', async () => {
  const b = bridge();
  const r = await recordSetup(b.call, { takesToLayers: true, replace: false, click: false });
  assert.deepEqual(r.recordModesSet, { replace: false, takesToLayers: true });
  assert.match(r.note, /cannot be read back/);
  assert.deepEqual(b.calls.filter(([op]) => op === 'command').map(([, a]) => [a.name, a.args]), [
    ['Record Mode Replace', ['State', 0]],
    ['Record Takes to Layers', ['State', 1]],
  ]);
  assert.equal(r.metronome.click, false);
  await assert.rejects(recordSetup(b.call, { loopTakes: true, loopMix: true }), /alternatives/);
});
