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
import { pluginParamNames } from '../../src/plugins.js';
import { arranger, listMacros, runMacro } from '../../src/arranger.js';
import { tempo } from '../../src/tempo.js';
import { trackEdit } from '../../src/tracks.js';

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

// ---- loop, takes, undo, track state, event edits, add track, meters ----------------

const uniqueNamed = async (pred = () => true) => {
  const tracks = await call('tracks');
  const names = tracks.map((x) => x.name);
  return tracks.find((x) => names.indexOf(x.name) === names.lastIndexOf(x.name) && pred(x));
};

test('setLoop in bars and seconds, restored', async () => {
  const t0 = (await call('song')).transport;
  try {
    const t1 = await call('setLoop', { start: '3.1.1.0', end: '5.1.1.0' });
    assert.equal(t1.loopRange.start.display.startsWith('0003.01.01'), true);
    assert.equal(t1.loopRange.end.display.startsWith('0005.01.01'), true);
    await assert.rejects(call('setLoop', { start: 'soon' }), /bars like/);
  } finally {
    const back = await call('setLoop', { start: t0.loopRange.start.seconds, end: t0.loopRange.end.seconds, enable: t0.loop });
    assert.deepEqual([back.loopRange.start.seconds, back.loopRange.end.seconds, back.loop], [t0.loopRange.start.seconds, t0.loopRange.end.seconds, t0.loop]);
  }
});

test('setTransport position in bars', async () => {
  const t0 = (await call('song')).transport;
  try {
    assert.ok((await call('setTransport', { positionBars: '2.1.1.0' })).position.display.startsWith('0002.01.01'));
  } finally {
    await call('setTransport', { positionSeconds: t0.position.seconds });
  }
});

test('takes: next then previous restores the active take', async (t) => {
  const track = await uniqueNamed((x) => x.takes > 1);
  if (!track) return t.skip('no track with more than one take');
  // Layers do not wrap: on the last take "next" is a no-op, so step whichever way moves.
  const list = await call('takes', { track: track.name });
  const same = (r) => r.activeEvents.join() === list.activeEvents.join();
  let [dir, back] = ['next', 'previous'];
  let moved = await call('takes', { track: track.name, action: dir });
  if (same(moved)) {
    [dir, back] = [back, dir];
    moved = await call('takes', { track: track.name, action: dir });
  }
  try {
    assert.ok(!same(moved), 'a different take is playing');
  } finally {
    if (!same(moved)) assert.ok(same(await call('takes', { track: track.name, action: back })), 'original take restored');
  }
});

// Mute is not on Studio One's undo stack: an undo here reverts the edit before it (it
// once flipped the take the test above had just restored). Toggle back instead.
test('trackState mute toggles the channel, and toggling again restores it', async () => {
  const track = await uniqueNamed();
  const muteOf = async () => (await call('channels')).find((c) => c.label === track.channel).mute;
  const before = await muteOf();
  const r = await call('trackState', { track: track.name, action: 'mute' });
  try {
    assert.equal(r.channel.mute, before ? 0 : 1);
  } finally {
    if ((await muteOf()) !== before) await call('trackState', { track: track.name, action: 'mute' });
  }
  assert.equal(await muteOf(), before);
});

test('editEvents split, then undo restores the events', async (t) => {
  const track = await uniqueNamed((x) => x.events.some((e) => e.end - e.start > 2));
  if (!track) return t.skip('no track with an event longer than 2 s');
  const ev = track.events.find((e) => e.end - e.start > 2);
  const r = await call('editEvents', { track: track.name, action: 'split', at: ev.start + 1 });
  try {
    assert.equal(r.events.length, track.events.length + 1, 'one more event after the split');
  } finally {
    await call('undo', {});
  }
  assert.equal((await call('tracks', { name: track.name })).find((x) => x.name === track.name).eventCount, track.eventCount);
});

test('addTrack, then undo removes it', async () => {
  const n0 = (await call('song')).trackCount;
  const r = await call('addTrack', { type: 'audioMono' });
  try {
    assert.equal(r.trackCount, n0 + 1);
  } finally {
    await call('undo', {});
  }
  assert.equal((await call('song')).trackCount, n0);
});

test('meters: a dB reading for every channel', async () => {
  const m = await call('meters');
  assert.equal(m.length, channels.length);
  for (const c of m) assert.ok(typeof c.left === 'number' && c.left <= 12 && c.left >= -200, `${c.label}: ${c.left}`);
});

test('save is available (checked, not run)', async () => {
  assert.equal(typeof (await call('command', { category: 'File', name: 'Save', checkOnly: true })).enabled, 'boolean');
  assert.equal(typeof (await call('command', { category: 'File', name: 'Save New Version', checkOnly: true })).enabled, 'boolean');
});

// ---- inserts, sends ---------------------------------------------------------------
// (live_record is never exercised here: it writes a take into the song.)

test('inserts: listed for every channel', async () => {
  const r = await call('inserts', {});
  assert.equal(r.length, channels.length);
  for (const c of r) for (const i of c.inserts) assert.equal(typeof i.name, 'string');
});

test('bypass one plug-in and restore it', async (t) => {
  const withPlugin = (await call('inserts', {})).find((c) => c.inserts.length);
  if (!withPlugin) return t.skip('no channel has a plug-in; add one (e.g. Pro EQ) to test bypass');
  const slot = withPlugin.inserts[0];
  try {
    const r = await call('setInsertBypass', { channel: withPlugin.channel, slot: slot.slot, bypassed: !slot.bypassed });
    assert.equal(r.after, !slot.bypassed);
  } finally {
    const back = await call('setInsertBypass', { channel: withPlugin.channel, slot: slot.slot, bypassed: slot.bypassed });
    assert.equal(back.after, slot.bypassed);
  }
});

// ---- plug-in parameters, automation --------------------------------------------------

test('plug-in parameters: read by discovered names, set one normalised, restore the raw value', async (t) => {
  const rack = (await call('inserts', {})).find((c) => c.inserts.some((i) => pluginParamNames(i.name).names.length));
  if (!rack) return t.skip('no channel has a PreSonus plug-in (e.g. Fat Channel or Pro EQ)');
  const plug = rack.inserts.find((i) => pluginParamNames(i.name).names.length);
  const r = await call('pluginParams', { channel: rack.channel, slot: plug.slot, names: pluginParamNames(plug.name).names });
  assert.equal(r.plugin, plug.name);
  assert.ok(r.params.length > 3, `${r.params.length} parameters answered`);
  for (const p of r.params) assert.equal(typeof p.text, 'string', p.name);
  const p = r.params.find((x) => typeof x.normalized === 'number' && x.max - x.min > 1);
  assert.ok(p, 'a continuous parameter');
  const target = p.normalized > 0.5 ? 0.25 : 0.75;
  try {
    const set = await call('setPluginParam', { channel: rack.channel, slot: plug.slot, param: p.name, normalized: target });
    assert.ok(Math.abs(set.after.normalized - target) < 0.01, `${p.name}: ${set.after.normalized}`);
    assert.notEqual(set.after.text, p.text);
  } finally {
    const back = await call('setPluginParam', { channel: rack.channel, slot: plug.slot, param: p.name, value: p.value });
    assert.equal(back.after.value, p.value);
  }
  await assert.rejects(call('setPluginParam', { channel: rack.channel, slot: plug.slot, param: '__nope__', value: 1 }), /no parameter __nope__/);
});

test('automation: every channel has a mode; set one and restore it', async () => {
  const now = await call('channels');
  for (const c of now) assert.ok(c.automation === null || ['off', 'read', 'touch', 'latch', 'write'].includes(c.automation), `${c.label}: ${c.automation}`);
  const before = now.find((c) => c.label === testChannel.label).automation;
  const mode = before === 'read' ? 'off' : 'read';
  try {
    assert.deepEqual(await call('setAutomation', { channel: testChannel.label, mode }), { channel: testChannel.label, before, after: mode });
  } finally {
    assert.equal((await call('setAutomation', { channel: testChannel.label, mode: before })).after, before);
  }
});

// ---- macros, arranger ------------------------------------------------------------------

test('macros: listed by decoded title; one checked, not run', async (t) => {
  const macros = await listMacros(call, { withState: true });
  if (!macros.length) return t.skip('no macros');
  for (const m of macros) assert.ok(!m.title.startsWith('Macro '), `undecoded: ${m.title}`);
  const r = await runMacro(call, { title: macros[0].title, checkOnly: true });
  assert.equal(typeof r.enabled, 'boolean');
});

// Seen on 5.5.2: Create Sections from Markers is one undo step and also shows the
// arranger track; play, stop, jumps and the sync mode are not undo steps. The sync
// mode cannot be read, so this test leaves it at Off (a fresh start had it at a
// setting where the jump never came within 6 s). "Create Markers from Sections" is
// enabled exactly while the arranger track is shown, not while sections exist.
test('arranger: sections from markers, jump while playing, all restored', async () => {
  const song0 = await call('song');
  const t0 = song0.transport;
  assert.equal(t0.playing, false, 'start the live suite with Studio One stopped');
  const markers0 = (await call('markers')).markers.map((m) => m.seconds);
  for (const s of [4, 8]) assert.ok(!markers0.includes(s), `no marker at ${s}s already`);
  const arrangerShown = async () => (await call('command', { category: 'Arranger', name: 'Create Markers from Sections', checkOnly: true })).enabled;
  const shown0 = await arrangerShown();
  await assert.rejects(arranger(call, () => [], { action: 'next' }), /while playing/);
  await call('addMarker', { seconds: 4 });
  await call('addMarker', { seconds: 8 });
  let created = false;
  try {
    created = (await arranger(call, () => [], { action: 'createFromMarkers' })).executed;
    assert.equal(created, true);
    assert.equal((await arranger(call, () => [], { action: 'syncMode', sync: 'off' })).executed, true);
    await call('setTransport', { positionSeconds: 0 });
    await call('transport', { action: 'play' });
    await arranger(call, () => [], { action: 'goto', section: 3 });
    let pos = 0;
    for (let i = 0; i < 30 && !(pos >= 8 && pos < 12); i++) {
      await new Promise((r) => setTimeout(r, 100));
      pos = (await call('song')).transport.position.seconds;
    }
    assert.ok(pos >= 8 && pos < 12, `playing inside section 3 (8 s..), at ${pos}`);
    const loop = (await call('song')).transport.loopRange;
    assert.deepEqual([loop.start.seconds, loop.end.seconds], [t0.loopRange.start.seconds, t0.loopRange.end.seconds], 'loop range kept');
  } finally {
    await call('transport', { action: 'stop' });
    if (created) await call('undo', {});
    for (const s of [8, 4]) await call('deleteMarker', { seconds: s }).catch(() => {});
    await call('setLoop', { start: t0.loopRange.start.seconds, end: t0.loopRange.end.seconds, enable: t0.loop });
    await call('setTransport', { positionSeconds: t0.position.seconds });
    for (const [i, name] of song0.selectedTracks.entries()) await call('selectTrack', { name, exclusive: i === 0 });
    if ((await arrangerShown()) !== shown0) await call('command', { category: 'View', name: 'Open Arranger Track' });
  }
  assert.deepEqual((await call('markers')).markers.map((m) => m.seconds), markers0);
  assert.equal(await arrangerShown(), shown0, 'arranger track shown/hidden as before');
});

// Insert + set are two undo steps. "Tempo/Delete" is not used: it did not delete
// the point at the playhead. A single-segment map is checked by changing the tempo
// late in the song and seeing it at 2 s too (then undoing that).
test('tempo: insert a change at 4 s, read it, two undos remove it', async () => {
  const t0 = (await call('song')).transport;
  const at = async (s) => (await tempo(call, { action: 'at', at: [s] })).tempo[0].bpm;
  const base = await at(2);
  assert.equal(await at(6), base, 'no tempo change between 2 s and 6 s to begin with');
  const bpm = base === 90 ? 100 : 90;
  const r = await tempo(call, { action: 'insert', at: 4, bpm });
  try {
    assert.equal(r.inserted.bpm, bpm);
    assert.deepEqual([await at(2), await at(6)], [base, bpm]);
  } finally {
    await call('undo', { steps: 2 });
  }
  assert.deepEqual([await at(2), await at(6)], [base, base]);
  await tempo(call, { action: 'set', at: 6, bpm: base + 1 });
  const reach = await at(2);
  await call('undo', {});
  assert.equal(reach, base + 1, 'the point at 4 s is gone: one segment again');
  assert.equal(await at(2), base);
  assert.equal((await call('song')).transport.position.seconds, t0.position.seconds);
});

test('notes: an instrument part reads back with pitches, velocities and times inside the part', async (t) => {
  const music = (await call('tracks')).find((x) => x.mediaType === 'Music' && x.eventCount > 0);
  if (!music) return t.skip('no instrument track with a part');
  const r = await call('notes', { track: music.name });
  const part = r.parts.find((p) => p.noteCount > 0);
  if (!part) return t.skip(`${music.name} has no notes`);
  assert.equal(part.notes.length, Math.min(part.noteCount, 500));
  for (const n of part.notes) {
    assert.ok(Number.isInteger(n.pitch) && n.pitch >= 0 && n.pitch <= 127, `pitch ${n.pitch}`);
    assert.ok(n.velocity >= 0 && n.velocity <= 127, `velocity ${n.velocity}`);
    assert.ok(n.start >= part.start - 0.001 && n.end <= part.end + 0.001 && n.end >= n.start, `${n.start}-${n.end} in ${part.start}-${part.end}`);
    assert.equal(typeof n.beat, 'number');
  }
});

// A scratch track is added, renamed, recoloured and removed: the song ends as it began
// (two undo steps: add, remove). Rename and colour are not undo steps.
test('track edit: rename, colour and remove a scratch track; selection kept', async () => {
  const song0 = await call('song');
  const added = await call('addTrack', { type: 'audioMono' });
  const scratch = added.added[0];
  let name = scratch;
  try {
    const r = await trackEdit(call, { track: scratch, action: 'rename', name: 'MCP Scratch Track' });
    name = r.renamed.after;
    assert.equal(name, 'MCP Scratch Track');
    const c = await trackEdit(call, { track: name, action: 'color', color: '#1e90ff' });
    assert.equal(c.after, '#1e90ff');
    assert.equal((await call('tracks', { name, events: false })).find((x) => x.name === name).color, '#1e90ff', 'the track shows the colour');
  } finally {
    await trackEdit(call, { track: name, action: 'remove' });
  }
  const song1 = await call('song');
  assert.equal(song1.trackCount, song0.trackCount);
  for (const [i, n] of song0.selectedTracks.entries()) await call('selectTrack', { name: n, exclusive: i === 0 });
  assert.deepEqual((await call('song')).selectedTracks, song0.selectedTracks);
});

test('sends: set a level and restore it', async (t) => {
  const withSend = (await call('sends', {})).find((c) => c.sends.length);
  if (!withSend) return t.skip('no channel has a send');
  const s = withSend.sends[0];
  assert.equal(typeof s.to, 'string', 'destination is a name (display text), not a list index');
  assert.notEqual(s.to, '-1');
  try {
    assert.equal((await call('setSend', { channel: withSend.channel, index: s.index, level: s.level > 0.5 ? 0.25 : 0.75 })).send.level > 0, true);
  } finally {
    assert.equal((await call('setSend', { channel: withSend.channel, index: s.index, level: s.level })).send.level, s.level);
  }
});
