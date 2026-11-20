// Model Context Protocol over Streamable HTTP (plain JSON responses): the
// modern 2026-07-28 era via server/discover, with the legacy initialize
// handshake as a fallback. Six tools, all acting on the same store REST
// reads. Unknown tools are JSON-RPC -32602/-32601, never HTTP 500; missing
// arguments are isError:true; a non-JSON body is HTTP 400 with -32700; no
// Authorization header is 401. tools/list is a frozen array, byte-identical
// on every call.

import type { IncomingHttpHeaders } from 'node:http';
import { jsonError, jsonResponse, type ForgeResponse } from './respond.ts';
import { mergePull } from './rest.ts';
import {
  VIEWER_LOGIN,
  checkAuth,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

const SERVER_NAME = 'forge-core-clone';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
}

const TOOLS: readonly ToolDef[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner (the authenticated user).' },
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  }),
]);

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function pick(args: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    if (args[name] !== undefined) return args[name];
  }
  return undefined;
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function pullJson(pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
  };
}

function needRepo(store: Store, args: Record<string, unknown>): Repo | string {
  const owner = pick(args, ['owner', 'owner_login']);
  const repoName = pick(args, ['repo', 'repository', 'repo_name']);
  if (typeof owner !== 'string' || typeof repoName !== 'string') return 'owner and repo are required';
  if (owner !== VIEWER_LOGIN) return `repository ${owner}/${repoName} not found`;
  const repo = store.getRepo(owner, repoName);
  if (repo === null) return `repository ${owner}/${repoName} not found`;
  return repo;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) throw new Error(`unknown tool ${name}`);
  const missing = tool.inputSchema.required.filter((required) => args[required] === undefined || args[required] === null || args[required] === '');
  if (missing.length > 0) return toolError(`missing required argument: ${missing.join(', ')}`);

  if (name === 'create_repo') {
    const repoName = pick(args, ['name', 'repo', 'repository']);
    if (typeof repoName !== 'string' || repoName === '') return toolError('name is required');
    if (store.getRepo(VIEWER_LOGIN, repoName) !== null) return toolError(`repository ${repoName} already exists`);
    const repo = store.createRepo(repoName, {
      description: typeof pick(args, ['description']) === 'string' ? (pick(args, ['description']) as string) : '',
      private: pick(args, ['private', 'is_private']) === true,
    });
    return toolResult(repoJson(repo));
  }

  if (name === 'get_repo') {
    const repo = needRepo(store, args);
    if (typeof repo === 'string') return toolError(repo);
    return toolResult(repoJson(repo));
  }

  if (name === 'create_issue') {
    const repo = needRepo(store, args);
    if (typeof repo === 'string') return toolError(repo);
    const title = pick(args, ['title']);
    if (typeof title !== 'string' || title === '') return toolError('title is required');
    const body = pick(args, ['body', 'description']);
    const issue = store.createIssue(repo, title, typeof body === 'string' ? body : '', []);
    return toolResult(issueJson(issue));
  }

  if (name === 'list_issues') {
    const repo = needRepo(store, args);
    if (typeof repo === 'string') return toolError(repo);
    const state = pick(args, ['state', 'status']);
    let list = [...repo.issues];
    if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
    const items = list.map((issue) => issueJson(issue));
    return {
      content: [{ type: 'text', text: JSON.stringify(items) }],
      structuredContent: { issues: items },
      isError: false,
    };
  }

  if (name === 'create_pull_request') {
    const repo = needRepo(store, args);
    if (typeof repo === 'string') return toolError(repo);
    const title = pick(args, ['title']);
    const head = pick(args, ['head', 'head_ref', 'head_branch']);
    const base = pick(args, ['base', 'base_ref', 'base_branch']);
    if (typeof title !== 'string' || typeof head !== 'string' || typeof base !== 'string') {
      return toolError('title, head and base are required');
    }
    const headTip = repo.refs.get(`refs/heads/${head}`);
    const baseTip = repo.refs.get(`refs/heads/${base}`);
    if (headTip === undefined) return toolError(`head branch ${head} does not exist`);
    if (baseTip === undefined) return toolError(`base branch ${base} does not exist`);
    const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
    if (duplicate !== undefined) return toolError('A pull request already exists for these branches');
    const body = pick(args, ['body', 'description']);
    const pull = store.createPull(repo, title, typeof body === 'string' ? body : '', head, base, headTip, baseTip);
    return toolResult(pullJson(pull));
  }

  if (name === 'merge_pull_request') {
    const repo = needRepo(store, args);
    if (typeof repo === 'string') return toolError(repo);
    const number = pick(args, ['pull_number', 'pull_request_number', 'pr_number', 'number']);
    const pullNumber = typeof number === 'number' ? number : typeof number === 'string' ? Number(number) : NaN;
    if (!Number.isInteger(pullNumber)) return toolError('pull_number is required');
    const pull = repo.pulls.find((entry) => entry.number === pullNumber);
    if (pull === undefined) return toolError(`pull request #${pullNumber} not found`);
    const merged = mergePull(store, repo, pull);
    if (!merged.ok) return toolError(merged.reason);
    return toolResult({ number: pull.number, merged: true, state: 'closed', sha: merged.commitOid });
  }

  return toolError(`unknown tool ${name}`);
}

interface RpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

function handleOne(store: Store, request: RpcRequest): ForgeResponse | null {
  const id = request.id;
  const method = request.method;
  if (typeof method !== 'string') {
    return jsonResponse(200, rpcError(id, -32600, 'Invalid Request'));
  }
  const params = request.params !== null && typeof request.params === 'object' ? (request.params as Record<string, unknown>) : {};

  if (method === 'server/discover') {
    return jsonResponse(200, rpcResult(id, {
      protocolVersion: '2026-07-28',
      supportedVersions: SUPPORTED_VERSIONS,
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    }));
  }

  if (method === 'initialize') {
    const wanted = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    const negotiated = SUPPORTED_VERSIONS.includes(wanted) ? wanted : '2025-11-25';
    return jsonResponse(200, rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    }));
  }

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return null;
  }

  if (method === 'ping') {
    return jsonResponse(200, rpcResult(id, {}));
  }

  if (method === 'tools/list') {
    return jsonResponse(200, rpcResult(id, { tools: TOOLS }));
  }

  if (method === 'tools/call') {
    const toolName = params.name;
    if (typeof toolName !== 'string' || toolName === '') {
      return jsonResponse(200, rpcError(id, -32602, 'tools/call needs a tool name'));
    }
    const args = params.arguments !== null && typeof params.arguments === 'object'
      ? (params.arguments as Record<string, unknown>)
      : {};
    const known = TOOLS.some((entry) => entry.name === toolName);
    if (!known) {
      return jsonResponse(200, rpcError(id, -32602, `unknown tool ${toolName}`));
    }
    const result = callTool(store, toolName, args);
    return jsonResponse(200, rpcResult(id, result));
  }

  return jsonResponse(200, rpcError(id, -32601, `Method not found: ${method}`));
}

export async function handleMcp(
  store: Store,
  method: string,
  _path: string,
  headers: IncomingHttpHeaders,
  body: Buffer,
): Promise<ForgeResponse> {
  if (method !== 'POST') return jsonError(404, 'Not Found');
  if (!checkAuth(headers.authorization)) return jsonError(401, 'Requires authentication');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return jsonResponse(400, rpcError(null, -32700, 'Parse error'));
  }
  if (Array.isArray(parsed)) {
    const results: Array<Record<string, unknown> | null> = [];
    for (const entry of parsed) {
      if (entry === null || typeof entry !== 'object') {
        results.push(rpcError(null, -32600, 'Invalid Request'));
        continue;
      }
      const answer = handleOne(store, entry as RpcRequest);
      results.push(answer === null ? null : (JSON.parse(answer.body.toString('utf8')) as Record<string, unknown>));
    }
    return jsonResponse(200, results.filter((entry) => entry !== null));
  }
  if (parsed === null || typeof parsed !== 'object') {
    return jsonResponse(400, rpcError(null, -32700, 'Parse error'));
  }
  const answer = handleOne(store, parsed as RpcRequest);
  if (answer === null) {
    return { status: 202, headers: { 'x-github-request-id': 'forge-mcp' }, body: Buffer.alloc(0) };
  }
  return answer;
}
