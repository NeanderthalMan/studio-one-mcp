// A Bridge (BridgeCore.js) wired to a fake song: transport, markers, tracks
// with takes, selection and the Studio One commands the tools drive.
import assert from 'node:assert/strict';
import { fakeHost, fakeDocument, loadCore, MAILBOX } from './s1host.js';

export function setup({ tracks, noSong = false, markers = [0, 300] } = {}) {
  const doc = fakeDocument({
    title: 'Live Song',
    tracks: tracks || [
      { name: 'Vox', takes: 2, events: [{ name: 'Vox take', start: 0, end: 14.9 }] },
      { name: 'Bass', color: 0x00ff00 },
      { name: 'Keys', mediaType: 'Music', events: [{ name: 'Pad', start: 2, end: 6, muted: true }, { name: 'Pad 2', start: 8, end: 9 }] },
    ],
  });
  const p = doc.params;
  const flip = (name) => () => (p[name].value = p[name].value ? 0 : 1);
  const commands = [
    { category: 'Transport', name: 'Start', enabled: true, run: () => ((p.start.value = 1), (p.stop.value = 0)) },
    { category: 'Transport', name: 'Stop', enabled: true, run: () => ((p.start.value = 0), (p.record.value = 0), (p.stop.value = 1)) },
    { category: 'Transport', name: 'Record', enabled: true, run: () => ((p.record.value = 1), (p.start.value = 1)) },
    { category: 'Transport', name: 'Toggle Loop', enabled: true, run: flip('loop') },
    { category: 'Transport', name: 'Precount', enabled: true, run: flip('precount') },
    { category: 'Transport', name: 'Preroll', enabled: true, run: flip('preroll') },
    { category: 'Transport', name: 'Return to Zero', enabled: true, run: () => (p.primaryTime.value = 0) },
  ];
  // Markers as the Marker commands see them: Recall Marker N exists for 1..20 and
  // is enabled when marker N exists; Insert/Delete act at the playhead.
  const marks = [...markers];
  for (let i = 1; i <= 20; i++) {
    commands.push({
      category: 'Marker', name: `Recall Marker ${i}`,
      get enabled() { return i <= marks.length; },
      run: () => (p.primaryTime.value = marks[i - 1]),
    });
  }
  commands.push(
    { category: 'Marker', name: 'Insert', enabled: true, run: () => { marks.push(p.primaryTime.value); marks.sort((a, b) => a - b); } },
    { category: 'Marker', name: 'Delete', enabled: true, run: () => { const k = marks.indexOf(p.primaryTime.value); if (k >= 0) marks.splice(k, 1); } },
  );
  // Event selection
  let eventsSelected = false;
  commands.push(
    { category: 'Edit', name: 'Deselect All', enabled: true, run: () => (eventsSelected = false) },
    { category: 'Edit', name: 'Select All', enabled: true, run: () => (eventsSelected = true) },
    { category: 'Edit', name: 'Select All on Tracks', enabled: true, run: () => (eventsSelected = doc.mainTrackList.numSelectedTracks > 0) },
  );
  // Undo history. `apply` acts on the current selection and returns the
  // { undo, redo } pair for the objects it changed, as Studio One's history does.
  const undo = [];
  const redo = [];
  const undoable = (category, name, apply, enabled = () => true) =>
    commands.push({ category, name, get enabled() { return enabled(); }, run: () => { undo.push(apply()); redo.length = 0; } });
  commands.push(
    { category: 'Edit', name: 'Undo', get enabled() { return undo.length > 0; }, run: () => { const u = undo.pop(); u.undo(); redo.push(u); } },
    { category: 'Edit', name: 'Redo', get enabled() { return redo.length > 0; }, run: () => { const u = redo.pop(); u.redo(); undo.push(u); } },
    { category: 'File', name: 'Save', enabled: true, run: () => (doc.saved = (doc.saved || 0) + 1) },
    { category: 'File', name: 'Save New Version', enabled: true, run: () => (doc.versions = (doc.versions || 0) + 1) },
    { category: 'Edit', name: 'Show All Tracks', enabled: true, run: () => doc.objs.forEach((o) => (o.hidden = false)) },
  );
  const sel = () => doc.mainTrackList.numSelectedTracks === 1 ? doc.mainTrackList.getSelectedTrack(0) : null;
  const setter = (obj, key, value) => {
    const old = obj[key];
    obj[key] = value;
    return { undo: () => (obj[key] = old), redo: () => (obj[key] = value) };
  };
  const layerCmd = (name, step) => undoable('Track', name,
    () => { const t = sel(); return setter(t, 'activeTake', (t.activeTake + step + t.layers.count) % t.layers.count); },
    () => !!sel() && sel().layers.count > 1);
  layerCmd('Activate Next Layer', 1);
  layerCmd('Activate Previous Layer', -1);
  for (const [name, key] of [['Arm', 'recordArmed'], ['Monitor', 'monitor'], ['Mute', 'mute'], ['Solo', 'solo']])
    undoable('Track', name, () => setter(sel(), key, !sel()[key]), () => !!sel());
  undoable('Track', 'Hide', () => setter(sel(), 'hidden', true), () => !!sel());
  undoable('Track', 'Add Audio Track (mono)', () => {
    doc.addTrack('Audio 1');
    return { undo: () => doc.removeTrack('Audio 1'), redo: () => doc.addTrack('Audio 1') };
  });
  // Event edits act on selected events of the selected track.
  // Selected events: the selected track's, or every track's after Edit/Select All.
  const evs = () => (sel() ? sel().currentEvents() : doc.objs.flatMap((o) => o.currentEvents()));
  const edit = (category, name, fn) => undoable(category, name, () => {
    const targets = evs();
    const before = targets.map((e) => ({ ...e }));
    fn(targets);
    return { undo: () => targets.splice(0, targets.length, ...before.map((e) => ({ ...e }))), redo: () => fn(targets) };
  }, () => eventsSelected);
  edit('Event', 'Mute Events', (e) => e.forEach((x) => (x.muted = true)));
  edit('Event', 'Unmute Events', (e) => e.forEach((x) => (x.muted = false)));
  edit('Edit', 'Split at Cursor', (e) => {
    const at = p.primaryTime.value;
    const hit = e.find((x) => x.start < at && x.end > at);
    if (hit) { e.push({ name: hit.name, start: at, end: hit.end }); hit.end = at; }
  });
  const host = fakeHost({ commands, document: noSong ? null : doc });
  const { get } = loadCore({ host, config: { mailbox: MAILBOX } });
  const bridge = new (get('Bridge'))({ mailbox: MAILBOX }, null);
  let n = 0;
  const ask = (op, args) => {
    const id = `d${++n}`;
    host.client.write('request.json', { id, op, args });
    bridge.tick();
    const res = host.client.read('response.json');
    assert.equal(res.id, id);
    return res;
  };
  return { host, doc, ask, marks };
}

