// The forge's one store: every surface (git smart HTTP, REST v3, GraphQL, MCP)
// reads and writes the same objects, so an issue created over MCP is the same
// issue REST lists and GraphQL reads. In-memory only; the trial mounts the repo
// read-only and the suite drives one process, so nothing needs to persist.
//
// The viewer is fixed by the kit's seeded scenario (wire.ts SCENARIO_SEED):
// the token owner is always `adaiversen` (id 1000). The bearer token itself is
// only a key: the entry receives MAKEFUN_SHOP_TOKEN in its environment and
// accepts exactly that token (or, with no token in the environment, any
// non-empty bearer token, for local runs only).

import { isoNow, tickNow } from './clock.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const ZERO_OID = '0000000000000000000000000000000000000000';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdSeq: number;
  updatedSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  createdSeq: number;
  updatedSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  issueSeq: number;
  pulls: Pull[];
  pullSeq: number;
  labels: Map<string, Label>;
  commentSeq: number;
  version: number;
  /** Serialized single-issue GET bodies, keyed by origin + number; valid only at the recorded repo version. */
  issueBodyCache: Map<string, { version: number; body: Buffer }>;
  /** Cached deterministic git responses (fetch packs, ls-refs, advertisements), keyed by request fingerprint; valid only at the recorded repo version. */
  fetchCache: Map<string, { version: number; body: Buffer }>;
}

/** One global id (GraphQL Relay style): base64url of "Kind:parts...". Opaque, stable. */
export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64url');
}

/** Decode a global id made by globalId, or null. */
export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const split = text.split(':');
    const kind = split[0];
    if (kind === undefined || kind === '' || split.length < 2) return null;
    return { kind, parts: split.slice(1) };
  } catch {
    return null;
  }
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private repoIdSeq = 1;
  private objectIdSeq = 1;
  private seq = 0;

  /** A fresh monotonically increasing sequence number (creation order). */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  nextObjectId(): number {
    const id = this.objectIdSeq;
    this.objectIdSeq += 1;
    return id;
  }

  createRepo(name: string, opts: { description?: string; private?: boolean; defaultBranch?: string }): Repo {
    const now = isoNow();
    const repo: Repo = {
      id: this.repoIdSeq,
      name,
      owner: VIEWER_LOGIN,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: opts.defaultBranch ?? 'main',
      createdSeq: this.nextSeq(),
      createdAt: now,
      updatedAt: now,
      objects: new Map(),
      refs: new Map(),
      issues: [],
      issueSeq: 0,
      pulls: [],
      pullSeq: 0,
      labels: new Map(),
      commentSeq: 0,
      version: 0,
      issueBodyCache: new Map(),
      fetchCache: new Map(),
    };
    this.repoIdSeq += 1;
    this.repos.set(`${VIEWER_LOGIN}/${name}`, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | null {
    if (owner !== VIEWER_LOGIN) return null;
    return this.repos.get(`${owner}/${name}`) ?? null;
  }

  findRepoById(id: number): Repo | null {
    for (const repo of this.repos.values()) {
      if (repo.id === id) return repo;
    }
    return null;
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    repo.issueSeq += 1;
    const now = isoNow();
    const issue: Issue = {
      id: this.nextObjectId(),
      number: repo.issueSeq,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdSeq: this.nextSeq(),
      updatedSeq: this.nextSeq(),
      createdAt: now,
      updatedAt: now,
    };
    repo.issues.push(issue);
    repo.version += 1;
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string, headSha: string, baseSha: string): Pull {
    repo.pullSeq += 1;
    const now = isoNow();
    const pull: Pull = {
      id: this.nextObjectId(),
      number: repo.pullSeq,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      createdSeq: this.nextSeq(),
      updatedSeq: this.nextSeq(),
      createdAt: now,
      updatedAt: now,
    };
    repo.pulls.push(pull);
    repo.version += 1;
    return pull;
  }

  addComment(repo: Repo, issue: Issue, body: string): Comment {
    repo.commentSeq += 1;
    const now = isoNow();
    const comment: Comment = {
      id: this.nextObjectId(),
      body,
      createdSeq: this.nextSeq(),
      createdAt: now,
      updatedAt: now,
    };
    issue.comments.push(comment);
    issue.updatedSeq = this.nextSeq();
    issue.updatedAt = now;
    repo.version += 1;
    return comment;
  }
}

/** The bearer token this process accepts, from the environment. */
export function expectedToken(): string | null {
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  return token !== undefined && token !== '' ? token : null;
}

/** Whether the request's Authorization header carries the accepted token. */
export function checkAuth(authorization: string | string[] | undefined): boolean {
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  if (header === undefined || !header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length);
  if (presented === '') return false;
  const expected = expectedToken();
  if (expected === null) return true;
  return presented === expected;
}

/** A git author/committer identity line for the viewer at a logical epoch. */
export function viewerIdent(epochSec: number): string {
  return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${epochSec} +0000`;
}

/** A fresh logical timestamp (epoch seconds) for a server-made commit. */
export function nextCommitTime(): number {
  return tickNow();
}
