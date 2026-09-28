// BridgeComponent.js: the doorbell (paramChanged) and the mixer operations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeHost, fakeMixer, loadComponent, MAILBOX } from './helpers/s1host.js';

const plain = (v) => JSON.parse(JSON.stringify(v)); // values from the vm realm

function setup({ config = { mailbox: MAILBOX }, channels } = {}) {
  const host = fakeHost();
  const mixer = fakeMixer(
    channels || [
      { label: 'Vox', volume: 0.8, recordArmed: 1 },
      { label: 'Bass', pan: 0.3, mute: 1 },
      { label: 'Main L/R' },
    ],
  );
  const loaded = loadComponent({ host, config, mixer });
  let n = 0;
  const ring = (op, args) => {
    const id = `r${++n}`;
    host.client.write('request.json', { id, op, args });
    loaded.component.paramChanged(loaded.params[0]); // the MIDI note toggling bridgeTick
    const res = host.client.read('response.json');
    assert.equal(res && res.id, id, 'the doorbell produced an answer');
    return res;
  };
  return { host, mixer, ring, ...loaded };
}

test('registers the bridgeTick param and starts the bridge', () => {
  const { params, host } = setup();
  assert.deepEqual(params.map((p) => p.name), ['bridgeTick']);
  assert.equal(host.client.read('status.json').protocol, 1);
});

test('a bridgeTick change answers the pending request and counts the midi clock', () => {
  const { ring, host, component } = setup();
  assert.equal(ring('ping').result.pong, true);
  component.bridge.beat(true);
  assert.equal(host.client.read('status.json').clocks.midi, 1);
});

test('other params go to the base class, not the bridge', () => {
  const { component, host } = setup();
  host.client.write('request.json', { id: 'x', op: 'ping' });
  component.paramChanged({ name: 'somethingElse' });
  assert.equal(host.client.raw('response.json'), undefined);
});

test('no BridgeConfig: logs and stays inert instead of throwing', () => {
  const host = fakeHost();
  const { component } = loadComponent({ host, config: { mailbox: 'not-a-file-url' }, mixer: fakeMixer([]) });
  assert.equal(component.bridge, null);
  assert.match(host.logs.join('\n'), /BridgeConfig/);
  component.paramChanged({}); // must not throw
});

test('channels: live values from the mixer bank', () => {
  const { ring } = setup();
  const res = ring('channels');
  assert.equal(res.ok, true);
  assert.deepEqual(plain(res.result).map((c) => [c.index, c.label, c.volume, c.pan, c.mute, c.recordArmed]), [
    [0, 'Vox', 0.8, 0.5, 0, 1],
    [1, 'Bass', 1, 0.3, 1, 0],
    [2, 'Main L/R', 1, 0.5, 0, 0],
  ]);
});

test('automation: mode per channel by name; setAutomation validates and reports before/after', () => {
  const { ring, mixer } = setup({ channels: [{ label: 'A', automationMode: 1 }, { label: 'B' }] });
  assert.deepEqual(plain(ring('channels').result).map((c) => [c.label, c.automation]), [['A', 'read'], ['B', 'off']]);
  assert.deepEqual(plain(ring('setAutomation', { channel: 'B', mode: 'touch' }).result), { channel: 'B', before: 'off', after: 'touch' });
  assert.equal(mixer.elements[1].params.automationMode, 2);
  assert.match(ring('setAutomation', { channel: 'B', mode: 'loud' }).error, /mode must be one of off, read/);
  assert.match(ring('setAutomation', { channel: 'Z', mode: 'off' }).error, /no channel named Z/);
});

test('channels: unlabeled and disconnected strips are skipped', () => {
  const { ring, mixer } = setup({ channels: [{ label: 'A' }, { label: '' }, { label: 'C' }] });
  mixer.elements[2].isConnected = () => false;
  assert.deepEqual(plain(ring('channels').result).map((c) => c.label), ['A']);
});

test('channels without a surface model is a clean error (the 5.5.2 this.model bug)', () => {
  const host = fakeHost();
  const { component, params } = loadComponent({ host, config: { mailbox: MAILBOX }, mixer: null });
  host.client.write('request.json', { id: 'm', op: 'channels' });
  component.paramChanged(params[0]);
  assert.match(host.client.read('response.json').error, /surface model not available/);
});

test('setChannel: before/after, and the change reaches the mixer', () => {
  const { ring, mixer } = setup();
  const res = ring('setChannel', { channel: 'Bass', field: 'mute', value: 0 });
  assert.deepEqual(plain(res.result), { channel: 'Bass', field: 'mute', before: 1, after: 0 });
  assert.equal(mixer.elements[1].params.mute, 0);
  ring('setChannel', { channel: 'Vox', field: 'volume', value: 0.5 });
  assert.equal(mixer.elements[0].params.volume, 0.5);
});

test('setChannel: unknown channel, ambiguous name, bad field', () => {
  const { ring } = setup({ channels: [{ label: 'Gtr' }, { label: 'Gtr' }, { label: 'Keys' }] });
  assert.match(ring('setChannel', { channel: 'Drums', field: 'mute', value: 1 }).error, /no channel named Drums/);
  assert.match(ring('setChannel', { channel: 'Gtr', field: 'mute', value: 1 }).error, /ambiguous/);
  assert.match(ring('setChannel', { channel: 'Keys', field: 'color', value: 1 }).error, /field must be one of/);
});

test('onExit closes the bridge', () => {
  const { component, host } = setup();
  component.onExit();
  assert.equal(host.client.read('status.json').closed, true);
  assert.equal(component.bridge, null);
});

test('meters: left/right peak dB per channel', () => {
  const { ring, mixer } = setup();
  mixer.elements[0].params.level1 = -12.5;
  mixer.elements[0].params.level2 = -13;
  const m = plain(ring('meters').result);
  assert.deepEqual(m[0], { label: 'Vox', left: -12.5, right: -13 });
  assert.deepEqual(m.map((c) => c.label), ['Vox', 'Bass', 'Main L/R']);
});
