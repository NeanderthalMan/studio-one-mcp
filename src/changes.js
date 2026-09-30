// What changed in the running song since the previous look: tracks and their
// events, the mixer (levels, mute/solo, arm, monitor, automation mode, routing,
// plug-ins), tempo and loop, markers and arranger sections. Each call takes a
// snapshot, keeps it (in the studio-one-mcp data folder, per song) and reports
// the difference from the one before.
//
// Why snapshots: Studio One 5.5.2 does tell scripts when things change
// (Host.Signals.advise), and a live feed built on that worked, but it crashed
// Studio One three times (2026-09-30): reading a parameter while a song closed,
// unsubscribing from an object that was already gone (a crash a minute later),
// and unsubscribing while Studio One quit. There is no notice before quitting to
// let go in time. Comparing snapshots never touches that machinery. The price:
// changes are net (a fader moved and moved back is no change), and who made them
// is not known.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { dataDir } from './paths.js';

const dir = () => join(dataDir, 'changes');
const fileFor = (song) => join(dir(), `${createHash('sha1').update(String(song)).digest('hex').slice(0, 16)}.json`);

const r3 = (x) => (typeof x === 'number' ? Math.round(x * 1000) / 1000 : x);

export async function snapshot(call) {
  const song = await call('song');
  const tracks = await call('tracks', { maxEvents: 500 });
  const channels = await call('channels');
  const inserts = await call('inserts', {});
  let markers = null;
  let sections = null;
  try {
    const { results } = await call('trackTask', { ops: [{ op: 'markers' }, { op: 'sections' }] });
    if (!results[0].error) markers = results[0].markers.filter((m) => m.kind === 'marker').map((m) => ({ name: m.name, seconds: m.seconds }));
    if (!results[1].error) sections = results[1].sections.map((s) => ({ name: s.name, start: s.start, end: s.end }));
  } catch {
    // without the MCP Track Edit task there are no markers or sections to compare
  }
  const fx = Object.fromEntries(inserts.map((c) => [c.channel, c.inserts.map((i) => `${i.name}${i.bypassed ? ' (bypassed)' : ''}`)]));
  return {
    at: new Date().toISOString(),
    song: song.title,
    file: song.fileUrl,
    tempo: r3(song.transport.tempo),
    loop: { on: song.transport.loop, start: r3(song.transport.loopRange.start.seconds), end: r3(song.transport.loopRange.end.seconds) },
    tracks: tracks.map((t) => ({ name: t.name, events: t.events.map((e) => `${e.name}@${r3(e.start)}-${r3(e.end)}${e.muted ? ' (muted)' : ''}`) })),
    channels: Object.fromEntries(channels.map((c) => [c.label, {
      volume: r3(c.volume), pan: r3(c.pan), mute: c.mute, solo: c.solo, recordArmed: c.recordArmed, monitor: c.monitor, automation: c.automation, output: c.output, inserts: fx[c.label] || [],
    }])),
    markers,
    sections,
  };
}

const keyOf = (x) => `${x.name}@${x.seconds ?? x.start}`;

// Added, removed, renamed (same place, new name) and moved (same name, new place).
export function diffList(before, after, where) {
  const pos = (x) => x[where];
  const out = { added: [], removed: [], renamed: [], moved: [] };
  const left = [...before];
  const right = [];
  for (const a of after) {
    const same = left.findIndex((b) => keyOf(b) === keyOf(a));
    if (same >= 0) left.splice(same, 1);
    else right.push(a);
  }
  for (const a of right) {
    const at = left.findIndex((b) => Math.abs(pos(b) - pos(a)) < 1e-3);
    if (at >= 0) { out.renamed.push({ from: left[at].name, to: a.name, at: pos(a) }); left.splice(at, 1); continue; }
    const named = left.findIndex((b) => b.name && b.name === a.name);
    if (named >= 0) { out.moved.push({ name: a.name, from: pos(left[named]), to: pos(a) }); left.splice(named, 1); continue; }
    out.added.push({ name: a.name, at: pos(a) });
  }
  for (const b of left) out.removed.push({ name: b.name, at: pos(b) });
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v.length));
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Names that came and went; a name that left the place where another arrived,
// with the same neighbour on one side, is a rename (without the neighbour it
// could as well be a reorder plus a new track).
export function diffNames(before, after) {
  const added = after.filter((n) => !before.includes(n));
  const removed = before.filter((n) => !after.includes(n));
  const renamed = [];
  for (const n of [...added]) {
    const i = after.indexOf(n);
    const was = before[i];
    const neighbour = (i > 0 && before[i - 1] === after[i - 1]) || (i + 1 < after.length && before[i + 1] === after[i + 1]);
    if (was !== undefined && removed.includes(was) && neighbour) {
      renamed.push({ from: was, to: n });
      added.splice(added.indexOf(n), 1);
      removed.splice(removed.indexOf(was), 1);
    }
  }
  return { added, removed, renamed };
}

export function diffSnapshots(a, b) {
  const out = {};
  if (a.tempo !== b.tempo) out.tempo = { from: a.tempo, to: b.tempo };
  if (!same(a.loop, b.loop)) out.loop = { from: a.loop, to: b.loop };

  const names = diffNames(a.tracks.map((t) => t.name), b.tracks.map((t) => t.name));
  const tracks = {};
  for (const k of ['added', 'removed', 'renamed']) if (names[k].length) tracks[k] = names[k];
  const fromName = (n) => names.renamed.find((r) => r.to === n)?.from ?? n;
  const kept = b.tracks.map((t) => t.name).filter((n) => !names.added.includes(n));
  const keptBefore = a.tracks.map((t) => t.name).filter((n) => !names.removed.includes(n));
  if (!same(kept.map(fromName), keptBefore)) tracks.order = b.tracks.map((t) => t.name);
  if (Object.keys(tracks).length) out.tracks = tracks;

  const events = [];
  for (const t of b.tracks) {
    const before = a.tracks.find((x) => x.name === fromName(t.name));
    if (!before) continue;
    const added = t.events.filter((e) => !before.events.includes(e));
    const removed = before.events.filter((e) => !t.events.includes(e));
    if (added.length || removed.length) events.push({ track: t.name, added, removed });
  }
  if (events.length) out.events = events;

  const ch = diffNames(Object.keys(a.channels), Object.keys(b.channels));
  const mixer = [];
  for (const [label, now] of Object.entries(b.channels)) {
    const was = a.channels[ch.renamed.find((r) => r.to === label)?.from ?? label];
    if (!was) continue;
    const fields = {};
    for (const k of Object.keys(now)) if (!same(was[k], now[k])) fields[k] = { from: was[k], to: now[k] };
    if (Object.keys(fields).length) mixer.push({ channel: label, ...fields });
  }
  // Channels that are just a track's own coming or going are already in tracks.
  const chAdded = ch.added.filter((n) => !names.added.includes(n));
  const chRemoved = ch.removed.filter((n) => !names.removed.includes(n));
  if (chAdded.length || chRemoved.length) out.channels = { ...(chAdded.length ? { added: chAdded } : {}), ...(chRemoved.length ? { removed: chRemoved } : {}) };
  if (mixer.length) out.mixer = mixer;

  if (a.markers && b.markers) {
    const d = diffList(a.markers, b.markers, 'seconds');
    if (Object.keys(d).length) out.markers = d;
  }
  if (a.sections && b.sections) {
    const d = diffList(a.sections, b.sections, 'start');
    if (Object.keys(d).length) out.sections = d;
  }
  return out;
}

export async function liveChanges(call, { reset } = {}) {
  const now = await snapshot(call);
  const file = fileFor(now.file || now.song);
  const prev = !reset && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  mkdirSync(dir(), { recursive: true });
  writeFileSync(file, JSON.stringify(now));
  if (!prev) return { song: now.song, since: null, note: 'First look at this song (or a reset): the next call reports what changed after this.' };
  const changes = diffSnapshots(prev, now);
  return { song: now.song, since: prev.at, now: now.at, changed: Object.keys(changes).length > 0, ...changes };
}
