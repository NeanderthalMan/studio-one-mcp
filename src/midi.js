// The bridge's doorbell: one MIDI CC on the port the MCP Bridge device listens to.
// Studio One 5 gives scripts no usable timer, so the device only wakes up when a
// mapped control changes. We alternate 0/127 so every nudge is a change.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const CC = 119; // must match <MidiMessage address="#77"> in StudioOneMCP.surface.xml
const PORT = process.env.STUDIO_ONE_MCP_MIDI_PORT || 'IAC';

let output = null;
let portName = null;
let state = 0;

function open() {
  if (output) return output;
  let midi;
  try {
    midi = require('@julusian/midi');
  } catch (e) {
    throw new Error(`MIDI unavailable (${e.message}). Run npm install in studio-one-mcp.`);
  }
  const out = new midi.Output();
  const names = [];
  for (let i = 0; i < out.getPortCount(); i++) names.push(out.getPortName(i));
  const index = names.findIndex((n) => n.toLowerCase().includes(PORT.toLowerCase()));
  if (index < 0) {
    out.closePort?.();
    throw new Error(
      `No MIDI output matching "${PORT}" (found: ${names.join(', ') || 'none'}). ` +
        'On macOS enable Audio MIDI Setup → IAC Driver → "Device is online", and set the MCP Bridge ' +
        "device's Receive From to that bus. Override with STUDIO_ONE_MCP_MIDI_PORT.",
    );
  }
  out.openPort(index);
  output = out;
  portName = names[index];
  return output;
}

export function nudge() {
  state = state ? 0 : 127;
  open().sendMessage([0xb0, CC, state]);
}

export const midiPort = () => portName;
