// live_changes: snapshots of the running song, compared call to call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffList, diffNames, diffSnapshots } from '../src/changes.js';

const snap = (over = {}) => ({
  tempo: 120,
  loop: { on: false, start: 0, end: 8 },
  tracks: [
    { name: 'Vox', events: ['Vox@0-4'] },
    { name: 'Gtr', events: ['Gtr@0-8', 'Gtr@8-16'] },
    { name: 'Bass', events: [] },
  ],
  channels: {
    Vox: { volume: 0.8, pan: 0.5, mute: 0, solo: 0, recordArmed: 0, monitor: 0, automation: 'off', output: 'Main', inserts: [] },
    Gtr: { volume: 0.7, pan: 0.5, mute: 0, solo: 0, recordArmed: 0, monitor: 0, automation: 'off', output: 'Main', inserts: ['Pro EQ'] },
    Bass: { volume: 0.7, pan: 0.5, mute: 0, solo: 0, recordArmed: 0, monitor: 0, automation: 'off', output: 'Main', inserts: [] },
    Reverb: { volume: 0.5, pan: 0.5, mute: 0, solo: 0, recordArmed: null, monitor: null, automation: 'off', output: 'Main', inserts: ['Room Reverb'] },
  },
  markers: [{ name: 'Verse', seconds: 4 }],
  sections: [{ name: 'Intro', start: 0, end: 8 }],
  ...over,
});

test('nothing changed is an empty diff', () => {
  assert.deepEqual(diffSnapshots(snap(), snap()), {});
});

test('mixer changes by field, with from and to', () => {
  const b = snap();
  b.channels = structuredClone(b.channels);
  b.channels.Gtr.volume = 0.5;
  b.channels.Gtr.inserts = ['Pro EQ (bypassed)', 'Compressor'];
  b.channels.Vox.mute = 1;
  assert.deepEqual(diffSnapshots(snap(), b).mixer, [
    { channel: 'Vox', mute: { from: 0, to: 1 } },
    { channel: 'Gtr', volume: { from: 0.7, to: 0.5 }, inserts: { from: ['Pro EQ'], to: ['Pro EQ (bypassed)', 'Compressor'] } },
  ]);
});

test('a renamed track is a rename (with its channel), not a removal and an addition', () => {
  const b = snap();
  b.tracks = structuredClone(b.tracks);
  b.tracks[1].name = 'Lead Gtr';
  b.channels = { Vox: b.channels.Vox, 'Lead Gtr': b.channels.Gtr, Bass: b.channels.Bass, Reverb: b.channels.Reverb };
  const d = diffSnapshots(snap(), b);
  assert.deepEqual(d.tracks, { renamed: [{ from: 'Gtr', to: 'Lead Gtr' }] });
  assert.equal(d.mixer, undefined, 'its channel is followed through the rename');
  assert.equal(d.channels, undefined);
  assert.equal(d.events, undefined, 'and so are its events');
});

test('tracks added, removed and reordered; a new bus is a channel', () => {
  const b = snap();
  b.tracks = [{ name: 'Gtr', events: ['Gtr@0-8', 'Gtr@8-16'] }, { name: 'Vox', events: ['Vox@0-4'] }, { name: 'Keys', events: [] }];
  b.channels = { Gtr: b.channels.Gtr, Vox: b.channels.Vox, Keys: b.channels.Bass, Reverb: b.channels.Reverb, 'Bus 1': b.channels.Reverb };
  const d = diffSnapshots(snap(), b);
  assert.deepEqual(d.tracks.removed, ['Bass']);
  assert.deepEqual(d.tracks.added, ['Keys']);
  assert.deepEqual(d.tracks.order, ['Gtr', 'Vox', 'Keys']);
  assert.deepEqual(d.channels, { added: ['Bus 1'] });
});

test('events per track, tempo, loop, markers and sections', () => {
  const b = snap({ tempo: 100, loop: { on: true, start: 0, end: 8 }, markers: [{ name: 'Verse', seconds: 6 }], sections: [{ name: 'Intro', start: 0, end: 4 }, { name: 'Verse', start: 4, end: 8 }] });
  b.tracks = structuredClone(b.tracks);
  b.tracks[1].events = ['Gtr@0-8', 'Gtr@10-18'];
  const d = diffSnapshots(snap(), b);
  assert.deepEqual(d.events, [{ track: 'Gtr', added: ['Gtr@10-18'], removed: ['Gtr@8-16'] }]);
  assert.deepEqual(d.tempo, { from: 120, to: 100 });
  assert.equal(d.loop.to.on, true);
  assert.deepEqual(d.markers, { moved: [{ name: 'Verse', from: 4, to: 6 }] });
  assert.deepEqual(d.sections, { added: [{ name: 'Verse', at: 4 }] });
});

test('without the edit task (no markers or sections) those are left out', () => {
  assert.deepEqual(diffSnapshots(snap({ markers: null, sections: null }), snap({ markers: null, sections: null })), {});
});

test('diffList: added, removed, renamed in place, moved by name', () => {
  const before = [{ name: 'Verse', seconds: 4 }, { name: 'Hook', seconds: 8 }, { name: 'Out', seconds: 20 }];
  const after = [{ name: 'Verse 1', seconds: 4 }, { name: 'Hook', seconds: 12 }, { name: 'Bridge', seconds: 16 }];
  assert.deepEqual(diffList(before, after, 'seconds'), {
    added: [{ name: 'Bridge', at: 16 }],
    removed: [{ name: 'Out', at: 20 }],
    renamed: [{ from: 'Verse', to: 'Verse 1', at: 4 }],
    moved: [{ name: 'Hook', from: 8, to: 12 }],
  });
  assert.deepEqual(diffList(before, before, 'seconds'), {});
});

test('diffNames: a name that left where another arrived is a rename', () => {
  assert.deepEqual(diffNames(['A', 'B', 'C'], ['A', 'X', 'C', 'D']), { added: ['D'], removed: [], renamed: [{ from: 'B', to: 'X' }] });
});
