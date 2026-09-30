// What changed between two saves of a song (two readSong() results): tempo,
// meter, markers, sections, tracks (added, removed, renamed, active take, events,
// notes), mixer channels (level, pan, mute, solo, automation mode, output,
// plug-ins and their saved settings) and automation envelopes.
//
// Tracks and channels are matched by their ids, so a rename is a rename, not a
// removal plus an addition. Events and notes are compared as multisets of
// (position, length, name / pitch): a moved event shows as one removed and one added.

const r3 = (n) => Math.round(n * 1000) / 1000;
const bar = (x) => `bar ${x.start.bar}`;
const evKey = (e) => `${e.name} at beat ${r3(e.start.beats)} (bar ${e.start.bar}), ${r3(e.lengthBeats)} beats${e.muted ? ', muted' : ''}`;
const noteKey = (n) => `pitch ${n.pitch} at beat ${r3(n.start.beats)}, ${r3(n.lengthBeats)} beats, velocity ${n.velocity}`;

// Multiset difference: what is in `a` but not in `b`, as labels.
function minus(a, b) {
  const left = new Map();
  for (const k of b) left.set(k, (left.get(k) || 0) + 1);
  const out = [];
  for (const k of a) {
    if (left.get(k)) left.set(k, left.get(k) - 1);
    else out.push(k);
  }
  return out;
}

const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
const byId = (list, id, name) => new Map(list.map((x, i) => [x[id] || `${x[name]}#${i}`, x]));

export function diffSongs(a, b) {
  const changes = [];
  const add = (area, what, detail) => changes.push({ area, what, ...(detail === undefined ? {} : { detail }) });

  // Song-wide
  const tempos = (s) => s.tempo.map((t) => `${t.bpm} bpm @ beat ${t.atBeat}`);
  if (!same(tempos(a), tempos(b))) add('song', 'tempo', { from: tempos(a), to: tempos(b) });
  const sigs = (s) => s.timeSignatures.map((t) => `${t.signature} @ beat ${t.atBeat}`);
  if (!same(sigs(a), sigs(b))) add('song', 'time signature', { from: sigs(a), to: sigs(b) });
  for (const [label, get] of [['marker', (s) => s.markers.map((m) => `${m.name} @ bar ${m.bar}`)], ['section', (s) => s.sections.map((x) => `${x.name} @ ${bar(x)}`)]]) {
    for (const x of minus(get(b), get(a))) add('song', `${label} added`, x);
    for (const x of minus(get(a), get(b))) add('song', `${label} removed`, x);
  }

  // Tracks
  const ta = byId(a.tracks, 'trackId', 'name');
  const tb = byId(b.tracks, 'trackId', 'name');
  for (const [id, t] of tb) if (!ta.has(id)) add('track', 'added', `${t.name} (${t.mediaType || t.type})`);
  for (const [id, t] of ta) if (!tb.has(id)) add('track', 'removed', t.name);
  for (const [id, t2] of tb) {
    const t1 = ta.get(id);
    if (!t1) continue;
    const name = t2.name;
    if (t1.name !== t2.name) add('track', 'renamed', { from: t1.name, to: t2.name });
    const take = (t) => t.layers?.find((l) => l.active)?.name;
    if (take(t1) !== take(t2)) add(name, 'active take', { from: take(t1) ?? null, to: take(t2) ?? null });
    if ((t1.layers?.length || 0) !== (t2.layers?.length || 0)) add(name, 'takes', { from: t1.layers?.length || 0, to: t2.layers?.length || 0 });
    const e1 = t1.events.map(evKey);
    const e2 = t2.events.map(evKey);
    for (const x of minus(e2, e1)) add(name, 'event added', x);
    for (const x of minus(e1, e2)) add(name, 'event removed', x);
    const n1 = t1.events.flatMap((e) => (e.notes || []).map(noteKey));
    const n2 = t2.events.flatMap((e) => (e.notes || []).map(noteKey));
    const nAdd = minus(n2, n1);
    const nDel = minus(n1, n2);
    if (nAdd.length || nDel.length) add(name, 'notes', { added: nAdd, removed: nDel });
  }

  // Mixer
  const ca = byId(a.mixer, 'id', 'label');
  const cb = byId(b.mixer, 'id', 'label');
  for (const [id, c] of cb) if (!ca.has(id)) add('mixer', 'channel added', `${c.label} (${c.kind})`);
  for (const [id, c] of ca) if (!cb.has(id)) add('mixer', 'channel removed', c.label);
  for (const [id, c2] of cb) {
    const c1 = ca.get(id);
    if (!c1) continue;
    const who = c2.label;
    if (c1.label !== c2.label) add('mixer', 'channel renamed', { from: c1.label, to: c2.label });
    for (const f of ['volumeDb', 'pan', 'mute', 'solo', 'automation', 'output']) {
      if (!same(c1[f], c2[f])) add(who, f, { from: c1[f] ?? null, to: c2[f] ?? null });
    }
    const slots = new Set([...c1.inserts.map((i) => i.slot), ...c2.inserts.map((i) => i.slot)]);
    for (const s of [...slots].sort((x, y) => x - y)) {
      const i1 = c1.inserts.find((i) => i.slot === s);
      const i2 = c2.inserts.find((i) => i.slot === s);
      if (!i1) { add(who, 'plug-in added', `${i2.name} (slot ${s})`); continue; }
      if (!i2) { add(who, 'plug-in removed', `${i1.name} (slot ${s})`); continue; }
      if (i1.name !== i2.name) { add(who, 'plug-in replaced', { slot: s, from: i1.name, to: i2.name }); continue; }
      if (!!i1.bypassed !== !!i2.bypassed) add(who, `${i2.name} bypass`, { from: !!i1.bypassed, to: !!i2.bypassed });
      const v1 = i1.settings?.values || {};
      const v2 = i2.settings?.values || {};
      const changed = {};
      for (const k of new Set([...Object.keys(v1), ...Object.keys(v2)])) if (!same(v1[k], v2[k])) changed[k] = { from: v1[k] ?? null, to: v2[k] ?? null };
      if (Object.keys(changed).length) add(who, `${i2.name} settings`, changed);
    }
  }

  // Song notes and channel notes
  if ((a.notes || '') !== (b.notes || '')) add('song', 'notes', { from: a.notes || '', to: b.notes || '' });
  const cn = (s) => new Map((s.channelNotes || []).map((n) => [n.channel, n.text]));
  const na = cn(a);
  const nb = cn(b);
  for (const ch of new Set([...na.keys(), ...nb.keys()])) {
    if (na.get(ch) !== nb.get(ch)) add(ch, 'channel notes', { from: na.get(ch) ?? '', to: nb.get(ch) ?? '' });
  }

  // Automation envelopes (points as stored)
  const env = (s) => new Map((s.automation || []).map((e) => [`${e.channel}/${e.parameter}`, e.points]));
  const ea = env(a);
  const eb = env(b);
  for (const k of new Set([...ea.keys(), ...eb.keys()])) {
    if (!same(ea.get(k), eb.get(k))) add('automation', k, { fromPoints: ea.get(k)?.length || 0, toPoints: eb.get(k)?.length || 0 });
  }

  return changes;
}
