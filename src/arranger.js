// Arranger sections and macros, on top of the bridge's generic ops (song,
// setTransport, setLoop, command, listCommands) and, for reading and editing
// sections, the MCP Track Edit task.
//
// Seen on Studio One 5.5.2:
//  - "Arranger/Goto Section N" (N = 1..16), "Goto Next/Previous Section" only
//    jump while the song plays, at the arranger's sync point. Stopped, they
//    leave the playhead alone, so a stopped goto locates to the section's start
//    instead.
//    With a sync mode other than Off the jump waits; after a fresh start it did
//    not come within 6 s, so set syncMode off for immediate jumps. Setting the
//    sync mode is an undo step when it changes the mode (and none when it does
//    not), so never pair it with a fixed number of undos.
//  - A goto has been seen to change the loop range to a section's range; it is
//    put back afterwards.
//  - Macro commands are named "Macro " + base64(title) in category "Macros".

import { trackTask } from './tracks.js';
import { toSeconds } from './time.js';
import { edit } from './events.js';

export const SYNC_MODES = { off: 'Set Sync Mode Off', '1bar': 'Set Sync Mode 1 Bar', '2bars': 'Set Sync Mode 2 Bars', '4bars': 'Set Sync Mode 4 Bars', end: 'Set Sync Mode End' };

// Sections, numbered in song order (the order Goto Section N uses).
export function numberSections(sections) {
  return [...sections]
    .sort((a, b) => a.start.seconds - b.start.seconds)
    .map((s, i) => ({
      number: i + 1,
      name: s.name,
      start: s.start.bar ? { seconds: s.start.seconds, bar: s.start.bar } : { seconds: s.start.seconds },
      ...(s.end ? { end: { seconds: s.end.seconds } } : { lengthBeats: s.lengthBeats }),
    }));
}

export function findSection(list, section) {
  if (typeof section === 'number') return list.find((s) => s.number === section) || null;
  const want = String(section).toLowerCase();
  return list.find((s) => s.name.toLowerCase() === want) || list.find((s) => s.name.toLowerCase().includes(want)) || null;
}

const sameRange = (a, b) => Math.abs(a.start.seconds - b.start.seconds) < 1e-6 && Math.abs(a.end.seconds - b.end.seconds) < 1e-6;

// call: the bridge call(op, args). savedSections: () => the song's sections (live
// when the MCP Track Edit task answers, else from the last save).
// Section edits through the MCP Track Edit task (each call one undo step).
// Moving or resizing a section changes only the section, not the events under it.
async function editSection(call, action, { section, name, start, end }) {
  if (action === 'add') {
    const s = await toSeconds(call, start), e = await toSeconds(call, end);
    if (typeof s !== 'number' || typeof e !== 'number') throw new Error('add needs start and end (seconds or bars)');
    const r = await trackTask(call, { op: 'addSection', start: s, end: e, name });
    return { added: r.added, start: s, end: e, sections: (await trackTask(call, { op: 'sections' })).sections, note: 'One live_undo removes it. Sections cannot overlap: Studio One trims or replaces what is there.' };
  }
  if (section === undefined) throw new Error(`${action} needs section (number or name)`);
  const op = { op: 'editSection', section };
  if (action === 'remove') op.remove = true;
  if (action === 'rename') {
    if (!name) throw new Error('rename needs name');
    op.name = name;
  }
  if (action === 'resize') {
    if (end === undefined) throw new Error('resize needs end (seconds or bars)');
    op.end = await toSeconds(call, end);
  }
  if (action === 'move') {
    if (start === undefined) throw new Error('move needs start (seconds or bars)');
    op.start = await toSeconds(call, start);
  }
  const r = await trackTask(call, op);
  return { ...(r.removed ? { removed: r.removed } : { before: r.before, after: r.after }), sections: (await trackTask(call, { op: 'sections' })).sections, note: 'One live_undo reverts it.' };
}

// A section together with everything under it, on every track. Seen on 5.5.2:
//  - with the section selected, Edit/Copy takes it and its content; Edit/Paste
//    inserts that at the playhead (what comes after moves later by its length),
//    placed from the focus track down, so the top track is focused first;
//  - Edit/Delete Time in Loop removes the loop range from every track, section and
//    marker and closes the gap (Edit/Delete and Cut on a section take only it).
// Each is one undo step; a move is two (the copy, then the original's removal).
async function withRestore(call, fn) {
  const song = await call('song');
  if (song.transport.playing || song.transport.recording) throw new Error('stop playback first');
  const t0 = song.transport;
  try {
    return await fn(song);
  } finally {
    await call('command', { category: 'Edit', name: 'Deselect All' }).catch(() => {});
    await call('setLoop', { start: t0.loopRange.start.seconds, end: t0.loopRange.end.seconds, enable: t0.loop }).catch(() => {});
    await call('setTransport', { positionSeconds: t0.position.seconds }).catch(() => {});
    for (const [i, n] of song.selectedTracks.entries()) await call('selectTrack', { name: n, exclusive: i === 0 }).catch(() => {});
  }
}

const liveSections = async (call) => (await trackTask(call, { op: 'sections' })).sections;

async function pickSection(call, section) {
  const list = await liveSections(call);
  const hit = typeof section === 'number' ? list.find((s) => s.number === section) : list.find((s) => s.name === section) || list.find((s) => s.name.toLowerCase() === String(section).toLowerCase());
  if (!hit) throw new Error(`no section ${JSON.stringify(section)}`);
  return hit;
}

async function pasteSectionAt(call, section, at) {
  await trackTask(call, { op: 'selectSection', section });
  if (!(await edit(call, 'Copy')).executed) throw new Error('Edit/Copy did not run');
  await call('command', { category: 'Edit', name: 'Deselect All' });
  const [top] = await call('tracks', { events: false });
  if (!top) throw new Error('the song has no tracks');
  await trackTask(call, { op: 'focusTrack', track: top.name });
  await call('setTransport', { positionSeconds: at });
  if (!(await edit(call, 'Paste')).executed) throw new Error('Edit/Paste did not run');
}

async function deleteRange(call, start, end) {
  await call('setLoop', { start, end });
  if (!(await call('command', { category: 'Edit', name: 'Delete Time in Loop' })).executed) throw new Error('Edit/Delete Time in Loop did not run');
}

async function sectionContent(call, action, { section, to }) {
  if (section === undefined) throw new Error(`${action} needs section (number or name)`);
  return withRestore(call, async () => {
    const s = await pickSection(call, section);
    const len = s.end - s.start;
    if (action === 'delete') {
      await deleteRange(call, s.start, s.end);
      return { deleted: s, sections: await liveSections(call), note: 'Everything in the section went with it and the gap closed. One live_undo brings it back.' };
    }
    const at = await toSeconds(call, to);
    if (typeof at !== 'number') throw new Error(`${action} needs to (seconds or bars), best a section boundary`);
    if (at > s.start + 1e-6 && at < s.end - 1e-6) throw new Error('to is inside the section itself');
    await pasteSectionAt(call, s.number, at);
    if (action === 'copy') return { copied: s, to: at, sections: await liveSections(call), note: 'Inserted: everything from there on moved later by the section length. One live_undo removes it.' };
    // move: the original moved later too if the copy went in before it.
    const from = at <= s.start + 1e-6 ? s.start + len : s.start;
    await deleteRange(call, from, from + len);
    return { moved: s, to: at > s.start ? at - len : at, sections: await liveSections(call), note: 'Two live_undo steps put it back (the removal, then the copy).' };
  });
}

export async function arranger(call, savedSections, { action, section, sync, name, start, end, to, content }) {
  if (action === 'copy' || action === 'delete' || (action === 'move' && content)) return sectionContent(call, action, { section, to: to ?? start });
  if (['add', 'rename', 'resize', 'move', 'remove'].includes(action)) return editSection(call, action, { section, name, start, end });
  const song = await call('song');
  const { playing } = song.transport;
  const run = (name) => call('command', { category: 'Arranger', name });
  const keepLoop = async (fn) => {
    const r = await fn();
    const after = (await call('song')).transport;
    if (!sameRange(after.loopRange, song.transport.loopRange)) {
      await call('setLoop', { start: song.transport.loopRange.start.seconds, end: song.transport.loopRange.end.seconds });
    }
    return r;
  };

  switch (action) {
    case 'sections':
      return { sections: numberSections(savedSections()) };
    case 'goto': {
      if (section === undefined) throw new Error('goto needs section (number or name)');
      const list = numberSections(savedSections());
      const hit = findSection(list, section);
      if (typeof section !== 'number' && !hit) throw new Error(`no section named ${section}`);
      const number = typeof section === 'number' ? section : hit.number;
      if (playing) {
        if (number < 1 || number > 16) throw new Error('Studio One can jump to sections 1-16');
        const r = await keepLoop(() => run(`Goto Section ${number}`));
        if (!r.executed) throw new Error(`Goto Section ${number} did not run (no such section?)`);
        return { jumped: number, section: hit, note: 'The jump happens at the arranger sync point (see syncMode).', transport: (await call('song')).transport };
      }
      if (!hit) throw new Error(`there is no section ${number}`);
      return { located: number, section: hit, transport: await call('setTransport', { positionSeconds: hit.start.seconds }) };
    }
    case 'next':
    case 'previous': {
      if (!playing) throw new Error('Studio One only steps between sections while playing; use goto when stopped');
      const r = await keepLoop(() => run(action === 'next' ? 'Goto Next Section' : 'Goto Previous Section'));
      return { executed: r.executed, transport: (await call('song')).transport };
    }
    case 'syncMode': {
      if (!SYNC_MODES[sync]) throw new Error(`sync must be one of ${Object.keys(SYNC_MODES).join(', ')}`);
      return { sync, executed: (await run(SYNC_MODES[sync])).executed };
    }
    case 'createFromMarkers': {
      const r = await run('Create Sections from Markers');
      return { executed: r.executed, note: 'Shows the arranger track. One live_undo removes them.' };
    }
    default:
      throw new Error(`unknown action ${action}`);
  }
}

// ---- macros -------------------------------------------------------------------

export const macroTitle = (name) => {
  const m = /^Macro (.+)$/.exec(name);
  if (!m) return null;
  const t = Buffer.from(m[1], 'base64').toString('utf8');
  return Buffer.from(t, 'utf8').toString('base64') === m[1] ? t : null;
};
export const macroCommand = (title) => `Macro ${Buffer.from(title, 'utf8').toString('base64')}`;

export async function listMacros(call, { filter, withState } = {}) {
  const cmds = await call('listCommands', { filter: 'Macros ', withState: !!withState }, { timeoutMs: 15000 });
  const want = filter ? filter.toLowerCase() : null;
  return cmds
    .filter((c) => c.category === 'Macros')
    .map((c) => ({ title: macroTitle(c.name) ?? c.name, ...(withState ? { enabled: c.enabled } : {}) }))
    .filter((m) => !want || m.title.toLowerCase().includes(want));
}

export async function runMacro(call, { title, checkOnly }) {
  const macros = await listMacros(call);
  const hit = macros.find((m) => m.title === title) || macros.find((m) => m.title.toLowerCase() === title.toLowerCase());
  if (!hit) {
    const near = macros.filter((m) => m.title.toLowerCase().includes(title.toLowerCase())).map((m) => m.title).slice(0, 10);
    throw new Error(`no macro titled ${title}${near.length ? `; did you mean: ${near.join(', ')}` : ''}`);
  }
  const r = await call('command', { category: 'Macros', name: macroCommand(hit.title), checkOnly: !!checkOnly });
  return { macro: hit.title, ...r };
}
