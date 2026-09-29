// The installer pieces: device status, MIDI port choice, MCP client registration,
// the doctor report and the CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installDevice, deviceStatus, deviceTarget, fileUrl, readDeviceConfig, editTasksStatus, editTasksTarget } from '../src/setup/device.js';
import { rmSync } from 'node:fs';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import { pickMidiPort, serverEntry, claudeCodeAddArgs, mergeDesktopConfig, readDesktopConfig, serverPath, runningFromNpx } from '../src/setup/checks.js';
import { version } from '../src/version.js';
import { formatReport } from '../src/setup/doctor.js';

const tmp = (p) => mkdtempSync(join(tmpdir(), p));

test('fileUrl keeps spaces unencoded, like Studio One does', () => {
  assert.equal(fileUrl('/Users/me/Library/Application Support/x'), 'file:///Users/me/Library/Application Support/x');
  assert.equal(fileUrl('C:\\Users\\me\\AppData'), 'file:///C:/Users/me/AppData');
});

test('deviceStatus: not installed → installed and current → stale after a change', () => {
  const profile = tmp('s1prof-');
  const none = deviceStatus(profile);
  assert.deepEqual([none.installed, none.current, none.config, none.editTasks.installed], [false, false, null, false]);
  installDevice({ profile, allowEval: true, mailbox: join(profile, 'mb') });
  const ok = deviceStatus(profile);
  assert.deepEqual([ok.installed, ok.current, ok.config.allowEval, ok.editTasks.current], [true, true, true, true]);
  writeFileSync(join(deviceTarget(profile), 'BridgeCore.js'), '// old version\n');
  const stale = deviceStatus(profile);
  assert.deepEqual([stale.installed, stale.current, stale.stale], [true, false, ['BridgeCore.js']]);
  assert.equal(readDeviceConfig(profile).mailbox, fileUrl(join(profile, 'mb')) + '/');
});

// The upgrade case: a device installed before the extension existed is current on
// its own files, but the install is not complete until the extension is there.
test('deviceStatus: a current device without the edit-task extension is out of date', () => {
  const profile = tmp('s1prof-');
  installDevice({ profile, mailbox: join(profile, 'mb') });
  rmSync(editTasksTarget(profile), { recursive: true, force: true });
  const s = deviceStatus(profile);
  assert.deepEqual([s.installed, s.current, s.editTasks.installed], [true, false, false]);
  assert.match(s.stale.join(), /edit-task extension \(not installed\)/);
});

test('editTasksStatus: a stale package file or extension metadata is named; the generated config is not compared', () => {
  const profile = tmp('s1prof-');
  installDevice({ profile, mailbox: join(profile, 'mb') });
  const pkg = join(editTasksTarget(profile), 'scripts', 'studio-one-mcp.package');
  const files = unzipSync(readFileSync(pkg));
  files['McpEditConfig.js'] = strToU8('var McpEditConfig = { mailbox: "file:///somewhere/else/" };');
  writeFileSync(pkg, zipSync(files));
  assert.equal(editTasksStatus(profile).current, true, 'a different mailbox is not staleness');
  files['McpEdit.js'] = strToU8('// old task\n');
  writeFileSync(pkg, zipSync(files));
  writeFileSync(join(editTasksTarget(profile), 'metainfo.xml'), '<old/>');
  assert.deepEqual(editTasksStatus(profile).stale.sort(), ['Extensions/metainfo.xml', 'edit-task package: McpEdit.js']);
  writeFileSync(pkg, 'not a zip');
  assert.match(editTasksStatus(profile).stale.join(), /unreadable/);
});

test('pickMidiPort: IAC first, then loopMIDI / studio-one-mcp, or an explicit name', () => {
  assert.equal(pickMidiPort(['Casio', 'IAC Driver Bus 1']), 'IAC Driver Bus 1');
  assert.equal(pickMidiPort(['Casio', 'loopMIDI Port']), 'loopMIDI Port');
  assert.equal(pickMidiPort(['studio-one-mcp 1']), 'studio-one-mcp 1');
  assert.equal(pickMidiPort(['Casio']), null);
  assert.equal(pickMidiPort(['IAC Driver Bus 1', 'My Bus'], 'my bus'), 'My Bus');
  assert.equal(pickMidiPort(['IAC Driver Bus 1'], 'nothing'), null);
});

test('serverEntry: node + absolute server path; MIDI port env only when not IAC', () => {
  assert.deepEqual(serverEntry({ midiPort: 'IAC Driver Bus 1' }), { command: process.execPath, args: [serverPath] });
  assert.deepEqual(serverEntry({ midiPort: 'loopMIDI Port' }).env, { STUDIO_ONE_MCP_MIDI_PORT: 'loopMIDI Port' });
  assert.ok(existsSync(serverPath));
});

test('serverEntry from npx: registers npx pinned to this version, not the cache path', () => {
  const cached = '/Users/me/.npm/_npx/3f2a9c/node_modules/studio-one-mcp/src/server.js';
  assert.equal(runningFromNpx(cached), true);
  assert.equal(runningFromNpx(serverPath), false, 'this checkout is not the npx cache');
  assert.deepEqual(serverEntry({ path: cached, platform: 'darwin', pkgVersion: '0.2.0' }), { command: 'npx', args: ['-y', 'studio-one-mcp@0.2.0'] });
  const win = 'C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\3f2a9c\\node_modules\\studio-one-mcp\\src\\server.js';
  assert.deepEqual(serverEntry({ path: win, platform: 'win32', pkgVersion: '0.2.0', midiPort: 'loopMIDI Port' }), {
    command: 'cmd', args: ['/c', 'npx', '-y', 'studio-one-mcp@0.2.0'], env: { STUDIO_ONE_MCP_MIDI_PORT: 'loopMIDI Port' },
  });
  assert.deepEqual(serverEntry({ path: cached }).args, ['-y', `studio-one-mcp@${version}`], 'defaults to package.json');
});

test('claude mcp add arguments: user scope, env, then the command', () => {
  assert.deepEqual(claudeCodeAddArgs({ command: '/bin/node', args: ['/x/server.js'], env: { A: '1' } }), [
    'mcp', 'add', '-s', 'user', '-e', 'A=1', 'studio-one', '--', '/bin/node', '/x/server.js',
  ]);
});

test('Claude Desktop config: creates, merges without touching other servers, backs up', () => {
  const dir = tmp('s1desk-');
  const path = join(dir, 'Claude', 'claude_desktop_config.json');
  const first = mergeDesktopConfig({ command: 'node', args: ['a'] }, { path });
  assert.equal(first.backup, null, 'nothing to back up yet');
  writeFileSync(path, JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' } } }));
  const second = mergeDesktopConfig({ command: 'node', args: ['b'] }, { path });
  const cfg = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(cfg, { theme: 'dark', mcpServers: { other: { command: 'x' }, 'studio-one': { command: 'node', args: ['b'] } } });
  assert.ok(existsSync(second.backup));
  assert.equal(readdirSync(join(dir, 'Claude')).filter((f) => f.includes('.bak-')).length, 1);
});

test('Claude Desktop config that is not JSON is left alone', () => {
  const path = join(tmp('s1bad-'), 'claude_desktop_config.json');
  writeFileSync(path, '{ not json');
  assert.match(readDesktopConfig(path).error, /not valid JSON/);
  assert.throws(() => mergeDesktopConfig({ command: 'node', args: [] }, { path }), /fix or remove it first/);
  assert.equal(readFileSync(path, 'utf8'), '{ not json');
});

test('doctor report: icons, fixes under failures, summary', () => {
  const out = formatReport([
    { name: 'Node.js', status: 'pass', detail: '24' },
    { name: 'Virtual MIDI port', status: 'fail', detail: 'none', fix: 'Turn on IAC' },
    { name: 'Claude Desktop', status: 'info', detail: 'not registered' },
  ]);
  assert.match(out, /✔ Node\.js/);
  assert.match(out, /✖ Virtual MIDI port\s+none\n\s+→ Turn on IAC/);
  assert.match(out, /1 problem\(s\) found\./);
  assert.match(formatReport([{ name: 'a', status: 'pass', detail: '' }]), /All good\./);
});

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const run = (args, env = {}) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, stdio: 'pipe' }) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout) + String(e.stderr) };
  }
};

test('cli: help, unknown command, doctor on an empty profile', () => {
  assert.match(run(['help']).out, /studio-one-mcp setup/);
  assert.equal(run(['bogus']).code, 1);
  const profile = tmp('s1doc-');
  const r = run(['doctor', '--profile', profile], { STUDIO_ONE_MCP_HOME: tmp('s1home-') });
  assert.match(r.out, /Bridge device installed\s+not installed/);
  assert.equal(r.code, 1);
});

test('cli: setup --dry-run --yes changes nothing', () => {
  const profile = tmp('s1dry-');
  mkdirSync(profile, { recursive: true });
  const r = run(['setup', '--dry-run', '--yes', '--profile', profile], { STUDIO_ONE_MCP_HOME: tmp('s1home-') });
  assert.match(r.out, /would install the device/);
  assert.equal(existsSync(deviceTarget(profile)), false);
});
