// BridgeCore.js (runs inside Studio One) against a fake host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeHost, loadCore, MAILBOX } from './helpers/s1host.js';

const COMMANDS = [
  { category: 'Transport', name: 'Start', enabled: true },
  { category: 'Transport', name: 'Stop', enabled: true },
  { category: 'Edit', name: 'Delete', enabled: false },
];

function setup({ allowEval = false } = {}) {
  const host = fakeHost({ commands: COMMANDS });
  const { get } = loadCore({ host, config: { mailbox: MAILBOX, allowEval } });
  const Bridge = get('Bridge');
  const bridge = new Bridge({ mailbox: MAILBOX, allowEval }, null);
  let n = 0;
  const ask = (op, args) => {
    const id = `req-${++n}`;
    host.client.write('request.json', { id, op, args });
    bridge.tick('test');
    const res = host.client.read('response.json');
    assert.equal(res.id, id, 'answered this request');
    return res;
  };
  return { host, bridge, ask, get };
}

test('startup writes status.json (with the BOM Studio One writes)', () => {
  const { host, bridge } = setup();
  assert.ok(host.client.raw('status.json').startsWith('﻿'));
  const s = host.client.read('status.json');
  assert.equal(s.protocol, 1);
  assert.equal(s.session, bridge.session);
  assert.match(s.session, /^[0-9a-f]{32}$/);
  assert.equal(s.allowEval, false);
});

test('close marks status closed', () => {
  const { host, bridge } = setup();
  bridge.close();
  assert.equal(host.client.read('status.json').closed, true);
});

test('ping answers with the session', () => {
  const { ask, bridge } = setup();
  const res = ask('ping');
  assert.equal(res.ok, true);
  assert.equal(res.result.pong, true);
  assert.equal(res.result.session, bridge.session);
  assert.equal(typeof res.ms, 'number');
});

test('each request id is answered once; no request, no response', () => {
  const { host, bridge } = setup();
  bridge.tick();
  assert.equal(host.client.raw('response.json'), undefined);
  host.client.write('request.json', { id: 'a', op: 'ping' });
  bridge.tick();
  const first = host.client.raw('response.json');
  host.files.delete(MAILBOX + 'response.json');
  bridge.tick();
  assert.equal(host.client.raw('response.json'), undefined, 'same id is not answered twice');
  assert.ok(first);
});

test('ticks are counted per clock source', () => {
  const { host, bridge } = setup();
  bridge.tick('midi');
  bridge.tick('midi');
  bridge.beat(true);
  assert.equal(host.client.read('status.json').clocks.midi, 2);
});

test('malformed requests are ignored', () => {
  const { host, bridge } = setup();
  host.files.set(MAILBOX + 'request.json', '{"id": "half-writ');
  bridge.tick();
  host.client.write('request.json', { op: 'ping' }); // no id
  bridge.tick();
  assert.equal(host.client.raw('response.json'), undefined);
});

test('unknown op and missing mixer are errors, not crashes', () => {
  const { ask } = setup();
  assert.deepEqual([ask('nope').ok, ask('nope').error], [false, 'unknown op: nope']);
  assert.equal(ask('channels').ok, false);
});

test('command: runs, checks without running, and rejects unknown commands', () => {
  const { ask, host } = setup();
  assert.deepEqual(ask('command', { category: 'Transport', name: 'Start' }).result, { executed: true });
  assert.deepEqual(ask('command', { category: 'Edit', name: 'Delete' }).result, { executed: false });
  assert.deepEqual(ask('command', { category: 'Transport', name: 'Stop', checkOnly: true }).result, { enabled: true });
  assert.deepEqual(ask('command', { category: 'Edit', name: 'Delete', checkOnly: true }).result, { enabled: false });
  assert.deepEqual(host.executed.map((e) => e.command), ['Transport/Start'], 'check-only never executes');
  const unknown = ask('command', { category: 'View', name: 'Mixer' });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /unknown command: View\/Mixer/);
  assert.match(ask('command', { category: 'View' }).error, /required/);
});

test('command arguments are passed as Host.Attributes', () => {
  const { ask, host } = setup();
  ask('command', { category: 'Transport', name: 'Start', args: ['State', true] });
  assert.deepEqual(JSON.parse(JSON.stringify(host.executed[0].args)), { pairs: ['State', true] }); // vm-realm array
});

test('listCommands: all, filtered, and with enabled state', () => {
  const { ask } = setup();
  assert.equal(ask('listCommands').result.length, 3);
  assert.deepEqual(ask('listCommands', { filter: 'transport' }).result.map((c) => c.name), ['Start', 'Stop']);
  assert.deepEqual(ask('listCommands', { filter: 'delete', withState: true }).result, [{ category: 'Edit', name: 'Delete', enabled: false }]);
});

test('eval is refused unless allowEval', () => {
  const { ask } = setup();
  const res = ask('eval', { code: 'return 1' });
  assert.equal(res.ok, false);
  assert.match(res.error, /eval is disabled/);
});

test('eval runs with Host in scope and reports thrown errors', () => {
  const { ask } = setup({ allowEval: true });
  assert.equal(ask('eval', { code: 'return 1 + 1' }).result, 2);
  assert.equal(ask('eval', { code: 'return typeof Host.GUI.Commands.findCommand' }).result, 'function');
  const boom = ask('eval', { code: 'throw new Error("boom")' });
  assert.deepEqual([boom.ok, boom.error], [false, 'boom']);
});

test('describe turns host-like objects into JSON-safe data', () => {
  const { get } = setup();
  const describe = get('describe');
  assert.equal(describe(undefined), '<undefined>');
  assert.equal(describe(() => 1), '<function>');
  assert.deepEqual(describe([1, 'a', null]), [1, 'a', null]);
  const cyclic = { name: 'track' };
  cyclic.self = cyclic;
  const d = describe(cyclic, 1);
  assert.equal(d.name, 'track');
  assert.equal(d.self, '<object>', 'depth-limited instead of throwing on cycles');
});
