// Git's object layer, written from the protocol: SHA-1 object ids, pkt-lines,
// packfiles of plain (non-delta) objects, tree/commit parsing, reachability
// walks and a file-level three-way merge. No git binary, no outside code.
//
// Pack format (version 2): "PACK", uint32be version, uint32be count, then per
// object a type+size varint, the zlib-deflated bytes, then a 20-byte SHA-1
// trailer over everything before it.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, ObjectType, Repo } from './store.ts';
import { ZERO_OID } from './store.ts';

export const GIT_AGENT = 'forge-core-clone/1.0';

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The id of a git object: sha1("<type> <len>\0" + bytes). */
export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

// ---------------------------------------------------------------- pkt-lines

/** One pkt-line framing `payload` (payload must already end with \n when the protocol wants one). */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  if (len > 0xffff) throw new Error('pkt-line too long');
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export type PktKind = 'data' | 'flush' | 'delim';

export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

/** Decode a whole buffer of pkt-lines. Throws on a malformed frame. */
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let pos = 0;
  while (pos < buf.length) {
    if (pos + 4 > buf.length) throw new Error('truncated pkt-line header');
    const hex = buf.subarray(pos, pos + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
    const len = parseInt(hex, 16);
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (len < 4 || pos + len > buf.length) throw new Error('bad pkt-line length');
    out.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + len) });
    pos += len;
  }
  return out;
}

/** Decode pkt-lines from the start of `buf` until the first flush packet (inclusive). Returns the packets and the offset where the trailing bytes (a packfile, for receive-pack) begin. Throws on a malformed frame before the flush. */
export function decodePktPrefix(buf: Buffer): { packets: Pkt[]; packStart: number } {
  const packets: Pkt[] = [];
  let pos = 0;
  while (pos < buf.length) {
    if (pos + 4 > buf.length) throw new Error('truncated pkt-line header');
    const hex = buf.subarray(pos, pos + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
    const len = parseInt(hex, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      return { packets, packStart: pos + 4 };
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (len < 4 || pos + len > buf.length) throw new Error('bad pkt-line length');
    packets.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + len) });
    pos += len;
  }
  return { packets, packStart: pos };
}

/** Encode data packets, then a flush. `lines` may include the sentinels 'flush' | 'delim'. */
export function encodePktLines(lines: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(pktFlush());
    else if (line === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- objects

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(tree: string, parents: string[], author: string, committer: string, message: string): Buffer {
  const lines: string[] = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${author}`, `committer ${committer}`, '', message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space < 0) throw new Error('malformed tree: no space');
    const nul = data.indexOf(0x00, space);
    if (nul < 0 || nul + 21 > data.length) throw new Error('malformed tree: no NUL');
    const mode = data.subarray(pos, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

/** Git's tree sort: entries order by name, directories as if named "name/". */
export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of sortTreeEntries(entries)) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------- packs

/** Build a version-2 packfile from plain objects, in the given order. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [Buffer.from('PACK', 'ascii')];
  const version = Buffer.alloc(4);
  version.writeUInt32BE(2, 0);
  const count = Buffer.alloc(4);
  count.writeUInt32BE(objects.length, 0);
  parts.push(version, count);
  for (const object of objects) {
    const typeNum = TYPE_CODE[object.type];
    let size = object.data.length;
    const header: number[] = [];
    let first = (typeNum << 4) | (size & 0x0f);
    size >>>= 4;
    if (size > 0) first |= 0x80;
    header.push(first);
    while (size > 0) {
      let byte = size & 0x7f;
      size >>>= 7;
      if (size > 0) byte |= 0x80;
      header.push(byte);
    }
    parts.push(Buffer.from(header));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Read a version-2 packfile of plain objects. Delta types are rejected. */
export function readPack(buf: Buffer): Map<string, GitObject> {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  let pos = 12;
  for (let i = 0; i < count; i += 1) {
    if (pos >= buf.length - 20) throw new Error('pack truncated');
    let byte = buf[pos];
    pos += 1;
    const typeNum = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      if (pos >= buf.length) throw new Error('pack truncated in size');
      byte = buf[pos];
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeNum === 6 || typeNum === 7) throw new Error('delta packs are not supported');
    const type = CODE_TYPE[typeNum];
    if (type === undefined) throw new Error(`unknown pack object type ${typeNum}`);
    const { data: inflated, length: consumed } = inflateOne(buf.subarray(pos), size);
    pos += consumed;
    const oid = hashObject(type, inflated);
    objects.set(oid, { type, data: Buffer.from(inflated) });
  }
  return objects;
}

/** Adler-32, the checksum a zlib stream ends with (big-endian, 4 bytes). */
function adler32(data: Buffer): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i += 1) {
    a = (a + data[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Inflate the zlib stream starting at `buf[0]` and say how many bytes it
 * consumes. One inflate yields the object (trailing bytes are ignored); the
 * stream's end is the position of its Adler-32 checksum, verified by
 * re-inflating the prefix. Two inflates per object instead of a binary
 * search's dozen.
 */
function inflateOne(buf: Buffer, expectedSize: number): { data: Buffer; length: number } {
  const inflated = inflateSync(buf);
  if (inflated.length !== expectedSize) throw new Error('pack object size mismatch');
  const needle = Buffer.alloc(4);
  needle.writeUInt32BE(adler32(inflated), 0);
  let from = 0;
  for (;;) {
    const idx = buf.indexOf(needle, from);
    if (idx < 0) throw new Error('corrupt deflated object');
    const candidate = idx + 4;
    try {
      const check = inflateSync(buf.subarray(0, candidate));
      if (check.length === expectedSize && check.equals(inflated)) return { data: check, length: candidate };
    } catch {
      // The checksum bytes occurred inside the deflate data: keep scanning.
    }
    from = idx + 1;
  }
}

/** Verify a packfile's SHA-1 trailer. */
export function verifyPackChecksum(buf: Buffer): { ok: boolean; actual: string; expected: string } {
  if (buf.length < 20) return { ok: false, actual: '', expected: '' };
  const expected = buf.subarray(buf.length - 20).toString('hex');
  const actual = sha1Hex(buf.subarray(0, buf.length - 20));
  return { ok: actual === expected, actual, expected };
}

// ---------------------------------------------------------------- reachability

export interface FlatEntry {
  oid: string;
  mode: string;
}

/** Flatten a tree to path -> entry, walking subtrees with an index pointer (no shift). */
export function flattenTree(repo: Repo, treeOid: string): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  const stack: Array<{ oid: string; prefix: string }> = [{ oid: treeOid, prefix: '' }];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (seen.has(frame.oid)) continue;
    seen.add(frame.oid);
    const object = repo.objects.get(frame.oid);
    if (object === undefined || object.type !== 'tree') continue;
    for (const entry of parseTree(object.data)) {
      const path = frame.prefix === '' ? entry.name : `${frame.prefix}/${entry.name}`;
      if (entry.mode === '40000') {
        stack.push({ oid: entry.oid, prefix: path });
      } else {
        out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    }
  }
  return out;
}

/** Walk commits from `starts`, following parents. Returns oid -> distance from the nearest start. With `maxDepth`, commits at distance maxDepth are never visited (their parents are not followed). */
export function walkCommits(repo: Repo, starts: readonly string[], maxDepth: number | null = null): Map<string, number> {
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const start of starts) {
    if (start === ZERO_OID) continue;
    if (!dist.has(start)) {
      dist.set(start, 0);
      queue.push(start);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head];
    head += 1;
    const depth = dist.get(oid) ?? 0;
    if (maxDepth !== null && depth >= maxDepth) continue;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    const next = depth + 1;
    for (const parent of commit.parents) {
      if (!dist.has(parent)) {
        dist.set(parent, next);
        queue.push(parent);
      }
    }
  }
  return dist;
}

/** True when `ancestor` is `descendant` itself or reachable from it by parents. Stops at the first hit instead of walking the whole history. */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === ZERO_OID) return true;
  if (ancestor === descendant) return true;
  const queue: string[] = [descendant];
  const seen = new Set<string>([descendant]);
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head];
    head += 1;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

/** A merge-base: the common ancestor minimizing dist(a) + dist(b). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  if (a === ZERO_OID || b === ZERO_OID) return null;
  const distA = walkCommits(repo, [a]);
  if (distA.has(b)) return b;
  const distB = walkCommits(repo, [b]);
  let best: string | null = null;
  let bestScore = Infinity;
  for (const [oid, da] of distA) {
    const db = distB.get(oid);
    if (db === undefined) continue;
    const score = da + db;
    if (score < bestScore) {
      bestScore = score;
      best = oid;
    }
  }
  return best;
}

export interface FetchPlan {
  /** Objects to send, in send order (commits, then trees, then blobs). */
  objects: GitObject[];
  /** New shallow boundary commits. */
  shallow: string[];
  /** Old shallow commits that are no longer shallow. */
  unshallow: string[];
}

/**
 * The objects a client already holds, from its `have` lines: every object
 * reachable from a have, walking parents — except that the walk stops at the
 * client's old shallow boundary (those commits' parents are beyond the
 * boundary, so the client does not hold them). With no boundary the closure
 * is the whole history below the haves.
 */
function haveClosure(repo: Repo, haves: readonly string[], oldShallow: readonly string[]): Set<string> {
  const out = new Set<string>();
  const stop = new Set(oldShallow);
  const commits: string[] = [];
  const queue: string[] = [...haves];
  const seen = new Set<string>();
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head];
    head += 1;
    if (oid === ZERO_OID || seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    commits.push(oid);
    out.add(oid);
    if (stop.has(oid)) continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  const treeQueue: string[] = [];
  for (const oid of commits) {
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'commit') treeQueue.push(parseCommit(object.data).tree);
  }
  const seenTrees = new Set<string>();
  let t = 0;
  while (t < treeQueue.length) {
    const treeOid = treeQueue[t];
    t += 1;
    if (seenTrees.has(treeOid)) continue;
    seenTrees.add(treeOid);
    const object = repo.objects.get(treeOid);
    if (object === undefined) continue;
    out.add(treeOid);
    if (object.type !== 'tree') continue;
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '40000') treeQueue.push(entry.oid);
      else out.add(entry.oid);
    }
  }
  return out;
}

/**
 * Plan a fetch: commits reachable from `wants` within `depth` (null = all),
 * plus their trees and blobs, minus the objects the client already holds
 * (the haves' closure, stopped at its old shallow boundary).
 * `oldShallow` is the client's current shallow boundary.
 */
export function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | null,
  oldShallow: readonly string[],
): FetchPlan {
  const dist = walkCommits(repo, wants, depth);
  const sentCommits = new Set<string>();
  const cut = new Set<string>();
  for (const [oid, d] of dist) {
    if (depth === null || d < depth) sentCommits.add(oid);
    if (depth !== null && d === depth - 1) cut.add(oid);
  }
  const held = haveClosure(repo, haves, oldShallow);
  // Expand trees and blobs of the sent commits.
  const send = new Map<string, GitObject>();
  const commitList: string[] = [...sentCommits];
  const treeQueue: string[] = [];
  for (const oid of commitList) {
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    if (!held.has(oid)) send.set(oid, object);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      treeQueue.push(commit.tree);
    }
  }
  const seenTrees = new Set<string>();
  let head = 0;
  while (head < treeQueue.length) {
    const treeOid = treeQueue[head];
    head += 1;
    if (seenTrees.has(treeOid)) continue;
    seenTrees.add(treeOid);
    const object = repo.objects.get(treeOid);
    if (object === undefined) continue;
    if (!held.has(treeOid)) send.set(treeOid, object);
    if (object.type !== 'tree') continue;
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '40000') {
        treeQueue.push(entry.oid);
      } else {
        const blob = repo.objects.get(entry.oid);
        if (blob !== undefined && !held.has(entry.oid)) send.set(entry.oid, blob);
      }
    }
  }
  const ordered: GitObject[] = [];
  for (const oid of commitList) {
    const object = send.get(oid);
    if (object !== undefined) ordered.push(object);
  }
  for (const [oid, object] of send) {
    if (object.type !== 'commit') ordered.push(object);
  }
  // Shallow-info: the new boundary is the cut; old boundary commits whose
  // parents are all now present stop being shallow.
  const shallow = [...cut].filter((oid) => sentCommits.has(oid));
  const unshallow: string[] = [];
  const stillShallow: string[] = [];
  for (const old of oldShallow) {
    const object = repo.objects.get(old);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    const complete = commit.parents.every((p) => sentCommits.has(p) || held.has(p));
    if (complete) unshallow.push(old);
    else if (sentCommits.has(old) || held.has(old)) stillShallow.push(old);
  }
  return { objects: ordered, shallow: [...shallow, ...stillShallow], unshallow };
}

// ---------------------------------------------------------------- merge + diff

export interface MergeResult {
  /** The merged flat tree, or null when the merge conflicts. */
  tree: Map<string, FlatEntry> | null;
  conflicts: string[];
}

/** File-level three-way merge of flattened trees. */
export function threeWayMerge(
  base: Map<string, FlatEntry>,
  ours: Map<string, FlatEntry>,
  theirs: Map<string, FlatEntry>,
): MergeResult {
  const out = new Map<string, FlatEntry>();
  const conflicts: string[] = [];
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const same = (x: FlatEntry | undefined, y: FlatEntry | undefined): boolean =>
      x?.oid === y?.oid && x?.mode === y?.mode;
    if (same(o, t)) {
      if (o !== undefined) out.set(path, o);
      continue;
    }
    if (same(b, o)) {
      if (t !== undefined) out.set(path, t);
      continue;
    }
    if (same(b, t)) {
      if (o !== undefined) out.set(path, o);
      continue;
    }
    conflicts.push(path);
  }
  return conflicts.length > 0 ? { tree: null, conflicts } : { tree: out, conflicts: [] };
}

/** Build a tree object from a flat path map, creating intermediate trees. Returns the root tree oid. */
export function buildTreeFromFlat(repo: Repo, flat: Map<string, FlatEntry>): string {
  interface Node {
    entries: Map<string, { mode: string; oid: string }>;
  }
  const root: Node = { entries: new Map() };
  const dirs = new Map<string, Node>();
  dirs.set('', root);
  const dirOf = (path: string): Node => {
    const node = dirs.get(path);
    if (node !== undefined) return node;
    const created: Node = { entries: new Map() };
    dirs.set(path, created);
    return created;
  };
  for (const [path, entry] of flat) {
    const parts = path.split('/');
    let prefix = '';
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i]!;
      const parent = dirOf(prefix);
      const childPrefix = prefix === '' ? part : `${prefix}/${part}`;
      if (!parent.entries.has(part)) parent.entries.set(part, { mode: '40000', oid: '' });
      dirOf(childPrefix);
      prefix = childPrefix;
    }
    const leaf = dirOf(prefix);
    leaf.entries.set(parts[parts.length - 1]!, { mode: entry.mode, oid: entry.oid });
  }
  const writeNode = (prefix: string): string => {
    const node = dirs.get(prefix)!;
    const entries: TreeEntry[] = [];
    for (const [name, value] of node.entries) {
      let oid = value.oid;
      if (value.mode === '40000') {
        oid = writeNode(prefix === '' ? name : `${prefix}/${name}`);
      }
      entries.push({ mode: value.mode, name, oid });
    }
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return writeNode('');
}

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

/** Count line additions/deletions between two blob versions (multiset diff). */
export function lineDiff(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const linesOf = (data: Buffer | null): string[] => {
    if (data === null) return [];
    const text = data.toString('utf8');
    if (text === '') return [];
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  const oldLines = linesOf(oldData);
  const newLines = linesOf(newData);
  const oldCounts = new Map<string, number>();
  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const left = oldCounts.get(line) ?? 0;
    if (left > 0) oldCounts.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of oldCounts.values()) deletions += left;
  return { additions, deletions };
}

/** The file changes between two tree oids (base -> head). */
export function diffTrees(repo: Repo, baseTree: string | null, headTree: string | null): FileChange[] {
  const baseFlat = baseTree === null ? new Map<string, FlatEntry>() : flattenTree(repo, baseTree);
  const headFlat = headTree === null ? new Map<string, FlatEntry>() : flattenTree(repo, headTree);
  const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
  const changes: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const b = baseFlat.get(path);
    const h = headFlat.get(path);
    if (b !== undefined && h !== undefined && b.oid === h.oid) continue;
    if (b === undefined && h !== undefined) {
      const blob = repo.objects.get(h.oid);
      const { additions } = lineDiff(null, blob?.data ?? null);
      changes.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b !== undefined && h === undefined) {
      const blob = repo.objects.get(b.oid);
      const { deletions } = lineDiff(blob?.data ?? null, null);
      changes.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (b !== undefined && h !== undefined) {
      const oldBlob = repo.objects.get(b.oid);
      const newBlob = repo.objects.get(h.oid);
      const { additions, deletions } = lineDiff(oldBlob?.data ?? null, newBlob?.data ?? null);
      changes.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return changes;
}
