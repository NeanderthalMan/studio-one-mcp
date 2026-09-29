#!/usr/bin/env node
// Non-interactive device install (the guided version is `studio-one-mcp setup`).
//
//   node scripts/install-device.js [--profile <dir>] [--allow-eval] [--uninstall]
import { existsSync } from 'node:fs';
import { studioOneProfiles, mailboxDir } from '../src/paths.js';
import { installDevice, uninstallDevice } from '../src/setup/device.js';

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null);

const profile = opt('--profile') || studioOneProfiles()[0];
if (!profile || !existsSync(profile)) {
  console.error('Could not find a Studio One user profile. Pass --profile "<…/PreSonus/Studio One 5>".');
  process.exit(1);
}

if (flag('--uninstall')) {
  console.log(`Removed ${uninstallDevice(profile)}. Also remove "MCP Bridge" from Studio One's External Devices.`);
  process.exit(0);
}

const { target, config, editTasks } = installDevice({ profile, allowEval: flag('--allow-eval') });
console.log(`Installed bridge device → ${target}`);
console.log(`Installed edit tasks → ${editTasks}`);
console.log(`Mailbox → ${mailboxDir}${config.allowEval ? '  (eval ENABLED)' : ''}`);
console.log('Next: restart Studio One, then Studio One → Preferences… (Mac) or Options (Windows) → External Devices → Add… → studio-one-mcp → MCP Bridge, Receive From: your virtual MIDI port (IAC Driver Bus 1).');
