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

export function fakeHost({ commands = [] } = {}) {
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
