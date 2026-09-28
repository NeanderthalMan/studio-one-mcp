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
  // Bar strings like "9.1.1.0" at 120 bpm in 4/4: two seconds per bar.
  const fromBars = (str) => { const [bar, beat = 1] = str.split('.').map(Number); return (bar - 1) * 2 + (beat - 1) * 0.5; };
  const param = (name, value, { min = 0, max = 1, display } = {}) => ({
    name, value, min, max,
    get string() { return display ? display(this.value) : String(this.value); },
    setValue(v) { this.value = v; },
    fromString(str) { this.value = fromBars(str); },
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
  // Environment/Metronome as on 5.5.2: clickOn/precount/preroll 0..1, bars 1..16.
  const metro = {
    clickOn: param('clickOn', 1), precount: param('precount', 0), preroll: param('preroll', 0), bars: param('bars', 1, { min: 1, max: 16 }),
  };
  const metronome = { params: metro, findParameter: (n) => metro[n] || null };
  // takeEvents: one events array per take; `events` is shorthand for a single take.
  const makeTrack = (t, i) => {
    const takes = (t.takeEvents || [t.events || []]).map((list) => list.map((e) => ({ ...e })));
    const o = {
      name: t.name, mediaType: t.mediaType || 'Audio', color: t.color ?? 0xffc693, trackIndex: i + 1,
      channel: { label: t.channel || t.name }, layers: { count: t.takes || takes.length },
      activeTake: 0,
      currentEvents: () => takes[o.activeTake] || [],
      isEmpty: () => !o.currentEvents().length,
      createIterator: () => {
        // A part with `notes` walks them like 5.5.2 does: createSequenceIterator() with done()/next().
        const seq = (notes) => () => {
          const ns = notes.map((n) => ({ pitch: n.pitch, velocity: n.velocity, startTime: { seconds: n.start, musical: n.start * 2 }, endTime: { seconds: n.end } }));
          let k = 0;
          return { done: () => k >= ns.length, next: () => ns[k++] || null };
        };
        const evs = o.currentEvents().map((e) => ({
          name: e.name, startTime: { seconds: e.start }, endTime: { seconds: e.end }, isMuted: e.muted ? 1 : 0,
          ...(e.notes ? { createSequenceIterator: seq(e.notes) } : {}),
        }));
        let k = 0;
        return { next: () => evs[k++] || null };
      },
    };
    return o;
  };
  const objs = tracks.map(makeTrack);
  let rows = [];
  const layout = () => (rows = objs.flatMap((o) => Array(o.layers.count > 1 ? 2 + o.layers.count : 1).fill(o)));
  layout();
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
    params, objs, mainTrackList,
    addTrack: (name) => { objs.push(makeTrack({ name }, objs.length)); layout(); },
    removeTrack: (name) => { const k = objs.findIndex((o) => o.name === name); if (k >= 0) objs.splice(k, 1); layout(); },
    urls: {
      '://studioapp/DocumentManager': { activeDocument: { title, path: { url: `file:///songs/${title}/${title}.song` } } },
      '://hostapp/DocumentManager/ActiveDocument/Environment/TransportPanel': transportPanel,
      '://hostapp/DocumentManager/ActiveDocument/Environment/Metronome': metronome,
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

// A plug-in's parameters as the Device component showed them on 5.5.2:
// raw value within min..max, display text, normalised value, fromString.
// spec: { 'comp.ratio': { value, min, max, unit } } (display = value + unit).
export function fakePlugin(spec) {
  const params = {};
  for (const [name, s] of Object.entries(spec)) {
    const min = s.min ?? 0;
    const max = s.max ?? 1;
    params[name] = {
      name, value: s.value ?? min, min, max,
      get string() { return `${this.value}${s.unit || ''}`; },
      getNormalized() { return (this.value - min) / (max - min); },
      setNormalized(n) { this.value = min + n * (max - min); },
      setValue(v) { this.value = v; },
      fromString(str) { this.value = parseFloat(str); },
    };
  }
  return { name: 'Plugin', params, findParameter: (n) => params[n] || null };
}

// Mixer bank of the kind the surface's ScrollBank exposes.
// Each channel may have inserts [{ name, bypassed }] and sends [{ to, level, muted }],
// exposed like the surface file's sub-banks: el.find('inserts'|'sends').getElement(i).
// Insert bypass lives on the channel as "Inserts/[i]/@bypass" (and "Inserts/bypassAll").
export function fakeMixer(channels) {
  const bankOf = (items, paramsOf) => {
    const els = items.map((it) => {
      const p = paramsOf(it);
      const display = { sendPort: () => it.to, sendlevel: () => `${(20 * Math.log10(Math.max(p.sendlevel, 1e-6))).toFixed(1)}` };
      // An insert's plug-in: slot.component.find('Device').findParameter(name).
      const device = it.params ? fakePlugin(it.params) : null;
      return {
        device,
        component: device ? { name: 'FX01', find: (n) => (n === 'Device' ? device : null) } : undefined,
        params: p, isConnected: () => true, getParamValue: (id) => p[id], setParamValue: (id, v) => ((p[id] = v), true),
        // Real sendPort values are list indexes (-1 for the default bus); the name is only display text.
        connectAliasParam: (alias, id) => (alias.string = display[id] ? display[id]() : String(p[id])),
      };
    });
    return { getElement: (i) => els[i] || null, els };
  };
  const elements = channels.map((c) => {
    const params = { label: c.label, volume: c.volume ?? 1, pan: c.pan ?? 0.5, mute: c.mute ?? 0, solo: c.solo ?? 0, recordArmed: c.recordArmed ?? 0, automationMode: c.automationMode ?? 0, monitor: c.monitor ?? 0, 'Inserts/bypassAll': 0 };
    // Routing as on 5.5.2: list index -1, names only as display text through an alias.
    if (c.output) params.outputPort = -1;
    if (c.input) params.recordPort = -1;
    const routeName = { outputPort: c.output, recordPort: c.input };
    (c.inserts || []).forEach((x, i) => (params[`Inserts/[${i}]/@bypass`] = x.bypassed ? 1 : 0));
    const banks = {
      inserts: bankOf(c.inserts || [], (x) => ({ '@owner/deviceName': x.name })),
      sends: bankOf(c.sends || [], (x) => ({ sendPort: -1, sendlevel: x.level ?? 0.5, sendMute: x.muted ? 1 : 0 })),
    };
    return {
      params,
      banks,
      find: (name) => banks[name] || null,
      isConnected: () => true,
      connectAliasParam: (alias, id) => (alias.string = routeName[id] ?? String(params[id])),
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

const ParamID = {
  kLabel: 'label', kVolume: 'volume', kPan: 'pan', kRecord: 'recordArmed', kChannelType: 'channelType', kAutoMode: 'automationMode', kColor: 'color',
  kInsertName: '@owner/deviceName', kInsertBypass: 'Inserts/bypassAll', kSendPort: 'sendPort', kSendLevel: 'sendlevel', kSendMute: 'sendMute',
};

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
    paramList: {
      addParam: (name) => (params.push({ name }), params[params.length - 1]),
      addAlias: (name) => ({ name, string: '' }),
    },
  };
  const component = vm.runInContext('createBridgeComponent()', ctx);
  component.onInit(hostComponent);
  return { ctx, component, hostComponent, params };
}
