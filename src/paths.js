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

// Studio One installs (the folder holding Presets/ and PlugIns/), newest first.
export function studioOneApps() {
  if (process.env.STUDIO_ONE_APP) return [process.env.STUDIO_ONE_APP];
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const roots = isMac ? ['/Applications'] : [join(pf, 'PreSonus'), join(pf, 'Fender')];
  const out = [];
  for (const r of roots) {
    if (!existsSync(r)) continue;
    for (const d of readdirSync(r)) if (/^Studio (One|Pro)/.test(d)) out.push(isMac ? join(r, d, 'Contents') : join(r, d));
  }
  return out.sort().reverse();
}

// Where plug-in presets live: the user's own first, then the factory ones.
export function presetRoots() {
  if (process.env.STUDIO_ONE_PRESETS) return process.env.STUDIO_ONE_PRESETS.split(':').filter(Boolean);
  const user = [join(home, 'Documents/Studio One/Presets'), join(home, 'Documents/Studio Pro/Presets')];
  return [...user, ...studioOneApps().map((a) => join(a, 'Presets'))].filter(existsSync);
}

// Studio One's built-in remote-control map (surfacedata XML): curated parameter
// names for every PreSonus plug-in, keyed by plug-in class.
export function remoteMapFiles() {
  if (process.env.STUDIO_ONE_REMOTE_MAP) return process.env.STUDIO_ONE_REMOTE_MAP.split(':').filter(Boolean);
  // The Windows path is a guess (only the Mac layout has been seen); a miss just means fewer names.
  const rel = isMac ? 'PlugIns/remoteservice.bundle/Contents/Resources/device/remotedevice.surfacedata' : 'Plugins/remoteservice/device/remotedevice.surfacedata';
  return studioOneApps().map((a) => join(a, rel)).filter(existsSync);
}

export const dataDir = process.env.STUDIO_ONE_MCP_HOME || (isMac ? join(home, 'Library/Application Support/studio-one-mcp') : join(home, '.studio-one-mcp'));
export const mailboxDir = join(dataDir, 'mailbox');
