// live_mix_snapshot over a fake bridge and a temp folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mixSnapshot } from '../src/mixsnap.js';

function bridge() {
  const channels = [
    { label: 'Vox', volume: 0.8, pan: 0.5, mute: 0, solo: 0, monitor: 0, recordArmed: 1, automation: 'off' },
    { label: 'Gtr', volume: 0.7, pan: 0.3, mute: 0, solo: 0, monitor: 1 },
    { label: 'Main', volume: 1, pan: 0.5, mute: 0, solo: 0, monitor: null },
    { label: 'Dup', volume: 1, pan: 0.5, mute: 0, solo: 0 }, { label: 'Dup', volume: 1, pan: 0.5, mute: 0, solo: 0 },
  ];
  const sends = { Vox: [{ index: 0, to: 'Reverb', level: 0.3, muted: false }] };
  const calls = [];
  const call = async (op, a) => {
    calls.push([op, a]);
    switch (op) {
      case 'song': return { title: 'My Song' };
      case 'channels': return channels.map((c) => ({ ...c }));
      case 'sends': return Object.entries(sends).map(([channel, s]) => ({ channel, sends: s.map((x) => ({ ...x })) }));
      case 'setChannel': channels.find((c) => c.label === a.channel)[a.field] = a.value; return {};
      case 'setSend': Object.assign(sends[a.channel].find((x) => x.index === a.index), a.level !== undefined ? { level: a.level } : {}, a.muted !== undefined ? { muted: a.muted } : {}); return {};
      default: throw new Error(`unexpected ${op}`);
    }
  };
  return { call, calls, channels, sends };
}

test('save, change the mix, restore: only differing values are set, sends included', async () => {
  const b = bridge();
  const dir = mkdtempSync(join(tmpdir(), 's1mix-'));
  const saved = await mixSnapshot(b.call, { action: 'save', name: 'rough mix' }, { dir });
  assert.equal(saved.channels, 3);
  assert.deepEqual(saved.skipped, ['Dup (more than one channel has this name)']);
  b.channels[0].volume = 0.2;
  b.channels[1].mute = 1;
  b.sends.Vox[0].level = 0.9;
  b.sends.Vox[0].muted = true;
  const r = await mixSnapshot(b.call, { action: 'restore', name: 'rough mix' }, { dir });
  assert.deepEqual(r.changes, ['Vox volume', 'Vox send 0', 'Gtr mute']);
  assert.deepEqual([b.channels[0].volume, b.channels[1].mute, b.sends.Vox[0].level, b.sends.Vox[0].muted], [0.8, 0, 0.3, false]);
  assert.ok(!b.calls.some(([op, a]) => op === 'setChannel' && ['recordArmed', 'automation'].includes(a.field)), 'arm and automation are not part of a mix');
  assert.deepEqual((await mixSnapshot(b.call, { action: 'list' }, { dir })).snapshots.map((s) => [s.name, s.channels]), [['rough mix', 3]]);
});

test('restore reports channels that are gone and sends that now go elsewhere', async () => {
  const b = bridge();
  const dir = mkdtempSync(join(tmpdir(), 's1mix-'));
  await mixSnapshot(b.call, { action: 'save', name: 'A' }, { dir });
  b.channels[1].label = 'Guitar';
  b.sends.Vox[0].to = 'Delay';
  const r = await mixSnapshot(b.call, { action: 'restore', name: 'A' }, { dir });
  assert.deepEqual(r.skipped, ['Vox send 0 to Reverb (not there now)', 'Gtr (not in the mixer now, or its name is shared)']);
  await assert.rejects(mixSnapshot(b.call, { action: 'restore', name: 'B' }, { dir }), /no mix snapshot "B" for My Song/);
  await assert.rejects(mixSnapshot(b.call, { action: 'save' }, { dir }), /needs name/);
});
