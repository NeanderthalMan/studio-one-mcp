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

export function resolveSong(song) {
  if (song.endsWith('.song') && existsSync(song)) return song;
  const hits = listSongs({ query: song, limit: 1000 });
  const exact = hits.filter((h) => h.title.toLowerCase() === song.toLowerCase());
  if (exact.length === 1 || hits.length === 1) return (exact[0] || hits[0]).path;
  if (!hits.length) throw new Error(`No song matching "${song}". Use song_list to see titles, or pass a full .song path.`);
  throw new Error(`"${song}" matches ${hits.length} songs: ${hits.slice(0, 10).map((h) => h.title).join(', ')}. Be more specific or pass the path.`);
}
