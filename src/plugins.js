// Parameter names of a plug-in, for the live_plugin_* tools.
//
// Studio One's script host finds a plug-in parameter by name but cannot list
// them, so the names come from files Studio One ships:
//  - the remote-control map (remotedevice.surfacedata): curated names per
//    PreSonus plug-in, e.g. "{5E91…}/filter.hpf" for the Fat Channel;
//  - presets (.preset zips): an XML ParameterData element whose attributes are
//    the names (Pro EQ: lffreq, lfgain…), or a .dsppreset JSON whose nested
//    sections become dotted names (Fat Channel: comp.threshold).
// The device drops any name the running plug-in does not answer to.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { parseXml, walk } from './xml.js';
import { presetRoots, remoteMapFiles } from './paths.js';

// Nested JSON object -> dotted leaf names.
export function flattenNames(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj || {})) {
    const name = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...flattenNames(v, name));
    else out.push(name);
  }
  return out;
}

// Names and class from one .preset file, or null if it is not one we can read.
export function readPreset(path) {
  let entries;
  try {
    entries = unzipSync(readFileSync(path));
  } catch {
    return null;
  }
  const text = (n) => (entries[n] ? strFromU8(entries[n]).replace(/^﻿/, '') : null);
  const meta = text('metainfo.xml');
  const attr = (id) => (meta ? (meta.match(new RegExp(`id="${id}" value="([^"]*)"`)) || [])[1] || null : null);
  const dataFile = attr('Preset:DataFile') || Object.keys(entries).find((n) => n.startsWith('data.'));
  const data = dataFile ? text(dataFile) : null;
  if (!data) return null;
  let names = [];
  if (data.trimStart().startsWith('{')) {
    try {
      names = flattenNames(JSON.parse(data).parameters);
    } catch {
      return null;
    }
  } else {
    const root = parseXml(data);
    for (const n of walk(root)) if (n.attrs['x:id'] === 'ParameterData') names.push(...Object.keys(n.attrs).filter((k) => k !== 'x:id'));
  }
  return { classId: attr('Class:ID'), className: attr('Class:Name'), names };
}

function* presetFiles(dir, depth = 0) {
  if (depth > 4 || !existsSync(dir)) return;
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* presetFiles(p, depth + 1);
    else if (e.endsWith('.preset')) yield p;
  }
}

// Remote map: plug-in friendly name -> [parameter names], in the map's order.
const remoteCache = new Map();
export function remoteMap(file) {
  if (remoteCache.has(file)) return remoteCache.get(file);
  const map = new Map();
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    text = '';
  }
  const blocks = text.split('<SurfaceDeviceAssignment ').slice(1);
  for (const b of blocks) {
    const name = (b.match(/friendlyName="([^"]*)"/) || [])[1];
    if (!name) continue;
    const names = [...b.matchAll(/<Association key="[^"]*" value="\{[^}]*\}\/([^"]+)"/g)].map((m) => m[1]);
    map.set(name, [...(map.get(name) || []), ...names]);
  }
  remoteCache.set(file, map);
  return map;
}

// Every parameter name we can find for a plug-in (by the name live_inserts shows).
// Presets are read from folders named after the plug-in (<root>/<vendor>/<name>),
// at most `maxPresets` of them.
export function pluginParamNames(pluginName, { roots = presetRoots(), maps = remoteMapFiles(), maxPresets = 8 } = {}) {
  const names = new Set();
  const sources = [];
  for (const f of maps) {
    const got = remoteMap(f).get(pluginName);
    if (got?.length) {
      got.forEach((n) => names.add(n));
      sources.push(f);
    }
  }
  let read = 0;
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const vendor of readdirSync(root)) {
      const dir = join(root, vendor, pluginName);
      for (const p of presetFiles(dir)) {
        if (read >= maxPresets) break;
        const preset = readPreset(p);
        if (!preset || (preset.className && preset.className !== pluginName)) continue;
        read++;
        preset.names.forEach((n) => names.add(n));
        sources.push(p);
      }
    }
  }
  return { names: [...names], sources };
}
