// live_bounce over a fake bridge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bounce } from '../src/bounce.js';

function bridge({ playing = false } = {}) {
  let tracks = [
    { index: 2, name: 'Gtr', events: [{ name: 'a', start: 0, end: 4, muted: false }, { name: 'b', start: 4, end: 8, muted: false }] },
    { index: 3, name: 'Empty', events: [] },
    { index: 4, name: 'Dup', events: [] }, { index: 5, name: 'Dup', events: [] },
  ];
  let selected = ['Keys'];
  let eventsOn = null;
  const calls = [];
  const call = async (op, a) => {
    calls.push([op, a]);
    switch (op) {
      case 'song': return { transport: { playing }, selectedTracks: [...selected] };
      case 'tracks': return tracks.filter((t) => !a.name || t.name.includes(a.name)).map((t) => ({ ...t, events: a.events === false ? undefined : t.events }));
      case 'selectEvents':
        if (a.none) { eventsOn = null; return { events: 'none' }; }
        eventsOn = a.track; selected = [a.track];
        return { selectedTracks: selected, eventCommandsEnabled: tracks.find((t) => t.name === a.track).events.length > 0 };
      case 'selectTrack': selected = a.exclusive === false ? [...selected, a.name] : [a.name]; return { selected };
      case 'command': {
        const src = tracks.find((t) => t.name === eventsOn);
        if (a.name === 'Bounce Selection') src.events = [{ name: src.name, start: 0, end: 8, muted: false }];
        if (a.name === 'Bounce To New Track') {
          const copy = { index: src.index + 1, name: src.name, events: [{ name: `${src.name}(3)`, start: 0, end: 8, muted: false }] };
          src.events = src.events.map((e) => ({ ...e, muted: true }));
          tracks = [...tracks.filter((t) => t.index <= src.index), copy, ...tracks.filter((t) => t.index > src.index).map((t) => ({ ...t, index: t.index + 1 }))];
        }
        return { executed: true };
      }
      default: throw new Error(`unexpected ${op}`);
    }
  };
  return { call, calls, selected: () => selected };
}

test('inPlace: one event after; Snap argument; selection restored', async () => {
  const b = bridge();
  const r = await bounce(b.call, { track: 'Gtr' });
  assert.deepEqual(r.events.map((e) => [e.start, e.end]), [[0, 8]]);
  assert.deepEqual(b.calls.find(([op]) => op === 'command')[1].args, ['Snap', '']);
  assert.deepEqual(b.selected(), ['Keys']);
});

test('toNewTrack: originals muted, the new same-named track reported', async () => {
  const b = bridge();
  const r = await bounce(b.call, { track: 'Gtr', mode: 'toNewTrack' });
  assert.ok(r.original.every((e) => e.muted));
  assert.equal(r.newTrack.index, 3);
  assert.equal(r.newTrack.events[0].name, 'Gtr(3)');
});

test('refuses: playing, ambiguous or unknown track, no events, bad mode', async () => {
  await assert.rejects(bounce(bridge({ playing: true }).call, { track: 'Gtr' }), /stop playback/);
  await assert.rejects(bounce(bridge().call, { track: 'Dup' }), /ambiguous/);
  await assert.rejects(bounce(bridge().call, { track: 'Nope' }), /no track named/);
  const b = bridge();
  await assert.rejects(bounce(b.call, { track: 'Empty' }), /no events to bounce/);
  assert.deepEqual(b.selected(), ['Keys'], 'selection restored after a refusal too');
  await assert.rejects(bounce(bridge().call, { track: 'Gtr', mode: 'stems' }), /mode must be/);
});
