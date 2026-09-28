// Track edits by name: rename and recolour (through the track's mixer channel),
// remove (Song/Remove Track on a selection of one). Seen on 5.5.2:
//  - rename and colour are not on the undo stack: the result carries "before";
//  - Remove Track is one undo step and asked nothing for an empty track;
//  - Track/Group Selected Tracks opens a name dialog, so grouping is not offered.

const hex = (rgb) => `#${(rgb & 0xffffff).toString(16).padStart(6, '0')}`;
export const toArgb = (color) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(color));
  if (!m) throw new Error('color must be "#rrggbb"');
  return (0xff000000 | parseInt(m[1], 16)) | 0;
};

async function findTrack(call, name) {
  const tracks = await call('tracks', { name, events: false });
  const hits = tracks.filter((t) => t.name === name);
  if (hits.length !== 1) throw new Error(hits.length ? `track name is ambiguous: ${name}` : `no track named ${name}`);
  return hits[0];
}

async function restoreSelection(call, names) {
  for (const [i, name] of names.entries()) await call('selectTrack', { name, exclusive: i === 0 }).catch(() => {});
}

export async function trackEdit(call, { track, action, name, color }) {
  const t = await findTrack(call, track);
  switch (action) {
    case 'rename': {
      if (!name) throw new Error('rename needs name');
      if (!t.channel) throw new Error(`${track} has no mixer channel to rename through`);
      await call('setChannelLabel', { channel: t.channel, name });
      return { renamed: { before: track, after: (await findTrack(call, name)).name }, note: 'Not on the undo stack: rename back to undo.' };
    }
    case 'color': {
      if (!t.channel) throw new Error(`${track} has no mixer channel to colour through`);
      const before = t.color;
      const r = await call('setChannelColor', { channel: t.channel, argb: toArgb(color) });
      return { track, before, after: hex(r.after), note: 'Not on the undo stack: set the "before" colour to undo.' };
    }
    case 'remove': {
      const { selectedTracks } = await call('song');
      await call('selectTrack', { name: track });
      const r = await call('command', { category: 'Song', name: 'Remove Track' });
      await restoreSelection(call, selectedTracks.filter((n) => n !== track));
      if (!r.executed) throw new Error('Song/Remove Track did not run');
      return { removed: track, trackCount: (await call('song')).trackCount, note: 'live_undo brings it back.' };
    }
    default:
      throw new Error(`unknown action ${action}`);
  }
}
