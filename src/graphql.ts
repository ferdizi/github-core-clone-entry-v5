// GraphQL v4 for the documents gh and github-mcp-server actually send: a
// small parser for the query/mutation subset they use (variables, inline
// inputs, inline enums, inline fragments, aliases, operation batching) and an
// executor over the shared store. Unknown fields are a 200 with an `errors`
// array naming the field; an unknown repository is data.repository = null
// with no errors; no token is 401.

import type { IncomingHttpHeaders } from 'node:http';
import { diffTrees } from './gitobj.ts';
import { jsonError, jsonResponse, type ForgeResponse } from './respond.ts';
import { branchTip, commitTree, mergePull, mergeableOf } from './rest.ts';
import {
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  checkAuth,
  decodeGlobalId,
  globalId,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ------------------------------------------------------------------- parser

type TokenKind = 'name' | 'string' | 'int' | 'float' | 'punct' | 'eof';
interface Token {
  kind: TokenKind;
  value: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (src[j] === '-') j += 1;
      let isFloat = false;
      while (j < src.length && /[0-9.]/.test(src[j]!)) {
        if (src[j] === '.') isFloat = true;
        j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < src.length && isNameChar(src[j]!)) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Record<string, ValueNode>;
  selections?: SelectionNode[];
}

interface InlineFragmentNode {
  kind: 'inline';
  typeCondition?: string;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | InlineFragmentNode;

interface Operation {
  kind: 'query' | 'mutation';
  name?: string;
  variables: Record<string, ValueNode>;
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${JSON.stringify(value)}, got ${JSON.stringify(token.value)}`);
    }
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${JSON.stringify(token.value)}`);
    return token.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.peek().kind !== 'eof') {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    const first = this.peek();
    if (first.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      kind = this.next().value as 'query' | 'mutation';
    }
    let name: string | undefined;
    if (this.peek().kind === 'name') name = this.next().value;
    const variables: Record<string, ValueNode> = {};
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseType();
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          variables[varName] = this.parseValue();
        } else {
          variables[varName] = { kind: 'null' };
        }
      }
      this.expectPunct(')');
    }
    const selections = this.parseSelectionSet();
    return { kind, name, variables, selections };
  }

  private parseType(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      let typeCondition: string | undefined;
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        typeCondition = this.expectName();
      } else if (this.peek().kind === 'name') {
        throw new Error('named fragment spreads are not supported');
      }
      return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: Record<string, ValueNode> = {};
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
      this.expectPunct(')');
    }
    let selections: SelectionNode[] | undefined;
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'var', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'bool', value: true };
      if (token.value === 'false') return { kind: 'bool', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const key = this.expectName();
        this.expectPunct(':');
        fields[key] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token.value)}`);
  }
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'var':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'bool':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = evalValue(value, variables);
      return out;
    }
  }
}

// ------------------------------------------------------------------- schema

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'closed', 'closedAt'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'url', 'createdAt', 'updatedAt', 'author', 'additions', 'deletions'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'createdAt', 'updatedAt', 'isPrivate', 'forkCount', 'stargazerCount'],
  User: ['id', 'login', 'name', 'email', 'avatarUrl'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  Ref: ['name', 'target'],
  Label: ['id', 'name', 'color', 'description'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
};

const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'LABEL', 'MILESTONE', 'PROJECT', 'REGISTRY_PACKAGE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['COMMENTS', 'CREATED_AT', 'UPDATED_AT'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

const QUERY_FIELDS = ['viewer', 'repository', 'node', '__type', '__schema'];
const MUTATION_FIELDS = ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'];

// ------------------------------------------------------------------- values

type GqlValue = Record<string, unknown> & { __typename: string };

function userValue(login: string): GqlValue {
  return {
    __typename: 'User',
    login,
    id: globalId('User', login),
    name: login === VIEWER_LOGIN ? VIEWER_NAME : login,
    email: login === VIEWER_LOGIN ? VIEWER_EMAIL : `${login}@example.invalid`,
    avatarUrl: '',
  };
}

function repoValue(repo: Repo): GqlValue {
  return { __typename: 'Repository', repo };
}

function issueValue(repo: Repo, issue: Issue): GqlValue {
  return { __typename: 'Issue', repo, issue };
}

function pullValue(repo: Repo, pull: Pull): GqlValue {
  return { __typename: 'PullRequest', repo, pull };
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

class GqlError extends Error {}

// ------------------------------------------------------------------- executor

interface ExecCtx {
  store: Store;
}

function knownFields(type: string): string[] {
  if (type === 'Query') return QUERY_FIELDS;
  if (type === 'Mutation') return MUTATION_FIELDS;
  if (type === '__Type') return ['name', 'fields', 'enumValues', 'kind'];
  return TYPE_FIELDS[type] ?? [];
}

function executeSelections(
  ctx: ExecCtx,
  parentType: string,
  parent: GqlValue | null,
  selections: SelectionNode[],
  variables: Record<string, unknown>,
  errors: Array<{ message: string }>,
): Record<string, unknown> | null {
  if (parent === null) return null;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition !== undefined && selection.typeCondition !== parentType) continue;
      const nested = executeSelections(ctx, parentType, parent, selection.selections, variables, errors);
      if (nested !== null) Object.assign(out, nested);
      continue;
    }
    const key = selection.alias ?? selection.name;
    const args: Record<string, unknown> = {};
    for (const [name, node] of Object.entries(selection.args)) args[name] = evalValue(node, variables);
    let value: unknown;
    try {
      value = resolveField(ctx, parentType, parent, selection.name, args);
    } catch (err) {
      if (err instanceof GqlError) {
        errors.push({ message: err.message });
        out[key] = null;
        continue;
      }
      throw err;
    }
    if (selection.selections !== undefined) {
      if (value === null || value === undefined) {
        out[key] = null;
      } else if (Array.isArray(value)) {
        out[key] = value.map((entry) => {
          if (entry !== null && typeof entry === 'object' && '__typename' in entry) {
            return executeSelections(ctx, (entry as GqlValue).__typename, entry as GqlValue, selection.selections!, variables, errors);
          }
          return entry;
        });
      } else if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
        out[key] = executeSelections(ctx, (value as GqlValue).__typename, value as GqlValue, selection.selections, variables, errors);
      } else {
        out[key] = value;
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}

const TYPED_OBJECTS = new Set([
  'Query',
  'Mutation',
  '__Type',
  'Repository',
  'Issue',
  'PullRequest',
  'User',
  'IssueConnection',
  'PullRequestConnection',
  'PageInfo',
  'Ref',
  'Label',
  'IssueComment',
  'PullRequestChangedFile',
]);

function resolveField(ctx: ExecCtx, parentType: string, parent: GqlValue | null, field: string, args: Record<string, unknown>): unknown {
  if (parent === null) return null;
  // A field the schema does not hold on a typed object is an error, so a
  // query for a made-up field is reported, not silently nulled.
  if (TYPED_OBJECTS.has(parentType) && !knownFields(parentType).includes(field)) {
    throw new GqlError(`Cannot query field "${field}" on type "${parentType}".`);
  }
  if (parentType === 'Query') return resolveQuery(ctx, field, args);
  if (parentType === 'Mutation') return resolveMutation(ctx, field, args);
  if (parentType === '__Type') return resolveTypeField(parent, field, args);
  if (parentType === 'Repository') return resolveRepository(ctx, parent.repo as Repo, field, args);
  if (parentType === 'Issue') return resolveIssue(parent.repo as Repo, parent.issue as Issue, field, args);
  if (parentType === 'PullRequest') return resolvePull(parent.repo as Repo, parent.pull as Pull, field, args);
  if (parentType === 'User') return resolveUser(parent, field);
  if (parentType === 'IssueConnection' || parentType === 'PullRequestConnection') {
    return resolveConnection(parent, field);
  }
  // Payload objects, __TypeField/__TypeEnumValue entries, edges and other
  // plain values resolve from their own properties without validation.
  return parent[field] ?? null;
}

function resolveQuery(ctx: ExecCtx, field: string, args: Record<string, unknown>): unknown {
  if (field === 'viewer') return userValue(VIEWER_LOGIN);
  if (field === 'repository') {
    const owner = args.owner;
    const name = args.name;
    if (typeof owner !== 'string' || typeof name !== 'string') return null;
    const repo = ctx.store.getRepo(owner, name);
    return repo === null ? null : repoValue(repo);
  }
  if (field === 'node') {
    const id = args.id;
    if (typeof id !== 'string') return null;
    const decoded = decodeGlobalId(id);
    if (decoded === null) return null;
    if (decoded.kind === 'Repository') {
      const repo = ctx.store.findRepoById(Number(decoded.parts[0]));
      return repo === null ? null : repoValue(repo);
    }
    if (decoded.kind === 'Issue') {
      const repo = ctx.store.findRepoById(Number(decoded.parts[0]));
      const issue = repo?.issues.find((entry) => entry.number === Number(decoded.parts[1]));
      return repo !== undefined && issue !== undefined ? issueValue(repo, issue) : null;
    }
    if (decoded.kind === 'PullRequest') {
      const repo = ctx.store.findRepoById(Number(decoded.parts[0]));
      const pull = repo?.pulls.find((entry) => entry.number === Number(decoded.parts[1]));
      return repo !== undefined && pull !== undefined ? pullValue(repo, pull) : null;
    }
    return null;
  }
  if (field === '__type') {
    const name = args.name;
    if (typeof name !== 'string') return null;
    if (TYPE_FIELDS[name] === undefined && TYPE_ENUMS[name] === undefined) return null;
    return {
      __typename: '__Type',
      name,
      fields: (TYPE_FIELDS[name] ?? []).map((entry) => ({ __typename: '__TypeField', name: entry })),
      enumValues: (TYPE_ENUMS[name] ?? []).map((entry) => ({ __typename: '__TypeEnumValue', name: entry })),
      kind: TYPE_ENUMS[name] !== undefined ? 'ENUM' : 'OBJECT',
    };
  }
  return null;
}

function resolveTypeField(parent: GqlValue, field: string, _args: Record<string, unknown>): unknown {
  if (field === 'fields') return parent.fields ?? null;
  if (field === 'enumValues') return parent.enumValues ?? null;
  return parent[field] ?? null;
}

function resolveUser(parent: GqlValue, field: string): unknown {
  return parent[field] ?? null;
}

function resolveConnection(parent: GqlValue, field: string): unknown {
  if (field === 'nodes') return (parent.nodes as GqlValue[]) ?? [];
  if (field === 'pageInfo') {
    return { __typename: 'PageInfo', ...(parent.pageInfo as Record<string, unknown>) };
  }
  if (field === 'totalCount') return (parent.nodes as GqlValue[] | undefined)?.length ?? 0;
  if (field === 'edges') {
    return ((parent.nodes as GqlValue[] | undefined) ?? []).map((node) => ({ __typename: 'Edge', node, cursor: '' }));
  }
  return null;
}

function resolveRepository(ctx: ExecCtx, repo: Repo, field: string, args: Record<string, unknown>): unknown {
  switch (field) {
    case 'id':
      return globalId('Repository', repo.id);
    case 'databaseId':
      return repo.id;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return `${repo.owner}/${repo.name}`;
    case 'owner':
      return userValue(repo.owner);
    case 'description':
      return repo.description;
    case 'defaultBranchRef':
      return { __typename: 'Ref', name: repo.defaultBranch };
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
      return true;
    case 'isPrivate':
      return repo.private;
    case 'url':
      return '';
    case 'createdAt':
      return repo.createdAt;
    case 'updatedAt':
      return repo.updatedAt;
    case 'issue': {
      const number = args.number;
      if (typeof number !== 'number') return null;
      const issue = repo.issues.find((entry) => entry.number === number);
      return issue === undefined ? null : issueValue(repo, issue);
    }
    case 'issues': {
      const ordered = orderIssues(repo.issues, args);
      const first = typeof args.first === 'number' ? args.first : ordered.length;
      const after = decodeCursor(args.after);
      let start = 0;
      if (after !== null) {
        const index = ordered.findIndex((issue) => issue.number === after);
        start = index < 0 ? 0 : index + 1;
      }
      const slice = ordered.slice(start, start + first);
      const hasNextPage = start + slice.length < ordered.length;
      const endCursor = slice.length > 0 ? encodeCursor(slice[slice.length - 1]!.number) : null;
      return {
        __typename: 'IssueConnection',
        nodes: slice.map((issue) => issueValue(repo, issue)),
        pageInfo: { hasNextPage, endCursor },
      };
    }
    case 'pullRequests': {
      const first = typeof args.first === 'number' ? args.first : repo.pulls.length;
      const ordered = [...repo.pulls].sort((a, b) => b.number - a.number);
      const slice = ordered.slice(0, first);
      return {
        __typename: 'PullRequestConnection',
        nodes: slice.map((pull) => pullValue(repo, pull)),
        pageInfo: { hasNextPage: slice.length < ordered.length, endCursor: null },
      };
    }
    case 'pullRequest': {
      const number = args.number;
      if (typeof number !== 'number') return null;
      const pull = repo.pulls.find((entry) => entry.number === number);
      return pull === undefined ? null : pullValue(repo, pull);
    }
    default:
      return null;
  }
}

function orderIssues(issues: Issue[], args: Record<string, unknown>): Issue[] {
  let list = [...issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = args.orderBy;
  let key: (issue: Issue) => number = (issue) => issue.createdSeq;
  let direction = 1;
  if (orderBy !== null && typeof orderBy === 'object') {
    const by = orderBy as Record<string, unknown>;
    if (by.field === 'UPDATED_AT') key = (issue) => issue.updatedSeq;
    else if (by.field === 'COMMENTS') key = (issue) => issue.comments.length;
    else key = (issue) => issue.createdSeq;
    direction = by.direction === 'DESC' ? -1 : 1;
  }
  list.sort((a, b) => {
    const diff = (key(a) - key(b)) * direction;
    if (diff !== 0) return diff;
    return (a.number - b.number) * direction;
  });
  return list;
}

function resolveIssue(repo: Repo, issue: Issue, field: string, _args: Record<string, unknown>): unknown {
  switch (field) {
    case 'id':
      return globalId('Issue', repo.id, issue.number);
    case 'number':
      return issue.number;
    case 'title':
      return issue.title;
    case 'state':
      return issue.state === 'open' ? 'OPEN' : 'CLOSED';
    case 'body':
      return issue.body;
    case 'url':
      return '';
    case 'createdAt':
      return issue.createdAt;
    case 'updatedAt':
      return issue.updatedAt;
    case 'author':
      return userValue(VIEWER_LOGIN);
    case 'closed':
      return issue.state === 'closed';
    case 'closedAt':
      return issue.state === 'closed' ? issue.updatedAt : null;
    case 'labels':
      return {
        __typename: 'IssueConnection',
        nodes: issue.labels.map((name) => ({ __typename: 'Label', name })),
        pageInfo: { hasNextPage: false, endCursor: null },
      };
    case 'comments':
      return {
        __typename: 'IssueConnection',
        nodes: issue.comments.map((comment) => ({
          __typename: 'IssueComment',
          id: globalId('IssueComment', repo.id, issue.number, comment.id),
          body: comment.body,
          author: userValue(VIEWER_LOGIN),
          createdAt: comment.createdAt,
          updatedAt: comment.updatedAt,
        })),
        pageInfo: { hasNextPage: false, endCursor: null },
      };
    default:
      return null;
  }
}

function resolvePull(repo: Repo, pull: Pull, field: string, args: Record<string, unknown>): unknown {
  switch (field) {
    case 'id':
      return globalId('PullRequest', repo.id, pull.number);
    case 'number':
      return pull.number;
    case 'title':
      return pull.title;
    case 'body':
      return pull.body;
    case 'state':
      return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    case 'merged':
      return pull.merged;
    case 'mergeable':
      return mergeableOf(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
    case 'headRefName':
      return pull.headRef;
    case 'baseRefName':
      return pull.baseRef;
    case 'url':
      return '';
    case 'createdAt':
      return pull.createdAt;
    case 'updatedAt':
      return pull.updatedAt;
    case 'author':
      return userValue(VIEWER_LOGIN);
    case 'files': {
      const first = typeof args.first === 'number' ? args.first : 100;
      const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
      const baseTree = commitTree(repo, pull.baseSha);
      const headTree = commitTree(repo, headTip);
      const changes = diffTrees(repo, baseTree, headTree).slice(0, first);
      return {
        __typename: 'PullRequestConnection',
        nodes: changes.map((change) => ({
          __typename: 'PullRequestChangedFile',
          path: change.filename,
          additions: change.additions,
          deletions: change.deletions,
          changeType: change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'REMOVED' : 'MODIFIED',
        })),
        pageInfo: { hasNextPage: false, endCursor: null },
      };
    }
    default:
      return null;
  }
}

function resolveMutation(ctx: ExecCtx, field: string, args: Record<string, unknown>): unknown {
  const input = args.input;
  if (input === null || typeof input !== 'object') throw new GqlError(`mutation ${field} needs an input object`);
  const values = input as Record<string, unknown>;
  if (field === 'createIssue') {
    const repoId = values.repositoryId;
    if (typeof repoId !== 'string') throw new GqlError('createIssue needs repositoryId');
    const decoded = decodeGlobalId(repoId);
    if (decoded === null || decoded.kind !== 'Repository') throw new GqlError('createIssue: unknown repositoryId');
    const repo = ctx.store.findRepoById(Number(decoded.parts[0]));
    if (repo === null) throw new GqlError('createIssue: unknown repository');
    const title = values.title;
    if (typeof title !== 'string' || title === '') throw new GqlError('createIssue needs a title');
    const issue = ctx.store.createIssue(repo, title, typeof values.body === 'string' ? values.body : '', []);
    return { __typename: 'CreateIssuePayload', issue: issueValue(repo, issue) };
  }
  if (field === 'closeIssue') {
    const issueId = values.issueId;
    if (typeof issueId !== 'string') throw new GqlError('closeIssue needs issueId');
    const decoded = decodeGlobalId(issueId);
    if (decoded === null || decoded.kind !== 'Issue') throw new GqlError('closeIssue: unknown issueId');
    const repo = ctx.store.findRepoById(Number(decoded.parts[0]));
    const issue = repo?.issues.find((entry) => entry.number === Number(decoded.parts[1]));
    if (repo === undefined || issue === undefined) throw new GqlError('closeIssue: unknown issue');
    issue.state = 'closed';
    issue.updatedSeq = ctx.store.nextSeq();
    return { __typename: 'CloseIssuePayload', issue: issueValue(repo, issue) };
  }
  if (field === 'createPullRequest') {
    const repoId = values.repositoryId;
    if (typeof repoId !== 'string') throw new GqlError('createPullRequest needs repositoryId');
    const decoded = decodeGlobalId(repoId);
    if (decoded === null || decoded.kind !== 'Repository') throw new GqlError('createPullRequest: unknown repositoryId');
    const repo = ctx.store.findRepoById(Number(decoded.parts[0]));
    if (repo === null) throw new GqlError('createPullRequest: unknown repository');
    const head = values.headRefName;
    const base = values.baseRefName;
    const title = values.title;
    if (typeof head !== 'string' || typeof base !== 'string' || typeof title !== 'string') {
      throw new GqlError('createPullRequest needs headRefName, baseRefName and title');
    }
    const headTip = branchTip(repo, head);
    const baseTip = branchTip(repo, base);
    if (headTip === null) throw new GqlError(`head branch ${head} does not exist`);
    if (baseTip === null) throw new GqlError(`base branch ${base} does not exist`);
    const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
    if (duplicate !== undefined) throw new GqlError('A pull request already exists for these branches');
    const pull = ctx.store.createPull(repo, title, typeof values.body === 'string' ? values.body : '', head, base, headTip, baseTip);
    return { __typename: 'CreatePullRequestPayload', pullRequest: pullValue(repo, pull) };
  }
  if (field === 'mergePullRequest') {
    const pullId = values.pullRequestId;
    if (typeof pullId !== 'string') throw new GqlError('mergePullRequest needs pullRequestId');
    const decoded = decodeGlobalId(pullId);
    if (decoded === null || decoded.kind !== 'PullRequest') throw new GqlError('mergePullRequest: unknown pullRequestId');
    const repo = ctx.store.findRepoById(Number(decoded.parts[0]));
    const pull = repo?.pulls.find((entry) => entry.number === Number(decoded.parts[1]));
    if (repo === undefined || pull === undefined) throw new GqlError('mergePullRequest: unknown pull request');
    const merged = mergePull(ctx.store, repo, pull);
    if (!merged.ok) throw new GqlError(merged.reason);
    return { __typename: 'MergePullRequestPayload', pullRequest: pullValue(repo, pull) };
  }
  if (field === 'addComment') {
    const subjectId = values.subjectId;
    if (typeof subjectId !== 'string') throw new GqlError('addComment needs subjectId');
    const decoded = decodeGlobalId(subjectId);
    if (decoded === null || decoded.kind !== 'Issue') throw new GqlError('addComment: unknown subjectId');
    const repo = ctx.store.findRepoById(Number(decoded.parts[0]));
    const issue = repo?.issues.find((entry) => entry.number === Number(decoded.parts[1]));
    if (repo === undefined || issue === undefined) throw new GqlError('addComment: unknown issue');
    const bodyText = values.body;
    if (typeof bodyText !== 'string') throw new GqlError('addComment needs a body');
    const comment = ctx.store.addComment(repo, issue, bodyText);
    return {
      __typename: 'AddCommentPayload',
      commentEdge: {
        __typename: 'IssueCommentEdge',
        node: {
          __typename: 'IssueComment',
          id: globalId('IssueComment', repo.id, issue.number, comment.id),
          body: comment.body,
        },
      },
    };
  }
  return null;
}

// ------------------------------------------------------------------- handler

function executeOne(
  ctx: ExecCtx,
  query: string,
  variables: Record<string, unknown>,
  operationName?: string,
): { data: unknown; errors?: Array<{ message: string }> } {
  let operations: Operation[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  let operation: Operation | undefined;
  if (operationName !== undefined) {
    operation = operations.find((entry) => entry.name === operationName);
    if (operation === undefined) return { data: null, errors: [{ message: `unknown operation ${operationName}` }] };
  } else if (operations.length === 1) {
    operation = operations[0];
  } else {
    return { data: null, errors: [{ message: 'multiple operations need an operationName' }] };
  }
  const vars: Record<string, unknown> = { ...variables };
  for (const [name, node] of Object.entries(operation.variables)) {
    if (!(name in vars) && node.kind !== 'null') vars[name] = evalValue(node, vars);
  }
  const errors: Array<{ message: string }> = [];
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const root: GqlValue = { __typename: rootType };
  const data = executeSelections(ctx, rootType, root, operation.selections, vars, errors);
  if (errors.length > 0) return { data, errors };
  return { data };
}

export async function handleGraphql(
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
    return jsonError(400, 'Invalid JSON body');
  }
  const ctx: ExecCtx = { store };
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => {
      if (entry === null || typeof entry !== 'object') return { data: null, errors: [{ message: 'invalid operation' }] };
      const op = entry as Record<string, unknown>;
      const query = op.query;
      if (typeof query !== 'string') return { data: null, errors: [{ message: 'query is required' }] };
      const variables = op.variables !== null && typeof op.variables === 'object' ? (op.variables as Record<string, unknown>) : {};
      const operationName = typeof op.operationName === 'string' ? op.operationName : undefined;
      return executeOne(ctx, query, variables, operationName);
    });
    return jsonResponse(200, results);
  }
  if (parsed === null || typeof parsed !== 'object') return jsonError(400, 'Invalid GraphQL body');
  const op = parsed as Record<string, unknown>;
  const query = op.query;
  if (typeof query !== 'string') return jsonError(400, 'query is required');
  const variables = op.variables !== null && typeof op.variables === 'object' ? (op.variables as Record<string, unknown>) : {};
  const operationName = typeof op.operationName === 'string' ? op.operationName : undefined;
  return jsonResponse(200, executeOne(ctx, query, variables, operationName));
}
