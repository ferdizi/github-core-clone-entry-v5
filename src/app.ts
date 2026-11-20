// The HTTP server: one process, one store, four surfaces. Routing order:
// /healthz (no auth), git smart HTTP, REST v3, GraphQL, MCP, then 404 JSON.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './gitproto.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { jsonError, jsonResponse, rawResponse, type ForgeResponse } from './respond.ts';
import { checkAuth, Store, VIEWER_LOGIN } from './store.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, answer: ForgeResponse): void {
  res.writeHead(answer.status, answer.headers);
  res.end(answer.body);
}

const ISSUE_GET_RE = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/;

/**
 * Fast path for the repeated single-issue GET: when the serialized body is
 * already cached at the repo's current version, answer it directly without
 * URL parsing, routing regexes or body parsing. Anything uncached,
 * unauthenticated or unmatched returns null and falls through to the normal
 * router, which produces the exact same 401/404/200 as before.
 */
function tryIssueCacheHit(store: Store, req: IncomingMessage): ForgeResponse | null {
  const url = req.url ?? '';
  if (url.includes('?')) return null;
  const match = ISSUE_GET_RE.exec(url);
  if (match === null) return null;
  if (!checkAuth(req.headers.authorization)) return null;
  let owner: string;
  let repoName: string;
  try {
    owner = decodeURIComponent(match[1]!);
    repoName = decodeURIComponent(match[2]!);
  } catch {
    return null;
  }
  if (owner !== VIEWER_LOGIN) return null;
  const repo = store.getRepo(owner, repoName);
  if (repo === null) return null;
  const number = Number(match[3]);
  const issue = repo.issues.find((entry) => entry.number === number);
  if (issue === undefined) return null;
  const host = typeof req.headers.host === 'string' ? req.headers.host : '127.0.0.1';
  const cached = repo.issueBodyCache.get(`http://${host}:${number}`);
  if (cached === undefined || cached.version !== repo.version) return null;
  return rawResponse(200, 'application/json', cached.body);
}

export function createApp(store: Store = new Store()): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        // Narrow fast path for the repeated issue GET (read workload).
        if ((req.method ?? 'GET') === 'GET') {
          const fast = tryIssueCacheHit(store, req);
          if (fast !== null) {
            send(res, fast);
            return;
          }
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const path = url.pathname;
        const method = req.method ?? 'GET';
        if (method === 'GET' && path === '/healthz') {
          send(res, jsonResponse(200, { ok: true }));
          return;
        }
        const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
        const git = handleGit(store, method, path, url.searchParams, req.headers, body);
        if (git !== null) {
          send(res, git);
          return;
        }
        if (path === '/api/graphql' || path.startsWith('/api/graphql/')) {
          send(res, await handleGraphql(store, method, path, req.headers, body));
          return;
        }
        if (path === '/mcp' || path.startsWith('/mcp/')) {
          send(res, await handleMcp(store, method, path, req.headers, body));
          return;
        }
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          send(res, await handleRest(store, method, path, url.searchParams, req.headers, body));
          return;
        }
        send(res, jsonError(404, 'Not Found'));
      } catch (err) {
        process.stderr.write(`[entry] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
        if (!res.headersSent) send(res, jsonError(500, 'Internal Server Error'));
        else res.end();
      }
    })();
  });
  return server;
}
