// End to end over stdio: spawn the real MCP server against a temporary Songs
// folder and a temporary mailbox, and call its tools as a client would.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeSong } from './helpers/fixtures.js';

const serverPath = fileURLToPath(new URL('../src/server.js', import.meta.url));
let client;
let songs;
let mcpHome;

const touch = (path, isoDate) => utimesSync(path, new Date(isoDate), new Date(isoDate));

before(async () => {
  songs = mkdtempSync(join(tmpdir(), 's1songs-'));
  mcpHome = mkdtempSync(join(tmpdir(), 's1home-'));
  // Saved song with two autosaves.
  const a = writeSong(join(songs, 'Demo Tune', 'Demo Tune.song'), { title: 'Demo Tune' });
  touch(a, '2026-01-02T00:00:00Z');
  touch(writeSong(join(songs, 'Demo Tune', 'History', 'Demo Tune 1 (Autosaved).song')), '2026-01-01T00:00:00Z');
  touch(writeSong(join(songs, 'Demo Tune', 'History', 'Demo Tune 2 (Autosaved).song')), '2026-01-01T12:00:00Z');
  // Older song whose title also contains "Tune".
  touch(writeSong(join(songs, 'Old Tune', 'Old Tune.song'), { title: 'Old Tune' }), '2025-06-01T00:00:00Z');
  // Never saved by hand: only autosaves.
  touch(writeSong(join(songs, 'Sketch', 'History', 'Sketch 1 (Autosaved).song')), '2026-02-01T00:00:00Z');
  // A folder Studio One made for a brand-new song: Media only, nothing to read.
  mkdirSync(join(songs, 'Brand New', 'Media'), { recursive: true });

  client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      env: { ...process.env, STUDIO_ONE_SONGS: songs, STUDIO_ONE_MCP_HOME: mcpHome },
    }),
  );
});

after(() => client?.close());

async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  return { isError: !!r.isError, text, data: r.isError ? null : JSON.parse(text) };
}

test('exposes the song and live tools', async () => {
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'live_add_bus', 'live_add_marker', 'live_add_track', 'live_arranger', 'live_bounce', 'live_bypass_insert', 'live_channels', 'live_command', 'live_delete_marker',
    'live_edit_events', 'live_edit_notes', 'live_eval', 'live_inserts', 'live_list_commands', 'live_macros', 'live_markers', 'live_meters', 'live_notes', 'live_plugin_params', 'live_plugin_snapshot', 'live_record', 'live_record_setup',
    'live_redo', 'live_run_macro', 'live_save', 'live_select_events', 'live_select_track', 'live_sends', 'live_set_automation',
    'live_set_channel', 'live_set_loop', 'live_set_plugin_param', 'live_set_send', 'live_set_transport', 'live_song', 'live_status', 'live_takes', 'live_tempo', 'live_track_edit', 'live_track_state',
    'live_tracks', 'live_transport', 'live_undo',
    'song_diff', 'song_history', 'song_list', 'song_read',
  ]);
});

test('song_list: newest first, autosave-only songs flagged, empty folders skipped', async () => {
  const { data } = await call('song_list');
  assert.deepEqual(data.map((s) => [s.title, !!s.unsaved, s.autosaves]), [
    ['Sketch', true, 1],
    ['Demo Tune', false, 2],
    ['Old Tune', false, 0],
  ]);
  assert.deepEqual((await call('song_list', { query: 'tune', limit: 1 })).data.map((s) => s.title), ['Demo Tune']);
});

test('song_read summary by exact title', async () => {
  const { data } = await call('song_read', { song: 'Demo Tune' });
  assert.equal(data.title, 'Demo Tune');
  assert.deepEqual(data.tempo, [120, 60]);
  assert.equal(data.tracks[0].name, 'Vox');
  assert.equal(data.otherMatches, undefined);
});

test('song_read: partial title picks the newest and names the others', async () => {
  const { data } = await call('song_read', { song: 'tune' });
  assert.equal(data.title, 'Demo Tune');
  assert.deepEqual(data.otherMatches, ['Old Tune']);
});

test('song_read full with a track filter; autosave-only songs are readable', async () => {
  const full = (await call('song_read', { song: 'Demo Tune', detail: 'full', track: 'vo' })).data;
  assert.equal(full.tracks.length, 1);
  assert.equal(full.tracks[0].layers.length, 2);
  assert.ok(full.mixer.length > 0);
  assert.equal((await call('song_read', { song: 'Sketch' })).data.tracks[0].name, 'Vox');
});

test('song_read: unknown song is a tool error, not a crash', async () => {
  const r = await call('song_read', { song: 'does not exist' });
  assert.equal(r.isError, true);
  assert.match(r.text, /No song matching/);
});

test('song_history: autosaves newest first, also for autosave-only songs', async () => {
  const { data } = await call('song_history', { song: 'Demo Tune' });
  assert.deepEqual(data.map((h) => h.file.split('/').pop()), ['Demo Tune 2 (Autosaved).song', 'Demo Tune 1 (Autosaved).song']);
  assert.equal((await call('song_history', { song: 'Sketch' })).data.length, 1);
});

test('song_diff: against the newest autosave by default, older to newer; errors without autosaves', async () => {
  const { data } = await call('song_diff', { song: 'Demo Tune' });
  // The save (2026-01-02) is newer than both autosaves, so the newest autosave is "from".
  assert.equal(data.from.split('/').pop(), 'Demo Tune 2 (Autosaved).song');
  assert.equal(data.to.split('/').pop(), 'Demo Tune.song');
  assert.deepEqual([data.changes, data.diff], [0, []]);
  const none = await call('song_diff', { song: 'Old Tune' });
  assert.equal(none.isError, true);
  assert.match(none.text, /no autosaves/);
});

test('live_status without a bridge explains how to install it', async () => {
  const { data } = await call('live_status');
  assert.equal(data.connected, false);
  assert.match(data.reason, /External Devices/);
});

test('live tools fail cleanly when the bridge is not loaded', async () => {
  const r = await call('live_channels');
  assert.equal(r.isError, true);
  assert.match(r.text, /bridge not loaded/);
});

test('live_status when Studio One closed the bridge', async () => {
  mkdirSync(join(mcpHome, 'mailbox'), { recursive: true });
  writeFileSync(join(mcpHome, 'mailbox', 'status.json'), '﻿' + JSON.stringify({ protocol: 1, closed: true }));
  const { data } = await call('live_status');
  assert.equal(data.connected, false);
  assert.match(data.reason, /closed/);
});

test('live_record refuses without confirm: true (it writes a take into the song)', async () => {
  const r = await client.callTool({ name: 'live_record', arguments: {} });
  assert.equal(r.isError, true);
  const r2 = await client.callTool({ name: 'live_record', arguments: { confirm: false } });
  assert.equal(r2.isError, true);
});
