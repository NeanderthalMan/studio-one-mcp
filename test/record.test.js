// live_record_setup over a fake bridge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordSetup } from '../src/record.js';

function bridge() {
  const calls = [];
  const call = async (op, args) => {
    calls.push([op, args]);
    if (op === 'command') return { executed: true };
    if (op === 'metronome') return { click: args.click ?? true, precount: false, preroll: false, precountBars: 1 };
    throw new Error(`unexpected ${op}`);
  };
  return { call, calls };
}

test('reads the metronome without touching record modes', async () => {
  const b = bridge();
  assert.deepEqual(await recordSetup(b.call, {}), { metronome: { click: true, precount: false, preroll: false, precountBars: 1 } });
  assert.ok(!b.calls.some(([op]) => op === 'command'));
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
