// song_diff's comparison, on readSong() results from fixture songs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSong } from '../src/song.js';
import { diffSongs } from '../src/diff.js';
import { fixture } from './helpers/fixtures.js';

const clone = (x) => JSON.parse(JSON.stringify(x));

test('identical songs: no changes', () => {
  const s = readSong(fixture({ extras: true }));
  assert.deepEqual(diffSongs(s, clone(s)), []);
});

test('base to extras: instrument track, automation mode, plug-in settings, envelope', () => {
  const d = diffSongs(readSong(fixture()), readSong(fixture({ extras: true })));
  const what = d.map((c) => `${c.area}: ${c.what}`);
  assert.ok(what.includes('track: added'));
  assert.equal(d.find((c) => c.what === 'added').detail, 'Keys (Music)');
  assert.deepEqual(d.find((c) => c.what === 'automation').detail, { from: 'off', to: 'read' });
  assert.deepEqual(d.find((c) => c.what === 'Pro EQ settings').detail, { lffreq: { from: null, to: 40 }, lfgain: { from: null, to: -3.5 } });
  assert.deepEqual(d.find((c) => c.area === 'automation').detail, { fromPoints: 0, toPoints: 2 });
});

test('song notes and channel notes changes', () => {
  const a = readSong(fixture({ extras: true }));
  const b = clone(a);
  b.notes = 'Verse 1: tighter';
  b.channelNotes = [{ channel: 'Vox', text: 'Take 3 now' }, { channel: 'Main', text: 'no limiter yet' }];
  const d = diffSongs(a, b).filter((c) => /notes/.test(c.what));
  assert.deepEqual(d.map((c) => [c.area, c.what, c.detail.to]), [['song', 'notes', 'Verse 1: tighter'], ['Vox', 'channel notes', 'Take 3 now'], ['Main', 'channel notes', 'no limiter yet']]);
});

test('renames by id, notes, events, mixer fields, plug-ins, markers and tempo', () => {
  const a = readSong(fixture({ extras: true }));
  const b = clone(a);
  const keys = b.tracks.find((t) => t.name === 'Keys');
  keys.name = 'Piano';
  keys.events[0].notes[0].velocity = 64;
  const vox = b.tracks.find((t) => t.name === 'Vox');
  vox.events.push({ ...vox.events[0], name: 'take3' });
  const ch = b.mixer.find((c) => c.label === 'Vox');
  ch.volumeDb = -3;
  ch.inserts[0].bypassed = true;
  ch.inserts.push({ slot: 1, name: 'Compressor' });
  b.markers.push({ name: 'Bridge', bar: 9 });
  b.tempo[0].bpm = 100;
  const d = diffSongs(a, b);
  const find = (w) => d.find((c) => c.what === w);
  assert.deepEqual(find('renamed').detail, { from: 'Keys', to: 'Piano' });
  assert.deepEqual(find('notes').detail, {
    added: ['pitch 60 at beat 4.5, 0.5 beats, velocity 64'],
    removed: ['pitch 60 at beat 4.5, 0.5 beats, velocity 102'],
  });
  assert.equal(find('notes').area, 'Piano');
  assert.match(find('event added').detail, /^take3 at beat 34 \(bar 9\), 3 beats$/);
  assert.deepEqual(find('volumeDb').detail, { from: -6.02, to: -3 });
  assert.deepEqual(find('Pro EQ bypass').detail, { from: false, to: true });
  assert.equal(find('plug-in added').detail, 'Compressor (slot 1)');
  assert.equal(find('marker added').detail, 'Bridge @ bar 9');
  assert.deepEqual(find('tempo').detail.to[0], '100 bpm @ beat 0');
});
