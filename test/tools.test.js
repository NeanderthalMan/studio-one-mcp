// The editing tools added after the first release: loop, takes, save/undo,
// track state, event edits, add track, bar positions. Fake song via docbridge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers/docbridge.js';

const plain = (v) => JSON.parse(JSON.stringify(v));
const song = () =>
  setup({
    tracks: [
      { name: 'Vox', takeEvents: [[{ name: 'Vox', start: 0, end: 10 }], [{ name: 'Vox Take 1', start: 0, end: 8 }]] },
      { name: 'Bass', events: [{ name: 'Bass', start: 2, end: 6 }] },
      { name: 'Empty' },
    ],
  });

test('setTransport accepts a bar position string', () => {
  const { ask } = song();
  assert.deepEqual(plain(ask('setTransport', { positionBars: '5.1.1.0' }).result).position, { seconds: 8, display: '0005.01.01.00' });
  assert.match(ask('setTransport', { positionBars: 'bar five' }).error, /bars like/);
});

test('setLoop: seconds or bars, and enabling toggles only when needed', () => {
  const { ask, host } = song();
  const r = plain(ask('setLoop', { start: '9.1.1.0', end: 20, enable: true }).result);
  assert.deepEqual([r.loopRange.start.seconds, r.loopRange.end.seconds, r.loop], [16, 20, true]);
  ask('setLoop', { enable: true });
  assert.equal(host.executed.filter((e) => e.command === 'Transport/Toggle Loop').length, 1);
  assert.match(ask('setLoop', { start: -1 }).error, /time must be >= 0/);
});

test('takes: list, next, previous; selection is restored', () => {
  const { ask } = song();
  ask('selectTrack', { name: 'Bass' });
  assert.deepEqual(plain(ask('takes', { track: 'Vox' }).result), { track: 'Vox', action: 'list', takes: 2, activeEvents: ['Vox'] });
  assert.deepEqual(plain(ask('takes', { track: 'Vox', action: 'next' }).result).activeEvents, ['Vox Take 1']);
  assert.deepEqual(plain(ask('takes', { track: 'Vox', action: 'previous' }).result).activeEvents, ['Vox']);
  assert.deepEqual(plain(ask('song').result).selectedTracks, ['Bass'], 'selection put back');
  assert.match(ask('takes', { track: 'Bass', action: 'next' }).error, /not available right now/, 'one take only');
  assert.match(ask('takes', { track: 'Nope' }).error, /no track named Nope/);
  assert.match(ask('takes', { track: 'Vox', action: 'shuffle' }).error, /action must be one of/);
});

test('save and save new version', () => {
  const { ask, doc } = song();
  assert.deepEqual(plain(ask('save', {}).result), { executed: true });
  ask('save', { newVersion: true });
  assert.deepEqual([doc.saved, doc.versions], [1, 1]);
});

test('undo / redo with steps; stops when history runs out', () => {
  const { ask } = song();
  ask('takes', { track: 'Vox', action: 'next' });
  ask('trackState', { track: 'Bass', action: 'mute' });
  assert.deepEqual(plain(ask('undo', { steps: 5 }).result), { done: 2 });
  assert.deepEqual(plain(ask('takes', { track: 'Vox' }).result).activeEvents, ['Vox']);
  assert.deepEqual(plain(ask('redo', {}).result), { done: 1 });
  assert.match(ask('undo', { steps: 0 }).error, /steps must be 1 to 50/);
});

test('trackState: toggles on the named track, restores selection, reports its channel', () => {
  const { ask, doc } = song();
  const r = plain(ask('trackState', { track: 'Bass', action: 'arm' }).result);
  assert.deepEqual([r.track, r.action], ['Bass', 'arm']);
  assert.equal(doc.objs[1].recordArmed, true);
  assert.deepEqual(plain(ask('song').result).selectedTracks, []);
  ask('trackState', { track: 'Bass', action: 'hide' });
  assert.equal(doc.objs[1].hidden, true);
  ask('trackState', { action: 'showAll' });
  assert.equal(doc.objs[1].hidden, false);
  assert.match(ask('trackState', { track: 'Bass', action: 'explode' }).error, /action must be one of/);
});

test('editEvents: mute/unmute, split at bars, playhead restored, needs `at`', () => {
  const { ask, doc } = song();
  doc.params.primaryTime.value = 1;
  assert.equal(plain(ask('editEvents', { track: 'Bass', action: 'mute' }).result).events[0].muted, true);
  assert.equal(plain(ask('editEvents', { track: 'Bass', action: 'unmute' }).result).events[0].muted, false);
  const split = plain(ask('editEvents', { track: 'Bass', action: 'split', at: '3.1.1.0' }).result);
  assert.deepEqual(split.events.map((e) => [e.start, e.end]), [[2, 4], [4, 6]]);
  assert.equal(doc.params.primaryTime.value, 1, 'playhead put back');
  assert.match(ask('editEvents', { track: 'Bass', action: 'split' }).error, /needs at/);
  assert.match(ask('editEvents', { track: 'Nope', action: 'mute' }).error, /no track named/);
});

test('addTrack reports the new track; undo removes it', () => {
  const { ask } = song();
  assert.deepEqual(plain(ask('addTrack', {}).result), { added: ['Audio 1'], trackCount: 4 });
  ask('undo', {});
  assert.equal(plain(ask('song').result).trackCount, 3);
  assert.match(ask('addTrack', { type: 'kazoo' }).error, /type must be one of/);
  assert.match(ask('addTrack', { type: 'folder' }).error, /unknown command/, 'fake has no folder command');
});
