// src/midi.js port selection. Runs in a child process per case because the
// module keeps its opened port for the life of the process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const midiUrl = new URL('../src/midi.js', import.meta.url).href;
const probe = (port) =>
  execFileSync(process.execPath, ['--input-type=module', '-e', `import { nudge, midiPort } from ${JSON.stringify(midiUrl)}; try { nudge(); console.log('ok ' + midiPort()); } catch (e) { console.log('err ' + e.message); }`], {
    env: { ...process.env, STUDIO_ONE_MCP_MIDI_PORT: port },
    encoding: 'utf8',
  }).trim();

test('a port that does not exist gives setup instructions', () => {
  const out = probe('no-such-port-xyz');
  assert.match(out, /^err No MIDI output matching "no-such-port-xyz"/);
  assert.match(out, /IAC Driver/);
});
