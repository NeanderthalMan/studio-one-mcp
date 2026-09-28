// Read a Studio One .song file (a zip of XML) into a plain object.
//
// Units, verified against songs saved by Studio One 5.5.2:
//  - Event/marker positions with timeFormat="2" are in quarter-note beats.
//    (An audio event's `length` is exactly frameCount / sampleRate * bpm / 60.)
//  - TempoMapSegment `tempo` is seconds per quarter note (0.5 = 120 bpm).
//  - Mixer `gain` is linear amplitude; `pan` is 0..1 with 0.5 centre.
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import { parseXml, kids, child, byXid, walk, num } from './xml.js';
import { decodeUbjson } from './ubjson.js';

const round = (n, d = 3) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : n);

export function openSongArchive(path) {
  const entries = unzipSync(readFileSync(path));
  const text = (name) => (entries[name] ? strFromU8(entries[name]) : null);
  const raw = (name) => entries[name] || null;
  const xml = (name) => {
    const t = text(name);
    return t ? parseXml(t) : null;
  };
  return { names: Object.keys(entries), text, raw, xml };
}

// ---- time ---------------------------------------------------------------

export function buildTimeline(songRoot) {
  const root = byXid(songRoot, 'Root') || child(songRoot, 'Attributes');
  const ctx = byXid(root, 'timeContext');
  const tempoSegs = kids(byXid(ctx, 'tempoMap'), 'TempoMapSegment')
    .map((s) => ({ start: num(s.attrs.start), secPerBeat: num(s.attrs.tempo, 0.5), curve: num(s.attrs.curveType) }))
    .sort((a, b) => a.start - b.start);
  if (!tempoSegs.length) tempoSegs.push({ start: 0, secPerBeat: 0.5, curve: 0 });
  const sigSegs = kids(byXid(ctx, 'timeSignatureMap'), 'TimeSignatureMapSegment')
    .map((s) => ({ start: num(s.attrs.start), num: num(s.attrs.numerator, 4), den: num(s.attrs.denominator, 4) }))
    .sort((a, b) => a.start - b.start);
  if (!sigSegs.length) sigSegs.push({ start: 0, num: 4, den: 4 });
  const keys = kids(byXid(ctx, 'keySignatureMap'))
    .map((k) => ({ start: num(k.attrs.start), root: num(k.attrs.root), scale: k.attrs.scale || '' }));

  // Tempo ramps (curveType != 0) are treated as steps; exact for the common constant case.
  const beatsToSeconds = (beats) => {
    let secs = 0;
    for (let i = 0; i < tempoSegs.length; i++) {
      const seg = tempoSegs[i];
      const end = i + 1 < tempoSegs.length ? tempoSegs[i + 1].start : Infinity;
      if (beats <= seg.start) break;
      secs += (Math.min(beats, end) - seg.start) * seg.secPerBeat;
    }
    return secs;
  };

  const secondsToBeats = (secs) => {
    let beats = 0;
    let left = secs;
    for (let i = 0; i < tempoSegs.length && left > 0; i++) {
      const seg = tempoSegs[i];
      const end = i + 1 < tempoSegs.length ? tempoSegs[i + 1].start : Infinity;
      const segSecs = (end - seg.start) * seg.secPerBeat;
      const take = Math.min(left, segSecs);
      beats = seg.start + take / seg.secPerBeat;
      left -= take;
    }
    return beats;
  };

  // Bar/beat, 1-based like Studio One's ruler. Beats here are in units of the
  // time signature's denominator (3/8 counts eighths).
  const beatsToBar = (beats) => {
    let bar = 1;
    for (let i = 0; i < sigSegs.length; i++) {
      const seg = sigSegs[i];
      const barLen = (seg.num * 4) / seg.den;
      const end = i + 1 < sigSegs.length ? sigSegs[i + 1].start : Infinity;
      if (beats < end) {
        const into = beats - seg.start;
        const whole = Math.floor(into / barLen + 1e-9);
        const beatInBar = ((into - whole * barLen) * seg.den) / 4;
        return { bar: bar + whole, beat: round(beatInBar + 1, 3) };
      }
      bar += Math.round((end - seg.start) / barLen);
    }
    return { bar, beat: 1 };
  };

  const at = (beats) => {
    const b = beatsToBar(beats);
    return { beats: round(beats), bar: b.bar, beat: b.beat, seconds: round(beatsToSeconds(beats)) };
  };

  return {
    tempo: tempoSegs.map((s) => ({ atBeat: s.start, bpm: round(60 / s.secPerBeat, 2), ramp: s.curve !== 0 })),
    timeSignatures: sigSegs.map((s) => ({ atBeat: s.start, signature: `${s.num}/${s.den}` })),
    keys,
    lengthSeconds: num(root && root.attrs.length, null),
    at,
    atSeconds: (secs) => at(secondsToBeats(secs)),
    span: (start, length) => ({
      start: at(start),
      lengthBeats: round(length),
      lengthSeconds: round(beatsToSeconds(start + length) - beatsToSeconds(start)),
    }),
  };
}

// ---- media pool -------------------------------------------------------------

function fileUrlToPath(url) {
  if (!url) return null;
  try {
    return url.startsWith('file:') ? fileURLToPath(url) : url;
  } catch {
    return url;
  }
}

export function readMediaPool(poolRoot) {
  const clips = new Map();
  for (const n of walk(poolRoot)) {
    if (!n.attrs.mediaID) continue;
    const fmt = byXid(n, 'format');
    const frames = num(fmt && fmt.attrs.frameCount, null);
    const rate = num(fmt && fmt.attrs.sampleRate, null);
    const rec = byXid(n, 'recordTime');
    clips.set(n.attrs.mediaID, {
      id: n.attrs.mediaID,
      kind: n.tag,
      file: fileUrlToPath(byXid(n, 'path')?.attrs.url),
      // Instrument parts: "media:///Performances/<track>/<name>.musicx", inside the .song.
      data: byXid(n, 'dataPath')?.attrs.url || undefined,
      durationSeconds: frames && rate ? round(frames / rate) : null,
      sampleRate: rate,
      channels: num(fmt && fmt.attrs.numChannels, null),
      bitDepth: num(fmt && fmt.attrs.bitDepth, null),
      recordedAt: rec ? rec.attrs.time : null,
      useCount: num(n.attrs.useCount, 1),
    });
  }
  return clips;
}

// ---- tracks -----------------------------------------------------------------

const EVENT_TAGS = /Event$|^MusicPart$|^AudioPart$|^Part$/;

function readEvent(ev, t, media) {
  const start = num(ev.attrs.start);
  const length = num(ev.attrs.length);
  const out = { type: ev.tag, name: ev.attrs.name || '', ...t.span(start, length) };
  if (ev.attrs.clipID) {
    const clip = media.get(ev.attrs.clipID);
    out.file = clip ? clip.file : null;
    out.clipId = ev.attrs.clipID;
    if (ev.attrs.offset) out.clipOffsetBeats = round(num(ev.attrs.offset));
  }
  if (ev.attrs.mute === '1') out.muted = true;
  if (ev.attrs.color) out.color = ev.attrs.color;
  // Instrument part: its clip's performance holds the notes in clip beats; the
  // part shows clip beats [offset, offset + length) at song beat `start`.
  const perf = ev.attrs.clipID ? media.get(ev.attrs.clipID)?.performance : null;
  if (perf && Array.isArray(perf.events)) {
    const offset = num(ev.attrs.offset);
    out.notes = perf.events
      .filter((n) => typeof n.pitch === 'number' && n.start >= offset && n.start < offset + length)
      .map((n) => ({ pitch: n.pitch, velocity: Math.round(num(n.velocity) * 127), ...t.span(start + n.start - offset, num(n.length)) }));
    return out;
  }
  // Note/controller events and anything else we don't model: pass numeric attrs through.
  const notes = [];
  for (const n of walk(ev)) {
    if (n !== ev && /Note/.test(n.tag)) {
      notes.push({
        pitch: num(n.attrs.pitch, null),
        velocity: num(n.attrs.velocity, null),
        ...t.span(start + num(n.attrs.start), num(n.attrs.length)),
      });
    }
  }
  if (notes.length) out.notes = notes;
  return out;
}

function readTrack(tr, t, media) {
  const base = {
    type: tr.tag,
    name: tr.attrs.name || '',
    mediaType: tr.attrs.mediaType || null,
    color: tr.attrs.color || null,
    trackId: tr.attrs.trackID || null,
    channelId: byXid(tr, 'channelID')?.attrs.uid || null,
    format: byXid(tr, 'trackFormat')?.attrs.type || null,
  };
  if (byXid(tr, 'attributes')?.attrs.hidden === '1') base.hidden = true;

  const layerList = byXid(tr, 'Layers');
  if (layerList) {
    const active = num(tr.attrs.activeLayer, 0);
    base.layers = kids(layerList).map((layer, i) => {
      const id = num(layer.attrs.id, i);
      return {
        id,
        name: layer.attrs.layerName || '',
        active: id === active,
        events: kids(byXid(layer, 'Events')).map((ev) => readEvent(ev, t, media)),
      };
    });
    base.events = base.layers.find((l) => l.active)?.events || [];
  } else {
    // Marker/arranger/chord tracks and single-lane tracks keep events directly.
    const evs = [];
    for (const n of tr.children) {
      if (EVENT_TAGS.test(n.tag)) evs.push(n);
      else if (n.tag === 'List') evs.push(...kids(n).filter((e) => EVENT_TAGS.test(e.tag)));
    }
    base.events = evs.map((ev) => readEvent(ev, t, media));
  }
  return base;
}

// ---- mixer ------------------------------------------------------------------

const toDb = (g) => (g > 0 ? round(20 * Math.log10(g), 2) : -Infinity);

const AUTOMATION_MODES = ['off', 'read', 'touch', 'latch', 'write'];

// Nested JSON sections -> dotted names ("comp.ratio"), as the live plug-in names them.
function flattenValues(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const name = prefix ? `${prefix}.${k}` : k;
    if (k.startsWith('__')) continue; // internal (__classid of a swappable section)
    if (v && typeof v === 'object' && !Array.isArray(v)) flattenValues(v, name, out);
    else out[name] = typeof v === 'number' ? round(v, 4) : v;
  }
  return out;
}

// An insert's saved state, from the preset file the song keeps for it
// (<String x:id="presetPath">). Values are in the preset's own units (dB, Hz,
// seconds), not the live raw values. Third-party formats are only named.
export function readInsertSettings(zip, presetPath) {
  if (!zip || !presetPath) return null;
  const format = presetPath.split('.').pop();
  const text = zip.text(presetPath);
  if (text === null) return { format, missing: true };
  const body = text.replace(/^﻿/, '').trimStart();
  if (body.startsWith('{')) {
    try {
      return { format, values: flattenValues(JSON.parse(body).parameters) };
    } catch {
      return { format };
    }
  }
  if (body.startsWith('<')) {
    const values = {};
    for (const n of walk(parseXml(body))) {
      if (n.attrs['x:id'] !== 'ParameterData') continue;
      for (const [k, v] of Object.entries(n.attrs)) if (k !== 'x:id') values[k] = num(v, v);
    }
    return Object.keys(values).length ? { format, values } : { format };
  }
  return { format }; // binary (VST / AU state)
}

// Plug-in slots are the rack's un-named children (<Attributes name="FX01">);
// siblings with an x:id (Presets, Combinator) are rack state, not plug-ins.
function readInserts(rack, postFader = false, zip = null) {
  return kids(rack, 'Attributes')
    .filter((s) => !s.attrs['x:id'])
    .map((slot, i) => {
      const cls = byXid(byXid(slot, 'ghostData'), 'classInfo');
      const settings = readInsertSettings(zip, byXid(slot, 'presetPath')?.attrs.text);
      return {
        slot: i,
        postFader: postFader || undefined,
        name: byXid(slot, 'deviceData')?.attrs.name || cls?.attrs.name || slot.attrs.name || '',
        category: cls?.attrs.subCategory || cls?.attrs.category || null,
        bypassed: slot.attrs.bypass === '1' || undefined,
        ...(settings ? { settings } : {}),
      };
    });
}

// Automation envelopes: Envelopes/<channel>/<parameter>.envelopex (UBJSON
// { bipolar, events }). Only envelopes with points are listed; points are passed
// through as stored.
export function readEnvelopes(zip) {
  const out = [];
  for (const name of zip.names.filter((n) => /^Envelopes\/.+\.envelopex$/.test(n)).sort()) {
    let env;
    try {
      env = decodeUbjson(zip.raw(name));
    } catch {
      continue;
    }
    const points = Array.isArray(env?.events) ? env.events : [];
    if (!points.length) continue;
    const [, channel, parameter] = /^Envelopes\/(.+)\/([^/]+)\.envelopex$/.exec(name);
    out.push({ channel, parameter, bipolar: !!env.bipolar, points });
  }
  return out;
}

export function readMixer(mixerRoot, zip = null) {
  if (!mixerRoot) return [];
  const channels = [];
  for (const group of [...walk(mixerRoot)].filter((n) => n.tag === 'ChannelGroup')) {
    for (const ch of kids(group).filter((c) => /Channel$/.test(c.tag))) {
      const dest = byXid(ch, 'destination');
      const sends = kids(byXid(ch, 'Sends'), 'Attributes').filter((s) => !s.attrs['x:id']);
      channels.push({
        group: group.attrs.name,
        kind: ch.tag.replace(/Channel$/, ''),
        label: ch.attrs.label || ch.attrs.name || '',
        id: byXid(ch, 'uniqueID')?.attrs.uid || null,
        volumeDb: toDb(num(ch.attrs.gain, 1)),
        pan: round((num(ch.attrs.pan, 0.5) - 0.5) * 2, 2), // -1 left .. +1 right
        mute: ch.attrs.mute === '1',
        solo: ch.attrs.solo === '1',
        format: byXid(ch, 'speakerType')?.attrs.type || null,
        output: dest ? dest.attrs.friendlyName || null : null,
        inserts: [...readInserts(byXid(ch, 'Inserts'), false, zip), ...readInserts(byXid(ch, 'PostFaderInserts'), true, zip)],
        automation: AUTOMATION_MODES[num(byXid(ch, 'Automation')?.attrs.mode, 0)] || null,
        sends: sends.length,
        recordArmed: byXid(byXid(byXid(ch, 'RecordUnit'), 'recordPort'), 'data')?.attrs.recordArmed === '1' || undefined,
      });
    }
  }
  return channels;
}

// ---- top level ----------------------------------------------------------------

export function readSong(path) {
  const zip = openSongArchive(path);
  const song = zip.xml('Song/song.xml');
  if (!song) throw new Error(`${path}: no Song/song.xml — not a Studio One song`);
  const t = buildTimeline(song);
  const media = readMediaPool(zip.xml('Song/mediapool.xml'));
  for (const clip of media.values()) {
    const entry = clip.data && clip.data.startsWith('media:///') ? decodeURI(clip.data.slice('media:///'.length)) : null;
    const bytes = entry ? zip.raw(entry) : null;
    if (!bytes) continue;
    try {
      clip.performance = decodeUbjson(bytes);
    } catch {
      clip.performance = null;
    }
  }
  const meta = {};
  for (const a of kids(zip.xml('metainfo.xml'), 'Attribute')) meta[a.attrs.id] = a.attrs.value;
  // Transport positions are stored in seconds, unlike events (beats).
  const transport = zip.xml('Devices/transportdevice.xml');

  const root = byXid(song, 'Root') || child(song, 'Attributes');
  const tracks = kids(byXid(root, 'Tracks')).map((tr) => readTrack(tr, t, media));
  const markerTrack = tracks.find((tr) => tr.type === 'MarkerTrack');
  const arranger = tracks.find((tr) => tr.type === 'ArrangerTrack');
  const mixer = readMixer(zip.xml('Devices/audiomixer.xml'), zip);
  const byChannel = new Map(mixer.map((c) => [c.id, c]));

  return {
    file: path,
    title: meta['Document:Title'] || basename(path, '.song'),
    artist: meta['Media:Artist'] || null,
    generator: meta['Document:Generator'] || null,
    modified: statSync(path).mtime.toISOString(),
    sampleRate: num(meta['Media:SampleRate'], null),
    bitDepth: num(meta['Media:BitDepth'], null),
    lengthSeconds: num(meta['Media:Length'], t.lengthSeconds),
    tempo: t.tempo,
    timeSignatures: t.timeSignatures,
    key: meta['Media:KeySignature'] && meta['Media:KeySignature'] !== '-' ? meta['Media:KeySignature'] : null,
    transport: transport
      ? {
          position: t.atSeconds(num(transport.attrs.position)),
          loop: { start: t.atSeconds(num(transport.attrs.loopStart)), end: t.atSeconds(num(transport.attrs.loopEnd)), active: transport.attrs.loopActive === '1' },
        }
      : null,
    markers: (markerTrack?.events || []).map((e) => ({ name: e.name, ...e.start })),
    sections: (arranger?.events || []).map((e) => ({ name: e.name, start: e.start, lengthBeats: e.lengthBeats })),
    tracks: tracks
      .filter((tr) => tr !== markerTrack && tr !== arranger)
      .map((tr) => {
        const ch = byChannel.get(tr.channelId);
        return ch ? { ...tr, mixer: { volumeDb: ch.volumeDb, pan: ch.pan, mute: ch.mute, solo: ch.solo, output: ch.output, automation: ch.automation, inserts: ch.inserts } } : tr;
      }),
    mixer,
    automation: readEnvelopes(zip),
    media: [...media.values()].map(({ performance, ...clip }) => clip),
    notes: zip.text('notes.txt') || '',
  };
}

// Compact view for an LLM: one line per track, no per-event arrays.
export function summarizeSong(s) {
  return {
    file: s.file,
    title: s.title,
    modified: s.modified,
    generator: s.generator,
    tempo: s.tempo.map((x) => x.bpm),
    timeSignatures: s.timeSignatures.map((x) => x.signature),
    key: s.key,
    lengthSeconds: s.lengthSeconds,
    markers: s.markers.map((m) => `${m.name} @ bar ${m.bar}`),
    sections: s.sections.map((x) => `${x.name} @ bar ${x.start.bar}`),
    tracks: s.tracks.map((tr) => ({
      name: tr.name,
      type: tr.mediaType || tr.type,
      events: tr.events.length,
      notes: tr.events.some((e) => e.notes) ? tr.events.reduce((n, e) => n + (e.notes?.length || 0), 0) : undefined,
      automation: tr.mixer?.automation && tr.mixer.automation !== 'off' ? tr.mixer.automation : undefined,
      takes: tr.layers ? tr.layers.length : undefined,
      activeTake: tr.layers ? tr.layers.find((l) => l.active)?.name : undefined,
      volumeDb: tr.mixer?.volumeDb,
      mute: tr.mixer?.mute || undefined,
      solo: tr.mixer?.solo || undefined,
      inserts: tr.mixer?.inserts.length ? tr.mixer.inserts.map((i) => i.name) : undefined,
    })),
    buses: s.mixer.filter((c) => !['AudioTrack', 'AudioInput'].includes(c.kind)).map((c) => `${c.kind}: ${c.label}`),
    mediaFiles: s.media.length,
    automation: s.automation.length ? s.automation.map((e) => `${e.channel}/${e.parameter}: ${e.points.length} points`) : undefined,
  };
}
