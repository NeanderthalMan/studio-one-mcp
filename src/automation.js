// Writing volume or pan automation the way a person does: the channel goes into
// Write mode, the song plays through the range while the fader follows the
// curve, and the channel goes back to Read.
//
// Seen on Studio One 5.5.2: scripts cannot add envelope points directly (the
// envelope functions exist but no envelope region is reachable), while this was
// checked end to end: saved and read back, the Volume envelope held the ramp.
// It plays the song (audibly) for the length of the range, and Write mode
// replaces whatever automation that parameter had between the two positions.
import { manyToSeconds } from './time.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const parseDb = (text) => {
  if (typeof text !== 'string') return null;
  if (/-\s*(oo|∞|inf)/i.test(text)) return -Infinity;
  // Studio One 5.5.2 shows "-10.5", "0dB", "-oo": the unit only sometimes.
  const m = /^\s*([+-]?\d+(?:\.\d+)?)\s*(?:dB)?\s*$/i.exec(text);
  return m ? Number(m[1]) : null;
};

// A fader table [normalised, dB] from Studio One's own display text, rising.
async function faderTable(call, channel) {
  const table = [];
  for (let i = 0; i <= 40; i++) {
    const v = i / 40;
    const r = await call('setChannel', { channel, field: 'volume', value: v });
    const db = parseDb(r.text);
    if (db !== null) table.push([v, db]);
  }
  if (table.length < 2) throw new Error('could not read the fader in dB');
  return table;
}

// Normalised fader value for a dB value, by linear interpolation in the table.
export function dbToFader(table, db) {
  if (db <= table[0][1]) return table[0][0];
  for (let i = 1; i < table.length; i++) {
    const [v1, d1] = table[i];
    const [v0, d0] = table[i - 1];
    if (db <= d1) return d0 === -Infinity ? v1 : v0 + ((db - d0) / (d1 - d0)) * (v1 - v0);
  }
  return table[table.length - 1][0];
}

// The value at `t` on a curve of [{ t, v }] sorted by t, held flat past the ends.
export function curveAt(curve, t) {
  if (t <= curve[0].t) return curve[0].v;
  for (let i = 1; i < curve.length; i++) {
    if (t <= curve[i].t) {
      const a = curve[i - 1], b = curve[i];
      return b.t === a.t ? b.v : a.v + ((t - a.t) / (b.t - a.t)) * (b.v - a.v);
    }
  }
  return curve[curve.length - 1].v;
}

// points: [{ at, db | value | pan }]: db for volume, value 0..1 (normalised,
// as live_set_channel takes it), pan -1 (left) .. 1 (right).
export async function writeAutomation(call, { channel, parameter = 'volume', points }) {
  if (!['volume', 'pan'].includes(parameter)) throw new Error('parameter must be volume or pan');
  if (!Array.isArray(points) || points.length < 2) throw new Error('points: two or more { at, db | value | pan }');
  const song = await call('song');
  if (song.transport.playing || song.transport.recording) throw new Error('stop playback first');
  const ch = (await call('channels')).find((c) => c.label === channel);
  if (!ch) throw new Error(`no channel named ${channel}`);

  const seconds = await manyToSeconds(call, points.map((p) => p.at));
  let table = null;
  const curve = [];
  for (const [i, p] of points.entries()) {
    let v;
    if (parameter === 'pan') {
      if (typeof p.pan === 'number') v = (Math.max(-1, Math.min(1, p.pan)) + 1) / 2;
      else if (typeof p.value === 'number') v = p.value;
    } else if (typeof p.db === 'number') {
      table ??= await faderTable(call, channel);
      v = dbToFader(table, p.db);
    } else if (typeof p.value === 'number') v = p.value;
    if (typeof v !== 'number' || v < 0 || v > 1) throw new Error(`point ${i + 1} needs ${parameter === 'pan' ? 'pan (-1..1) or value (0..1)' : 'db, or value (0..1)'}`);
    curve.push({ t: seconds[i], v });
  }
  curve.sort((a, b) => a.t - b.t);
  const from = curve[0].t, to = curve[curve.length - 1].t;
  if (to - from <= 0) throw new Error('the points must span some time');
  if (to - from > 600) throw new Error('at most 600 seconds at a time (it plays in real time)');

  const t0 = song.transport;
  const restoreMode = ch.automation && ch.automation !== 'write' ? ch.automation : 'read';
  const writes = [];
  try {
    await call('setChannel', { channel, field: parameter, value: curve[0].v });
    await call('setTransport', { positionSeconds: from, loop: false, precount: false, preroll: false });
    await call('setAutomation', { channel, mode: 'write' });
    await call('transport', { action: 'play' });
    const deadline = Date.now() + (to - from + 10) * 1000;
    for (;;) {
      const pos = (await call('song')).transport.position.seconds;
      if (pos >= to || Date.now() > deadline) break;
      const v = curveAt(curve, pos);
      await call('setChannel', { channel, field: parameter, value: v });
      writes.push([Math.round(pos * 1000) / 1000, Math.round(v * 10000) / 10000]);
      await sleep(20);
    }
  } finally {
    await call('transport', { action: 'stop' }).catch(() => {});
    await call('setAutomation', { channel, mode: restoreMode === 'off' ? 'read' : restoreMode }).catch(() => {});
    await call('setTransport', { positionSeconds: t0.position.seconds, loop: t0.loop, precount: t0.precount, preroll: t0.preroll }).catch(() => {});
  }
  return {
    channel,
    parameter,
    from,
    to,
    values: writes.length,
    first: writes[0] ?? null,
    last: writes[writes.length - 1] ?? null,
    mode: 'read',
    note: 'Written by playing the range in Write mode; the channel is left in Read so it plays back. Studio One thins the points. live_undo should remove the pass; check by listening or with song_read after saving.',
  };
}
