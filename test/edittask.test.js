// The MCP Edit task (device/EditTasks/package/McpEdit.js) under node:vm, with a
// fake host: mailbox files, and an edit context shaped like the one Studio One
// 5.5.2 handed the probe (iterator over the selected notes; functions).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../device/EditTasks/package/McpEdit.js', import.meta.url)), 'utf8');
const MAILBOX = 'file:///mb/';

function load() {
  const files = new Map();
  const Host = {
    Url: (u) => ({ url: u }),
    IO: {
      File: (u) => ({ exists: () => files.has(u.url) }),
      openTextFile: (u) => { const lines = files.get(u.url).split('\n'); let i = 0; return { readLine: () => lines[i++], close() {} }; },
      createTextFile: (u) => { let buf = ''; return { writeString: (s) => (buf += s), close: () => files.set(u.url, '﻿' + buf) }; },
    },
    Results: { kResultOk: 0, kResultFailed: 1 },
    Interfaces: { IEditTask: 'IEditTask' },
  };
  const ctx = vm.createContext({ Host, include_file: () => {}, McpEditConfig: { mailbox: MAILBOX } });
  vm.runInContext(source, ctx);
  const task = vm.runInContext('createMcpEdit()', ctx);
  return {
    task,
    request: (ops, id = 'r1') => files.set(MAILBOX + 'edit-request.json', JSON.stringify({ id, ops }) + '\n'),
    result: () => JSON.parse(files.get(MAILBOX + 'edit-result.json').replace(/^﻿/, '')),
  };
}

// Notes as the probe saw them: pitch, velocity 0..1, startTime/endTime.time in beats.
function editContext(specs, { activeRegion = { id: 'region' } } = {}) {
  const region = { id: 'region' };
  const notes = specs.map(([pitch, start, length, velocity = 0.8]) => ({ pitch, velocity, startTime: { time: start }, endTime: { time: start + length }, region }));
  const calls = [];
  const functions = {
    modifyPitch: (n, p) => { calls.push('pitch'); n.pitch = p; },
    modifyVelocity: (n, v) => { calls.push('velocity'); n.velocity = v; },
    moveEvent: (n, t) => { const len = n.endTime.time - n.startTime.time; n.startTime.time = t; n.endTime.time = t + len; },
    resizeEvent: (n, len) => { n.endTime.time = n.startTime.time + len; },
    deleteEvent: (n) => { n.deleted = true; },
    createEvent: () => ({ pitch: 60, velocity: 0.8, startTime: { time: 0 }, endTime: { time: 1 } }),
    insertEvent: (r, n) => { n.region = r; notes.push(n); },
    freezeVelocity: () => {},
  };
  let k = 0;
  const snapshot = [...notes];
  const iterator = { done: () => k >= snapshot.length, next: () => snapshot[k++] || null };
  return { context: { iterator, functions, activeRegion }, notes, calls };
}

test('transpose, velocity (set and add), move and length, in order, with filters', () => {
  const { task, request, result } = load();
  const { context, notes } = editContext([[64, 4.5, 0.25], [53, 5.5, 0.1], [53, 6, 0.5]]);
  request([
    { op: 'transpose', semitones: 12, filter: { pitch: 53 } },
    { op: 'velocity', set: 127, filter: { from: 5, to: 6 } },
    { op: 'velocity', add: -200, filter: { pitch: 64 } },
    { op: 'move', beats: -0.5, filter: { pitches: [65] } },
    { op: 'length', scale: 2, filter: { from: 5.5 } }, // the note moved from 6 to 5.5 just before
  ]);
  assert.equal(task.performEdit(context), 0);
  const r = result();
  assert.deepEqual(r.applied, [{ op: 'transpose', notes: 2 }, { op: 'velocity', notes: 1 }, { op: 'velocity', notes: 1 }, { op: 'move', notes: 2 }, { op: 'length', notes: 1 }]);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(notes.map((n) => n.pitch), [64, 65, 65]);
  assert.deepEqual(notes.map((n) => Math.round(n.velocity * 127)), [1, 127, 102], 'velocity clamps to 1..127');
  assert.deepEqual(notes.map((n) => n.startTime.time), [4.5, 5, 5.5], 'the transposed notes moved');
  assert.equal(notes[2].endTime.time - notes[2].startTime.time, 1, 'length doubled');
  assert.equal(r.id, 'r1');
});

test('delete needs a filter; add inserts into the part of the existing notes', () => {
  const { task, request, result } = load();
  const { context, notes } = editContext([[60, 4, 1], [62, 5, 1]]);
  request([
    { op: 'delete' },
    { op: 'delete', filter: { pitch: 62 } },
    { op: 'add', notes: [{ pitch: 67, beat: 6, length: 0.5, velocity: 90 }, { pitch: 69, beat: 7 }] },
  ]);
  task.performEdit(context);
  const r = result();
  assert.deepEqual(r.applied.map((a) => a.notes), [0, 1, 1]);
  assert.match(r.errors.join('; '), /delete needs a filter/);
  assert.match(r.errors.join('; '), /each note needs pitch, beat, length/);
  assert.equal(notes.find((n) => n.pitch === 62).deleted, true);
  const added = notes.find((n) => n.pitch === 67);
  assert.deepEqual([added.startTime.time, added.endTime.time, Math.round(added.velocity * 127), added.region.id], [6, 6.5, 90, 'region']);
});

test('an empty part adds into the active region; no request is reported, not thrown', () => {
  const { task, request, result } = load();
  const empty = editContext([], { activeRegion: { id: 'active' } });
  request([{ op: 'add', notes: [{ pitch: 60, beat: 4, length: 1 }] }]);
  task.performEdit(empty.context);
  assert.equal(empty.notes[0].region.id, 'active');
  const none = load();
  assert.equal(none.task.performEdit(editContext([]).context), 0);
  assert.equal(none.result().error, 'no edit request');
  const bad = load();
  bad.request([{ op: 'explode' }]);
  bad.task.performEdit(editContext([[60, 0, 1]]).context);
  assert.match(bad.result().errors[0], /unknown op explode/);
});
