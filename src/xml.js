// Tiny normalised XML tree over fast-xml-parser: every element becomes
// { tag, attrs, children }. Studio One files lean on `x:id` to name child roles
// (<Attributes x:id="Inserts">, <List x:id="Tracks">), so helpers look those up.
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseAttributeValue: false,
  trimValues: true,
});

function normalise(items) {
  const out = [];
  for (const item of items) {
    const tag = Object.keys(item).find((k) => k !== ':@');
    if (!tag || tag === '#text' || tag.startsWith('?')) continue;
    out.push({ tag, attrs: item[':@'] || {}, children: normalise(item[tag] || []) });
  }
  return out;
}

export function parseXml(text) {
  const roots = normalise(parser.parse(text.replace(/^﻿/, '')));
  return roots[0] || null;
}

export const kids = (node, tag) => (node ? node.children.filter((c) => !tag || c.tag === tag) : []);
export const child = (node, tag) => kids(node, tag)[0] || null;
export const byXid = (node, xid) => (node ? node.children.find((c) => c.attrs['x:id'] === xid) || null : null);

export function* walk(node) {
  if (!node) return;
  yield node;
  for (const c of node.children) yield* walk(c);
}

export const num = (v, dflt = 0) => {
  const n = Number(v);
  return v === undefined || v === '' || !Number.isFinite(n) ? dflt : n;
};
