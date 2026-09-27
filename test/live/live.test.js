// Integration tests against a real, running Studio One with the MCP Bridge
// device installed and receiving from the IAC bus. Not part of `npm test`:
//
//   npm run test:live
//
// They touch the open song only reversibly: one channel's mute/solo/volume are
// changed and restored, and View/Console is toggled twice. Pick the channel with
// S1_TEST_CHANNEL (default: the first channel that is neither muted nor soloed).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { bridgeStatus, call } from '../../src/bridge.js';

let channels;
let testChannel;

before(async () => {
  const s = bridgeStatus();
  assert.ok(s.loaded, `bridge not loaded: ${s.reason}`);
  await call('ping', {}, { timeoutMs: 3000 });
  channels = await call('channels');
  testChannel = process.env.S1_TEST_CHANNEL
    ? channels.find((c) => c.label === process.env.S1_TEST_CHANNEL)
    : channels.find((c) => !c.mute && !c.solo);
  assert.ok(testChannel, 'a channel to test with');
});

test('ping round trip is fast and carries the live session', async () => {
  const t0 = Date.now();
  const pong = await call('ping');
  assert.equal(pong.pong, true);
  assert.equal(pong.session, bridgeStatus().session);
  assert.ok(Date.now() - t0 < 2000, `ping took ${Date.now() - t0}ms`);
});

test('channels: every strip has a label and volume; other params are numbers or null', () => {
  assert.ok(channels.length > 0);
  for (const c of channels) {
    assert.equal(typeof c.label, 'string');
    assert.equal(typeof c.volume, 'number', `${c.label}.volume`);
    // Not every strip has every param: an output like 2TrackIn has no pan.
    for (const f of ['pan', 'mute', 'solo', 'recordArmed']) assert.ok(c[f] === null || typeof c[f] === 'number', `${c.label}.${f}`);
  }
});

for (const [field, value] of [['mute', 1], ['solo', 1], ['volume', 0.5]]) {
  test(`setChannel ${field} round trip on the test channel, restored`, async () => {
    const original = testChannel[field];
    try {
      const set = await call('setChannel', { channel: testChannel.label, field, value });
      assert.equal(set.before, original);
      assert.equal(set.after, value);
      const now = (await call('channels')).find((c) => c.label === testChannel.label);
      assert.equal(now[field], value, 'visible in a fresh channels read');
    } finally {
      const back = await call('setChannel', { channel: testChannel.label, field, value: original });
      assert.equal(back.after, original);
    }
  });
}

test('setChannel on an unknown channel is an error', async () => {
  await assert.rejects(call('setChannel', { channel: '__no such channel__', field: 'mute', value: 1 }), /no channel named/);
});

test('every listed command can be queried (check-only, nothing runs)', async () => {
  const all = await call('listCommands', { withState: true }, { timeoutMs: 20000 });
  assert.ok(all.length > 500, `${all.length} commands`);
  for (const c of all) assert.equal(typeof c.enabled, 'boolean', `${c.category}/${c.name}`);
  const enabled = all.filter((c) => c.enabled).length;
  assert.ok(enabled > 0 && enabled < all.length, `${enabled}/${all.length} enabled right now`);
  for (const must of ['Transport/Start', 'Transport/Stop', 'Transport/Record', 'View/Console', 'File/Save', 'Edit/Undo'])
    assert.ok(all.some((c) => `${c.category}/${c.name}` === must), must);
});

test('command check-only does not run it; unknown commands are errors', async () => {
  const r = await call('command', { category: 'Transport', name: 'Start', checkOnly: true });
  assert.equal(typeof r.enabled, 'boolean');
  await assert.rejects(call('command', { category: 'View', name: 'Mixer' }), /unknown command/);
});

test('command executes: View/Console toggled twice leaves the window as it was', async () => {
  assert.deepEqual(await call('command', { category: 'View', name: 'Console' }), { executed: true });
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(await call('command', { category: 'View', name: 'Console' }), { executed: true });
});

test('eval (when installed with --allow-eval)', async (t) => {
  if (!bridgeStatus().allowEval) return t.skip('bridge installed without --allow-eval');
  assert.equal(await call('eval', { code: 'return 6 * 7' }), 42);
  await assert.rejects(call('eval', { code: 'throw new Error("nope")' }), /nope/);
  const n = await call('eval', { code: 'const b = component.hostComponent.model.root.find("mixer").find("channels"); let n = 0; for (let i = 0; i < 256; i++) { const e = b.getElement(i); if (e && e.isConnected()) n++; } return n;' });
  assert.equal(n, channels.length);
});
