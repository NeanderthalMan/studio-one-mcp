// A fake Studio One scripting host, just enough to run the device scripts in
// device/StudioOneMCP/ under node:vm. Modelled on what the real host showed us
// on 5.5.2: Host.IO text files (written with a UTF-8 BOM), Host.GUI.Commands,
// and a control-surface component whose mixer bank lives at hostComponent.model.
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const deviceDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'device', 'StudioOneMCP');
export const MAILBOX = 'file:///mailbox/';

// A document as the live object model showed it on 5.5.2: TransportPanel
// parameters (tempo in bpm, times in seconds with a display string) and a
// mainTrackList whose tracks with takes appear once per lane (same object).
export function fakeDocument({ title = 'Live Song', tracks = [], tempo = 120 } = {}) {
  const param = (name, value, { min = 0, max = 1, display } = {}) => ({
    name, value, min, max,
    get string() { return display ? display(this.value) : String(this.value); },
    setValue(v) { this.value = v; },
  });
  const bars = (sec) => `${String(Math.floor(sec / 2) + 1).padStart(4, '0')}.01.01.00`; // 120 bpm, 4/4
  const params = {
    start: param('start', 0), stop: param('stop', 1), record: param('record', 0), loop: param('loop', 0),
    precount: param('precount', 0), preroll: param('preroll', 0),
    tempo: param('tempo', tempo, { min: 10, max: 400, display: (v) => v.toFixed(2) }),
    primaryTime: param('primaryTime', 0, { display: bars }),
    primaryTimeFormat: param('primaryTimeFormat', 2, { display: () => 'Bars' }),
    loopStart: param('loopStart', 0, { display: bars }),
    loopEnd: param('loopEnd', 16, { display: bars }),
  };
  const transportPanel = { findParameter: (n) => params[n] || null };
  const objs = tracks.map((t, i) => ({
    name: t.name, mediaType: t.mediaType || 'Audio', color: t.color ?? 0xffc693, trackIndex: i + 1,
    channel: { label: t.channel || t.name }, layers: { count: t.takes || 1 },
    isEmpty: () => !(t.events || []).length,
    createIterator: () => {
      const evs = (t.events || []).map((e) => ({ name: e.name, startTime: { seconds: e.start }, endTime: { seconds: e.end }, isMuted: e.muted ? 1 : 0 }));
      let k = 0;
      return { next: () => evs[k++] || null };
    },
  }));
  const rows = objs.flatMap((o, i) => Array((tracks[i].takes || 1) > 1 ? 2 + tracks[i].takes : 1).fill(o));
  let selected = [];
  const mainTrackList = {
    get numTracks() { return rows.length; },
    getTrack: (i) => rows[i],
    get numSelectedTracks() { return selected.length; },
    getSelectedTrack: (i) => selected[i],
    selectTrack: (t, state) => { if (state && !selected.includes(t)) selected.push(t); },
    unselectAll: () => { selected = []; },
  };
  return {
    params, objs, rows, mainTrackList,
    urls: {
      '://studioapp/DocumentManager': { activeDocument: { title, path: { url: `file:///songs/${title}/${title}.song` } } },
      '://hostapp/DocumentManager/ActiveDocument/Environment/TransportPanel': transportPanel,
      '://hostapp/DocumentManager/ActiveDocument/TrackList': { mainTrackList },
    },
  };
}

export function fakeHost({ commands = [], document = null } = {}) {
  const files = new Map(); // url string -> contents
  const logs = [];
  const executed = [];
  const key = (c, n) => `${c}/${n}`;
  const table = new Map(commands.map((c) => [key(c.category, c.name), c]));

  const Host = {
    Url: (u) => ({ url: u }),
    IO: {
      File: (u) => ({ exists: () => files.has(u.url) }),
      openTextFile: (u) => {
        const lines = (files.get(u.url) ?? '').split('\n');
        let i = 0;
        return { readLine: () => lines[i++], close() {} };
      },
      createTextFile: (u) => {
        let buf = '';
        return { writeString: (s) => (buf += s), close: () => files.set(u.url, '﻿' + buf) };
      },
    },
    GUI: {
      Commands: {
        findCommand: (c, n) => table.get(key(c, n)) || null,
        interpretCommand: (c, n, checkOnly, args) => {
          const cmd = table.get(key(c, n));
          if (!cmd) return false;
          if (checkOnly) return !!cmd.enabled;
          if (!cmd.enabled) return false;
          executed.push({ command: key(c, n), args });
          if (cmd.run) cmd.run();
          return true;
        },
        newCommandIterator: () => {
          const list = [...table.values()];
          let i = 0;
          return { done: () => i >= list.length, next: () => list[i++] };
        },
      },
    },
    Attributes: (pairs) => ({ pairs }),
    Objects: { getObjectByUrl: (url) => (document && document.urls[url]) || null },
    Console: { writeLine: (s) => logs.push(String(s)) },
  };

  const client = {
    write: (name, value) => files.set(MAILBOX + name, JSON.stringify(value) + '\n'),
    read: (name) => {
      const t = files.get(MAILBOX + name);
      return t === undefined ? null : JSON.parse(t.replace(/^﻿/, ''));
    },
    raw: (name) => files.get(MAILBOX + name),
  };
  return { Host, files, logs, executed, client };
}

// Mixer bank of the kind the surface's ScrollBank exposes.
export function fakeMixer(channels) {
  const elements = channels.map((c) => {
    const params = { label: c.label, volume: c.volume ?? 1, pan: c.pan ?? 0.5, mute: c.mute ?? 0, solo: c.solo ?? 0, recordArmed: c.recordArmed ?? 0 };
    return {
      params,
      isConnected: () => true,
      getParamValue: (id) => params[id],
      setParamValue: (id, v) => {
        params[id] = v;
        return true;
      },
    };
  });
  const bank = { getElement: (i) => elements[i] || null };
  const model = { root: { find: (n) => (n === 'mixer' ? { find: (m) => (m === 'channels' ? bank : null) } : null) } };
  return { elements, model };
}

const ParamID = { kLabel: 'label', kVolume: 'volume', kPan: 'pan', kRecord: 'recordArmed', kChannelType: 'channelType' };

// Load BridgeCore.js alone. Returns the context, so tests can reach its
// top-level classes and functions by name.
export function loadCore({ host, config }) {
  const ctx = vm.createContext({ Host: host.Host, PreSonus: { ParamID }, BridgeConfig: config });
  vm.runInContext(readFileSync(join(deviceDir, 'BridgeCore.js'), 'utf8'), ctx, { filename: 'BridgeCore.js' });
  const get = (name) => vm.runInContext(name, ctx);
  return { ctx, get };
}

// Load BridgeComponent.js the way Studio One does: include_file pulls in the
// SDK (faked here), the generated BridgeConfig.js and BridgeCore.js.
export function loadComponent({ host, config, mixer }) {
  class ControlSurfaceComponent {
    onInit(hostComponent) {
      this.hostComponent = hostComponent;
    }
    onExit() {}
    paramChanged() {}
  }
  const ctx = vm.createContext({
    Host: host.Host,
    PreSonus: { ParamID, ControlSurfaceComponent },
    include_file: (path) => {
      if (path.startsWith('resource://')) return;
      if (path === 'BridgeConfig.js') return vm.runInContext(`var BridgeConfig = ${JSON.stringify(config)};`, ctx);
      vm.runInContext(readFileSync(join(deviceDir, path), 'utf8'), ctx, { filename: path });
    },
  });
  vm.runInContext(readFileSync(join(deviceDir, 'BridgeComponent.js'), 'utf8'), ctx, { filename: 'BridgeComponent.js' });
  const params = [];
  const hostComponent = {
    model: mixer ? mixer.model : undefined,
    paramList: { addParam: (name) => (params.push({ name }), params[params.length - 1]) },
  };
  const component = vm.runInContext('createBridgeComponent()', ctx);
  component.onInit(hostComponent);
  return { ctx, component, hostComponent, params };
}
