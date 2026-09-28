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

test('command executes: View/Console toggled twice leaves the window as it was', async (t) => {
  // Console is only enabled on the Song page (not the Start page).
  const { enabled } = await call('command', { category: 'View', name: 'Console', checkOnly: true });
  if (!enabled) return t.skip('View/Console is disabled right now; switch Studio One to the Song page');
  assert.deepEqual(await call('command', { category: 'View', name: 'Console' }), { executed: true });
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(await call('command', { category: 'View', name: 'Console' }), { executed: true });
});

test('eval (when installed with --allow-eval)', async (t) => {
  if (!bridgeStatus().allowEval) return t.skip('bridge installed without --allow-eval');
  assert.equal(await call('eval', { code: 'return 6 * 7' }), 42);
  // No "throws" case here: on 5.5.2 a throw inside Studio One pops a Scripting
  // Error dialog (the first time per session), even though the bridge catches
  // it. test/core.test.js covers the error path with the fake host.
  const n = await call('eval', { code: 'const b = component.hostComponent.model.root.find("mixer").find("channels"); let n = 0; for (let i = 0; i < 256; i++) { const e = b.getElement(i); if (e && e.isConnected()) n++; } return n;' });
  assert.equal(n, channels.length);
});

// ---- song, tracks, selection, transport ------------------------------------------

test('song: title, transport and track count', async () => {
  const s = await call('song');
  assert.equal(typeof s.title, 'string');
  assert.ok(s.trackCount > 0);
  assert.equal(typeof s.transport.tempo, 'number');
  assert.match(s.transport.position.display, /\d/);
  assert.ok(Array.isArray(s.selectedTracks));
});

test('tracks: deduplicated (a track with takes is listed once) and consistent with song', async () => {
  const tracks = await call('tracks');
  const song = await call('song');
  assert.equal(tracks.length, song.trackCount);
  for (const t of tracks) {
    assert.equal(typeof t.name, 'string');
    assert.equal(t.events.length, Math.min(t.eventCount, 50));
    for (const e of t.events) assert.ok(e.end >= e.start, `${t.name}: ${e.name}`);
  }
  const names = tracks.map((t) => t.name);
  const unique = tracks.filter((t) => names.indexOf(t.name) === names.lastIndexOf(t.name));
  assert.ok(unique.length > 0);
});

test('selectTrack: select one, then restore the previous selection', async () => {
  const before = (await call('song')).selectedTracks;
  const tracks = await call('tracks', { events: false });
  const names = tracks.map((t) => t.name);
  const target = names.find((n) => names.indexOf(n) === names.lastIndexOf(n));
  try {
    assert.deepEqual((await call('selectTrack', { name: target })).selected, [target]);
    assert.deepEqual((await call('song')).selectedTracks, [target]);
    await assert.rejects(call('selectTrack', { name: '__no such track__' }), /no track named/);
  } finally {
    for (const [i, name] of before.entries()) await call('selectTrack', { name, exclusive: i === 0 });
  }
});

test('setTransport: tempo, position and loop round trips, restored', async () => {
  const t0 = (await call('song')).transport;
  try {
    const t1 = await call('setTransport', { tempo: t0.tempo + 1, positionSeconds: 2, loop: !t0.loop });
    assert.equal(t1.tempo, t0.tempo + 1);
    assert.equal(t1.position.seconds, 2);
    assert.equal(t1.loop, !t0.loop);
    await assert.rejects(call('setTransport', { tempo: 1 }), /tempo must be/);
  } finally {
    const back = await call('setTransport', { tempo: t0.tempo, positionSeconds: t0.position.seconds, loop: t0.loop });
    assert.deepEqual([back.tempo, back.position.seconds, back.loop], [t0.tempo, t0.position.seconds, t0.loop]);
  }
});

test('transport: play then stop (never record), position restored', async () => {
  const t0 = (await call('song')).transport;
  assert.equal(t0.playing, false, 'start the live suite with Studio One stopped');
  try {
    assert.equal((await call('transport', { action: 'play' })).transport.playing, true);
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    assert.equal((await call('transport', { action: 'stop' })).transport.playing, false);
    await call('setTransport', { positionSeconds: t0.position.seconds });
  }
  await assert.rejects(call('transport', { action: 'explode' }), /action must be one of/);
});

// ---- markers, event selection -----------------------------------------------------

test('markers: listed with positions, playhead untouched', async () => {
  const pos = (await call('song')).transport.position.seconds;
  const { markers } = await call('markers');
  assert.ok(Array.isArray(markers));
  for (const m of markers) assert.equal(typeof m.seconds, 'number');
  assert.equal((await call('song')).transport.position.seconds, pos);
});

test('addMarker then deleteMarker leaves the markers as they were', async () => {
  const before = (await call('markers')).markers.map((m) => m.seconds);
  const at = 3.25;
  assert.ok(!before.includes(at), 'no marker at the test position already');
  const added = await call('addMarker', { seconds: at });
  assert.ok(added.markers.some((m) => Math.abs(m.seconds - at) < 0.001), 'new marker present');
  const deleted = await call('deleteMarker', { seconds: added.markers.find((m) => Math.abs(m.seconds - at) < 0.001).seconds });
  assert.deepEqual(deleted.markers.map((m) => m.seconds), before);
  await assert.rejects(call('deleteMarker', { number: 99 }), /no marker/);
});

test('selectEvents + Event/Mute Events + Unmute: events toggled and restored', async (t) => {
  const tracks = await call('tracks');
  const names = tracks.map((x) => x.name);
  const target = tracks.find((x) => x.eventCount > 0 && names.indexOf(x.name) === names.lastIndexOf(x.name) && x.events.every((e) => !e.muted));
  if (!target) return t.skip('no track with unmuted events');
  const beforeSel = (await call('song')).selectedTracks;
  try {
    const sel = await call('selectEvents', { track: target.name });
    assert.deepEqual([sel.selectedTracks, sel.eventCommandsEnabled], [[target.name], true]);
    assert.deepEqual(await call('command', { category: 'Event', name: 'Mute Events' }), { executed: true });
    assert.ok((await call('tracks', { name: target.name }))[0].events.every((e) => e.muted), 'muted');
  } finally {
    await call('command', { category: 'Event', name: 'Unmute Events' });
    await call('selectEvents', { none: true });
    for (const [i, name] of beforeSel.entries()) await call('selectTrack', { name, exclusive: i === 0 });
  }
  const after = (await call('tracks', { name: target.name })).find((x) => x.name === target.name);
  assert.ok(after.events.every((e) => !e.muted), 'unmuted again');
});
