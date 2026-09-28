// Arranger sections and macros, on top of the bridge's generic ops (song,
// setTransport, setLoop, command, listCommands): no device code of their own.
//
// Seen on Studio One 5.5.2:
//  - "Arranger/Goto Section N" (N = 1..16), "Goto Next/Previous Section" only
//    jump while the song plays, at the arranger's sync point. Stopped, they
//    leave the playhead alone, so a stopped goto locates to the section's start
//    from the last save instead.
//  - A goto has been seen to change the loop range to a section's range; it is
//    put back afterwards.
//  - Macro commands are named "Macro " + base64(title) in category "Macros".

export const SYNC_MODES = { off: 'Set Sync Mode Off', '1bar': 'Set Sync Mode 1 Bar', '2bars': 'Set Sync Mode 2 Bars', '4bars': 'Set Sync Mode 4 Bars', end: 'Set Sync Mode End' };

// Saved sections, numbered in song order (the order Goto Section N uses).
export function numberSections(sections) {
  return [...sections]
    .sort((a, b) => a.start.seconds - b.start.seconds)
    .map((s, i) => ({ number: i + 1, name: s.name, start: { seconds: s.start.seconds, bar: s.start.bar }, lengthBeats: s.lengthBeats }));
}

export function findSection(list, section) {
  if (typeof section === 'number') return list.find((s) => s.number === section) || null;
  const want = String(section).toLowerCase();
  return list.find((s) => s.name.toLowerCase() === want) || list.find((s) => s.name.toLowerCase().includes(want)) || null;
}

const sameRange = (a, b) => Math.abs(a.start.seconds - b.start.seconds) < 1e-6 && Math.abs(a.end.seconds - b.end.seconds) < 1e-6;

// call: the bridge call(op, args). savedSections: () => sections of the last save.
export async function arranger(call, savedSections, { action, section, sync }) {
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
      return { sections: numberSections(savedSections()), note: 'From the last save; sections added since then are not listed.' };
    case 'goto': {
      if (section === undefined) throw new Error('goto needs section (number or name)');
      const list = numberSections(savedSections());
      const hit = findSection(list, section);
      if (typeof section !== 'number' && !hit) throw new Error(`no saved section named ${section}`);
      const number = typeof section === 'number' ? section : hit.number;
      if (playing) {
        if (number < 1 || number > 16) throw new Error('Studio One can jump to sections 1-16');
        const r = await keepLoop(() => run(`Goto Section ${number}`));
        if (!r.executed) throw new Error(`Goto Section ${number} did not run (no such section?)`);
        return { jumped: number, section: hit, note: 'The jump happens at the arranger sync point (see syncMode).', transport: (await call('song')).transport };
      }
      if (!hit) throw new Error(`section ${number} is not in the last save; save first, or goto while playing`);
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
      return { executed: r.executed, note: 'New sections are not listed until the song is saved. live_undo removes them.' };
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
