// Arranger and macro tools over a fake bridge call().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arranger, numberSections, findSection, macroTitle, macroCommand, listMacros, runMacro } from '../src/arranger.js';

const range = (s, e) => ({ start: { seconds: s }, end: { seconds: e } });
const SAVED = [
  { name: 'Chorus', start: { seconds: 8, bar: 5 }, lengthBeats: 8 },
  { name: 'Verse', start: { seconds: 0, bar: 1 }, lengthBeats: 16 },
];

// A bridge that records calls. `jumpSetsLoop` mimics the loop range moving on a goto.
function bridge({ playing = false, jumpSetsLoop = false, commands = {} } = {}) {
  const t = { playing, position: { seconds: 1 }, loopRange: range(0, 15) };
  const calls = [];
  const call = async (op, args) => {
    calls.push([op, args]);
    switch (op) {
      case 'song': return { transport: JSON.parse(JSON.stringify(t)) };
      case 'setTransport': t.position.seconds = args.positionSeconds; return JSON.parse(JSON.stringify(t));
      case 'setLoop': t.loopRange = range(args.start, args.end); return t;
      case 'listCommands': return Object.keys(commands).map((name) => ({ category: 'Macros', name, enabled: commands[name] }));
      case 'command':
        if (args.checkOnly) return { enabled: true };
        if (jumpSetsLoop && /^Goto/.test(args.name)) t.loopRange = range(4, 8);
        return { executed: !/Section 9/.test(args.name) };
      default: throw new Error(`unexpected ${op}`);
    }
  };
  return { call, calls, t };
}

test('sections are numbered in song order; found by number, exact or partial name', () => {
  const list = numberSections(SAVED);
  assert.deepEqual(list.map((s) => [s.number, s.name]), [[1, 'Verse'], [2, 'Chorus']]);
  assert.equal(findSection(list, 2).name, 'Chorus');
  assert.equal(findSection(list, 'chor').number, 2);
  assert.equal(findSection(list, 'bridge'), null);
});

test('goto while stopped locates the playhead to the saved start', async () => {
  const b = bridge();
  const r = await arranger(b.call, () => SAVED, { action: 'goto', section: 'Chorus' });
  assert.equal(r.located, 2);
  assert.equal(b.t.position.seconds, 8);
  assert.ok(!b.calls.some(([op]) => op === 'command'));
  await assert.rejects(arranger(b.call, () => SAVED, { action: 'goto', section: 5 }), /not in the last save/);
  await assert.rejects(arranger(b.call, () => SAVED, { action: 'goto', section: 'Bridge' }), /no saved section named Bridge/);
});

test('goto while playing uses the arranger jump and puts the loop range back', async () => {
  const b = bridge({ playing: true, jumpSetsLoop: true });
  const r = await arranger(b.call, () => SAVED, { action: 'goto', section: 2 });
  assert.equal(r.jumped, 2);
  assert.ok(b.calls.some(([op, a]) => op === 'command' && a.name === 'Goto Section 2'));
  assert.deepEqual(b.t.loopRange, range(0, 15));
  await assert.rejects(arranger(b.call, () => [], { action: 'goto', section: 9 }), /did not run/);
  await assert.rejects(arranger(b.call, () => [], { action: 'goto', section: 17 }), /1-16/);
});

test('next/previous need playback; syncMode and createFromMarkers run their commands', async () => {
  await assert.rejects(arranger(bridge().call, () => SAVED, { action: 'next' }), /only steps between sections while playing/);
  const b = bridge({ playing: true });
  assert.equal((await arranger(b.call, () => SAVED, { action: 'previous' })).executed, true);
  assert.equal((await arranger(b.call, () => SAVED, { action: 'syncMode', sync: '2bars' })).executed, true);
  assert.ok(b.calls.some(([, a]) => a?.name === 'Set Sync Mode 2 Bars'));
  await assert.rejects(arranger(b.call, () => SAVED, { action: 'syncMode', sync: 'soon' }), /sync must be one of/);
  await arranger(b.call, () => SAVED, { action: 'createFromMarkers' });
  assert.ok(b.calls.some(([, a]) => a?.name === 'Create Sections from Markers'));
});

test('macro names are base64 titles', () => {
  assert.equal(macroTitle('Macro QWxsIEZYIG9mZg=='), 'All FX off');
  assert.equal(macroCommand('All FX off'), 'Macro QWxsIEZYIG9mZg==');
  assert.equal(macroTitle('Macro not base64!'), null);
  assert.equal(macroTitle('Something else'), null);
});

test('listMacros decodes and filters; runMacro finds by title and suggests near misses', async () => {
  const commands = { [macroCommand('All FX off')]: true, [macroCommand('Increase Volume +3dB')]: false };
  const b = bridge({ commands });
  assert.deepEqual(await listMacros(b.call, { filter: 'volume', withState: true }), [{ title: 'Increase Volume +3dB', enabled: false }]);
  const r = await runMacro(b.call, { title: 'all fx off' });
  assert.deepEqual(r, { macro: 'All FX off', executed: true });
  assert.ok(b.calls.some(([op, a]) => op === 'command' && a.category === 'Macros' && a.name === macroCommand('All FX off')));
  assert.deepEqual(await runMacro(b.call, { title: 'All FX off', checkOnly: true }), { macro: 'All FX off', enabled: true });
  await assert.rejects(runMacro(b.call, { title: 'Volume' }), /did you mean: Increase Volume \+3dB/);
});
