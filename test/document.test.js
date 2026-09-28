// Song, tracks, selection and transport ops in BridgeCore.js, against a fake
// document shaped like the 5.5.2 object model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers/docbridge.js';

const plain = (v) => JSON.parse(JSON.stringify(v));

test('song: title, transport, unique track count, selection', () => {
  const { ask } = setup();
  const r = plain(ask('song').result);
  assert.equal(r.title, 'Live Song');
  assert.equal(r.trackCount, 3, 'a track with takes appears once, not once per lane');
  assert.deepEqual(r.selectedTracks, []);
  assert.deepEqual(
    [r.transport.playing, r.transport.recording, r.transport.loop, r.transport.tempo, r.transport.timeFormat],
    [false, false, false, 120, 'Bars'],
  );
  assert.deepEqual(r.transport.position, { seconds: 0, display: '0001.01.01.00' });
  assert.deepEqual(r.transport.loopRange.end, { seconds: 16, display: '0009.01.01.00' });
});

test('no song open: every document op fails cleanly', () => {
  const { ask } = setup({ noSong: true });
  for (const op of ['song', 'tracks', 'selectTrack', 'setTransport'])
    assert.deepEqual([ask(op, { name: 'x' }).ok, ask(op, { name: 'x' }).error], [false, 'no song open'], op);
});

test('tracks: deduplicated, with colour, channel, takes and events', () => {
  const { ask } = setup();
  const r = plain(ask('tracks').result);
  assert.deepEqual(r.map((t) => t.name), ['Vox', 'Bass', 'Keys']);
  const [vox, bass, keys] = r;
  assert.deepEqual([vox.takes, vox.eventCount, vox.events[0]], [2, 1, { name: 'Vox take', start: 0, end: 14.9, length: 14.9, muted: false }]);
  assert.deepEqual([bass.color, bass.channel, bass.eventCount], ['#00ff00', 'Bass', 0]);
  assert.deepEqual([keys.mediaType, keys.events[0].muted, keys.events[0].length], ['Music', true, 4]);
});

test('tracks: name filter, events off, max events', () => {
  const { ask } = setup();
  assert.deepEqual(plain(ask('tracks', { name: 'ke' }).result).map((t) => t.name), ['Keys']);
  assert.equal(plain(ask('tracks', { events: false }).result)[0].events, undefined);
  const keys = plain(ask('tracks', { name: 'keys', maxEvents: 1 }).result)[0];
  assert.deepEqual([keys.eventCount, keys.events.length], [2, 1]);
});

test('selectTrack: exclusive by default, additive on request, errors for unknown/ambiguous', () => {
  const { ask } = setup({ tracks: [{ name: 'Gtr' }, { name: 'Gtr' }, { name: 'Vox' }, { name: 'Bass' }] });
  assert.deepEqual(plain(ask('selectTrack', { name: 'Vox' }).result), { selected: ['Vox'] });
  assert.deepEqual(plain(ask('selectTrack', { name: 'Bass', exclusive: false }).result), { selected: ['Vox', 'Bass'] });
  assert.deepEqual(plain(ask('selectTrack', { name: 'Bass' }).result), { selected: ['Bass'] });
  assert.match(ask('selectTrack', { name: 'Drums' }).error, /no track named Drums/);
  assert.match(ask('selectTrack', { name: 'Gtr' }).error, /ambiguous/);
  assert.deepEqual(plain(ask('song').result).selectedTracks, ['Bass']);
});

test('transport: actions run the matching command and report the new state', () => {
  const { ask, host } = setup();
  const play = plain(ask('transport', { action: 'play' }).result);
  assert.deepEqual([play.executed, play.transport.playing], [true, true]);
  assert.equal(plain(ask('transport', { action: 'stop' }).result).transport.playing, false);
  assert.equal(plain(ask('transport', { action: 'toggleLoop' }).result).transport.loop, true);
  assert.deepEqual(host.executed.map((e) => e.command), ['Transport/Start', 'Transport/Stop', 'Transport/Toggle Loop']);
  assert.match(ask('transport', { action: 'explode' }).error, /action must be one of/);
});

test('setTransport: tempo and position via parameters, toggles only when different', () => {
  const { ask, host } = setup();
  const r = plain(ask('setTransport', { tempo: 97.5, positionSeconds: 4, loop: true, precount: false }).result);
  assert.equal(r.tempo, 97.5);
  assert.deepEqual(r.position, { seconds: 4, display: '0003.01.01.00' });
  assert.deepEqual([r.loop, r.precount], [true, false]);
  assert.deepEqual(host.executed.map((e) => e.command), ['Transport/Toggle Loop'], 'precount was already off');
  ask('setTransport', { loop: true });
  assert.equal(host.executed.length, 1, 'loop already on: no toggle');
});

test('setTransport validates input', () => {
  const { ask, doc } = setup();
  assert.match(ask('setTransport', { tempo: 5 }).error, /tempo must be a number from 10 to 400/);
  assert.match(ask('setTransport', { tempo: '120' }).error, /tempo must be/);
  assert.match(ask('setTransport', { positionSeconds: -1 }).error, /positionSeconds/);
  assert.equal(doc.params.tempo.value, 120, 'rejected values are not applied');
});

test('song reports the file URL of the open document', () => {
  const { ask } = setup();
  assert.equal(plain(ask('song').result).fileUrl, 'file:///songs/Live Song/Live Song.song');
});

test('markers: positions via Recall Marker N, playhead restored', () => {
  const { ask, doc } = setup({ markers: [0, 16, 300] });
  doc.params.primaryTime.value = 7;
  const r = plain(ask('markers').result);
  assert.deepEqual(r.markers.map((m) => [m.number, m.seconds, m.display]), [[1, 0, '0001.01.01.00'], [2, 16, '0009.01.01.00'], [3, 300, '0151.01.01.00']]);
  assert.equal(doc.params.primaryTime.value, 7, 'playhead put back');
});

test('markers refuse while playing (reading them moves the playhead)', () => {
  const { ask, doc } = setup();
  doc.params.start.value = 1;
  assert.match(ask('markers').error, /stop playback first/);
});

test('addMarker at a position or at the playhead; playhead restored', () => {
  const { ask, doc, marks } = setup();
  doc.params.primaryTime.value = 3;
  const r = plain(ask('addMarker', { seconds: 8 }).result);
  assert.deepEqual([r.added, r.seconds, r.markers.map((m) => m.seconds)], [true, 8, [0, 8, 300]]);
  ask('addMarker');
  assert.deepEqual(marks, [0, 3, 8, 300], 'default is the playhead');
  assert.equal(doc.params.primaryTime.value, 3);
  assert.match(ask('addMarker', { seconds: -2 }).error, /seconds must be/);
});

test('deleteMarker by number or by position; unknown is an error', () => {
  const { ask, marks, doc } = setup({ markers: [0, 8, 16, 300] });
  doc.params.primaryTime.value = 5;
  assert.equal(plain(ask('deleteMarker', { number: 2 }).result).deleted.seconds, 8);
  assert.deepEqual(plain(ask('deleteMarker', { seconds: 16 }).result).markers.map((m) => m.seconds), [0, 300]);
  assert.deepEqual(marks, [0, 300]);
  assert.equal(doc.params.primaryTime.value, 5);
  assert.match(ask('deleteMarker', { number: 9 }).error, /no marker number 9/);
  assert.match(ask('deleteMarker', { seconds: 1.5 }).error, /no marker at 1.5s/);
});

test('selectEvents: by track(s), all, none; enables event commands', () => {
  const { ask, host } = setup();
  const one = plain(ask('selectEvents', { track: 'Keys' }).result);
  assert.deepEqual([one.selectedTracks, one.eventCommandsEnabled], [['Keys'], true]);
  assert.deepEqual(plain(ask('selectEvents', { tracks: ['Vox', 'Bass'] }).result).selectedTracks, ['Vox', 'Bass']);
  assert.equal(plain(ask('selectEvents', { all: true }).result).eventCommandsEnabled, true);
  assert.equal(plain(ask('selectEvents', { none: true }).result).events, 'none');
  assert.equal(host.Host.GUI.Commands.interpretCommand('Event', 'Mute Events', true), false, 'deselected');
  assert.match(ask('selectEvents', { track: 'Nope' }).error, /no track named Nope/);
  assert.match(ask('selectEvents', {}).error, /required/);
});
