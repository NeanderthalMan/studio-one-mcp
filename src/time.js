// Song positions: seconds (a number) or a bar position like "9.1.1.0". Bars are
// turned into seconds by putting the playhead there and reading it back (the
// transport's time parameter parses them), so that needs Studio One stopped;
// the playhead is put back.
export async function toSeconds(call, at) {
  if (at === undefined || at === null) return at;
  if (typeof at === 'number') {
    if (at < 0) throw new Error('positions are >= 0 seconds');
    return at;
  }
  const [s] = await manyToSeconds(call, [at]);
  return s;
}

export async function manyToSeconds(call, list) {
  if (list.every((x) => typeof x === 'number')) return list;
  const { transport } = await call('song');
  if (transport.playing) throw new Error('stop playback first, or give positions in seconds: bars are converted by moving the playhead');
  const out = [];
  try {
    for (const at of list) {
      if (typeof at === 'number') out.push(at);
      else if (typeof at === 'string' && /^\d+(\.\d+){0,3}$/.test(at)) out.push((await call('setTransport', { positionBars: at })).position.seconds);
      else throw new Error(`position must be seconds or bars like "9.1.1.0", not ${JSON.stringify(at)}`);
    }
  } finally {
    await call('setTransport', { positionSeconds: transport.position.seconds });
  }
  return out;
}
