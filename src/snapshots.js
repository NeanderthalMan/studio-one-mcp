// Plug-in snapshots: every known parameter's raw value, saved to a JSON file and
// set back later. A stand-in for presets: Studio One's preset commands act on the
// focused editor window and store/import through dialogs, and a preset file's
// values are in display units that the host's fromString reads inconsistently
// (seconds read as milliseconds), while raw values round-trip exactly.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './paths.js';
import { pluginParamNames } from './plugins.js';

const safe = (s) => String(s).replace(/[^\w .-]+/g, '_').trim();
const fileOf = (dir, plugin, name) => join(dir, safe(plugin), `${safe(name)}.json`);
// Selector parameters (e.g. the Fat Channel's opt.compmodel) swap which other
// parameters exist, so they go first.
const order = (names) => [...names.filter((n) => n.startsWith('opt.')), ...names.filter((n) => !n.startsWith('opt.'))];

async function pluginAt(call, channel, slot) {
  const rack = (await call('inserts', { channel }))[0];
  const plug = rack && rack.inserts.find((i) => i.slot === slot);
  if (!plug) throw new Error(`no plug-in in slot ${slot} on ${channel}`);
  return plug.name;
}

export async function snapshot(call, { action, channel, slot, name, plugin }, { dir = join(dataDir, 'snapshots'), names = pluginParamNames } = {}) {
  if (action === 'list') {
    if (!existsSync(dir)) return [];
    const plugins = plugin ? [safe(plugin)] : readdirSync(dir);
    return plugins.flatMap((p) => (existsSync(join(dir, p)) ? readdirSync(join(dir, p)) : [])
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const s = JSON.parse(readFileSync(join(dir, p, f), 'utf8'));
        return { plugin: s.plugin, name: s.name, savedAt: s.savedAt, params: Object.keys(s.params).length };
      }));
  }
  if (!name) throw new Error(`${action} needs name`);
  const pluginName = await pluginAt(call, channel, slot);
  const file = fileOf(dir, pluginName, name);
  if (action === 'save') {
    const known = names(pluginName).names;
    if (!known.length) throw new Error(`no parameter names known for ${pluginName}`);
    const r = await call('pluginParams', { channel, slot, names: known });
    const params = Object.fromEntries(r.params.map((p) => [p.name, p.value]));
    mkdirSync(join(dir, safe(pluginName)), { recursive: true });
    writeFileSync(file, JSON.stringify({ plugin: pluginName, name, savedAt: new Date().toISOString(), from: { channel, slot }, params }, null, 1));
    return { saved: name, plugin: pluginName, params: Object.keys(params).length, file };
  }
  if (action === 'restore') {
    if (!existsSync(file)) throw new Error(`no snapshot "${name}" for ${pluginName}`);
    const s = JSON.parse(readFileSync(file, 'utf8'));
    const current = await call('pluginParams', { channel, slot, names: Object.keys(s.params) });
    const now = Object.fromEntries(current.params.map((p) => [p.name, p.value]));
    const changed = [];
    for (const n of order(Object.keys(s.params))) {
      if (now[n] === undefined || now[n] === s.params[n]) continue;
      await call('setPluginParam', { channel, slot, param: n, value: s.params[n] });
      changed.push(n);
    }
    return { restored: name, plugin: pluginName, changed: changed.length, unchanged: Object.keys(s.params).length - changed.length, changedParams: changed };
  }
  throw new Error(`unknown action ${action}`);
}
