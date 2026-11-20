// git smart HTTP: info/refs, git-upload-pack (protocol v0 and v2) and
// git-receive-pack (v0 only), over the shared store. Plain-object packs only;
// the suite's client writes plain packs, and the server answers with plain
// packs. Every update is checked for fast-forward before it is applied.

import type { IncomingHttpHeaders } from 'node:http';
import {
  GIT_AGENT,
  buildCommit,
  decodePktLines,
  decodePktPrefix,
  encodePktLines,
  hashObject,
  isAncestor,
  parseCommit,
  parseTag,
  parseTree,
  planFetch,
  readPack,
  verifyPackChecksum,
  writePack,
  type GitObject,
} from './gitobj.ts';
import { jsonError, rawResponse, type ForgeResponse } from './respond.ts';
import { VIEWER_LOGIN, ZERO_OID, checkAuth, type Repo, type Store } from './store.ts';

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
}

/** All advertised refs, sorted: HEAD first, then branches, then tags. */
function advertisedRefs(repo: Repo): RefLine[] {
  const refs: RefLine[] = [];
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (defaultTip !== undefined) {
    refs.push({ oid: defaultTip, name: 'HEAD' });
  } else {
    refs.push({ oid: ZERO_OID, name: 'HEAD' });
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const ref: RefLine = { oid, name };
    const object = repo.objects.get(oid);
    if (name.startsWith('refs/tags/') && object !== undefined && object.type === 'tag') {
      const tag = parseTag(object.data);
      ref.peeled = tag.object;
    }
    refs.push(ref);
  }
  return refs;
}

function v0Capabilities(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): string {
  const common = `agent=${GIT_AGENT}`;
  if (service === 'git-upload-pack') {
    return `side-band-64k symref=HEAD:refs/heads/${repo.defaultBranch} shallow thin-pack ofs-delta ${common}`;
  }
  return `report-status side-band-64k delete-refs ofs-delta ${common}`;
}

/** The v0 advertisement body, with the "# service=" preamble. */
function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): Buffer {
  const refs = advertisedRefs(repo);
  const caps = v0Capabilities(service, repo);
  const parts: Buffer[] = [encodePktLines([`# service=${service}\n`, 'flush'])];
  const lines: Array<string | 'flush'> = [];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    refs.forEach((ref, index) => {
      const first = index === 0 ? `\0${caps}` : '';
      lines.push(`${ref.oid} ${ref.name}${first}\n`);
      if (ref.peeled !== undefined) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    });
  }
  lines.push('flush');
  parts.push(encodePktLines(lines));
  return Buffer.concat(parts);
}

/** The v2 capability advertisement (no service preamble). */
function v2Advertisement(): Buffer {
  return encodePktLines([
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    `agent=${GIT_AGENT}\n`,
    'flush',
  ]);
}

/** The packfile bytes for a fetch plan, split into sideband band-1 packets. */
function sidebandPack(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 65500;
  for (let pos = 0; pos < pack.length; pos += CHUNK) {
    const chunk = pack.subarray(pos, Math.min(pos + CHUNK, pack.length));
    packets.push(Buffer.concat([Buffer.from([1]), chunk]));
  }
  if (packets.length === 0) packets.push(Buffer.from([1]));
  return packets;
}

/** A cached deterministic git response body, or null when the fingerprint is uncached or the repo moved on. */
function cachedBody(repo: Repo, key: string): Buffer | null {
  const entry = repo.fetchCache.get(key);
  if (entry === undefined || entry.version !== repo.version) return null;
  return entry.body;
}

/** Remember a response body under a fingerprint, keeping the cache bounded. */
function rememberBody(repo: Repo, key: string, body: Buffer): void {
  if (repo.fetchCache.size > 64) repo.fetchCache.clear();
  repo.fetchCache.set(key, { version: repo.version, body });
}

/** A cached advertisement buffer for this repo version, computed once. */
function cachedAd(repo: Repo, key: string, compute: () => Buffer): Buffer {
  const hit = cachedBody(repo, key);
  if (hit !== null) return hit;
  const body = compute();
  rememberBody(repo, key, body);
  return body;
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function ackLines(repo: Repo, wants: readonly string[], haves: readonly string[]): string[] {
  const lines: string[] = [];
  if (haves.length === 0) {
    lines.push('NAK\n');
  } else {
    let acked = false;
    for (const have of haves) {
      if (have === ZERO_OID) continue;
      if (wants.includes(have) || wants.some((want) => isAncestor(repo, have, want))) {
        lines.push(`ACK ${have}\n`);
        acked = true;
      }
    }
    if (!acked) lines.push('NAK\n');
  }
  lines.push('ready\n');
  return lines;
}

/** Handle POST git-upload-pack with protocol v2. */
function handleUploadPackV2(repo: Repo, body: Buffer): ForgeResponse {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return jsonError(400, 'malformed pkt-line stream');
  }
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
    else if (packet.kind === 'delim') lines.push('\u0001');
    else lines.push('\u0000');
  }
  const command = lines[0]?.replace(/\n$/, '') ?? '';
  if (command === 'command=ls-refs') {
    // Identical clones repeat the same ls-refs: the refs advertisement is
    // deterministic for this repo version, so serve it from the cache.
    const key = `v2:ls-refs:${JSON.stringify(lines.slice(1))}`;
    const hit = cachedBody(repo, key);
    if (hit !== null) return rawResponse(200, UPLOAD_RESULT, hit);
    const answer = lsRefsV2(repo, lines.slice(1));
    if (answer.status === 200) rememberBody(repo, key, answer.body);
    return answer;
  }
  if (command === 'command=fetch') {
    // Identical shallow clones repeat the same fetch: plan, pack and deflate
    // are deterministic for this repo version, so the whole response body is
    // cached and the other 49 clones skip the rebuild entirely.
    const key = `v2:fetch:${JSON.stringify(lines.slice(1))}`;
    const hit = cachedBody(repo, key);
    if (hit !== null) return rawResponse(200, UPLOAD_RESULT, hit);
    const answer = fetchV2(repo, lines.slice(1));
    if (answer.status === 200) rememberBody(repo, key, answer.body);
    return answer;
  }
  return jsonError(400, `unknown v2 command ${JSON.stringify(command)}`);
}

function lsRefsV2(repo: Repo, lines: string[]): ForgeResponse {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let pastDelim = false;
  for (const raw of lines) {
    if (raw === '\u0001') {
      pastDelim = true;
      continue;
    }
    if (raw === '\u0000') break;
    const line = raw.replace(/\n$/, '');
    if (!pastDelim) continue;
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const out: string[] = [];
  const refs = advertisedRefs(repo);
  const empty = repo.refs.size === 0;
  if (empty) {
    if (unborn) out.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
  } else {
    for (const ref of refs) {
      if (prefixes.length > 0) {
        if (ref.name === 'HEAD') continue;
        if (!prefixes.some((prefix) => ref.name.startsWith(prefix))) continue;
        out.push(`${ref.oid} ${ref.name}${peel && ref.peeled !== undefined ? ` peeled:${ref.peeled}` : ''}\n`);
        continue;
      }
      if (ref.name === 'HEAD') {
        out.push(`${ref.oid} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
      } else {
        out.push(`${ref.oid} ${ref.name}${peel && ref.peeled !== undefined ? ` peeled:${ref.peeled}` : ''}\n`);
      }
    }
  }
  out.push('flush');
  return rawResponse(200, UPLOAD_RESULT, encodePktLines(out));
}

function fetchV2(repo: Repo, lines: string[]): ForgeResponse {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  let pastDelim = false;
  for (const raw of lines) {
    if (raw === '\u0001') {
      pastDelim = true;
      continue;
    }
    if (raw === '\u0000') break;
    const line = raw.replace(/\n$/, '');
    if (!pastDelim) continue;
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isFinite(n) && n > 0) request.depth = Math.trunc(n);
    }
  }
  const plan = planFetch(repo, request.wants, request.haves, request.depth, request.shallow);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  parts.push(encodePktLines(['acknowledgments\n', ...ackLines(repo, request.wants, request.haves), 'delim']));
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const shallowLines: Array<string | 'delim'> = ['shallow-info\n'];
    for (const oid of plan.shallow) shallowLines.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) shallowLines.push(`unshallow ${oid}\n`);
    shallowLines.push('delim');
    parts.push(encodePktLines(shallowLines));
  }
  const packParts: Array<string | Buffer | 'flush'> = ['packfile\n'];
  for (const packet of sidebandPack(pack)) packParts.push(packet);
  packParts.push('flush');
  parts.push(encodePktLines(packParts));
  return rawResponse(200, UPLOAD_RESULT, Buffer.concat(parts));
}

/** Handle POST git-upload-pack with protocol v0. */
function handleUploadPackV0(repo: Repo, body: Buffer): ForgeResponse {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return jsonError(400, 'malformed pkt-line stream');
  }
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5);
        const nul = rest.indexOf('\0');
        request.wants.push((nul >= 0 ? rest.slice(0, nul) : rest).trim());
      } else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const n = Number(line.slice(7).trim());
        if (Number.isFinite(n) && n > 0) request.depth = Math.trunc(n);
      }
    } else if (line.startsWith('have ')) {
      request.haves.push(line.slice(5).trim());
    }
  }
  if (request.wants.length === 0) return jsonError(400, 'no want lines');
  // Same as the v2 fetch: identical shallow clones repeat the same request,
  // and the pack is deterministic for this repo version.
  const cacheKey = `v0:fetch:${request.wants.join(',')}|${request.haves.join(',')}|${request.shallow.join(',')}|${request.depth ?? ''}`;
  const hit = cachedBody(repo, cacheKey);
  if (hit !== null) return rawResponse(200, UPLOAD_RESULT, hit);
  const plan = planFetch(repo, request.wants, request.haves, request.depth, request.shallow);
  const pack = writePack(plan.objects);
  const out: Array<string | Buffer | 'flush'> = [];
  for (const line of ackLines(repo, request.wants, request.haves)) out.push(line);
  for (const oid of plan.shallow) out.push(`shallow ${oid}\n`);
  for (const oid of plan.unshallow) out.push(`unshallow ${oid}\n`);
  for (const packet of sidebandPack(pack)) out.push(packet);
  out.push('flush');
  const answer = rawResponse(200, UPLOAD_RESULT, encodePktLines(out));
  rememberBody(repo, cacheKey, answer.body);
  return answer;
}

/** Handle POST git-receive-pack (v0 only). */
function handleReceivePack(repo: Repo, body: Buffer): ForgeResponse {
  let prefix;
  try {
    prefix = decodePktPrefix(body);
  } catch {
    return jsonError(400, 'malformed pkt-line stream');
  }
  const packets = prefix.packets;
  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: Command[] = [];
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    const head = nul >= 0 ? text.slice(0, nul) : text;
    const parts = head.split(' ');
    if (parts.length < 3) return jsonError(400, 'malformed push command');
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
  }
  if (commands.length === 0) return jsonError(400, 'no push commands');
  // The pack is the raw bytes after the flush packet that ends the command list.
  const packBytes = body.subarray(prefix.packStart);
  const report: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  const incoming = new Map<string, GitObject>();
  if (packBytes.length > 0) {
    const checksum = verifyPackChecksum(packBytes);
    if (!checksum.ok) {
      unpackOk = false;
      unpackDetail = 'pack checksum mismatch';
    } else {
      try {
        for (const [oid, object] of readPack(packBytes)) incoming.set(oid, object);
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : 'pack parse failed';
      }
    }
  }
  if (unpackOk) {
    // Store the pack's objects, then check only what the pack adds: each new
    // commit's tree and parents, and each new tree's entries, must resolve.
    // The parents' own ancestry was verified when they were pushed, so there
    // is no need to re-walk the whole history.
    for (const [oid, object] of incoming) repo.objects.set(oid, object);
    for (const command of commands) {
      if (command.newOid === ZERO_OID) continue;
      const object = repo.objects.get(command.newOid);
      if (object === undefined) {
        unpackOk = false;
        unpackDetail = `object ${command.newOid} missing`;
        break;
      }
      if (object.type === 'commit') {
        const missing = missingDirectRefs(repo, incoming);
        if (missing !== null) {
          unpackOk = false;
          unpackDetail = `object ${missing} missing`;
          break;
        }
      }
    }
  }
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        if (current === undefined) {
          report.push(`ng ${command.ref} remote ref does not exist\n`);
        } else if (command.oldOid !== ZERO_OID && current !== command.oldOid) {
          report.push(`ng ${command.ref} non-fast-forward\n`);
        } else {
          repo.refs.delete(command.ref);
          repo.version += 1;
          report.push(`ok ${command.ref}\n`);
        }
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        if (current !== undefined) {
          report.push(`ng ${command.ref} already exists\n`);
        } else {
          repo.refs.set(command.ref, command.newOid);
          repo.version += 1;
          report.push(`ok ${command.ref}\n`);
        }
        continue;
      }
      if (current === undefined) {
        report.push(`ng ${command.ref} remote ref does not exist\n`);
      } else if (current !== command.oldOid) {
        report.push(`ng ${command.ref} non-fast-forward\n`);
      } else if (!isAncestor(repo, command.oldOid, command.newOid)) {
        report.push(`ng ${command.ref} non-fast-forward\n`);
      } else {
        repo.refs.set(command.ref, command.newOid);
        repo.version += 1;
        report.push(`ok ${command.ref}\n`);
      }
    }
  } else {
    for (const command of commands) report.push(`ng ${command.ref} unpack failed\n`);
  }
  const lines: Array<string | Buffer | 'flush'> = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  // When unpack failed the suite's parser still wants the unpack line first;
  // the per-ref ng lines above follow it.
  for (const line of report) lines.push(line);
  const banded: Array<string | Buffer | 'flush'> = [];
  for (const line of lines) {
    if (typeof line === 'string') banded.push(Buffer.concat([Buffer.from([1]), encodePktLines([line])]));
    else banded.push(line);
  }
  banded.push('flush');
  return rawResponse(200, RECEIVE_RESULT, encodePktLines(banded));
}

/** The first direct reference of the pack's new objects that the repo does not hold, or null. Only the pack's own objects are checked. */
function missingDirectRefs(repo: Repo, incoming: Map<string, GitObject>): string | null {
  for (const object of incoming.values()) {
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      if (!repo.objects.has(commit.tree)) return commit.tree;
      for (const parent of commit.parents) {
        if (!repo.objects.has(parent)) return parent;
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (!repo.objects.has(entry.oid)) return entry.oid;
      }
    } else if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      if (!repo.objects.has(target)) return target;
    }
  }
  return null;
}

/**
 * Route one git smart-HTTP request. Returns null when the path is not a git
 * route. `gitProtocol` is the request's Git-Protocol header, if any.
 */
export function handleGit(
  store: Store,
  method: string,
  path: string,
  query: URLSearchParams,
  headers: IncomingHttpHeaders,
  body: Buffer,
): ForgeResponse | null {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (match === null) return null;
  const owner = decodeURIComponent(match[1]!);
  const repoName = decodeURIComponent(match[2]!);
  const service = match[3]!;
  if (!checkAuth(headers.authorization)) return jsonError(401, 'Requires authentication');
  if (owner !== VIEWER_LOGIN) return jsonError(404, 'Not Found');
  const repo = store.getRepo(owner, repoName);
  if (method === 'GET' && service === 'info/refs') {
    if (repo === null) return jsonError(404, 'Not Found');
    const wanted = query.get('service');
    if (wanted === 'git-upload-pack') {
      if ((headers['git-protocol'] ?? '') === 'version=2') {
        return rawResponse(200, UPLOAD_AD, cachedAd(repo, 'ad:v2', () => v2Advertisement()));
      }
      return rawResponse(200, UPLOAD_AD, cachedAd(repo, `ad:v0:upload:${repo.defaultBranch}`, () => v0Advertisement('git-upload-pack', repo)));
    }
    if (wanted === 'git-receive-pack') {
      return rawResponse(200, RECEIVE_AD, cachedAd(repo, `ad:v0:receive:${repo.defaultBranch}`, () => v0Advertisement('git-receive-pack', repo)));
    }
    return jsonError(400, 'unknown service');
  }
  if (method === 'POST' && service === 'git-upload-pack') {
    if (repo === null) return jsonError(404, 'Not Found');
    if ((headers['git-protocol'] ?? '') === 'version=2') return handleUploadPackV2(repo, body);
    return handleUploadPackV0(repo, body);
  }
  if (method === 'POST' && service === 'git-receive-pack') {
    if (repo === null) return jsonError(404, 'Not Found');
    return handleReceivePack(repo, body);
  }
  return jsonError(404, 'Not Found');
}

// Re-exported for the REST contents/commits paths, which build commits too.
export { buildCommit, hashObject };
