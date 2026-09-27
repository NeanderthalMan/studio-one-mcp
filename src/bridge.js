// Client side of the file mailbox (see device/StudioOneMCP/BridgeComponent.js).
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mailboxDir } from './paths.js';

const STALE_MS = 6000; // the device heartbeats every 2s

const readJson = (p) => {
  try {
    // Studio One's createTextFile writes a UTF-8 BOM.
    return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
};

export function bridgeStatus(dir = mailboxDir) {
  const s = readJson(join(dir, 'status.json'));
  if (!s) return { connected: false, reason: 'No status.json yet — is the MCP Bridge device added in Studio One (Options → External Devices)?' };
  if (s.closed) return { connected: false, reason: 'Studio One closed the bridge (song/app closed).', ...s };
  const age = Date.now() - s.heartbeat;
  if (age > STALE_MS) return { connected: false, reason: `Last heartbeat ${Math.round(age / 1000)}s ago — Studio One is not running or the device is disabled.`, ...s };
  return { connected: true, ...s };
}

let queue = Promise.resolve();

// One request in flight at a time: the mailbox has a single slot.
export function call(op, args = {}, { timeoutMs = 5000, dir = mailboxDir } = {}) {
  const run = async () => {
    const status = bridgeStatus(dir);
    if (!status.connected) throw new Error(`Studio One bridge not connected: ${status.reason}`);
    mkdirSync(dir, { recursive: true });
    const id = randomUUID();
    const tmp = join(dir, `request.${id}.tmp`);
    writeFileSync(tmp, JSON.stringify({ id, op, args }) + '\n');
    renameSync(tmp, join(dir, 'request.json'));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 40));
      const res = readJson(join(dir, 'response.json'));
      if (res && res.id === id) {
        if (!res.ok) throw new Error(`Studio One: ${res.error}`);
        return res.result;
      }
    }
    throw new Error(`Studio One did not answer "${op}" within ${timeoutMs}ms`);
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}
