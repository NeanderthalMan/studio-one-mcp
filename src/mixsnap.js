// Mix snapshots: every channel's volume, pan, mute, solo and monitor, and each
// send's level and mute, saved under a name per song and set back later.
// Only the bridge's existing channel and send ops are used.
//
// Left out on purpose: record-arm (not part of a mix) and automation mode (setting
// a channel back to touch/latch/write would start recording automation on play).
// Restore sets only what differs, and a send only when it still goes to the same
// place. Channels that are gone, or share a name, are reported rather than guessed.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './paths.js';

const FIELDS = ['volume', 'pan', 'mute', 'solo', 'monitor'];
const safe = (s) => String(s).replace(/[^\w .()-]+/g, '_').trim() || '_';
const same = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-6 : a === b);

async function current(call) {
  const [channels, sends] = await Promise.all([call('channels'), call('sends', {})]);
  const count = new Map();
  for (const c of channels) count.set(c.label, (count.get(c.label) || 0) + 1);
  const byLabel = new Map();
  for (const c of channels) {
    if (count.get(c.label) > 1) continue; // ambiguous: cannot be addressed by name
    const entry = {};
    for (const f of FIELDS) if (c[f] !== null && c[f] !== undefined) entry[f] = c[f];
    byLabel.set(c.label, entry);
  }
  for (const s of sends) {
    const e = byLabel.get(s.channel);
    if (e && s.sends.length) e.sends = s.sends.map((x) => ({ index: x.index, to: x.to, level: x.level, muted: x.muted }));
  }
  return { byLabel, duplicates: [...count].filter(([, n]) => n > 1).map(([l]) => l) };
}

export async function mixSnapshot(call, { action, name }, { dir = join(dataDir, 'mix-snapshots') } = {}) {
  const { title } = await call('song');
  const songDir = join(dir, safe(title));
  if (action === 'list') {
    if (!existsSync(songDir)) return { song: title, snapshots: [] };
    const snapshots = readdirSync(songDir).filter((f) => f.endsWith('.json')).map((f) => {
      const s = JSON.parse(readFileSync(join(songDir, f), 'utf8'));
      return { name: s.name, savedAt: s.savedAt, channels: Object.keys(s.channels).length };
    });
    return { song: title, snapshots };
  }
  if (!name) throw new Error(`${action} needs name`);
  const file = join(songDir, `${safe(name)}.json`);
  if (action === 'save') {
    const { byLabel, duplicates } = await current(call);
    mkdirSync(songDir, { recursive: true });
    writeFileSync(file, JSON.stringify({ song: title, name, savedAt: new Date().toISOString(), channels: Object.fromEntries(byLabel) }, null, 1));
    return { saved: name, song: title, channels: byLabel.size, ...(duplicates.length ? { skipped: duplicates.map((l) => `${l} (more than one channel has this name)`) } : {}), file };
  }
  if (action === 'restore') {
    if (!existsSync(file)) throw new Error(`no mix snapshot "${name}" for ${title}`);
    const snap = JSON.parse(readFileSync(file, 'utf8'));
    const { byLabel } = await current(call);
    const changed = [];
    const skipped = [];
    for (const [label, saved] of Object.entries(snap.channels)) {
      const now = byLabel.get(label);
      if (!now) { skipped.push(`${label} (not in the mixer now, or its name is shared)`); continue; }
      for (const f of FIELDS) {
        if (saved[f] === undefined || now[f] === undefined || same(saved[f], now[f])) continue;
        await call('setChannel', { channel: label, field: f, value: saved[f] });
        changed.push(`${label} ${f}`);
      }
      for (const s of saved.sends || []) {
        const live = (now.sends || []).find((x) => x.index === s.index);
        if (!live || live.to !== s.to) { skipped.push(`${label} send ${s.index} to ${s.to} (not there now)`); continue; }
        const set = {};
        if (!same(live.level, s.level)) set.level = s.level;
        if (live.muted !== s.muted) set.muted = s.muted;
        if (Object.keys(set).length) {
          await call('setSend', { channel: label, index: s.index, ...set });
          changed.push(`${label} send ${s.index}`);
        }
      }
    }
    return { restored: name, song: title, changed: changed.length, changes: changed, ...(skipped.length ? { skipped } : {}) };
  }
  throw new Error(`unknown action ${action}`);
}
