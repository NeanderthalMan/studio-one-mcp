// Environment checks shared by `setup` and `doctor`. Each returns plain data;
// printing and prompting live in wizard.js / doctor.js.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const isMac = platform() === 'darwin';
export const isWindows = platform() === 'win32';
export const serverPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'server.js');

export function midiOutputs() {
  try {
    const midi = require('@julusian/midi');
    const out = new midi.Output();
    const names = [];
    for (let i = 0; i < out.getPortCount(); i++) names.push(out.getPortName(i));
    out.closePort?.();
    return { ok: true, names };
  } catch (e) {
    return { ok: false, names: [], error: e.message };
  }
}

// The virtual port the bridge should use: IAC on macOS, loopMIDI (or any
// port with "studio-one-mcp" in its name) on Windows.
export function pickMidiPort(names, preferred = process.env.STUDIO_ONE_MCP_MIDI_PORT) {
  const lower = (s) => s.toLowerCase();
  if (preferred) return names.find((n) => lower(n).includes(lower(preferred))) || null;
  return names.find((n) => /iac/i.test(n)) || names.find((n) => /studio-one-mcp|loopmidi/i.test(n)) || null;
}

export function studioOneRunning() {
  try {
    if (isMac) return execFileSync('pgrep', ['-x', 'studioapp'], { encoding: 'utf8' }).trim().length > 0;
    if (isWindows) return /Studio One|Studio Pro/i.test(execFileSync('tasklist', { encoding: 'utf8' }));
  } catch {
    return false;
  }
  return false;
}

export function serverEntry({ midiPort } = {}) {
  const entry = { command: process.execPath, args: [serverPath] };
  if (midiPort && !/iac/i.test(midiPort)) entry.env = { STUDIO_ONE_MCP_MIDI_PORT: midiPort };
  return entry;
}

// ---- Claude Code ----------------------------------------------------------------

export function claudeCodeAvailable() {
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Run from the home folder: inside this repo, its .mcp.json (project scope)
// would make it look registered everywhere.
export function claudeCodeRegistered(name = 'studio-one') {
  try {
    execFileSync('claude', ['mcp', 'get', name], { stdio: 'ignore', cwd: homedir() });
    return true;
  } catch {
    return false;
  }
}

export function claudeCodeAddArgs(entry, name = 'studio-one') {
  const env = Object.entries(entry.env || {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  return ['mcp', 'add', '-s', 'user', ...env, name, '--', entry.command, ...entry.args];
}

// ---- Claude Desktop -------------------------------------------------------------

export function desktopConfigPath() {
  if (isMac) return join(homedir(), 'Library/Application Support/Claude/claude_desktop_config.json');
  if (isWindows) return join(process.env.APPDATA || join(homedir(), 'AppData/Roaming'), 'Claude', 'claude_desktop_config.json');
  return join(homedir(), '.config/Claude/claude_desktop_config.json');
}

export function readDesktopConfig(path = desktopConfigPath()) {
  if (!existsSync(path)) return { exists: false, config: {} };
  try {
    return { exists: true, config: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (e) {
    return { exists: true, config: null, error: `not valid JSON: ${e.message}` };
  }
}

export function desktopRegistered(path = desktopConfigPath(), name = 'studio-one') {
  const { config } = readDesktopConfig(path);
  return !!config?.mcpServers?.[name];
}

// Adds or replaces one server entry, leaving everything else as it was.
// Backs the old file up next to it first.
export function mergeDesktopConfig(entry, { path = desktopConfigPath(), name = 'studio-one' } = {}) {
  const { exists, config, error } = readDesktopConfig(path);
  if (error) throw new Error(`${path} is ${error}; fix or remove it first`);
  let backup = null;
  if (exists) {
    backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(path, backup);
  }
  const next = { ...config, mcpServers: { ...(config.mcpServers || {}), [name]: entry } };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n');
  return { path, backup };
}
