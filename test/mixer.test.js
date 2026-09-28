// Inserts and sends on the component, against the fake mixer's sub-banks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeHost, fakeMixer, loadComponent, MAILBOX } from './helpers/s1host.js';

const plain = (v) => JSON.parse(JSON.stringify(v));

function setup() {
  const host = fakeHost();
  const mixer = fakeMixer([
    { label: 'Vox', inserts: [{ name: 'Pro EQ' }, { name: 'Compressor', bypassed: true }], sends: [{ to: 'Reverb', level: 0.3 }] },
    { label: 'Bass', inserts: [{ name: '' }] },
    { label: 'Main L/R', inserts: [{ name: 'Limiter' }] },
  ]);
  const { component, params } = loadComponent({ host, config: { mailbox: MAILBOX }, mixer });
  let n = 0;
  const ring = (op, args) => {
    const id = `m${++n}`;
    host.client.write('request.json', { id, op, args });
    component.paramChanged(params[0]);
    return host.client.read('response.json');
  };
  return { ring, mixer };
}

test('inserts: names and bypass per channel; empty slots skipped', () => {
  const { ring } = setup();
  const r = plain(ring('inserts', {}).result);
  assert.deepEqual(r.map((c) => [c.channel, c.inserts.map((i) => `${i.slot}:${i.name}${i.bypassed ? ' (off)' : ''}`)]), [
    ['Vox', ['0:Pro EQ', '1:Compressor (off)']],
    ['Bass', []],
    ['Main L/R', ['0:Limiter']],
  ]);
  assert.deepEqual(plain(ring('inserts', { channel: 'Main L/R' }).result).length, 1);
  assert.match(ring('inserts', { channel: 'Drums' }).error, /no channel named Drums/);
});

test('setInsertBypass: one slot, or the whole rack', () => {
  const { ring, mixer } = setup();
  assert.deepEqual(plain(ring('setInsertBypass', { channel: 'Vox', slot: 0, bypassed: true }).result), { channel: 'Vox', slot: 0, before: false, after: true });
  assert.equal(mixer.elements[0].params['Inserts/[0]/@bypass'], 1);
  assert.equal(plain(ring('setInsertBypass', { channel: 'Vox', slot: 'all', bypassed: true }).result).after, true);
  assert.equal(mixer.elements[0].params['Inserts/bypassAll'], 1);
  assert.match(ring('setInsertBypass', { channel: 'Vox', slot: 5, bypassed: true }).error, /no plug-in in slot 5/);
  assert.match(ring('setInsertBypass', { channel: 'Nope', slot: 0, bypassed: true }).error, /no channel named/);
});

test('sends: listed per channel; channels without sends omitted unless asked', () => {
  const { ring } = setup();
  assert.deepEqual(plain(ring('sends', {}).result), [{ channel: 'Vox', sends: [{ index: 0, to: 'Reverb', level: 0.3, muted: false }] }]);
  assert.deepEqual(plain(ring('sends', { channel: 'Bass' }).result), [{ channel: 'Bass', sends: [] }]);
});

test('setSend: level and mute; validation', () => {
  const { ring, mixer } = setup();
  const r = plain(ring('setSend', { channel: 'Vox', index: 0, level: 0.8, muted: true }).result);
  assert.deepEqual(r.send, { index: 0, to: 'Reverb', level: 0.8, muted: true });
  assert.equal(mixer.elements[0].banks.sends.els[0].params.sendlevel, 0.8);
  assert.match(ring('setSend', { channel: 'Vox', index: 0, level: 2 }).error, /level must be 0..1/);
  assert.match(ring('setSend', { channel: 'Vox', index: 3, level: 0.1 }).error, /no send 3/);
});
