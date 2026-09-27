// Where things live on this machine. Everything is overridable by env var so the
// server works for other Studio One versions and non-default song folders.
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';

const home = homedir();
const isMac = platform() === 'darwin';

// Studio One's per-user profile ("Studio One 5", "Studio One 6", "Studio Pro 8"…).
export function studioOneProfiles() {
  if (process.env.STUDIO_ONE_PROFILE) return [process.env.STUDIO_ONE_PROFILE];
  const roots = isMac
    ? [join(home, 'Library/Application Support/PreSonus'), join(home, 'Library/Application Support/Fender')]
    : [join(process.env.APPDATA || join(home, 'AppData/Roaming'), 'PreSonus'), join(process.env.APPDATA || join(home, 'AppData/Roaming'), 'Fender')];
  const out = [];
  for (const r of roots) {
    if (!existsSync(r)) continue;
    for (const d of readdirSync(r)) if (/^Studio (One|Pro)/.test(d)) out.push(join(r, d));
  }
  return out.sort().reverse(); // newest version first
}

export function songRoots() {
  if (process.env.STUDIO_ONE_SONGS) return process.env.STUDIO_ONE_SONGS.split(':').filter(Boolean);
  return [join(home, 'Documents/Studio One/Songs'), join(home, 'Documents/Studio Pro/Songs')].filter(existsSync);
}

export const dataDir = process.env.STUDIO_ONE_MCP_HOME || (isMac ? join(home, 'Library/Application Support/studio-one-mcp') : join(home, '.studio-one-mcp'));
export const mailboxDir = join(dataDir, 'mailbox');
