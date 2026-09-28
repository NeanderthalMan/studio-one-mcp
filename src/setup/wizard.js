// `studio-one-mcp setup`: a guided install. Each step says what it will do and
// asks first (or takes the default with --yes). --dry-run changes nothing.
import { createInterface } from 'node:readline/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { stdin, stdout } from 'node:process';
import { studioOneProfiles } from '../paths.js';
import { installDevice, deviceStatus } from './device.js';
import {
  midiOutputs, pickMidiPort, studioOneRunning, serverEntry, claudeCodeAvailable, claudeCodeRegistered,
  claudeCodeAddArgs, desktopConfigPath, desktopRegistered, mergeDesktopConfig, isMac,
} from './checks.js';
import { bridgeStatus, call } from '../bridge.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function setup(argv = []) {
  const yes = argv.includes('--yes') || argv.includes('-y');
  const dry = argv.includes('--dry-run');
  const profileArg = argv.includes('--profile') ? argv[argv.indexOf('--profile') + 1] : null;
  const rl = yes ? null : createInterface({ input: stdin, output: stdout });
  const ask = async (q, dflt = true) => {
    if (!rl) return dflt;
    const a = (await rl.question(`${q} ${dflt ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
    return a ? a.startsWith('y') : dflt;
  };
  const say = (s = '') => console.log(s);
  const step = (n, s) => say(`\n${n}. ${s}`);
  const act = (desc, fn) => (dry ? say(`   (dry run) would ${desc}`) : fn());

  try {
    say('studio-one-mcp setup' + (dry ? ' (dry run: nothing will be changed)' : ''));

    // 1. Studio One profile
    step(1, 'Studio One');
    const profiles = profileArg ? [profileArg] : studioOneProfiles();
    if (!profiles.length) {
      say('   No Studio One profile found. Open Studio One once, then run setup again (or pass --profile).');
      return 1;
    }
    let profile = profiles[0];
    if (profiles.length > 1 && rl) {
      profiles.forEach((p, i) => say(`   ${i + 1}) ${p}`));
      const pick = Number((await rl.question(`   Which one? [1] `)).trim() || 1);
      profile = profiles[pick - 1] || profile;
    }
    say(`   Profile: ${profile}`);

    // 2. Device
    step(2, 'MCP Bridge device');
    const before = deviceStatus(profile);
    say(`   ${before.installed ? (before.current ? 'Installed and up to date.' : 'Installed, but out of date.') : 'Not installed yet.'}`);
    let changedDevice = false;
    if (!before.current && (await ask('   Install it now?'))) {
      say('   live_eval runs arbitrary JavaScript inside Studio One. Useful for development; leave it off otherwise.');
      const allowEval = await ask('   Enable live_eval?', false);
      act('install the device', () => {
        const { target } = installDevice({ profile, allowEval });
        say(`   Installed → ${target}`);
      });
      changedDevice = true;
    }

    // 3. Virtual MIDI port
    step(3, 'Virtual MIDI port (the bridge\'s doorbell)');
    let port = pickMidiPort(midiOutputs().names);
    if (!port) {
      if (isMac) {
        say('   Turn on the IAC Driver: Audio MIDI Setup → Window → Show MIDI Studio → double-click IAC Driver → tick "Device is online".');
        if (!dry && (await ask('   Open Audio MIDI Setup now?'))) spawnSync('open', ['-a', 'Audio MIDI Setup']);
      } else {
        say('   Install loopMIDI (https://www.tobias-erichsen.de/software/loopmidi.html) and add a port named "studio-one-mcp".');
      }
      if (!dry) {
        say('   Waiting for the port to appear (Ctrl-C to stop)…');
        for (let i = 0; i < 90 && !port; i++) {
          await sleep(2000);
          port = pickMidiPort(midiOutputs().names);
        }
      }
    }
    say(port ? `   Using "${port}".` : '   No virtual MIDI port yet; the live_* tools will not work until there is one.');

    // 4. MCP clients
    step(4, 'Register with your MCP client');
    const entry = serverEntry({ midiPort: port });
    if (claudeCodeAvailable()) {
      if (claudeCodeRegistered()) say('   Claude Code: already registered as "studio-one".');
      else if (await ask('   Add to Claude Code (all projects)?')) {
        const args = claudeCodeAddArgs(entry);
        act(`run: claude ${args.join(' ')}`, () => {
          execFileSync('claude', args, { stdio: 'inherit' });
        });
      }
    }
    const dp = desktopConfigPath();
    if (desktopRegistered(dp)) say('   Claude Desktop: already registered.');
    else if (await ask(`   Add to Claude Desktop (${dp})?`, false)) {
      act(`add "studio-one" to ${dp}`, () => {
        const { backup } = mergeDesktopConfig(entry, { path: dp });
        say(`   Added${backup ? ` (backup: ${backup})` : ''}. Restart Claude Desktop to load it.`);
      });
    }
    say('   Any other MCP client: ' + JSON.stringify({ mcpServers: { 'studio-one': entry } }));

    // 5. Studio One side
    step(5, 'In Studio One');
    const running = studioOneRunning();
    if (changedDevice && running) say('   Studio One is running: quit and reopen it so it loads the new device files.');
    say('   Once, if MCP Bridge is not listed yet:');
    say(`     Studio One → ${isMac ? 'Preferences… (⌘,)' : 'Options'} → External Devices → Add… → studio-one-mcp → MCP Bridge`);
    say(`     Receive From: ${port || 'your virtual MIDI port'}    Send To: None`);

    // 6. Verify
    step(6, 'Check the connection');
    if (dry) say('   (dry run) would wait for Studio One to answer a ping');
    else if (await ask('   Wait for Studio One to answer? (do the steps above first)')) {
      for (let i = 0; i < 60; i++) {
        if (bridgeStatus().loaded) {
          try {
            await call('ping', {}, { timeoutMs: 2000 });
            say('   ✔ Studio One answered. You are set up; try asking your assistant for live_song.');
            return 0;
          } catch {
            /* keep waiting */
          }
        }
        await sleep(3000);
      }
      say('   ✖ No answer yet. Run "studio-one-mcp doctor" to see which link is missing.');
      return 1;
    }
    say('\nDone. "studio-one-mcp doctor" checks everything at any time.');
    return 0;
  } finally {
    rl?.close();
  }
}
