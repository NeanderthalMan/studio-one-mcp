// Static checks on the device definition. Each of these encodes something
// Studio One 5.5.2 taught us the hard way; see README "How the live bridge works".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { deviceDir } from './helpers/s1host.js';
import { parseXml, kids, walk } from '../src/xml.js';

const read = (f) => readFileSync(join(deviceDir, f), 'utf8');
const device = parseXml(read('StudioOneMCP.device'));
const surface = parseXml(read('StudioOneMCP.surface.xml'));

test('.device is a JS control surface and every file it names exists', () => {
  const a = device.attrs;
  assert.equal(a.nativeCode, 'JSControlSurfaceDevice');
  assert.equal(a.category, 'Surface');
  assert.match(a.classID, /^\{[0-9A-F-]{36}\}$/);
  for (const f of [a.deviceScriptFile, a.componentScriptFile, a.surfaceFile]) assert.ok(existsSync(join(deviceDir, f)), f);
  assert.match(read(a.deviceScriptFile), new RegExp(`function ${a['deviceScriptFile.functionName']}\\(`));
  assert.match(read(a.componentScriptFile), new RegExp(`function ${a['componentScriptFile.functionName']}\\(`));
});

test('doorbell: a trigger control on note 119, matching src/midi.js', () => {
  const ctl = [...walk(surface)].find((n) => n.tag === 'Control' && n.attrs.name === 'bridgeTick');
  assert.equal(ctl.attrs.type, 'trigger');
  assert.match(ctl.attrs.options, /receive/);
  const msg = kids(ctl, 'MidiMessage')[0].attrs;
  assert.equal(msg.status, '#90');
  const note = parseInt(msg.address.slice(1), 16);
  assert.match(readFileSync(new URL('../src/midi.js', import.meta.url), 'utf8'), new RegExp(`const NOTE = ${note};`));
});

test('doorbell mapping is a <Toggle> inside <Global> (a bare <Value> never fires)', () => {
  const mappings = kids(surface, 'Mappings')[0];
  const global = kids(mappings, 'Global')[0];
  assert.ok(global, '<Global> block present');
  const toggle = kids(global, 'Toggle').find((t) => t.attrs.control === 'bridgeTick');
  assert.equal(toggle.attrs.param, 'bridgeTick');
  assert.ok(![...walk(surface)].some((n) => n.tag === 'Value' && n.attrs.control === 'bridgeTick'));
  assert.match(read('BridgeComponent.js'), /addParam\("bridgeTick"\)/);
});

test('mixer bank the component reads is mapped', () => {
  const dm = [...walk(surface)].find((n) => n.tag === 'DeviceMapping' && n.attrs.device === 'MixerConsole');
  assert.equal(dm.attrs.name, 'mixer');
  assert.ok(kids(dm, 'ScrollBank').some((b) => b.attrs.name === 'channels'));
});

test('device script loads midiprotocol.js before controlsurfacedevice.js (SysexBuffer)', () => {
  const src = read('BridgeDevice.js');
  const a = src.indexOf('sdk/midiprotocol.js');
  const b = src.indexOf('sdk/controlsurfacedevice.js');
  assert.ok(a >= 0 && a < b);
  assert.doesNotMatch(src, /\bHost\./, 'device scripts have no Host object');
});

test('no host APIs that are missing or crash on Studio One 5', () => {
  for (const f of ['BridgeCore.js', 'BridgeComponent.js', 'BridgeDevice.js']) {
    const code = read(f).replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /Signals\.postMessage/, `${f}: postMessage does not exist on 5.5.2`);
    assert.doesNotMatch(code, /addIdleTask/, `${f}: addIdleTask crashed Studio One 5.5.2`);
    assert.doesNotMatch(code, /this\.model\b/, `${f}: the model is this.hostComponent.model`);
  }
});

test('device scripts never throw (Studio One turns that into an error dialog)', () => {
  for (const f of ['BridgeCore.js', 'BridgeComponent.js', 'BridgeDevice.js', '../EditTasks/package/McpEdit.js', '../EditTasks/package/McpTrackEdit.js', '../EditTasks/package/McpTrackOps.js']) {
    const code = read(f).replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /\bthrow\b/, f);
  }
});

test('each mixer channel strip carries inserts and sends sub-banks', () => {
  const bank = [...walk(surface)].find((n) => n.tag === 'ScrollBank' && n.attrs.name === 'channels');
  const strip = [...walk(bank)].find((n) => n.tag === 'Strip' && kids(n, 'Bank').length);
  assert.deepEqual(kids(strip, 'Bank').map((b) => [b.attrs.target, b.attrs.name]), [['Inserts', 'inserts'], ['Sends', 'sends']]);
});
