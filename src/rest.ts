// REST v3: repositories, branches, commits, contents, git refs, issues,
// comments, labels and pull requests, over the shared store. Every reply is
// JSON with X-GitHub-Request-Id; a repository under another owner is 404,
// never 403; a missing or wrong token is 401. The API root needs no token,
// matching api.github.com; every other route does.

import type { IncomingHttpHeaders } from 'node:http';
import {
  buildCommit,
  buildTreeFromFlat,
  diffTrees,
  flattenTree,
  hashObject,
  isAncestor,
  mergeBase,
  parseCommit,
  parseTree,
  threeWayMerge,
} from './gitobj.ts';
import { jsonError, jsonResponse, rawResponse, type ForgeResponse } from './respond.ts';
import {
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  checkAuth,
  globalId,
  nextCommitTime,
  viewerIdent,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { isoNow } from './clock.ts';

const SCOPES = 'repo, read:org';

interface Ctx {
  store: Store;
  origin: string;
  headers: IncomingHttpHeaders;
  query: URLSearchParams;
}

function parseBody(body: Buffer): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (body.length === 0) return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false };
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** Paginate a list: ?per_page (default 30) and ?page (default 1), with a Link header. */
function paginate<T>(ctx: Ctx, items: readonly T[], path: string): { page: T[]; link: string | null } {
  const perPageRaw = Number(ctx.query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.trunc(perPageRaw) : 30;
  const pageRaw = Number(ctx.query.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const next = new URL(`${ctx.origin}${path}`);
    for (const [key, value] of ctx.query) next.searchParams.set(key, value);
    next.searchParams.set('per_page', String(perPage));
    next.searchParams.set('page', String(page + 1));
    const lastPage = Math.ceil(items.length / perPage);
    const last = new URL(`${ctx.origin}${path}`);
    for (const [key, value] of ctx.query) last.searchParams.set(key, value);
    last.searchParams.set('per_page', String(perPage));
    last.searchParams.set('page', String(lastPage));
    link = `<${next.toString()}>; rel="next", <${last.toString()}>; rel="last"`;
  }
  return { page: [...slice], link };
}

function linkHeaders(link: string | null): Record<string, string> {
  return link === null ? {} : { link };
}

function repoJson(ctx: Ctx, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `${ctx.origin}/${repo.owner}/${repo.name}`,
    clone_url: `${ctx.origin}/${repo.owner}/${repo.name}.git`,
    url: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    size: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return { name, color: label?.color ?? 'ededed', description: label?.description ?? '' };
}

function issueJson(ctx: Ctx, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    assignees: [],
    locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `${ctx.origin}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments_url: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
  };
}

function commentJson(ctx: Ctx, repo: Repo, issue: Issue, comment: { id: number; body: string; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `${ctx.origin}/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
  };
}

/** The tip of a branch, or null when the branch does not exist. */
function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** Mergeability of a pull request, computed from its tips. */
function mergeableOf(repo: Repo, pull: Pull): boolean {
  const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseTip = branchTip(repo, pull.baseRef) ?? pull.baseSha;
  if (headTip === baseTip) return true;
  if (isAncestor(repo, headTip, baseTip)) return true;
  const base = mergeBase(repo, baseTip, headTip);
  if (base === null) return false;
  const baseTree = commitTree(repo, base);
  const oursTree = commitTree(repo, baseTip);
  const theirsTree = commitTree(repo, headTip);
  if (baseTree === null || oursTree === null || theirsTree === null) return false;
  const merged = threeWayMerge(flattenTree(repo, baseTree), flattenTree(repo, oursTree), flattenTree(repo, theirsTree));
  return merged.tree !== null;
}

function commitTree(repo: Repo, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

function pullJson(ctx: Ctx, repo: Repo, pull: Pull, withMergeable: boolean): Record<string, unknown> {
  const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseTip = branchTip(repo, pull.baseRef) ?? pull.baseSha;
  const out: Record<string, unknown> = {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headTip, label: `${repo.owner}:${pull.headRef}`, user: { login: VIEWER_LOGIN, id: VIEWER_ID } },
    base: { ref: pull.baseRef, sha: baseTip, label: `${repo.owner}:${pull.baseRef}`, user: { login: VIEWER_LOGIN, id: VIEWER_ID } },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    draft: false,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `${ctx.origin}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
  if (withMergeable) out.mergeable = mergeableOf(repo, pull);
  return out;
}

/** Resolve a repo from the path, or answer the 404. */
function needRepo(ctx: Ctx, owner: string, name: string): Repo | ForgeResponse {
  if (owner !== VIEWER_LOGIN) return jsonError(404, 'Not Found');
  const repo = ctx.store.getRepo(owner, name);
  if (repo === null) return jsonError(404, 'Not Found');
  return repo;
}

/** Commit a file change (create/update/delete) on a branch. Returns the new commit oid and blob oid. */
function commitFile(
  ctx: Ctx,
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): { commitOid: string; blobOid: string | null } {
  const tip = branchTip(repo, branch);
  const baseTree = tip === null ? null : commitTree(repo, tip);
  const flat = baseTree === null ? new Map() : flattenTree(repo, baseTree);
  let blobOid: string | null = null;
  if (content !== null) {
    blobOid = hashObject('blob', content);
    if (!repo.objects.has(blobOid)) repo.objects.set(blobOid, { type: 'blob', data: content });
    flat.set(path, { oid: blobOid, mode: '100644' });
  } else {
    flat.delete(path);
  }
  const treeOid = buildTreeFromFlat(repo, flat);
  const epoch = nextCommitTime();
  const ident = viewerIdent(epoch);
  const commit = buildCommit(treeOid, tip === null ? [] : [tip], ident, ident, message);
  const commitOid = hashObject('commit', commit);
  repo.objects.set(commitOid, { type: 'commit', data: commit });
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  repo.version += 1;
  return { commitOid, blobOid };
}

/** Squash-merge a pull request onto its base branch. Shared by REST, GraphQL and MCP. */
export function mergePull(
  store: Store,
  repo: Repo,
  pull: Pull,
): { ok: true; commitOid: string } | { ok: false; reason: string } {
  if (pull.merged) return { ok: false, reason: 'Pull request has already been merged' };
  if (pull.state === 'closed') return { ok: false, reason: 'Pull request is closed' };
  const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseTip = branchTip(repo, pull.baseRef) ?? pull.baseSha;
  const base = mergeBase(repo, baseTip, headTip);
  const baseTree = base === null ? null : commitTree(repo, base);
  const oursTree = commitTree(repo, baseTip);
  const theirsTree = commitTree(repo, headTip);
  if (baseTree === null || oursTree === null || theirsTree === null) {
    return { ok: false, reason: 'Merge conflict' };
  }
  const merged = threeWayMerge(flattenTree(repo, baseTree), flattenTree(repo, oursTree), flattenTree(repo, theirsTree));
  if (merged.tree === null) return { ok: false, reason: 'Merge conflict' };
  const treeOid = buildTreeFromFlat(repo, merged.tree);
  const epoch = nextCommitTime();
  const ident = viewerIdent(epoch);
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`;
  const commit = buildCommit(treeOid, [baseTip], ident, ident, message);
  const commitOid = hashObject('commit', commit);
  repo.objects.set(commitOid, { type: 'commit', data: commit });
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = new Date(epoch * 1000).toISOString();
  pull.mergeCommitSha = commitOid;
  pull.updatedSeq = store.nextSeq();
  pull.updatedAt = pull.mergedAt;
  repo.version += 1;
  return { ok: true, commitOid };
}

export async function handleRest(
  store: Store,
  method: string,
  path: string,
  query: URLSearchParams,
  headers: IncomingHttpHeaders,
  body: Buffer,
): Promise<ForgeResponse> {
  const host = typeof headers.host === 'string' ? headers.host : '127.0.0.1';
  const ctx: Ctx = { store, origin: `http://${host}`, headers, query };

  // The API root: no token needed, as api.github.com answers it.
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    return jsonResponse(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': SCOPES });
  }
  if (!checkAuth(headers.authorization)) return jsonError(401, 'Requires authentication');

  const parsed = parseBody(body);
  if (!parsed.ok) return jsonError(400, 'Invalid JSON body');
  const input = parsed.value;

  if (method === 'GET' && path === '/api/v3/meta') {
    return jsonResponse(200, { installed_version: '1.0.0', verifiable_password_authentication: false, git: ['1.0.0'], hooks: [], github_enterprise_importer: [] });
  }
  if (method === 'GET' && path === '/api/v3/user') {
    return jsonResponse(200, { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' });
  }

  // POST /api/v3/user/repos — create a repository.
  if (path === '/api/v3/user/repos') {
    if (method === 'POST') {
      const name = str(input.name);
      if (name === null || name === '' || /[/\s]/.test(name)) return jsonError(422, 'Invalid repository name');
      if (store.getRepo(VIEWER_LOGIN, name) !== null) return jsonError(422, `Repository ${name} already exists`);
      const repo = store.createRepo(name, {
        description: str(input.description) ?? '',
        private: bool(input.private) ?? false,
        defaultBranch: str(input.default_branch) ?? 'main',
      });
      return jsonResponse(201, repoJson(ctx, repo));
    }
    if (method === 'GET') {
      const repos = [...store.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
      const { page, link } = paginate(ctx, repos, path);
      return jsonResponse(200, page.map((repo) => repoJson(ctx, repo)), linkHeaders(link));
    }
    return jsonError(404, 'Not Found');
  }

  const repoMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
  if (repoMatch === null) return jsonError(404, 'Not Found');
  const owner = decodeURIComponent(repoMatch[1]!);
  const repoName = decodeURIComponent(repoMatch[2]!);
  const rest = repoMatch[3] ?? '';
  const repoOrError = needRepo(ctx, owner, repoName);
  if ('status' in repoOrError) return repoOrError;
  const repo = repoOrError;

  // The repository itself.
  if (rest === '') {
    if (method === 'GET') return jsonResponse(200, repoJson(ctx, repo));
    if (method === 'PATCH') {
      if (str(input.description) !== null) repo.description = str(input.description)!;
      if (bool(input.private) !== null) repo.private = bool(input.private)!;
      if (str(input.default_branch) !== null) repo.defaultBranch = str(input.default_branch)!;
      repo.updatedAt = isoNow();
      return jsonResponse(200, repoJson(ctx, repo));
    }
    if (method === 'DELETE') {
      store.repos.delete(`${owner}/${repoName}`);
      return rawResponse(204, 'application/json', Buffer.alloc(0));
    }
    return jsonError(404, 'Not Found');
  }

  // Branches.
  if (rest === '/branches' && method === 'GET') {
    const branches = [...repo.refs.keys()]
      .filter((ref) => ref.startsWith('refs/heads/'))
      .sort()
      .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref)! }, protected: false }));
    return jsonResponse(200, branches);
  }
  const branchMatch = /^\/branches\/([^/]+)$/.exec(rest);
  if (branchMatch !== null && method === 'GET') {
    const branch = decodeURIComponent(branchMatch[1]!);
    const tip = branchTip(repo, branch);
    if (tip === null) return jsonError(404, 'Not Found');
    return jsonResponse(200, { name: branch, commit: { sha: tip }, protected: false });
  }

  // Commits.
  if (rest === '/commits' && method === 'GET') {
    const shaParam = query.get('sha');
    const tip = shaParam === null ? branchTip(repo, repo.defaultBranch) : repo.refs.get(`refs/heads/${shaParam}`) ?? (repo.objects.has(shaParam) ? shaParam : null);
    if (tip === null) return jsonResponse(200, []);
    const dist = new Map<string, number>();
    const queue: string[] = [tip];
    dist.set(tip, 0);
    let head = 0;
    const ordered: string[] = [];
    while (head < queue.length) {
      const oid = queue[head];
      head += 1;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      ordered.push(oid);
      for (const parent of parseCommit(object.data).parents) {
        if (!dist.has(parent)) {
          dist.set(parent, (dist.get(oid) ?? 0) + 1);
          queue.push(parent);
        }
      }
    }
    const { page, link } = paginate(ctx, ordered, path);
    const items = page.map((oid) => {
      const commit = parseCommit(repo.objects.get(oid)!.data);
      return {
        sha: oid,
        commit: { message: commit.message, author: { name: VIEWER_NAME, email: VIEWER_EMAIL }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL } },
        parents: commit.parents.map((p) => ({ sha: p })),
      };
    });
    return jsonResponse(200, items, linkHeaders(link));
  }

  // Git Data: refs.
  if (rest === '/git/refs' && method === 'GET') {
    const refs = [...repo.refs.keys()].sort().map((ref) => ({ ref, object: { sha: repo.refs.get(ref)!, type: 'commit' } }));
    return jsonResponse(200, refs);
  }
  const refGetMatch = /^\/git\/refs\/(.+)$/.exec(rest);
  if (refGetMatch !== null && method === 'GET') {
    const ref = `refs/${decodeURIComponent(refGetMatch[1]!)}`;
    const oid = repo.refs.get(ref);
    if (oid === undefined) return jsonError(404, 'Not Found');
    const type = repo.objects.get(oid)?.type ?? 'commit';
    return jsonResponse(200, { ref, object: { sha: oid, type } });
  }
  if (rest === '/git/refs' && method === 'POST') {
    const ref = str(input.ref);
    const sha = str(input.sha);
    if (ref === null || !ref.startsWith('refs/') || sha === null || !repo.objects.has(sha)) {
      return jsonError(422, 'Invalid ref or sha');
    }
    if (repo.refs.has(ref)) return jsonError(422, `Reference ${ref} already exists`);
    repo.refs.set(ref, sha);
    repo.version += 1;
    return jsonResponse(201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
  }

  // Contents.
  const contentsMatch = /^\/contents\/?(.*)$/.exec(rest);
  if (contentsMatch !== null) {
    const rawPath = contentsMatch[1] ?? '';
    const contentPath = rawPath.split('/').map((s) => decodeURIComponent(s)).filter((s) => s !== '').join('/');
    const refParam = query.get('ref') ?? str(input.branch) ?? null;
    const branch = refParam ?? repo.defaultBranch;
    const tip = branchTip(repo, branch) ?? (repo.objects.has(branch) ? branch : null);
    if (method === 'GET') {
      if (tip === null) return jsonError(404, 'Not Found');
      const treeOid = commitTree(repo, tip);
      if (treeOid === null) return jsonError(404, 'Not Found');
      if (contentPath === '') {
        const tree = parseTree(repo.objects.get(treeOid)!.data);
        const items = tree.map((entry) => ({
          type: entry.mode === '40000' ? 'dir' : 'file',
          name: entry.name,
          path: entry.name,
          sha: entry.oid,
          size: entry.mode === '40000' ? 0 : repo.objects.get(entry.oid)?.data.length ?? 0,
        }));
        return jsonResponse(200, items);
      }
      const flat = flattenTree(repo, treeOid);
      const file = flat.get(contentPath);
      if (file !== undefined) {
        const blob = repo.objects.get(file.oid);
        return jsonResponse(200, {
          type: 'file',
          encoding: 'base64',
          content: (blob?.data ?? Buffer.alloc(0)).toString('base64'),
          sha: file.oid,
          size: blob?.data.length ?? 0,
          name: contentPath.split('/').pop(),
          path: contentPath,
        });
      }
      // A directory: any path that is a prefix of a file path.
      const prefix = `${contentPath}/`;
      const children = new Map<string, { type: 'file' | 'dir'; oid: string; size: number }>();
      for (const [p, entry] of flat) {
        if (!p.startsWith(prefix)) continue;
        const restPath = p.slice(prefix.length);
        const first = restPath.split('/')[0]!;
        if (!children.has(first)) {
          children.set(first, restPath.includes('/') ? { type: 'dir', oid: '', size: 0 } : { type: 'file', oid: entry.oid, size: repo.objects.get(entry.oid)?.data.length ?? 0 });
        }
      }
      if (children.size === 0) return jsonError(404, 'Not Found');
      const treeOidAt = treeOidAtPath(repo, treeOid, contentPath);
      const items = [...children.entries()].map(([name, info]) => ({
        type: info.type,
        name,
        path: `${contentPath}/${name}`,
        sha: info.type === 'dir' ? treeOidAt?.get(name) ?? '' : info.oid,
        size: info.size,
      }));
      return jsonResponse(200, items);
    }
    if (method === 'PUT') {
      const message = str(input.message) ?? 'Update file';
      const contentB64 = str(input.content);
      if (contentB64 === null) return jsonError(422, 'content is required');
      const content = Buffer.from(contentB64, 'base64');
      const targetBranch = str(input.branch) ?? repo.defaultBranch;
      let writeBranch = targetBranch;
      if (branchTip(repo, targetBranch) === null) {
        if (repo.refs.size === 0) writeBranch = repo.defaultBranch;
        else {
          const defaultTip = branchTip(repo, repo.defaultBranch);
          if (defaultTip === null) return jsonError(422, 'cannot create branch from an unborn repository');
          repo.refs.set(`refs/heads/${targetBranch}`, defaultTip);
          repo.version += 1;
        }
      }
      const tipNow = branchTip(repo, writeBranch);
      const treeNow = tipNow === null ? null : commitTree(repo, tipNow);
      const flatNow = treeNow === null ? new Map() : flattenTree(repo, treeNow);
      const existing = flatNow.get(contentPath);
      const givenSha = str(input.sha);
      if (existing !== undefined && givenSha === null) return jsonError(422, 'File already exists');
      if (existing === undefined && givenSha !== null) return jsonError(404, 'Not Found');
      if (existing !== undefined && givenSha !== null && existing.oid !== givenSha) {
        return jsonError(409, 'sha does not match');
      }
      const { commitOid, blobOid } = commitFile(ctx, repo, writeBranch, contentPath, content, message);
      const status = existing === undefined ? 201 : 200;
      return jsonResponse(status, {
        content: { name: contentPath.split('/').pop(), path: contentPath, sha: blobOid, size: content.length, type: 'file', encoding: 'base64', content: content.toString('base64') },
        commit: { sha: commitOid, message },
      });
    }
    if (method === 'DELETE') {
      const givenSha = str(input.sha);
      const message = str(input.message) ?? 'Delete file';
      const targetBranch = str(input.branch) ?? repo.defaultBranch;
      const tipNow = branchTip(repo, targetBranch);
      if (tipNow === null) return jsonError(404, 'Not Found');
      const treeNow = commitTree(repo, tipNow);
      if (treeNow === null) return jsonError(404, 'Not Found');
      const existing = flattenTree(repo, treeNow).get(contentPath);
      if (existing === undefined) return jsonError(404, 'Not Found');
      if (givenSha !== null && existing.oid !== givenSha) return jsonError(409, 'sha does not match');
      const { commitOid } = commitFile(ctx, repo, targetBranch, contentPath, null, message);
      return jsonResponse(200, { commit: { sha: commitOid, message } });
    }
    return jsonError(404, 'Not Found');
  }

  // Labels.
  if (rest === '/labels') {
    if (method === 'GET') {
      return jsonResponse(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: label.description })));
    }
    if (method === 'POST') {
      const name = str(input.name);
      const color = str(input.color) ?? 'ededed';
      if (name === null || name === '') return jsonError(422, 'Invalid label name');
      const existing = repo.labels.get(name);
      if (existing !== undefined) return jsonResponse(201, { name, color: existing.color, description: existing.description });
      repo.labels.set(name, { name, color, description: str(input.description) ?? '' });
      repo.version += 1;
      return jsonResponse(201, { name, color, description: str(input.description) ?? '' });
    }
    return jsonError(404, 'Not Found');
  }

  // Issues.
  if (rest === '/issues') {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      const labelsParam = query.get('labels');
      let list = [...repo.issues];
      if (state !== 'all') list = list.filter((issue) => issue.state === state);
      if (labelsParam !== null && labelsParam !== '') {
        const wanted = labelsParam.split(',').map((s) => s.trim()).filter((s) => s !== '');
        list = list.filter((issue) => wanted.every((label) => issue.labels.includes(label)));
      }
      if (sort === 'created') {
        list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      }
      const { page, link } = paginate(ctx, list, path);
      return jsonResponse(200, page.map((issue) => issueJson(ctx, repo, issue)), linkHeaders(link));
    }
    if (method === 'POST') {
      const title = str(input.title);
      if (title === null || title === '') return jsonError(422, 'title is required');
      const labels = labelsFrom(input.labels);
      for (const label of labels) {
        if (!repo.labels.has(label)) return jsonError(422, `Label '${label}' does not exist`);
      }
      const issue = store.createIssue(repo, title, str(input.body) ?? '', labels);
      return jsonResponse(201, issueJson(ctx, repo, issue));
    }
    return jsonError(404, 'Not Found');
  }
  const issueMatch = /^\/issues\/(\d+)(\/comments)?$/.exec(rest);
  if (issueMatch !== null) {
    const number = Number(issueMatch[1]);
    const issue = repo.issues.find((entry) => entry.number === number);
    if (issue === undefined) return jsonError(404, 'Not Found');
    if (issueMatch[2] === '/comments') {
      if (method === 'GET') {
        return jsonResponse(200, issue.comments.map((comment) => commentJson(ctx, repo, issue, comment)));
      }
      if (method === 'POST') {
        const bodyText = str(input.body);
        if (bodyText === null || bodyText === '') return jsonError(422, 'body is required');
        const comment = store.addComment(repo, issue, bodyText);
        return jsonResponse(201, commentJson(ctx, repo, issue, comment));
      }
      return jsonError(404, 'Not Found');
    }
    if (method === 'GET') {
      const cacheKey = `${ctx.origin}:${issue.number}`;
      const cached = repo.issueBodyCache.get(cacheKey);
      if (cached !== undefined && cached.version === repo.version) {
        return rawResponse(200, 'application/json', cached.body);
      }
      const answer = jsonResponse(200, issueJson(ctx, repo, issue));
      repo.issueBodyCache.set(cacheKey, { version: repo.version, body: answer.body });
      return answer;
    }
    if (method === 'PATCH') {
      if (str(input.state) === 'open' || str(input.state) === 'closed') issue.state = str(input.state) as 'open' | 'closed';
      if (str(input.title) !== null) issue.title = str(input.title)!;
      if (str(input.body) !== null) issue.body = str(input.body)!;
      if (input.labels !== undefined) {
        const labels = labelsFrom(input.labels);
        for (const label of labels) {
          if (!repo.labels.has(label)) return jsonError(422, `Label '${label}' does not exist`);
        }
        issue.labels = labels;
      }
      issue.updatedSeq = store.nextSeq();
      issue.updatedAt = isoNow();
      repo.version += 1;
      return jsonResponse(200, issueJson(ctx, repo, issue));
    }
    return jsonError(404, 'Not Found');
  }

  // Pull requests.
  if (rest === '/pulls') {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = [...repo.pulls];
      if (state !== 'all') list = list.filter((pull) => pull.state === state);
      list.sort((a, b) => b.createdSeq - a.createdSeq);
      const { page, link } = paginate(ctx, list, path);
      return jsonResponse(200, page.map((pull) => pullJson(ctx, repo, pull, false)), linkHeaders(link));
    }
    if (method === 'POST') {
      const title = str(input.title);
      const head = str(input.head);
      const base = str(input.base);
      if (title === null || title === '' || head === null || base === null) {
        return jsonError(422, 'title, head and base are required');
      }
      const headTip = branchTip(repo, head);
      const baseTip = branchTip(repo, base);
      if (headTip === null) return jsonError(422, `head branch ${head} does not exist`);
      if (baseTip === null) return jsonError(422, `base branch ${base} does not exist`);
      const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
      if (duplicate !== undefined) return jsonError(422, 'A pull request already exists for these branches');
      const pull = store.createPull(repo, title, str(input.body) ?? '', head, base, headTip, baseTip);
      return jsonResponse(201, pullJson(ctx, repo, pull, false));
    }
    return jsonError(404, 'Not Found');
  }
  const pullMatch = /^\/pulls\/(\d+)(\/files|\/merge)?$/.exec(rest);
  if (pullMatch !== null) {
    const number = Number(pullMatch[1]);
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (pull === undefined) return jsonError(404, 'Not Found');
    if (pullMatch[2] === '/files' && method === 'GET') {
      const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
      const base = mergeBase(repo, pull.baseSha, pull.headSha) ?? pull.baseSha;
      const baseTree = commitTree(repo, base);
      const headTree = commitTree(repo, headTip);
      return jsonResponse(200, diffTrees(repo, baseTree, headTree));
    }
    if (pullMatch[2] === '/merge' && method === 'PUT') {
      const merged = mergePull(store, repo, pull);
      if (!merged.ok) return jsonError(405, merged.reason);
      return jsonResponse(200, { sha: merged.commitOid, merged: true, message: 'Pull request successfully merged' });
    }
    if (pullMatch[2] === undefined && method === 'GET') {
      return jsonResponse(200, pullJson(ctx, repo, pull, true));
    }
    return jsonError(404, 'Not Found');
  }

  return jsonError(404, 'Not Found');
}

/** Labels from a POST/PATCH body: strings, or objects with a name. */
function labelsFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') out.push(entry);
    else if (entry !== null && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
      out.push((entry as { name: string }).name);
    }
  }
  return out;
}

/** The child tree oids at a path, for a directory listing's sha values. */
function treeOidAtPath(repo: Repo, treeOid: string, path: string): Map<string, string> | null {
  const parts = path.split('/').filter((s) => s !== '');
  let current = treeOid;
  for (const part of parts) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((e) => e.name === part && e.mode === '40000');
    if (entry === undefined) return null;
    current = entry.oid;
  }
  const object = repo.objects.get(current);
  if (object === undefined || object.type !== 'tree') return null;
  const out = new Map<string, string>();
  for (const entry of parseTree(object.data)) out.set(entry.name, entry.oid);
  return out;
}

// Re-exported for GraphQL/MCP, which share the same shapes and merge logic.
export { branchTip, commitTree, globalId, issueJson, mergeableOf, pullJson, repoJson };
