// Decoder for UBJSON (Universal Binary JSON), the format of a .song's
// Performances/*.musicx (instrument notes) and Envelopes/*.envelopex (automation).
// Big-endian numbers; object keys are length-prefixed strings without the 'S'.
export function decodeUbjson(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  let i = 0;
  const int = (m) => {
    switch (m) {
      case 'i': return b.readInt8((i += 1) - 1);
      case 'U': return b.readUInt8((i += 1) - 1);
      case 'I': return b.readInt16BE((i += 2) - 2);
      case 'l': return b.readInt32BE((i += 4) - 4);
      case 'L': return Number(b.readBigInt64BE((i += 8) - 8));
      default: throw new Error(`ubjson: bad length marker ${m} at ${i - 1}`);
    }
  };
  const marker = () => String.fromCharCode(b[i++]);
  const str = () => { const n = int(marker()); const s = b.toString('utf8', i, i + n); i += n; return s; };
  const value = (m = marker()) => {
    switch (m) {
      case 'Z': return null;
      case 'T': return true;
      case 'F': return false;
      case 'i': case 'U': case 'I': case 'l': case 'L': return int(m);
      case 'd': return b.readFloatBE((i += 4) - 4);
      case 'D': return b.readDoubleBE((i += 8) - 8);
      case 'C': return String.fromCharCode(b[i++]);
      case 'S': case 'H': return str();
      case '[': { const a = []; while (b[i] !== 0x5d) { if (b[i] === 0x4e) { i++; continue; } a.push(value()); } i++; return a; }
      case '{': { const o = {}; while (b[i] !== 0x7d) { if (b[i] === 0x4e) { i++; continue; } const k = str(); o[k] = value(); } i++; return o; }
      case 'N': return value();
      default: throw new Error(`ubjson: unknown marker ${m} at ${i - 1}`);
    }
  };
  return value();
}
