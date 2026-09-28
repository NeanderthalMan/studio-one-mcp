// Tempo changes in the running song, from the bridge's transport ops alone.
//
// Seen on Studio One 5.5.2:
//  - The transport's tempo parameter reads and writes the tempo of the segment
//    under the playhead, so moving the playhead samples the tempo map.
//  - "Tempo/Insert" adds a tempo point at the playhead (same tempo as before).
//    Inserting and then setting its tempo are two undo steps.
//  - "Tempo/Delete" does not delete the point at the playhead (it changed a
//    different part of the map), so it is not offered; undo removes points.

const locate = (call, at) => call('setTransport', typeof at === 'string' ? { positionBars: at } : { positionSeconds: at });

export async function tempo(call, { action, at, bpm }) {
  const t0 = (await call('song')).transport;
  if (t0.playing) throw new Error('stop playback first: reading or changing the tempo map moves the playhead');
  const here = at === undefined ? t0.position.seconds : at;
  const sample = async (x) => {
    const t = await locate(call, x);
    return { at: x, seconds: t.position.seconds, bar: t.position.display, bpm: t.tempo };
  };
  try {
    switch (action) {
      case 'at': {
        const list = Array.isArray(at) ? at : [here];
        const out = [];
        for (const x of list) out.push(await sample(x));
        return { tempo: out };
      }
      case 'set': {
        if (typeof bpm !== 'number') throw new Error('set needs bpm');
        const before = await sample(here);
        await call('setTransport', { tempo: bpm });
        return { before, after: await sample(here), note: 'Changes the tempo segment that contains this position.' };
      }
      case 'insert': {
        if (typeof bpm !== 'number') throw new Error('insert needs bpm');
        if (Array.isArray(at)) throw new Error('insert takes one position');
        await locate(call, here);
        const r = await call('command', { category: 'Tempo', name: 'Insert' });
        if (!r.executed) throw new Error('Tempo/Insert did not run');
        await call('setTransport', { tempo: bpm });
        return { inserted: await sample(here), note: 'Two undo steps: live_undo with steps 2 removes this tempo change.' };
      }
      default:
        throw new Error(`unknown action ${action}`);
    }
  } finally {
    await call('setTransport', { positionSeconds: t0.position.seconds });
  }
}
