// One event (clip or part) on a track: list, edit (move, to another track, gain,
// fades), duplicate, copy. Events are numbered in time order, as `list` shows.
//
// Seen on Studio One 5.5.2:
//  - edit runs as one MCP Track Edit task, so everything one call changes is one
//    undo step. Gain is AudioFunctions.modifyVolume, which adds dB.
//  - duplicate is Edit/Duplicate on the selected event: the copy goes right
//    after it (on the next bar line when snapping is on).
//  - copy is Edit/Copy, then Edit/Paste at the playhead. Paste goes to the focus
//    track (with only another track selected it made a new track), so the target
//    is focused first through the editor. One undo step; it uses the clipboard.
//    (Duplicating into occupied space did nothing visible, so copy does not.)
import { trackTask } from './tracks.js';
import { toSeconds } from './time.js';

// Edit commands go to the arrangement editor, not to whatever view has focus.
// An older bridge without editorCommand gets the plain command.
export async function edit(call, name) {
  try {
    return await call('editorCommand', { category: 'Edit', name });
  } catch (e) {
    if (!/unknown op/.test(String(e.message))) throw e;
    return call('command', { category: 'Edit', name });
  }
}

async function restoreSelection(call, names) {
  for (const [i, name] of names.entries()) await call('selectTrack', { name, exclusive: i === 0 }).catch(() => {});
}

const list = async (call, track) => (await trackTask(call, { op: 'events', track })).events;

export async function liveEvents(call, a) {
  const { track, action = 'list', event } = a;
  if (action === 'list') return { track, events: await list(call, track) };
  if (event === undefined) throw new Error(`${action} needs event (number from list, or name)`);
  switch (action) {
    case 'edit': {
      const op = { op: 'editEvent', track, event };
      if (a.to !== undefined) op.to = await toSeconds(call, a.to);
      for (const [from, key] of [['to_track', 'toTrack'], ['gain_db', 'gainDb'], ['add_gain_db', 'addGainDb'], ['fade_in', 'fadeIn'], ['fade_out', 'fadeOut']]) if (a[from] !== undefined) op[key] = a[from];
      if (Object.keys(op).length === 3) throw new Error('edit needs one or more of to, to_track, gain_db, add_gain_db, fade_in, fade_out');
      const r = await trackTask(call, op);
      return { track, before: r.before, after: r.after, done: r.done, note: 'One live_undo reverts the whole edit.' };
    }
    case 'duplicate':
    case 'copy': {
      const times = a.times ?? 1;
      if (action === 'duplicate' && (!Number.isInteger(times) || times < 1 || times > 64)) throw new Error('times must be 1 to 64');
      const song = await call('song');
      const at = action === 'copy' ? await toSeconds(call, a.to) : null;
      if (action === 'copy' && at === undefined) throw new Error('copy needs to (seconds or bars)');
      const target = a.to_track ?? track;
      const before = (await list(call, target)).length;
      try {
        await trackTask(call, { op: 'selectEvent', track, event });
        if (action === 'duplicate') {
          for (let i = 0; i < times; i++) {
            const r = await edit(call, 'Duplicate');
            if (!r.executed) throw new Error('Edit/Duplicate did not run');
          }
        } else {
          if (!(await edit(call, 'Copy')).executed) throw new Error('Edit/Copy did not run');
          await call('command', { category: 'Edit', name: 'Deselect All' });
          await trackTask(call, { op: 'focusTrack', track: target });
          await call('setTransport', { positionSeconds: at });
          if (!(await edit(call, 'Paste')).executed) throw new Error('Edit/Paste did not run');
        }
      } finally {
        await call('command', { category: 'Edit', name: 'Deselect All' }).catch(() => {});
        await call('setTransport', { positionSeconds: song.transport.position.seconds }).catch(() => {});
        await restoreSelection(call, song.selectedTracks);
      }
      const after = await list(call, target);
      return {
        track: target,
        added: after.length - before,
        events: after,
        note: action === 'duplicate' ? `${times} live_undo steps revert it. The copies go right after the event; into occupied space they may not show.` : 'Uses the clipboard. One live_undo reverts the paste.',
      };
    }
    default:
      throw new Error(`unknown action ${action}`);
  }
}
