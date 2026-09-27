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

test('not connected without a heartbeat', () => {
  const dir = mkdtempSync(join(tmpdir(), 's1mb-'));
  assert.equal(bridgeStatus(dir).connected, false);
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ protocol: 1, heartbeat: Date.now() - 60000 }));
  assert.match(bridgeStatus(dir).reason, /heartbeat/);
});

test('round trip, sequential requests, and device errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 's1mb-'));
  const stop = fakeDevice(dir, (op, args) => {
    if (op === 'boom') throw new Error('nope');
    return { op, args };
  });
  try {
    assert.equal(bridgeStatus(dir).connected, true);
    const [a, b] = await Promise.all([call('ping', {}, { dir }), call('echo', { x: 1 }, { dir })]);
    assert.deepEqual(a, { op: 'ping', args: {} });
    assert.deepEqual(b, { op: 'echo', args: { x: 1 } });
    await assert.rejects(call('boom', {}, { dir }), /Studio One: nope/);
  } finally {
    stop();
  }
});
