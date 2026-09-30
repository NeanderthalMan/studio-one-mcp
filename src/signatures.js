// Time signatures in the running song.
//
// Seen on Studio One 5.5.2:
//  - Edit/Insert Time Signature takes arguments "Bar, Numerator, Denominator" and
//    Edit/Remove Time Signature takes "Bar" (Host.GUI.Commands.findCommand(...)
//    .arguments lists them). Given as numbers they run without a dialog; given as
//    strings, or left out, the command opens its dialog, which blocks the bridge
//    until someone closes it. So every argument is checked here first.
//  - The signature in effect anywhere is read from the song's time context
//    (MCP Track Edit task, op signatures).
import { trackTask } from './tracks.js';
import { manyToSeconds } from './time.js';

const DENOMINATORS = [1, 2, 4, 8, 16, 32];

function checkBar(bar) {
  if (!Number.isInteger(bar) || bar < 1 || bar > 9999) throw new Error('bar must be a whole bar number from 1');
}

async function at(call, positions) {
  const seconds = await manyToSeconds(call, positions);
  return (await trackTask(call, { op: 'signatures', at: seconds })).signatures;
}

export async function timeSignature(call, { action, at: positions, bar, numerator, denominator }) {
  switch (action) {
    case 'at': {
      const list = positions === undefined ? [0] : Array.isArray(positions) ? positions : [positions];
      return { signatures: await at(call, list) };
    }
    case 'insert': {
      checkBar(bar);
      if (!Number.isInteger(numerator) || numerator < 1 || numerator > 32) throw new Error('numerator must be 1 to 32');
      if (!DENOMINATORS.includes(denominator)) throw new Error(`denominator must be one of ${DENOMINATORS.join(', ')}`);
      const r = await call('command', { category: 'Edit', name: 'Insert Time Signature', args: ['Bar', bar, 'Numerator', numerator, 'Denominator', denominator] });
      if (!r.executed) throw new Error('Edit/Insert Time Signature did not run');
      return { inserted: { bar, numerator, denominator }, now: (await at(call, [`${bar}.1.1.0`]))[0], note: 'One live_undo removes it; or action remove at the same bar.' };
    }
    case 'remove': {
      checkBar(bar);
      const r = await call('command', { category: 'Edit', name: 'Remove Time Signature', args: ['Bar', bar] });
      if (!r.executed) throw new Error(`Edit/Remove Time Signature did not run (no change at bar ${bar}?)`);
      return { removed: bar, now: (await at(call, [`${bar}.1.1.0`]))[0] };
    }
    default:
      throw new Error(`unknown action ${action}`);
  }
}
