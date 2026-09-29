// Musical grid names to quarter-note beats (the unit notes are edited in):
// "1/16" -> 0.25; "1/8T" triplet (x 2/3); "1/8." dotted (x 3/2); a number is beats.
export function gridBeats(grid) {
  if (typeof grid === 'number' && grid > 0) return grid;
  const m = /^1\/(\d+)\s*([tT.])?$/.exec(String(grid ?? '').trim());
  if (!m || Number(m[1]) <= 0) throw new Error('grid must look like "1/16", "1/8T" or "1/8.", or be a number of beats');
  const beats = 4 / Number(m[1]);
  return m[2] === '.' ? beats * 1.5 : m[2] ? (beats * 2) / 3 : beats;
}
