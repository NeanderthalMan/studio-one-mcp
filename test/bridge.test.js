// Drives the mailbox client against a fake device that behaves like
// BridgeComponent.js: heartbeat in status.json, answer request.json once per id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bridgeStatus, call } from '../src/bridge.js';

function fakeDevice(dir, handle) {
  let lastId = null;
  const beat = () => writeFileSync(join(dir, 'status.json'), '\uFEFF' + JSON.stringify({ protocol: 1, session: 'abc', heartbeat: Date.now() }));
  beat();
  const timer = setInterval(() => {
    beat();
    let req;
    try {
      req = JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8'));
    } catch {
      return;
    }
    if (req.id === lastId) return;
    lastId = req.id;
    let res;
    try {
      res = { id: req.id, ok: true, result: handle(req.op, req.args) };
    } catch (e) {
      res = { id: req.id, ok: false, error: e.message };
    }
    writeFileSync(join(dir, 'response.json'), '\uFEFF' + JSON.stringify(res) + '\n');
  }, 30);
  return () => clearInterval(timer);
}

test('status: not loaded, loaded, closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 's1mb-'));
  assert.equal(bridgeStatus(dir).loaded, false);
  writeFileSync(join(dir, 'status.json'), '\uFEFF' + JSON.stringify({ protocol: 1, heartbeat: 1 }));
  assert.equal(bridgeStatus(dir).loaded, true);
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ protocol: 1, closed: true }));
  assert.match(bridgeStatus(dir).reason, /closed/);
});

test('round trip, sequential requests, and device errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 's1mb-'));
  const stop = fakeDevice(dir, (op, args) => {
    if (op === 'boom') throw new Error('nope');
    return { op, args };
  });
  try {
    let nudges = 0;
    const opts = { dir, nudge: () => nudges++ };
    const [a, b] = await Promise.all([call('ping', {}, opts), call('echo', { x: 1 }, opts)]);
    assert.ok(nudges >= 2, 'each request rings the doorbell');
    assert.deepEqual(a, { op: 'ping', args: {} });
    assert.deepEqual(b, { op: 'echo', args: { x: 1 } });
    await assert.rejects(call('boom', {}, opts), /Studio One: nope/);
  } finally {
    stop();
  }
});

test('times out with a helpful message when nobody answers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 's1mb-'));
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ protocol: 1, heartbeat: 1 }));
  let nudges = 0;
  await assert.rejects(call('ping', {}, { dir, timeoutMs: 400, nudge: () => nudges++ }), /did not answer "ping" within 400ms/);
  assert.ok(nudges >= 2, 'keeps ringing while waiting');
});

test('a doorbell failure (no MIDI port) surfaces as the error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 's1mb-'));
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ protocol: 1, heartbeat: 1 }));
  await assert.rejects(call('ping', {}, { dir, nudge: () => { throw new Error('No MIDI output matching "IAC"'); } }), /No MIDI output/);
  // and the queue is not poisoned for the next call
  await assert.rejects(call('ping', {}, { dir, timeoutMs: 100, nudge: () => {} }), /did not answer/);
});
