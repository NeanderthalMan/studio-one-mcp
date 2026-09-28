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

export async function recordSetup(call, args = {}) {
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
  return {
    metronome,
    ...(Object.keys(set).length ? { recordModesSet: set, note: 'Record modes cannot be read back from Studio One; these were set, not confirmed.' } : {}),
  };
}
