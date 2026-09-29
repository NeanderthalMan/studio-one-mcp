// scripts/install-device.js against a throwaway Studio One profile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';

const script = fileURLToPath(new URL('../scripts/install-device.js', import.meta.url));

function run(args, home) {
  return execFileSync(process.execPath, [script, ...args], {
    env: { ...process.env, STUDIO_ONE_MCP_HOME: home },
    encoding: 'utf8',
  });
}

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 's1inst-'));
  const profile = join(root, 'Studio One 5');
  const home = join(root, 'mcp home'); // with a space, like "Application Support"
  mkdirSync(profile);
  return { profile, home, target: join(profile, 'User Devices', 'studio-one-mcp') };
}

test('installs every device file plus a generated BridgeConfig.js', () => {
  const { profile, home, target } = sandbox();
  run(['--profile', profile], home);
  const src = readdirSync(fileURLToPath(new URL('../device/StudioOneMCP/', import.meta.url)));
  for (const f of src) assert.ok(existsSync(join(target, f)), f);
  const cfg = readFileSync(join(target, 'BridgeConfig.js'), 'utf8');
  const config = JSON.parse(cfg.slice(cfg.indexOf('{'), cfg.lastIndexOf('}') + 1));
  // Studio One stores file URLs unencoded; a %20 here would point nowhere.
  assert.equal(config.mailbox, `file://${home}/mailbox/`);
  assert.equal(config.allowEval, false);
  assert.ok(existsSync(join(home, 'mailbox')));
});

test('--allow-eval is opt-in', () => {
  const { profile, home, target } = sandbox();
  run(['--profile', profile, '--allow-eval'], home);
  assert.match(readFileSync(join(target, 'BridgeConfig.js'), 'utf8'), /"allowEval": true/);
});

test('reinstall is idempotent and --uninstall removes the folder', () => {
  const { profile, home, target } = sandbox();
  run(['--profile', profile], home);
  run(['--profile', profile], home);
  assert.ok(existsSync(join(target, 'StudioOneMCP.device')));
  run(['--profile', profile, '--uninstall'], home);
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(join(profile, 'Extensions', 'studio-one-mcp.edittasks')), false, 'edit tasks removed too');
});

test('installs the edit-task extension: metadata plus a ZIP package with the mailbox config', () => {
  const { profile, home } = sandbox();
  run(['--profile', profile], home);
  const ext = join(profile, 'Extensions', 'studio-one-mcp.edittasks');
  for (const f of ['metainfo.xml', 'installdata.xml', 'scripts/studio-one-mcp.package']) assert.ok(existsSync(join(ext, f)), f);
  const files = unzipSync(readFileSync(join(ext, 'scripts', 'studio-one-mcp.package')));
  assert.deepEqual(Object.keys(files).sort(), ['McpEdit.js', 'McpEditConfig.js', 'classfactory.xml', 'metainfo.xml']);
  const cfg = strFromU8(files['McpEditConfig.js']);
  assert.equal(JSON.parse(cfg.slice(cfg.indexOf('{'), cfg.lastIndexOf('}') + 1)).mailbox, `file://${home}/mailbox/`);
});

test('missing profile is a clear error', () => {
  const { home } = sandbox();
  assert.throws(() => execFileSync(process.execPath, [script, '--profile', '/nonexistent/Studio One 9'], {
    env: { ...process.env, STUDIO_ONE_MCP_HOME: home }, encoding: 'utf8', stdio: 'pipe',
  }), /Could not find a Studio One user profile/);
});
