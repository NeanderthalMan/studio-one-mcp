#!/usr/bin/env node
// studio-one-mcp: MCP server for PreSonus Studio One.
//
// Two kinds of tools:
//  - song_*  read .song files from disk. Always available; reflect the last save.
//  - live_*  talk to a running Studio One through the MCP Bridge device.
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readSong, summarizeSong } from './song.js';
import { fileURLToPath } from 'node:url';
import { listSongs, resolveSong, songFolder } from './library.js';
import { bridgeStatus, call } from './bridge.js';
import { midiPort } from './midi.js';
import { pluginParamNames } from './plugins.js';
import { arranger, listMacros, runMacro } from './arranger.js';
import { tempo } from './tempo.js';
import { trackEdit, addBus, trackTask, addInstrumentTrack, addPlugin, addFxSend } from './tracks.js';
import { liveEvents } from './events.js';
import { timeSignature } from './signatures.js';
import { writeAutomation } from './automation.js';
import { toSeconds } from './time.js';
import { recordSetup } from './record.js';
import { snapshot } from './snapshots.js';
import { mixSnapshot } from './mixsnap.js';
import { bounce } from './bounce.js';
import { diffSongs } from './diff.js';
import { gridBeats } from './grid.js';
import { version } from './version.js';

const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 1) }] });
const fail = (message) => ({ content: [{ type: 'text', text: message }], isError: true });
const guard = (fn) => async (args) => {
  try {
    return json(await fn(args));
  } catch (e) {
    return fail(String(e.message || e));
  }
};

// ---- server ---------------------------------------------------------------------

const server = new McpServer({ name: 'studio-one-mcp', version });

server.tool(
  'song_list',
  'List Studio One songs on disk (newest first), from ~/Documents/Studio One/Songs or $STUDIO_ONE_SONGS.',
  { query: z.string().optional().describe('Case-insensitive substring of the song title'), limit: z.number().int().optional() },
  guard((a) => listSongs(a)),
);

server.tool(
  'song_read',
  "Read a Studio One song from its .song file: tempo, time signature, markers, arranger sections, tracks with takes/clips (bar, beat and seconds) and instrument notes, mixer channels with volume/pan/mute/solo, automation mode and plug-in inserts (with each plug-in's saved settings in its own units, for PreSonus plug-ins), automation envelopes that have points, the song notes and channel notes, and media files. Reflects the last save, not unsaved edits. Notes, settings and envelope points are in detail=full.",
  {
    song: z.string().describe('Song title, part of one (newest match wins), or absolute path to a .song file'),
    detail: z.enum(['summary', 'full']).optional().describe('summary (default): one line per track. full: every take and clip.'),
    track: z.string().optional().describe('With detail=full, only include tracks whose name contains this'),
  },
  guard(({ song, detail = 'summary', track }) => {
    const { path, otherMatches } = resolveSong(song);
    const s = readSong(path);
    const out = detail === 'summary' ? summarizeSong(s) : s;
    if (detail !== 'summary' && track) out.tracks = out.tracks.filter((t) => t.name.toLowerCase().includes(track.toLowerCase()));
    if (otherMatches.length) out.otherMatches = otherMatches; // picked the newest; these also matched
    return out;
  }),
);

server.tool(
  'song_history',
  "List a song's autosaves and backups in its History folder (newest first). Each path can be passed to song_read to compare versions.",
  { song: z.string().describe('Song title or .song path') },
  guard(({ song }) => {
    const history = join(songFolder(resolveSong(song).path), 'History');
    if (!existsSync(history)) return [];
    return readdirSync(history)
      .filter((f) => f.endsWith('.song'))
      .map((f) => ({ file: join(history, f), modified: statSync(join(history, f)).mtime.toISOString() }))
      .sort((a, b) => b.modified.localeCompare(a.modified));
  }),
);

server.tool(
  'song_diff',
  "What changed between two saves of a song: tempo, meter, markers, sections, tracks (added, removed, renamed, active take, events, notes), mixer (level, pan, mute, solo, automation mode, output, plug-ins and their saved settings) and automation envelopes. Compares `song` with `against` (default: the newest autosave in the song's History folder), older to newer by file time, so by default it answers \"what have I changed since I saved?\" (or, if the save is newer, since the last autosave). Both take a title or a .song path; paths from song_history work.",
  { song: z.string(), against: z.string().optional() },
  guard(({ song, against }) => {
    const main = resolveSong(song).path;
    let other;
    if (against) other = resolveSong(against).path;
    else {
      const history = join(songFolder(main), 'History');
      const saves = existsSync(history)
        ? readdirSync(history).filter((f) => f.endsWith('.song')).map((f) => join(history, f)).filter((p) => p !== main).sort((x, y) => statSync(y).mtimeMs - statSync(x).mtimeMs)
        : [];
      if (!saves.length) throw new Error(`no autosaves to compare ${song} against; pass against`);
      other = saves[0];
    }
    const [from, to] = statSync(other).mtimeMs <= statSync(main).mtimeMs ? [other, main] : [main, other];
    const changes = diffSongs(readSong(from), readSong(to));
    return { from, to, changes: changes.length, diff: changes };
  }),
);

server.tool(
  'live_status',
  'Is a running Studio One reachable through the MCP Bridge device? Explains how to fix it if not.',
  {},
  guard(async () => {
    const s = bridgeStatus();
    if (!s.loaded) return { connected: false, ...s };
    try {
      const ping = await call('ping', {}, { timeoutMs: 2500 });
      return { connected: true, midiPort: midiPort(), ping, ...s };
    } catch (e) {
      return { connected: false, error: e.message, ...s };
    }
  }),
);

server.tool(
  'live_channels',
  'List the mixer channels of the song open in Studio One right now, with live volume, pan, mute, solo, record-arm, input monitoring, automation mode, and routing (input and output names; read-only).',
  {},
  guard(() => call('channels')),
);

server.tool(
  'live_set_channel',
  'Change one mixer channel in the running Studio One. Values are Studio One normalised values (volume/pan 0..1, pan 0.5 = centre; mute/solo/recordArmed/monitor 0 or 1). Returns before/after.',
  {
    channel: z.string().describe('Exact channel label as shown in the console'),
    field: z.enum(['volume', 'pan', 'mute', 'solo', 'recordArmed', 'monitor']),
    value: z.number(),
  },
  guard((a) => call('setChannel', a)),
);

server.tool(
  'live_set_automation',
  "Set a mixer channel's automation mode in the running Studio One: off, read, touch, latch or write (live_channels shows each channel's mode). Touch, latch and write record fader and plug-in moves as automation while the song plays. Returns before/after.",
  { channel: z.string(), mode: z.enum(['off', 'read', 'touch', 'latch', 'write']) },
  guard((a) => call('setAutomation', a)),
);

server.tool(
  'live_song',
  'The song open in Studio One right now: title, transport (playing, recording, loop, position, tempo, loop range, precount, preroll), track count and selected tracks. Unlike song_read this includes unsaved changes.',
  {},
  guard(async () => {
    const song = await call('song');
    return { ...song, file: song.fileUrl ? fileURLToPath(song.fileUrl) : null };
  }),
);

server.tool(
  'live_tracks',
  'Tracks of the song open in Studio One right now, with media type, colour, mixer channel, number of takes, selection, and (by default) their events: name, start/end/length in seconds, muted.',
  {
    name: z.string().optional().describe('Only tracks whose name contains this'),
    events: z.boolean().optional().describe('Include events (default true)'),
    max_events: z.number().int().optional().describe('Per track (default 50)'),
  },
  guard(({ name, events, max_events }) => call('tracks', { name, events, maxEvents: max_events })),
);

// Studio One's default note names: middle C (MIDI 60) is C3.
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (p) => `${NOTE_NAMES[p % 12]}${Math.floor(p / 12) - 2}`;

server.tool(
  'live_notes',
  "Notes in an instrument track's parts in the running Studio One, unsaved edits included: pitch (MIDI number and name, middle C = C3 as Studio One shows it by default), velocity 0-127, start/end/length in seconds, and start in quarter-note beats. Read-only.",
  { track: z.string().describe('Exact track name'), max_notes: z.number().int().optional().describe('Default 500') },
  guard(async ({ track, max_notes }) => {
    const r = await call('notes', { track, maxNotes: max_notes });
    for (const p of r.parts) for (const n of p.notes) if (typeof n.pitch === 'number') n.note = noteName(n.pitch);
    return r;
  }),
);

const NOTE_FILTER = z
  .object({
    pitch: z.number().int().optional(),
    pitches: z.array(z.number().int()).optional(),
    from: z.number().optional().describe('Start beat, inclusive'),
    to: z.number().optional().describe('Start beat, exclusive'),
  })
  .optional()
  .describe('Which notes (default: all). Beats as live_notes reports them.');

server.tool(
  'live_edit_notes',
  "Edit the notes of an instrument track's parts in the running Studio One, through the MCP Edit task (installed with the device). Operations run in order: transpose {semitones}, velocity {set 1-127 | add}, move {beats}, length {set beats | scale}, quantize {grid like 1/16, 1/8T (triplet) or 1/8. (dotted), strength 0-1; note starts only, Studio One's own quantize setting is left alone}, delete (needs a filter), add {notes: [{pitch, beat, length, velocity}]}. Each can take a filter (pitch, pitches, from/to beats). Beats are the ones live_notes reports. Returns what each operation touched and the notes afterwards. One live_undo per operation, usually; check with live_notes.",
  {
    track: z.string(),
    ops: z.array(
      z.object({
        op: z.enum(['transpose', 'velocity', 'move', 'length', 'quantize', 'delete', 'add']),
        grid: z.union([z.string(), z.number()]).optional().describe('For quantize: "1/16", "1/8T" (triplet), "1/8." (dotted), or beats'),
        strength: z.number().optional().describe('For quantize: 0..1 (default 1)'),
        filter: NOTE_FILTER,
        semitones: z.number().int().optional(),
        set: z.number().optional(),
        add: z.number().optional(),
        beats: z.number().optional(),
        scale: z.number().optional(),
        notes: z.array(z.object({ pitch: z.number().int(), beat: z.number(), length: z.number(), velocity: z.number().int().optional() })).optional(),
      }),
    ),
  },
  guard(async ({ track, ops }) => {
    const r = await call('editNotes', { track, ops: ops.map((o) => (o.op === 'quantize' ? { ...o, grid: gridBeats(o.grid) } : o)) });
    for (const p of r.parts || []) for (const n of p.notes) if (typeof n.pitch === 'number') n.note = noteName(n.pitch);
    return r;
  }),
);

server.tool(
  'live_select_track',
  'Select a track by exact name in the running Studio One, so that selection-based commands (live_command) act on it. Replaces the selection unless exclusive is false.',
  { name: z.string(), exclusive: z.boolean().optional() },
  guard((a) => call('selectTrack', a)),
);

server.tool(
  'live_transport',
  'Press a transport button in the running Studio One and return the resulting transport state.',
  {
    action: z.enum(['play', 'stop', 'record', 'togglePlay', 'returnToZero', 'rewind', 'forward', 'loopStart', 'loopEnd', 'toggleLoop', 'toggleClick', 'togglePrecount', 'togglePreroll', 'locateSelection']),
  },
  guard((a) => call('transport', a)),
);

server.tool(
  'live_set_transport',
  'Set transport values in the running Studio One: tempo (bpm), playhead position (seconds), loop / precount / preroll on or off. Returns the resulting transport state.',
  {
    tempo: z.number().optional(),
    position_seconds: z.number().optional(),
    position_bars: z.string().optional().describe('Bar position like "9.1.1.0" (bar.beat.sixteenth.tick); alternative to position_seconds'),
    loop: z.boolean().optional(),
    precount: z.boolean().optional(),
    preroll: z.boolean().optional(),
  },
  guard(({ position_seconds, position_bars, ...a }) => call('setTransport', { ...a, positionSeconds: position_seconds, positionBars: position_bars })),
);

// Marker names, live from the marker track (MCP Track Edit task); if the task is
// not there, from the last save by position.
async function markerNames() {
  try {
    return (await trackTask(call, { op: 'markers' })).markers;
  } catch {
    try {
      const { fileUrl } = await call('song');
      return fileUrl && existsSync(fileURLToPath(fileUrl)) ? readSong(fileURLToPath(fileUrl)).markers : [];
    } catch {
      return [];
    }
  }
}

async function liveMarkers(result) {
  const names = await markerNames();
  return {
    ...result,
    markers: result.markers.map((m) => {
      const hit = names.find((x) => Math.abs(x.seconds - m.seconds) < 0.01);
      return { ...m, name: hit ? hit.name : null };
    }),
  };
}

server.tool(
  'live_markers',
  'Markers of the song open in Studio One right now: number, position (seconds and bar display) and name. Briefly moves the playhead to read them and puts it back; refuses while playing. Only markers 1-20 are visible.',
  {},
  guard(async () => liveMarkers(await call('markers'))),
);

server.tool(
  'live_add_marker',
  'Add a marker in the running Studio One at a position (seconds or bars; default: the playhead), optionally named. The playhead is left where it was.',
  { seconds: z.number().optional(), at: z.union([z.number(), z.string()]).optional().describe('Seconds or bars like "9.1.1.0" (instead of seconds)'), name: z.string().optional() },
  guard(async ({ seconds, at, name }) => {
    const where = at !== undefined ? await toSeconds(call, at) : seconds;
    if (!name) return liveMarkers(await call('addMarker', { seconds: where }));
    // Marker/Insert Named takes its name as an argument (no dialog when given).
    const { transport } = await call('song');
    try {
      if (where !== undefined) await call('setTransport', { positionSeconds: where });
      const r = await call('command', { category: 'Marker', name: 'Insert Named', args: ['Name', name] });
      if (!r.executed) throw new Error('Marker/Insert Named did not run');
    } finally {
      await call('setTransport', { positionSeconds: transport.position.seconds });
    }
    return liveMarkers({ added: true, seconds: where ?? transport.position.seconds, name, markers: (await call('markers')).markers });
  }),
);

server.tool(
  'live_rename_marker',
  'Rename a marker in the running Studio One, by number (as live_markers numbers them) or by its current name. One live_undo reverts it.',
  { marker: z.union([z.number().int(), z.string()]), name: z.string() },
  guard(async ({ marker, name }) => {
    const r = await trackTask(call, { op: 'renameMarker', marker, name });
    return { before: r.before, name, markers: await markerNames() };
  }),
);

server.tool(
  'live_delete_marker',
  'Delete a marker in the running Studio One, by number (from live_markers) or by exact position in seconds.',
  { number: z.number().int().optional(), seconds: z.number().optional() },
  guard(async (a) => liveMarkers(await call('deleteMarker', a))),
);

server.tool(
  'live_select_events',
  'Select all events on the named track(s), or on every track, or clear the event selection. Then use live_command for selection-based edits, e.g. Event/Mute Events, Event/Unmute Events, Event/Toggle Mute, Edit/Split at Cursor, Event/Quantize, Event/Transpose Events Up, Track/Activate Next Layer (switch takes), Edit/Undo.',
  {
    track: z.string().optional(),
    tracks: z.array(z.string()).optional(),
    all: z.boolean().optional(),
    none: z.boolean().optional().describe('Deselect all events'),
  },
  guard((a) => call('selectEvents', a)),
);

const TIME = z.union([z.number(), z.string()]).describe('Seconds (number) or a bar position string like "9.1.1.0"');

server.tool(
  'live_set_loop',
  'Set the loop range in the running Studio One (start/end in seconds or as bars like "9.1.1.0"), and optionally turn looping on or off. Returns the transport state.',
  { start: TIME.optional(), end: TIME.optional(), enable: z.boolean().optional() },
  guard((a) => call('setLoop', a)),
);

server.tool(
  'live_takes',
  "A track's takes (layers) in the running Studio One: list them (with their names from the last save), switch to the next/previous take or to take N (goto, 1-based), add an empty take or duplicate the active one (each one live_undo), unpack all takes to separate tracks, or recall a retrospective recording (instrument tracks: what you played while not recording). Returns the number of takes and the names of the clips now playing. Takes do not wrap: next on the last take (or previous on the first) changes nothing.",
  {
    track: z.string(),
    action: z.enum(['list', 'next', 'previous', 'goto', 'add', 'duplicate', 'unpack', 'retrospective']).optional(),
    take: z.number().int().optional().describe('For goto: 1-based take number'),
  },
  guard(async (a) => {
    const r = await call('takes', a);
    if ((a.action || 'list') !== 'list') return r;
    try {
      const { fileUrl } = await call('song');
      const saved = fileUrl && existsSync(fileURLToPath(fileUrl)) ? readSong(fileURLToPath(fileUrl)).tracks.find((t) => t.name === a.track) : null;
      if (saved?.layers) r.saved = { takes: saved.layers.map((l) => l.name), active: saved.layers.findIndex((l) => l.active) + 1 };
    } catch {
      // names are a bonus; the live answer stands without them
    }
    return r;
  }),
);

server.tool(
  'live_save',
  'Save the song open in Studio One (File/Save), or save it as a new version (File/Save New Version) to keep the old one.',
  { new_version: z.boolean().optional() },
  guard(({ new_version }) => call('save', { newVersion: !!new_version })),
);

server.tool(
  'live_undo',
  "Undo the last edit(s) in the running Studio One; returns how many ran (a refused undo counts 0). Check the result rather than counting steps: mixer parameter changes (volume, monitor, plug-in parameters, automation mode...) become undo steps that are recorded late and merge, so an undo can land on one of those instead of the edit you just made. Undo again until your edit is gone.",
  { steps: z.number().int().optional() },
  guard((a) => call('undo', a)),
);

server.tool(
  'live_redo',
  'Redo edit(s) in the running Studio One.',
  { steps: z.number().int().optional() },
  guard((a) => call('redo', a)),
);

server.tool(
  'live_track_state',
  "Toggle a track's arm / monitor / mute / solo, hide it, or duplicate it, by track name; showAll unhides every track. Returns the track's mixer channel afterwards. The track selection is restored. Mute is not on Studio One's undo stack: revert it by toggling again, since live_undo would undo the edit before it.",
  { track: z.string().optional(), action: z.enum(['arm', 'monitor', 'mute', 'solo', 'hide', 'duplicate', 'showAll']) },
  guard((a) => call('trackState', a)),
);

server.tool(
  'live_edit_events',
  'Edit all events on one track in the running Studio One: mute, unmute, toggleMute, quantize, transposeUp/Down (instrument parts), split / trimStart / trimEnd at a time (seconds or bars), merge, delete. Returns the track\'s events afterwards. Use live_undo to revert.',
  {
    track: z.string(),
    action: z.enum(['mute', 'unmute', 'toggleMute', 'quantize', 'transposeUp', 'transposeDown', 'split', 'trimStart', 'trimEnd', 'merge', 'delete']),
    at: TIME.optional().describe('Required for split, trimStart, trimEnd'),
  },
  guard((a) => call('editEvents', a)),
);

server.tool(
  'live_add_track',
  'Add a track to the song open in Studio One: audioMono (default), audioStereo, instrument, folder or automation.',
  { type: z.enum(['audioMono', 'audioStereo', 'instrument', 'folder', 'automation']).optional() },
  guard((a) => call('addTrack', a)),
);

server.tool(
  'live_meters',
  'Peak meters of every mixer channel in dB (-144 = silence). With duration_ms, samples repeatedly (e.g. while playing) and returns the highest peak per channel, plus which channels clipped (above -0.1 dB).',
  { duration_ms: z.number().int().optional() },
  guard(async ({ duration_ms }) => {
    const first = await call('meters');
    if (!duration_ms) return first;
    const peak = new Map(first.map((m) => [m.label, Math.max(m.left ?? -144, m.right ?? -144)]));
    const until = Date.now() + Math.min(duration_ms, 60000);
    while (Date.now() < until) {
      for (const m of await call('meters')) peak.set(m.label, Math.max(peak.get(m.label) ?? -144, m.left ?? -144, m.right ?? -144));
      await new Promise((r) => setTimeout(r, 100));
    }
    const channels = [...peak].map(([label, db]) => ({ label, peakDb: Math.round(db * 10) / 10 }));
    return { durationMs: duration_ms, channels, clipped: channels.filter((c) => c.peakDb > -0.1).map((c) => c.label) };
  }),
);

server.tool(
  'live_inserts',
  'Plug-ins on each mixer channel of the running Studio One (or one channel): slot, plug-in name, bypassed; plus the channel\'s bypass-all switch.',
  { channel: z.string().optional() },
  guard((a) => call('inserts', a)),
);

server.tool(
  'live_plugins',
  'The plug-ins installed in the running Studio One, by name (PreSonus, VST and AU), optionally filtered: audio effects (default; the names live_add_plugin and live_add_send take) or instruments (kind "instrument"; the names live_add_instrument_track takes).',
  { filter: z.string().optional(), kind: z.enum(['effect', 'instrument']).optional() },
  guard((a) => call('plugins', a, { timeoutMs: 10000 })),
);

server.tool(
  'live_add_plugin',
  "Add a plug-in by name (from live_plugins) to a channel's inserts in the running Studio One. Returns the channel's inserts afterwards. One live_undo removes it (the add goes through the MCP Track Edit task).",
  { channel: z.string().describe('Exact channel label'), plugin: z.string().describe('Plug-in name, e.g. "Pro EQ", "Compressor", "Room Reverb"') },
  guard((a) => addPlugin(call, a)),
);

server.tool(
  'live_add_send',
  "Add an effect send to a channel in the running Studio One: Studio One makes a new FX channel with the plug-in (by name, from live_plugins) and a send to it, e.g. a reverb or delay send. Returns the FX channel and the channel's sends (set the level with live_set_send). Sending to an existing bus or FX channel cannot be scripted. Not reliably undone by live_undo, so ask before adding when the user has not clearly asked for it.",
  { channel: z.string().describe('Exact channel label'), plugin: z.string().describe('Effect for the new FX channel, e.g. "Room Reverb", "Analog Delay"') },
  guard((a) => addFxSend(call, a)),
);

server.tool(
  'live_add_instrument_track',
  'Add an instrument track in the running Studio One with a new instance of an instrument (by name, from live_plugins with kind "instrument", e.g. "Mai Tai", "Presence"), optionally named. One live_undo removes the track and the instrument.',
  { instrument: z.string(), name: z.string().optional().describe('Track name (default: the instrument name)') },
  guard((a) => addInstrumentTrack(call, a)),
);

server.tool(
  'live_bypass_insert',
  'Bypass or un-bypass one plug-in slot on a channel in the running Studio One (slot number from live_inserts), or the whole insert rack with slot "all".',
  { channel: z.string(), slot: z.union([z.number().int(), z.literal('all')]), bypassed: z.boolean() },
  guard((a) => call('setInsertBypass', a)),
);

server.tool(
  'live_sends',
  'Sends on each mixer channel of the running Studio One (or one channel): destination, level (0..1, Studio One normalised) and mute.',
  { channel: z.string().optional() },
  guard((a) => call('sends', a)),
);

server.tool(
  'live_set_send',
  'Set a send level (0..1) and/or mute on a channel in the running Studio One (index from live_sends).',
  { channel: z.string(), index: z.number().int(), level: z.number().optional(), muted: z.boolean().optional() },
  guard((a) => call('setSend', a)),
);

server.tool(
  'live_plugin_params',
  "Parameters of one plug-in on a channel in the running Studio One (slot from live_inserts): name, value, display text (e.g. \"2.0:1\", \"-12.0 dB\"), range and normalised value. Studio One cannot list a plug-in's parameters, so names come from its presets and Studio One's remote-control map; this works for PreSonus plug-ins. For others, pass the names in `params`.",
  {
    channel: z.string(),
    slot: z.number().int(),
    filter: z.string().optional().describe('Only parameters whose name contains this (e.g. "comp", "freq")'),
    params: z.array(z.string()).optional().describe('Exact parameter names to read instead of the discovered ones'),
  },
  guard(async ({ channel, slot, filter, params }) => {
    const rack = (await call('inserts', { channel }))[0];
    const plug = rack && rack.inserts.find((i) => i.slot === slot);
    if (!plug) throw new Error(`no plug-in in slot ${slot} on ${channel}`);
    const known = params?.length ? { names: params, sources: ['params'] } : pluginParamNames(plug.name);
    const want = filter ? known.names.filter((n) => n.toLowerCase().includes(filter.toLowerCase())) : known.names;
    if (!want.length) {
      return { channel, slot, plugin: plug.name, params: [], note: known.names.length ? `no parameter name contains "${filter}"` : `no parameter names known for ${plug.name}; pass them in params` };
    }
    const r = await call('pluginParams', { channel, slot, names: want });
    // Discovered names the plug-in does not answer to are noise (other versions, UI state); given ones are not.
    return params?.length ? r : { channel: r.channel, slot: r.slot, plugin: r.plugin, params: r.params };
  }),
);

server.tool(
  'live_set_plugin_param',
  'Set one plug-in parameter on a channel in the running Studio One (names from live_plugin_params). Give exactly one of: text, as Studio One displays it (e.g. "4.0:1", "-12 dB", "Standard"); normalized, 0..1; or value, the raw value within its min..max. Returns before/after; to revert, set the "before" value.',
  {
    channel: z.string(),
    slot: z.number().int(),
    param: z.string(),
    text: z.string().optional(),
    normalized: z.number().optional(),
    value: z.number().optional(),
  },
  guard((a) => {
    const given = ['text', 'normalized', 'value'].filter((k) => a[k] !== undefined);
    if (given.length !== 1) throw new Error('give exactly one of text, normalized or value');
    return call('setPluginParam', a);
  }),
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

server.tool(
  'live_record',
  'Record in the running Studio One. This writes a new take into the song, so it only runs with confirm: true, which should mean the user asked for it. Optionally arms a track first, starts from a position (seconds or bars), sets precount, and stops after `seconds`; without `seconds` it keeps recording until live_transport stop.',
  {
    confirm: z.literal(true).describe('Must be true: the user asked to record'),
    track: z.string().optional().describe('Arm this track first (left armed afterwards)'),
    from: TIME.optional(),
    precount: z.boolean().optional(),
    seconds: z.number().optional().describe('Stop after this many seconds (max 600)'),
  },
  guard(async ({ track, from, precount, seconds }) => {
    if (seconds !== undefined && (seconds <= 0 || seconds > 600)) throw new Error('seconds must be 0-600');
    const song = await call('song');
    if (song.transport.playing || song.transport.recording) throw new Error('Studio One is already playing or recording; stop first');
    let armed = null;
    if (track) {
      const t = (await call('tracks', { name: track, events: false })).find((x) => x.name === track);
      if (!t) throw new Error(`no track named ${track}`);
      const ch = (await call('channels')).find((c) => c.label === t.channel);
      if (ch && !ch.recordArmed) await call('trackState', { track, action: 'arm' });
      armed = track;
    }
    const setup = {};
    if (typeof from === 'number') setup.positionSeconds = from;
    if (typeof from === 'string') setup.positionBars = from;
    if (precount !== undefined) setup.precount = precount;
    if (Object.keys(setup).length) await call('setTransport', setup);
    const started = await call('transport', { action: 'record' });
    if (seconds === undefined) return { recording: true, armed, transport: started.transport, note: 'Call live_transport with action "stop" to finish.' };
    await sleep(seconds * 1000);
    const stopped = await call('transport', { action: 'stop' });
    const after = armed ? (await call('tracks', { name: armed })).find((x) => x.name === armed) : null;
    return { recorded: seconds, armed, transport: stopped.transport, track: after };
  }),
);

server.tool(
  'live_command',
  'Run any Studio One command by category and name, exactly as listed in Studio One → Keyboard Shortcuts (e.g. Transport/Start, Transport/Stop, Transport/Record, Edit/Undo, File/Save, View/Console). Use live_list_commands to discover names. With check_only, only reports whether the command is currently enabled, without running it.',
  {
    category: z.string(),
    name: z.string(),
    check_only: z.boolean().optional().describe('Report {enabled} without executing'),
    args: z.array(z.any()).optional().describe('Optional flat [key, value, key, value…] command arguments'),
  },
  guard(({ check_only, ...a }) => call('command', { ...a, checkOnly: !!check_only })),
);

server.tool(
  'live_list_commands',
  'List Studio One commands available to live_command (about 1,000 on Studio One 5), optionally filtered by a substring. with_state adds whether each is enabled right now; many need a selection or an open editor.',
  { filter: z.string().optional(), with_state: z.boolean().optional() },
  guard(({ filter, with_state }) => call('listCommands', { filter, withState: !!with_state }, { timeoutMs: 15000 })),
);

server.tool(
  'live_tempo',
  "Tempo map of the running Studio One (stopped). at: tempo at one or more positions. set: change the tempo of the segment containing a position (default: the playhead). insert: add a tempo change at a position with its bpm. Removing one needs live_undo (usually two steps), and Studio One has refused an undo right after a tempo edit, so check with action at afterwards; setting a segment back is exact. Positions are seconds or bars like \"9.1.1.0\"; the playhead is put back. For the whole saved map, and time signatures, use song_read.",
  {
    action: z.enum(['at', 'set', 'insert']),
    at: z.union([TIME, z.array(TIME)]).optional(),
    bpm: z.number().optional(),
  },
  guard((a) => tempo(call, a)),
);

server.tool(
  'live_bounce',
  "Bounce all events on one track in the running Studio One: inPlace renders them into a single new event (with plug-ins), toNewTrack renders them onto a new track of the same name and mutes the originals. No dialogs; one live_undo reverts it, but the rendered .wav stays in the song's Bounces folder. Exporting a mixdown or stems is not offered: those open dialogs.",
  { track: z.string(), mode: z.enum(['inPlace', 'toNewTrack']).optional() },
  guard((a) => bounce(call, a)),
);

server.tool(
  'live_mix_snapshot',
  "Save the whole mix of the running song under a name (every channel's volume, pan, mute, solo, input monitoring, and each send's level and mute), restore it later, or list this song's snapshots. Restore sets only what differs. Record-arm and automation mode are not included. Mixer changes are not reverted by one live_undo; restore a snapshot instead.",
  { action: z.enum(['save', 'restore', 'list']), name: z.string().optional() },
  guard((a) => mixSnapshot(call, a)),
);

server.tool(
  'live_plugin_snapshot',
  "Save a plug-in's current settings under a name, restore them onto the same kind of plug-in (any channel), or list saved snapshots. A stand-in for presets that works remotely: it stores every known parameter's raw value (PreSonus plug-ins; names as in live_plugin_params) in the studio-one-mcp data folder. Restore only sets parameters that differ.",
  {
    action: z.enum(['save', 'restore', 'list']),
    channel: z.string().optional(),
    slot: z.number().int().optional(),
    name: z.string().optional(),
    plugin: z.string().optional().describe('For list: only this plug-in'),
  },
  guard((a) => {
    if (a.action !== 'list' && (a.channel === undefined || a.slot === undefined)) throw new Error(`${a.action} needs channel and slot`);
    return snapshot(call, a);
  }),
);

server.tool(
  'live_record_setup',
  'Recording setup in the running Studio One. With no arguments, reads the metronome: click, precount, precount length in bars, preroll. Set any of those, and/or record modes: replace, loopTakes or loopMix, takesToLayers, inputQuantize, noteErase (true/false). Record modes cannot be read back from Studio One, so they are reported as set, not confirmed. Auto Punch: punch off, in, out or both, and punchFrom/punchTo for the range (seconds or bars; Studio One punches between the loop locators, so this sets the loop range without turning looping on). The result shows punch-in and whether any autopunch is on (punch-out alone cannot be read separately once punch-in is on).',
  {
    punch: z.enum(['off', 'in', 'out', 'both']).optional(),
    punchFrom: TIME.optional(),
    punchTo: TIME.optional(),
    click: z.boolean().optional(),
    precount: z.boolean().optional(),
    precountBars: z.number().int().optional().describe('1-16'),
    preroll: z.boolean().optional(),
    replace: z.boolean().optional(),
    loopTakes: z.boolean().optional(),
    loopMix: z.boolean().optional(),
    takesToLayers: z.boolean().optional(),
    inputQuantize: z.boolean().optional(),
    noteErase: z.boolean().optional(),
  },
  guard((a) => recordSetup(call, a)),
);

server.tool(
  'live_add_bus',
  'Create a bus for some tracks (their outputs are routed into it) or a VCA that controls them, in the running Studio One. Returns the new channel and, for a bus, where each track now goes. One live_undo removes it. The track selection is kept.',
  { tracks: z.array(z.string()).describe('Exact track names'), kind: z.enum(['bus', 'vca']).optional() },
  guard((a) => addBus(call, a)),
);

server.tool(
  'live_track_edit',
  'Edit a track by exact name in the running Studio One: rename (and its mixer channel), color ("#rrggbb"), remove, move (reorder: put it just before or after another track; both at the top level, not inside a folder), route (send its channel\'s output to a bus or output, by channel name), folder (move it into a folder track, creating it with create: true; the folder is expanded so the track stays visible to these tools), or renameEvents (name every event on it, numbered in time order if asked). Rename and colour are not on the undo stack; route is set back by routing to the "before" channel the result gives; remove, move, folder and renameEvents undo with live_undo. The track selection is kept. Move, route, folder and renameEvents run through the MCP Track Edit task installed with the device.',
  {
    track: z.string(),
    action: z.enum(['rename', 'color', 'remove', 'move', 'route', 'folder', 'renameEvents']),
    name: z.string().optional().describe('For rename and renameEvents'),
    color: z.string().optional().describe('For color: "#rrggbb"'),
    to: z.string().optional().describe('For route: destination channel name, e.g. "Bus 1" or "Main"'),
    folder: z.string().optional().describe('For folder: folder track name'),
    create: z.boolean().optional().describe('For folder: create the folder track if there is none by that name'),
    numbered: z.boolean().optional().describe('For renameEvents: add (01), (02)… in time order'),
    before: z.string().optional().describe('For move: put the track just before this track'),
    after: z.string().optional().describe('For move: put the track just after this track'),
  },
  guard((a) => trackEdit(call, a)),
);

// Sections of the open song: live from the arranger track (MCP Track Edit task),
// or as of the last save if the task is not there.
async function savedSections() {
  try {
    const { sections } = await trackTask(call, { op: 'sections' });
    const live = sections.map((s) => ({ name: s.name, start: { seconds: s.start, bar: null }, end: { seconds: s.end } }));
    return () => live;
  } catch {
    const { fileUrl } = await call('song');
    const path = fileUrl ? fileURLToPath(fileUrl) : null;
    const sections = path && existsSync(path) ? readSong(path).sections : [];
    return () => sections;
  }
}

server.tool(
  'live_arranger',
  "Arranger sections in the running Studio One. sections: list them (numbered in song order). goto: a section by number or name; while playing it jumps at the arranger's sync point, while stopped it moves the playhead to the section's start. next / previous: step while playing. syncMode: when jumps happen (off = immediately, 1bar, 2bars, 4bars, end of section); changing it is an undo step. createFromMarkers: make sections between markers. Editing (each one live_undo): add {start, end, name}, rename {section, name}, resize {section, end}, move {section, start}, remove {section}; moving or resizing a section does not move the events under it. Positions are seconds or bars like \"9.1.1.0\". The loop range is kept.",
  {
    action: z.enum(['sections', 'goto', 'next', 'previous', 'syncMode', 'createFromMarkers', 'add', 'rename', 'resize', 'move', 'remove']),
    section: z.union([z.number().int(), z.string()]).optional().describe('Section number or name (goto jumps while playing only to 1-16)'),
    sync: z.enum(['off', '1bar', '2bars', '4bars', 'end']).optional().describe('For syncMode'),
    name: z.string().optional().describe('For add and rename'),
    start: TIME.optional().describe('For add and move'),
    end: TIME.optional().describe('For add and resize'),
  },
  guard(async (a) => arranger(call, await savedSections(), a)),
);

server.tool(
  'live_macros',
  "List the macros in the running Studio One (Macros panel: built-in and your own) by title, optionally filtered; with_state adds whether each can run right now (most act on the selection).",
  { filter: z.string().optional(), with_state: z.boolean().optional() },
  guard(({ filter, with_state }) => listMacros(call, { filter, withState: with_state })),
);

server.tool(
  'live_run_macro',
  'Run a Studio One macro by title (from live_macros), e.g. "Normalize Audio & Set Peaks To -12". Macros are chains of commands that usually act on the selected events or tracks (see live_select_events / live_select_track) and can edit the song; most edits undo with live_undo. check_only reports whether it is enabled without running it.',
  { title: z.string(), check_only: z.boolean().optional() },
  guard(({ title, check_only }) => runMacro(call, { title, checkOnly: check_only })),
);

server.tool(
  'live_events',
  "One event (audio clip or instrument part) on a track in the running Studio One. list: the track's events, numbered in time order, with start/end in seconds and, for audio, gain (dB) and fade lengths. edit {event, and any of: to (new start), to_track (move it to another track), gain_db (set), add_gain_db, fade_in / fade_out (seconds, audio)}: one live_undo reverts the whole edit. duplicate {event, times}: copies right after it, times times. copy {event, to, to_track?}: pastes a copy at a position (uses the clipboard). Positions are seconds or bars like \"9.1.1.0\".",
  {
    track: z.string(),
    action: z.enum(['list', 'edit', 'duplicate', 'copy']).optional(),
    event: z.union([z.number().int(), z.string()]).optional().describe('Event number (from list) or name'),
    to: TIME.optional(),
    to_track: z.string().optional(),
    gain_db: z.number().optional(),
    add_gain_db: z.number().optional(),
    fade_in: z.number().optional(),
    fade_out: z.number().optional(),
    times: z.number().int().optional(),
  },
  guard((a) => liveEvents(call, a)),
);

server.tool(
  'live_time_signature',
  'Time signatures in the running Studio One. at: the signature in effect at positions (seconds or bars; default the start). insert {bar, numerator, denominator}: a change at the start of a bar. remove {bar}: the change at that bar. Each insert or remove is one live_undo.',
  {
    action: z.enum(['at', 'insert', 'remove']),
    at: z.union([TIME, z.array(TIME)]).optional(),
    bar: z.number().int().optional(),
    numerator: z.number().int().optional(),
    denominator: z.number().int().optional(),
  },
  guard((a) => timeSignature(call, a)),
);

server.tool(
  'live_write_automation',
  "Write volume or pan automation on a channel in the running Studio One, along points [{at, db}] (volume in dB), [{at, pan}] (-1 left .. 1 right) or [{at, value}] (0..1 as live_set_channel takes it), straight lines between them. Studio One gives scripts no way to add envelope points, so this plays the range once in real time with the channel in Write mode and the fader following the curve (audible, and it replaces that parameter's automation in the range), then leaves the channel in Read. Only runs with confirm: true. For fades inside one clip, prefer live_events fade_in/fade_out.",
  {
    confirm: z.literal(true).describe('Must be true: the user asked for automation to be written'),
    channel: z.string(),
    parameter: z.enum(['volume', 'pan']).optional(),
    points: z.array(z.object({ at: TIME, db: z.number().optional(), pan: z.number().optional(), value: z.number().optional() })),
  },
  guard(({ channel, parameter, points }) => writeAutomation(call, { channel, parameter, points })),
);

server.tool(
  'live_eval',
  "Run JavaScript inside Studio One's script engine and return the result (host objects are described to a depth). Globals: Host, PreSonus, component, describe. Only works when the bridge was installed with --allow-eval. Useful for exploring the undocumented object model, e.g. Host.Objects.getObjectByUrl('://studioapp/DocumentManager'). Do not throw, and check that a host member exists (typeof) before calling it: either one pops a modal Scripting Error dialog in Studio One.",
  { code: z.string().describe('Function body; use `return` to send a value back'), depth: z.number().int().optional() },
  guard((a) => call('eval', a, { timeoutMs: 15000 })),
);

await server.connect(new StdioServerTransport());
