// Record setup: metronome (read and set through the bridge's metronome op) and
// record modes (set through their commands with a State argument).
//
// Seen on 5.5.2: Environment/Metronome has clickOn, precount, preroll and bars
// (precount length). Record modes live in app settings that scripts cannot read;
// their menu commands are toggles, but given ["State", 0|1] a toggle command sets
// that state (checked on Transport/Click, whose state is readable). So record
// modes are set, and reported as set, but cannot be read back.

export const RECORD_MODES = {
  replace: 'Record Mode Replace',
  loopTakes: 'Loop Record Takes',
  loopMix: 'Loop Record Mix',
  takesToLayers: 'Record Takes to Layers',
  inputQuantize: 'Input Quantize',
  noteErase: 'Note Erase',
};

// Auto Punch: Transport/Autopunch In|Out|Autopunch, set with a State argument
// (checked on 5.5.2), recording between the loop locators (Studio One manual,
// "Auto Punch"). The range is set without turning looping on.
const PUNCH = { off: [['Autopunch', 0]], in: [['Autopunch', 0], ['Autopunch In', 1]], out: [['Autopunch', 0], ['Autopunch Out', 1]], both: [['Autopunch', 1]] };

async function setPunch(call, { punch, punchFrom, punchTo }) {
  if (punch !== undefined && !PUNCH[punch]) throw new Error(`punch must be one of ${Object.keys(PUNCH).join(', ')}`);
  if ((punchFrom === undefined) !== (punchTo === undefined)) throw new Error('give both punchFrom and punchTo (the punch range is the loop range)');
  if (punchFrom !== undefined) await call('setLoop', { start: punchFrom, end: punchTo });
  for (const [name, state] of PUNCH[punch] || []) {
    const r = await call('command', { category: 'Transport', name, args: ['State', state] });
    if (!r.executed) throw new Error(`Transport/${name} did not run`);
  }
  const t = (await call('song')).transport;
  return { autopunch: t.autopunch, range: t.loopRange };
}

export async function recordSetup(call, args = {}) {
  // Validate the punch arguments before changing anything.
  if (args.punch !== undefined && !PUNCH[args.punch]) throw new Error(`punch must be one of ${Object.keys(PUNCH).join(', ')}`);
  if ((args.punchFrom === undefined) !== (args.punchTo === undefined)) throw new Error('give both punchFrom and punchTo (the punch range is the loop range)');
  const metro = {};
  for (const k of ['click', 'precount', 'preroll', 'precountBars']) if (args[k] !== undefined) metro[k] = args[k];
  const modes = {};
  for (const k of Object.keys(RECORD_MODES)) if (args[k] !== undefined) modes[k] = !!args[k];
  if (modes.loopTakes && modes.loopMix) throw new Error('loopTakes and loopMix are alternatives; pick one');
  const set = {};
  for (const [k, on] of Object.entries(modes)) {
    const r = await call('command', { category: 'Record Mode', name: RECORD_MODES[k], args: ['State', on ? 1 : 0] });
    if (!r.executed) throw new Error(`Record Mode/${RECORD_MODES[k]} did not run`);
    set[k] = on;
  }
  const metronome = await call('metronome', metro);
  const wantPunch = args.punch !== undefined || args.punchFrom !== undefined || args.punchTo !== undefined;
  const punch = wantPunch ? await setPunch(call, args) : { autopunch: (await call('song')).transport.autopunch };
  return {
    metronome,
    punch,
    ...(Object.keys(set).length ? { recordModesSet: set, note: 'Record modes cannot be read back from Studio One; these were set, not confirmed.' } : {}),
  };
}
