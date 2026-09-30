// The MCP Track Edit task under node:vm, with a fake host shaped after what
// Studio One's own track scripts use (MixerConsole channel list, DeviceEditFunctions).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../device/EditTasks/package/McpTrackEdit.js', import.meta.url)), 'utf8');
const MAILBOX = 'file:///mb/';

function load() {
  const files = new Map();
  const Host = {
    Url: (u) => ({ url: u }),
    IO: {
      File: (u) => ({ exists: () => files.has(u.url) }),
      openTextFile: (u) => { const lines = files.get(u.url).split('\n'); let i = 0; return { readLine: () => lines[i++], close() {} }; },
      createTextFile: (u) => { let buf = ''; return { writeString: (s) => (buf += s), close: () => files.set(u.url, buf) }; },
    },
    Results: { kResultOk: 0 },
    Interfaces: { IEditTask: 'IEditTask' },
  };
  const ctx = vm.createContext({ Host, include_file: () => {}, McpEditConfig: { mailbox: MAILBOX } });
  vm.runInContext(source, ctx);
  return {
    task: vm.runInContext('createMcpTrackEdit()', ctx),
    request: (ops) => files.set(MAILBOX + 'track-edit-request.json', JSON.stringify({ id: 't1', ops }) + '\n'),
    result: () => JSON.parse(files.get(MAILBOX + 'track-edit-result.json')),
  };
}

function studio() {
  const ch = (label) => ({ label, input: { of: label }, output: null });
  const channels = [ch('Vox'), ch('Gtr'), ch('Bus 1'), ch('Main')];
  const connected = [];
  const folder = { name: 'Band', isFolder: true, children: [] };
  const tracks = [{ name: 'Vox' }, { name: 'Gtr' }, folder];
  const context = {
    mainTrackList: { numTracks: tracks.length, getTrack: (i) => tracks[i] },
    functions: {
      moveToFolder: (f, t) => f.children.push(t.name),
      root: {
        environment: { find: (n) => (n === 'MixerConsole' ? { getChannelList: () => ({ numChannels: channels.length, getChannel: (i) => channels[i] }) } : null) },
        createFunctions: (n) => (n === 'DeviceEditFunctions' ? { connectChannel: (c, input) => connected.push([c.label, input.of]) } : null),
      },
    },
  };
  return { context, connected, folder };
}

test('route connects one channel to another channel\'s input; names must be unique and present', () => {
  const t = load();
  const s = studio();
  t.request([{ op: 'route', channel: 'Vox', to: 'Bus 1' }, { op: 'route', channel: 'Keys', to: 'Main' }, { op: 'route', channel: 'Gtr', to: 'Nowhere' }]);
  t.task.performEdit(s.context);
  const r = t.result().results;
  assert.deepEqual(s.connected, [['Vox', 'Bus 1']]);
  assert.equal(r[0].done, true);
  assert.match(r[1].error, /no channel named Keys/);
  assert.match(r[2].error, /no channel named Nowhere/);
});

test('folder moves named tracks into a folder track; probe describes what it finds', () => {
  const t = load();
  const s = studio();
  t.request([{ op: 'folder', folder: 'Band', tracks: ['Vox', 'Gtr', 'Drums'] }, { op: 'folder', folder: 'Vox', tracks: ['Gtr'] }, { op: 'probe' }]);
  t.task.performEdit(s.context);
  const [folder, notFolder, probe] = t.result().results;
  assert.deepEqual([folder.moved, folder.missing, s.folder.children], [['Vox', 'Gtr'], ['Drums'], ['Vox', 'Gtr']]);
  assert.match(notFolder.error, /no folder track named Vox/);
  assert.deepEqual([probe.channelCount, probe.firstChannels, probe.deviceFunctions, probe.trackCount], [4, ['Vox', 'Gtr', 'Bus 1', 'Main'], { connectChannel: 'function' }, 3]);
});

test('missing host members are reported, not called', () => {
  const t = load();
  t.request([{ op: 'route', channel: 'A', to: 'B' }, { op: 'folder', folder: 'F', tracks: [] }, { op: 'probe' }]);
  t.task.performEdit({ functions: {} });
  const r = t.result().results;
  assert.match(r[0].error, /no channel named A/);
  assert.match(r[1].error, /no folder track named F/);
  assert.equal(r[2].channelCount, 0);
});
