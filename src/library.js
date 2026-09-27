// Finding songs on disk.
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { songRoots } from './paths.js';

export function listSongs({ query, limit = 50 } = {}) {
  const out = [];
  for (const root of songRoots()) {
    for (const dir of readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const folder = join(root, dir.name);
      let files;
      try {
        files = readdirSync(folder).filter((f) => f.endsWith('.song'));
      } catch {
        continue;
      }
      const history = join(folder, 'History');
      const autosaves = existsSync(history) ? readdirSync(history)
            .filter((h) => h.endsWith('.song'))
            .sort((a, b) => statSync(join(history, a)).mtimeMs - statSync(join(history, b)).mtimeMs)
        : [];
      // A song that was never saved by hand only exists as History autosaves.
      if (!files.length && autosaves.length) {
        if (query && !dir.name.toLowerCase().includes(query.toLowerCase())) continue;
        const path = join(history, autosaves[autosaves.length - 1]);
        out.push({ title: dir.name, path, modified: statSync(path).mtime.toISOString(), autosaves: autosaves.length, unsaved: true });
        continue;
      }
      for (const f of files) {
        const path = join(folder, f);
        const title = basename(f, '.song');
        if (query && !title.toLowerCase().includes(query.toLowerCase())) continue;
        out.push({ title, path, modified: statSync(path).mtime.toISOString(), autosaves: autosaves.length });
      }
    }
  }
  return out.sort((a, b) => b.modified.localeCompare(a.modified)).slice(0, limit);
}

export function songFolder(path) {
  const d = dirname(path);
  return basename(d) === 'History' ? dirname(d) : d;
}

// Returns { path, otherMatches }. An exact title wins; otherwise the most
// recently modified match (listSongs is newest-first), naming the others so the
// caller can tell the user which song was picked.
export function resolveSong(song) {
  if (song.endsWith('.song') && existsSync(song)) return { path: song, otherMatches: [] };
  const hits = listSongs({ query: song, limit: 1000 });
  if (!hits.length) throw new Error(`No song matching "${song}". Use song_list to see titles, or pass a full .song path.`);
  const exact = hits.find((h) => h.title.toLowerCase() === song.toLowerCase());
  const pick = exact || hits[0];
  return { path: pick.path, otherMatches: exact ? [] : hits.slice(1).map((h) => h.title) };
}
