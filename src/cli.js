#!/usr/bin/env node
// Entry point. With no arguments it is the MCP server (stdio), which is how MCP
// clients launch it; subcommands are for people.
const [cmd, ...rest] = process.argv.slice(2);

const usage = `studio-one-mcp            run the MCP server (stdio)
studio-one-mcp setup      guided install: device, virtual MIDI port, MCP client
                          [--yes] [--dry-run] [--profile <dir>]
studio-one-mcp doctor     check every link in the chain, with fixes
studio-one-mcp uninstall  remove the bridge device [--profile <dir>]`;

if (!cmd) {
  await import('./server.js');
} else if (cmd === 'setup') {
  const { setup } = await import('./setup/wizard.js');
  process.exit(await setup(rest));
} else if (cmd === 'doctor') {
  const { doctor } = await import('./setup/doctor.js');
  const profile = rest.includes('--profile') ? rest[rest.indexOf('--profile') + 1] : undefined;
  process.exit(await doctor({ profile }));
} else if (cmd === 'uninstall') {
  const { uninstallDevice } = await import('./setup/device.js');
  const { studioOneProfiles } = await import('./paths.js');
  const profile = rest.includes('--profile') ? rest[rest.indexOf('--profile') + 1] : studioOneProfiles()[0];
  if (!profile) {
    console.error('No Studio One profile found; pass --profile.');
    process.exit(1);
  }
  console.log(`Removed ${uninstallDevice(profile)}. Also remove "MCP Bridge" in Studio One → External Devices.`);
} else {
  console.log(usage);
  process.exit(cmd === 'help' || cmd === '--help' || cmd === '-h' ? 0 : 1);
}
