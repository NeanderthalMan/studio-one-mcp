// Bounce a track's events, without dialogs. Seen on Studio One 5.5.2:
//  - Event/Bounce Selection (with ["Snap", ""], as a saved macro uses it) renders
//    the selected events into one new event in place;
//  - Event/Bounce To New Track renders them onto a new track (named like the
//    source) and mutes the originals;
//  - either is one undo step, and writes a .wav into the song's Bounces folder,
//    which an undo leaves on disk. The undo also re-selects the bounced track.
// Not in the live suite: every run would leave another .wav in the song folder.
// Both modes and their undo were checked by hand on 2026-09-28.
// Song/Export Mixdown, Export Stems and Event/Export Selection open dialogs, so
// they are not offered.

const COMMANDS = { inPlace: ['Bounce Selection', ['Snap', '']], toNewTrack: ['Bounce To New Track', null] };

export async function bounce(call, { track, mode = 'inPlace' }) {
  if (!COMMANDS[mode]) throw new Error(`mode must be one of ${Object.keys(COMMANDS).join(', ')}`);
  const song0 = await call('song');
  if (song0.transport.playing || song0.transport.recording) throw new Error('stop playback first');
  const before = await call('tracks', { events: false });
  const src = before.filter((t) => t.name === track);
  if (src.length !== 1) throw new Error(src.length ? `track name is ambiguous: ${track}` : `no track named ${track}`);
  const sel = await call('selectEvents', { track });
  let r;
  try {
    if (!sel.eventCommandsEnabled) throw new Error(`${track} has no events to bounce`);
    const [name, args] = COMMANDS[mode];
    r = await call('command', { category: 'Event', name, ...(args ? { args } : {}) });
    if (!r.executed) throw new Error(`Event/${name} did not run`);
  } finally {
    await call('selectEvents', { none: true }).catch(() => {});
    for (const [i, name] of song0.selectedTracks.entries()) await call('selectTrack', { name, exclusive: i === 0 }).catch(() => {});
  }
  const after = await call('tracks', { name: track });
  const note = 'One live_undo reverts it (and re-selects this track); the rendered .wav stays in the song\'s Bounces folder.';
  if (mode === 'inPlace') return { track, mode, events: after.find((t) => t.index === src[0].index)?.events ?? [], note };
  // The source name was unique, so the other track with that name is the new one.
  return {
    track, mode,
    original: after.find((t) => t.index === src[0].index)?.events ?? [],
    newTrack: after.find((t) => t.index !== src[0].index && t.name === track) || null,
    note: `The originals are muted. ${note}`,
  };
}
