import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSong, summarizeSong } from '../src/song.js';
import { fixture } from './helpers/fixtures.js';

test('tempo, time signature and metadata', () => {
  const s = readSong(fixture());
  assert.equal(s.title, 'Fixture Song');
  assert.deepEqual(s.tempo.map((t) => t.bpm), [120, 60]);
  assert.deepEqual(s.timeSignatures.map((t) => t.signature), ['4/4', '3/4']);
  assert.equal(s.key, null);
});

test('markers convert beats to bars and seconds', () => {
  const s = readSong(fixture());
  assert.deepEqual(s.markers.map((m) => [m.name, m.bar, m.beat, m.seconds]), [
    ['Start', 1, 1, 0],
    ['Chorus', 5, 1, 8],
  ]);
});

test('takes: active layer drives track events; positions cross tempo and meter changes', () => {
  const [vox] = readSong(fixture()).tracks;
  assert.equal(vox.name, 'Vox');
  assert.deepEqual(vox.layers.map((l) => [l.name, l.active]), [['Vox Take 1', false], ['Vox Take 2', true]]);
  const [ev] = vox.events;
  assert.equal(ev.name, 'take2');
  // beat 34 = 32 beats at 0.5s (16s) + 2 beats at 1s → 18s; bar 9 is at beat 32 so this is bar 9 beat 3.
  assert.deepEqual([ev.start.bar, ev.start.beat, ev.start.seconds, ev.lengthSeconds], [9, 3, 18, 3]);
  assert.equal(ev.file, '/tmp/Media/Vox 2.wav');
  assert.equal(vox.layers[0].events[0].file, '/tmp/Media/Vox 1.wav', 'file URLs are decoded');
});

test('mixer: dB, pan, mute, inserts without rack state entries', () => {
  const s = readSong(fixture());
  const vox = s.mixer.find((c) => c.label === 'Vox');
  assert.equal(vox.volumeDb, -6.02);
  assert.equal(vox.pan, -0.5);
  assert.equal(vox.mute, true);
  assert.deepEqual(vox.inserts.map((i) => i.name), ['Pro EQ']);
  assert.equal(s.tracks[0].mixer.output, 'Main');
});

test('transport positions are seconds', () => {
  const { transport } = readSong(fixture());
  assert.deepEqual([transport.position.seconds, transport.position.beats, transport.position.bar], [20, 36, 10]);
  assert.equal(transport.loop.end.beats, 8);
  assert.equal(transport.loop.active, true);
});

test('summary is compact', () => {
  const sum = summarizeSong(readSong(fixture()));
  assert.deepEqual(sum.tracks, [{ name: 'Vox', type: 'Audio', events: 1, takes: 2, activeTake: 'Vox Take 2', volumeDb: -6.02, mute: true, solo: undefined, inserts: ['Pro EQ'] }]);
  assert.deepEqual(sum.markers, ['Start @ bar 1', 'Chorus @ bar 5']);
});
