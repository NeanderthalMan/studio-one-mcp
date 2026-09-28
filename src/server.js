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

const server = new McpServer({ name: 'studio-one-mcp', version: '0.1.0' });

server.tool(
  'song_list',
  'List Studio One songs on disk (newest first), from ~/Documents/Studio One/Songs or $STUDIO_ONE_SONGS.',
  { query: z.string().optional().describe('Case-insensitive substring of the song title'), limit: z.number().int().optional() },
  guard((a) => listSongs(a)),
);

server.tool(
  'song_read',
  'Read a Studio One song from its .song file: tempo, time signature, markers, arranger sections, tracks with takes/clips (bar, beat and seconds), mixer channels with volume/pan/mute/solo and plug-in inserts, and media files. Reflects the last save, not unsaved edits.',
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
  'List the mixer channels of the song open in Studio One right now, with live volume, pan, mute, solo and record-arm.',
  {},
  guard(() => call('channels')),
);

server.tool(
  'live_set_channel',
  'Change one mixer channel in the running Studio One. Values are Studio One normalised values (volume/pan 0..1, pan 0.5 = centre; mute/solo/recordArmed 0 or 1). Returns before/after.',
  {
    channel: z.string().describe('Exact channel label as shown in the console'),
    field: z.enum(['volume', 'pan', 'mute', 'solo', 'recordArmed']),
    value: z.number(),
  },
  guard((a) => call('setChannel', a)),
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
    loop: z.boolean().optional(),
    precount: z.boolean().optional(),
    preroll: z.boolean().optional(),
  },
  guard(({ position_seconds, ...a }) => call('setTransport', { ...a, positionSeconds: position_seconds })),
);

// Marker names are not exposed live; take them from the last save by position.
function nameMarkers(markers, fileUrl) {
  let saved = [];
  try {
    if (fileUrl && existsSync(fileURLToPath(fileUrl))) saved = readSong(fileURLToPath(fileUrl)).markers;
  } catch {
    saved = [];
  }
  return markers.map((m) => {
    const hit = saved.find((x) => Math.abs(x.seconds - m.seconds) < 0.01);
    return { ...m, name: hit ? hit.name : null };
  });
}

async function liveMarkers(result) {
  const { fileUrl } = await call('song');
  return { ...result, markers: nameMarkers(result.markers, fileUrl), note: 'Names come from the last save; a marker added since then has name null.' };
}

server.tool(
  'live_markers',
  'Markers of the song open in Studio One right now: number, position (seconds and bar display) and name (from the last save). Briefly moves the playhead to read them and puts it back; refuses while playing. Only markers 1-20 are visible.',
  {},
  guard(async () => liveMarkers(await call('markers'))),
);

server.tool(
  'live_add_marker',
  'Add a marker in the running Studio One at a position in seconds (default: the playhead). The playhead is left where it was.',
  { seconds: z.number().optional() },
  guard(async (a) => liveMarkers(await call('addMarker', a))),
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
  'live_eval',
  "Run JavaScript inside Studio One's script engine and return the result (host objects are described to a depth). Globals: Host, PreSonus, component, describe. Only works when the bridge was installed with --allow-eval. Useful for exploring the undocumented object model, e.g. Host.Objects.getObjectByUrl('://studioapp/DocumentManager'). Do not throw, and check that a host member exists (typeof) before calling it: either one pops a modal Scripting Error dialog in Studio One.",
  { code: z.string().describe('Function body; use `return` to send a value back'), depth: z.number().int().optional() },
  guard((a) => call('eval', a, { timeoutMs: 15000 })),
);

await server.connect(new StdioServerTransport());
