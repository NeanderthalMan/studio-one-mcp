// live_track_edit over a fake bridge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trackEdit, toArgb } from '../src/tracks.js';

function bridge() {
  const tracks = [
    { name: 'Vox', channel: 'Vox', color: '#dd6105' },
    { name: 'Gtr', channel: 'Gtr', color: '#00ff00' },
    { name: 'Dup', channel: 'Dup' }, { name: 'Dup', channel: 'Dup' },
  ];
  let selected = ['Gtr'];
  const calls = [];
  const call = async (op, args) => {
    calls.push([op, args]);
    switch (op) {
      case 'tracks': return tracks.filter((t) => t.name.includes(args.name));
      case 'song': return { selectedTracks: [...selected], trackCount: tracks.length };
      case 'selectTrack':
        if (!tracks.some((t) => t.name === args.name)) throw new Error(`no track named ${args.name}`);
        selected = args.exclusive === false ? [...selected, args.name] : [args.name];
        return { selected };
      case 'setChannelLabel': { const t = tracks.find((x) => x.channel === args.channel); t.name = t.channel = args.name; return { after: args.name }; }
      case 'setChannelColor': tracks.find((x) => x.channel === args.channel).color = `#${(args.argb & 0xffffff).toString(16).padStart(6, '0')}`; return { after: args.argb };
      case 'command': if (args.name === 'Remove Track') tracks.splice(tracks.findIndex((t) => t.name === selected[0]), 1); return { executed: true };
      default: throw new Error(`unexpected ${op}`);
    }
  };
  return { call, tracks, calls, selected: () => selected };
}

test('toArgb: "#rrggbb" to signed opaque ARGB', () => {
  assert.equal(toArgb('#0000ff'), 0xff0000ff | 0);
  assert.equal(toArgb('dd6105'), (0xffdd6105 | 0));
  assert.throws(() => toArgb('blue'), /#rrggbb/);
});

test('rename and color go through the channel; before values reported', async () => {
  const b = bridge();
  assert.deepEqual((await trackEdit(b.call, { track: 'Vox', action: 'rename', name: 'Lead Vox' })).renamed, { before: 'Vox', after: 'Lead Vox' });
  const c = await trackEdit(b.call, { track: 'Lead Vox', action: 'color', color: '#0000ff' });
  assert.deepEqual([c.before, c.after], ['#dd6105', '#0000ff']);
  await assert.rejects(trackEdit(b.call, { track: 'Dup', action: 'rename', name: 'x' }), /ambiguous/);
  await assert.rejects(trackEdit(b.call, { track: 'Nope', action: 'color', color: '#000000' }), /no track named Nope/);
  await assert.rejects(trackEdit(b.call, { track: 'Gtr', action: 'rename' }), /needs name/);
});

test('remove selects the track, removes it and keeps the rest of the selection', async () => {
  const b = bridge();
  const r = await trackEdit(b.call, { track: 'Vox', action: 'remove' });
  assert.equal(r.removed, 'Vox');
  assert.ok(!b.tracks.some((t) => t.name === 'Vox'));
  assert.deepEqual(b.selected(), ['Gtr']);
});
