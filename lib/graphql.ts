// GraphQL v4 API at /api/graphql: a small document parser and executor covering
// exactly the surface the suite drives (viewer, repository, node, __type and the
// five mutations), plus batched operation arrays. A GraphQL-level failure is an
// HTTP 200 carrying `errors`; unauthenticated is 401.

import {
  branchTip,
  diffTrees,
  ownerMatches,
  repoByName,
  viewerName,
  type IssueRec,
  type PullRec,
  type RepoRec,
  type Vault,
} from './store.ts';
import { mergePullRequest } from './mcp.ts';

export interface Reply {
  status: number;
  body: Buffer;
  contentType: string;
}

// ---- global ids (opaque, stable) -----------------------------------------------

function gid(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

function ungid(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function repoGid(v: Vault, repo: RepoRec): string {
  return gid('repo', `${viewerName(v)}/${repo.name}`);
}

function issueGid(v: Vault, repo: RepoRec, issue: IssueRec): string {
  return gid('issue', `${viewerName(v)}/${repo.name}#${issue.number}`);
}

function pullGid(v: Vault, repo: RepoRec, pull: PullRec): string {
  return gid('pr', `${viewerName(v)}/${repo.name}#${pull.number}`);
}

function commentGid(v: Vault, repo: RepoRec, issue: IssueRec, commentId: number): string {
  return gid('comment', `${viewerName(v)}/${repo.name}#${issue.number}:${commentId}`);
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function cursorNumber(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = parseInt(text.slice(7), 10);
    return Number.isSafeInteger(n) ? n : null;
  } catch {
    return null;
  }
}

// ---- tokenizer -------------------------------------------------------------------

type Tok =
  | { kind: 'name'; text: string }
  | { kind: 'string'; text: string }
  | { kind: 'number'; text: string }
  | { kind: 'punct'; text: string }
  | { kind: 'spread' };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && src.slice(i, i + 3) === '...') {
      out.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}():!$=[]@'.includes(ch)) {
      out.push({ kind: 'punct', text: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let text = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          if (esc === 'n') text += '\n';
          else if (esc === 't') text += '\t';
          else if (esc === 'r') text += '\r';
          else text += esc;
          j += 2;
        } else {
          text += src[j];
          j += 1;
        }
      }
      out.push({ kind: 'string', text });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9.]/.test(src[j])) j += 1;
      out.push({ kind: 'number', text: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < src.length && /[_A-Za-z0-9]/.test(src[j])) j += 1;
      out.push({ kind: 'name', text: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return out;
}

// ---- parser ----------------------------------------------------------------------

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface SelectionNode {
  kind: 'field' | 'spread' | 'inline';
  name?: string;
  alias?: string;
  args?: Array<{ name: string; value: ValueNode }>;
  selections?: SelectionNode[];
  fragment?: string;
  typeCondition?: string;
}

interface OperationNode {
  kind: 'query' | 'mutation';
  name: string | null;
  selections: SelectionNode[];
}

interface FragmentNode {
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Tok[];
  constructor(tokens: Tok[]) {
    this.tokens = tokens;
  }

  private peek(): Tok | undefined {
    return this.tokens[this.pos];
  }

  private next(): Tok {
    const t = this.tokens[this.pos];
    if (!t) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return t;
  }

  private isPunct(text: string): boolean {
    const t = this.peek();
    return !!t && t.kind === 'punct' && t.text === text;
  }

  private eatPunct(text: string): boolean {
    if (this.isPunct(text)) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectPunct(text: string): void {
    if (!this.eatPunct(text)) throw new Error(`expected ${text} in GraphQL document`);
  }

  private expectName(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return t.text;
  }

  parseDocument(): DocumentNode {
    const doc: DocumentNode = { operations: [], fragments: new Map() };
    while (this.peek()) {
      const t = this.peek()!;
      if (t.kind === 'name' && (t.text === 'query' || t.text === 'mutation')) {
        doc.operations.push(this.parseOperation(t.text as 'query' | 'mutation'));
      } else if (t.kind === 'name' && t.text === 'fragment') {
        const frag = this.parseFragment();
        doc.fragments.set(frag.name, frag);
      } else if (t.kind === 'punct' && t.text === '{') {
        doc.operations.push({ kind: 'query', name: null, selections: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token in GraphQL document: ${JSON.stringify(t)}`);
      }
    }
    return doc;
  }

  private parseOperation(kind: 'query' | 'mutation'): OperationNode {
    this.next(); // query / mutation
    let name: string | null = null;
    const t = this.peek();
    if (t && t.kind === 'name') {
      name = this.expectName();
    }
    if (this.isPunct('(')) this.skipVariableDefinitions();
    return { kind, name, selections: this.parseSelectionSet() };
  }

  private skipVariableDefinitions(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const t = this.next();
      if (t.kind === 'punct' && t.text === '(') depth += 1;
      else if (t.kind === 'punct' && t.text === ')') depth -= 1;
    }
  }

  private parseFragment(): FragmentNode {
    this.next(); // fragment
    const name = this.expectName();
    const on = this.expectName();
    if (on !== 'on') throw new Error('expected "on" in fragment');
    const typeCondition = this.expectName();
    return { name, typeCondition, selections: this.parseSelectionSet() };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const out: SelectionNode[] = [];
    while (!this.isPunct('}')) {
      if (!this.peek()) throw new Error('unterminated selection set');
      out.push(this.parseSelection());
    }
    this.expectPunct('}');
    return out;
  }

  private parseSelection(): SelectionNode {
    const t = this.peek()!;
    if (t.kind === 'spread') {
      this.next();
      const next = this.peek();
      if (next && next.kind === 'name' && next.text === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (next && next.kind === 'name') {
        return { kind: 'spread', fragment: this.expectName() };
      }
      throw new Error('bad fragment spread');
    }
    // Field: [alias:] name [args] [selection set]
    const first = this.expectName();
    let name = first;
    let alias: string | undefined;
    if (this.isPunct(':')) {
      this.next();
      alias = first;
      name = this.expectName();
    }
    let args: Array<{ name: string; value: ValueNode }> | undefined;
    if (this.isPunct('(')) args = this.parseArguments();
    let selections: SelectionNode[] | undefined;
    if (this.isPunct('{')) selections = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selections };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    this.expectPunct('(');
    const out: Array<{ name: string; value: ValueNode }> = [];
    while (!this.isPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      out.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return out;
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.text === '$') return { kind: 'var', name: this.expectName() };
    if (t.kind === 'string') return { kind: 'string', value: t.text };
    if (t.kind === 'number') return { kind: 'number', value: Number(t.text) };
    if (t.kind === 'name') {
      if (t.text === 'true') return { kind: 'boolean', value: true };
      if (t.text === 'false') return { kind: 'boolean', value: false };
      if (t.text === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.text };
    }
    if (t.kind === 'punct' && t.text === '[') {
      const items: ValueNode[] = [];
      while (!this.isPunct(']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.text === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.isPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${JSON.stringify(t)}`);
  }
}

// ---- executor --------------------------------------------------------------------

type GqlValue = string | number | boolean | null | GqlValue[] | { [key: string]: GqlValue };

interface ExecCtx {
  v: Vault;
  variables: Record<string, unknown>;
  errors: Array<{ message: string; path?: string[] }>;
  doc: DocumentNode;
}

function resolveValue(node: ValueNode, ctx: ExecCtx): unknown {
  switch (node.kind) {
    case 'var':
      return ctx.variables[node.name] ?? null;
    case 'string':
    case 'number':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((item) => resolveValue(item, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, ctx);
      return out;
    }
  }
}

function argsOf(sel: SelectionNode, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of sel.args ?? []) out[arg.name] = resolveValue(arg.value, ctx);
  return out;
}

/** A resolved node the executor can select fields from. */
type Node =
  | { __type: 'Query' }
  | { __type: 'User'; login: string }
  | { __type: 'Repository'; repo: RepoRec }
  | { __type: 'Issue'; repo: RepoRec; issue: IssueRec }
  | { __type: 'PullRequest'; repo: RepoRec; pull: PullRec }
  | { __type: 'IssueConnection'; repo: RepoRec; items: IssueRec[]; hasNext: boolean; endCursor: string | null }
  | { __type: 'PullRequestConnection'; repo: RepoRec; items: PullRec[] }
  | { __type: 'ChangedFile'; path: string }
  | { __type: 'Comment'; id: string; body: string }
  | { __type: 'PageInfo'; hasNext: boolean; endCursor: string | null }
  | { __type: 'TypeInfo'; name: string; kind: 'OBJECT' | 'ENUM'; fields: string[]; enumValues: string[] }
  | { __type: 'FieldInfo'; name: string }
  | { __type: 'BranchRef'; name: string };

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: [
    'id',
    'databaseId',
    'name',
    'nameWithOwner',
    'owner',
    'defaultBranchRef',
    'viewerPermission',
    'hasIssuesEnabled',
    'issue',
    'issues',
    'pullRequests',
    'pullRequest',
  ],
};

const SEARCH_ENUM = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'MARKETPLACE', 'COMMIT'];

function typeInfo(name: string): Node | null {
  if (name === 'SearchType') return { __type: 'TypeInfo', name, kind: 'ENUM', fields: [], enumValues: SEARCH_ENUM };
  const fields = TYPE_FIELDS[name];
  if (!fields) return null;
  return { __type: 'TypeInfo', name, kind: 'OBJECT', fields, enumValues: [] };
}

function findRepo(v: Vault, owner: string, name: string): RepoRec | null {
  if (!ownerMatches(v, owner)) return null;
  return repoByName(v, name) ?? null;
}

function decodeNodeId(v: Vault, id: string): { repo: RepoRec; issue?: IssueRec; pull?: PullRec } | null {
  const parsed = ungid(id);
  if (!parsed) return null;
  const [ownerRepo, rest] = parsed.key.split('#');
  const [owner, name] = ownerRepo.split('/');
  const repo = findRepo(v, owner, name);
  if (!repo) return null;
  if (parsed.kind === 'repo') return { repo };
  if (parsed.kind === 'issue' && rest !== undefined) {
    const issue = repo.issues.find((i) => i.number === parseInt(rest, 10));
    return issue ? { repo, issue } : null;
  }
  if (parsed.kind === 'pr' && rest !== undefined) {
    const pull = repo.pulls.find((p) => p.number === parseInt(rest, 10));
    return pull ? { repo, pull } : null;
  }
  if (parsed.kind === 'comment' && rest !== undefined) {
    const [issueNum] = rest.split(':');
    const issue = repo.issues.find((i) => i.number === parseInt(issueNum, 10));
    return issue ? { repo, issue } : null;
  }
  return null;
}

function issueList(
  v: Vault,
  repo: RepoRec,
  args: Record<string, unknown>,
): { items: IssueRec[]; hasNext: boolean; endCursor: string | null } {
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = orderBy.direction === 'ASC' ? 'asc' : 'desc';
  const first = typeof args.first === 'number' ? args.first : 100;
  const after = typeof args.after === 'string' ? cursorNumber(args.after) : null;
  let list = [...repo.issues];
  if (states) {
    const wanted = new Set(states.map((s) => s.toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  list.sort((a, b) => (direction === 'asc' ? a.order - b.order : b.order - a.order));
  if (after !== null) {
    list = list.filter((i) => (direction === 'asc' ? i.number > after : i.number < after));
  }
  const page = list.slice(0, first);
  const hasNext = list.length > page.length;
  const endCursor = page.length ? cursorFor(page[page.length - 1].number) : null;
  return { items: page, hasNext, endCursor };
}

function resolveField(node: Node, sel: SelectionNode, ctx: ExecCtx, path: string[]): unknown {
  const { v } = ctx;
  const args = argsOf(sel, ctx);
  const field = sel.name!;
  switch (node.__type) {
    case 'Query': {
      if (field === 'viewer') return { __type: 'User', login: viewerName(v) };
      if (field === 'repository') {
        const repo = findRepo(v, String(args.owner ?? ''), String(args.name ?? ''));
        return repo ? { __type: 'Repository', repo } : null;
      }
      if (field === 'node') {
        const found = decodeNodeId(v, String(args.id ?? ''));
        if (!found) return null;
        if (found.pull) return { __type: 'PullRequest', repo: found.repo, pull: found.pull };
        if (found.issue) return { __type: 'Issue', repo: found.repo, issue: found.issue };
        return { __type: 'Repository', repo: found.repo };
      }
      if (field === '__type') {
        return typeInfo(String(args.name ?? ''));
      }
      if (field === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = decodeNodeId(v, String(input.repositoryId ?? ''));
        if (!found) return { issue: null };
        const issue: IssueRec = {
          number: found.repo.nextIssue++,
          title: String(input.title ?? ''),
          body: String(input.body ?? ''),
          state: 'open',
          labels: [],
          order: v.clock++,
          comments: [],
        };
        found.repo.issues.push(issue);
        return { issue: { __type: 'Issue', repo: found.repo, issue } };
      }
      if (field === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = decodeNodeId(v, String(input.issueId ?? ''));
        if (!found || !found.issue) return { issue: null };
        found.issue.state = 'closed';
        return { issue: { __type: 'Issue', repo: found.repo, issue: found.issue } };
      }
      if (field === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = decodeNodeId(v, String(input.repositoryId ?? ''));
        if (!found) return { pullRequest: null };
        const headTip = branchTip(v, found.repo, String(input.headRefName ?? ''));
        const baseTip = branchTip(v, found.repo, String(input.baseRefName ?? ''));
        if (headTip === undefined || baseTip === undefined) return { pullRequest: null };
        const pull: PullRec = {
          number: found.repo.nextPull++,
          title: String(input.title ?? ''),
          body: String((input as Record<string, unknown>).body ?? ''),
          state: 'open',
          merged: false,
          mergedAt: null,
          mergeSha: null,
          headRef: String(input.headRefName),
          baseRef: String(input.baseRefName),
          headTip,
          baseTip,
          order: v.clock++,
        };
        found.repo.pulls.push(pull);
        return { pullRequest: { __type: 'PullRequest', repo: found.repo, pull } };
      }
      if (field === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = decodeNodeId(v, String(input.pullRequestId ?? ''));
        if (!found || !found.pull) return { pullRequest: null };
        mergePullRequest(v, found.repo, found.pull);
        return { pullRequest: { __type: 'PullRequest', repo: found.repo, pull: found.pull } };
      }
      if (field === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = decodeNodeId(v, String(input.subjectId ?? ''));
        if (!found || !found.issue) return { commentEdge: null };
        const comment = { id: found.repo.nextComment++, body: String(input.body ?? '') };
        found.issue.comments.push(comment);
        const gid = commentGid(v, found.repo, found.issue, comment.id);
        return { commentEdge: { node: { __type: 'Comment', id: gid, body: comment.body } } };
      }
      break;
    }
    case 'User': {
      if (field === 'login') return node.login;
      break;
    }
    case 'Repository': {
      const repo = node.repo;
      if (field === 'id') return repoGid(v, repo);
      if (field === 'databaseId') return repo.id;
      if (field === 'name') return repo.name;
      if (field === 'nameWithOwner') return `${viewerName(v)}/${repo.name}`;
      if (field === 'owner') return { __type: 'User', login: viewerName(v) };
      if (field === 'defaultBranchRef') return { __type: 'BranchRef', name: repo.branch };
      if (field === 'viewerPermission') return 'ADMIN';
      if (field === 'hasIssuesEnabled') return true;
      if (field === 'issue') {
        const issue = repo.issues.find((i) => i.number === Number(args.number));
        return issue ? { __type: 'Issue', repo, issue } : null;
      }
      if (field === 'issues') {
        const page = issueList(v, repo, args);
        return { __type: 'IssueConnection', repo, items: page.items, hasNext: page.hasNext, endCursor: page.endCursor };
      }
      if (field === 'pullRequests') {
        const first = typeof args.first === 'number' ? args.first : 100;
        const items = [...repo.pulls].sort((a, b) => b.order - a.order).slice(0, first);
        return { __type: 'PullRequestConnection', repo, items };
      }
      if (field === 'pullRequest') {
        const pull = repo.pulls.find((p) => p.number === Number(args.number));
        return pull ? { __type: 'PullRequest', repo, pull } : null;
      }
      break;
    }
    case 'Issue': {
      if (field === 'id') return issueGid(v, node.repo, node.issue);
      if (field === 'number') return node.issue.number;
      if (field === 'title') return node.issue.title;
      if (field === 'state') return node.issue.state.toUpperCase();
      if (field === 'body') return node.issue.body;
      break;
    }
    case 'PullRequest': {
      if (field === 'id') return pullGid(v, node.repo, node.pull);
      if (field === 'number') return node.pull.number;
      if (field === 'state') return node.pull.merged ? 'MERGED' : node.pull.state.toUpperCase();
      if (field === 'merged') return node.pull.merged;
      if (field === 'headRefName') return node.pull.headRef;
      if (field === 'baseRefName') return node.pull.baseRef;
      if (field === 'mergeable') return 'MERGEABLE';
      if (field === 'files') {
        const changes = diffTrees(v, node.pull.baseTip, node.pull.headTip);
        const first = typeof args.first === 'number' ? args.first : 100;
        return {
          nodes: changes.slice(0, first).map((c) => ({ __type: 'ChangedFile', path: c.path })),
        };
      }
      break;
    }
    case 'IssueConnection': {
      if (field === 'nodes') {
        return node.items.map((issue) => ({ __type: 'Issue', repo: node.repo, issue }));
      }
      if (field === 'pageInfo') return { __type: 'PageInfo', hasNext: node.hasNext, endCursor: node.endCursor };
      break;
    }
    case 'PullRequestConnection': {
      if (field === 'nodes') {
        return node.items.map((pull) => ({ __type: 'PullRequest', repo: node.repo, pull }));
      }
      break;
    }
    case 'ChangedFile': {
      if (field === 'path') return node.path;
      break;
    }
    case 'Comment': {
      if (field === 'id') return node.id;
      if (field === 'body') return node.body;
      break;
    }
    case 'PageInfo': {
      if (field === 'hasNextPage') return node.hasNext;
      if (field === 'endCursor') return node.endCursor;
      break;
    }
    case 'TypeInfo': {
      if (field === 'name') return node.name;
      if (field === 'kind') return node.kind;
      if (field === 'fields') {
        return node.fields.map((name) => ({ __type: 'FieldInfo', name }));
      }
      if (field === 'enumValues') {
        return node.enumValues.map((name) => ({ __type: 'FieldInfo', name }));
      }
      break;
    }
    case 'FieldInfo': {
      if (field === 'name') return node.name;
      break;
    }
    case 'BranchRef': {
      if (field === 'name') return node.name;
      break;
    }
  }
  ctx.errors.push({ message: `Cannot query field "${field}" on type "${node.__type}".`, path });
  return null;
}

/** Execute one selection set against a node value. */
function executeSelections(node: Node | null, selections: SelectionNode[], ctx: ExecCtx, path: string[]): Record<string, unknown> | null {
  if (node === null) return null;
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'spread') {
      const frag = ctx.doc.fragments.get(sel.fragment ?? '');
      if (frag) {
        const merged = executeSelections(node, frag.selections, ctx, path);
        if (merged) Object.assign(out, merged);
      }
      continue;
    }
    if (sel.kind === 'inline') {
      const condition = sel.typeCondition ?? '';
      const typeName = node.__type === 'Repository' ? 'Repository' : node.__type;
      if (condition === '' || condition === typeName) {
        const merged = executeSelections(node, sel.selections ?? [], ctx, path);
        if (merged) Object.assign(out, merged);
      }
      continue;
    }
    const key = sel.alias ?? sel.name!;
    const value = resolveField(node, sel, ctx, [...path, key]);
    out[key] = executeValue(value, sel.selections ?? [], ctx, [...path, key]);
  }
  return out;
}

function executeValue(value: unknown, selections: SelectionNode[], ctx: ExecCtx, path: string[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => executeValue(item, selections, ctx, path));
  if (typeof value === 'object' && '__type' in (value as Record<string, unknown>)) {
    return executeSelections(value as Node, selections, ctx, path);
  }
  if (typeof value === 'object' && selections.length > 0) {
    // A plain object result (mutation payloads): resolve each selected field from it.
    const out: Record<string, unknown> = {};
    for (const sel of selections) {
      if (sel.kind !== 'field') continue;
      const key = sel.alias ?? sel.name!;
      const child = (value as Record<string, unknown>)[sel.name!];
      out[key] = executeValue(child, sel.selections ?? [], ctx, [...path, key]);
    }
    return out;
  }
  return value as GqlValue;
}

function runOperation(doc: DocumentNode, op: OperationNode, variables: Record<string, unknown>, v: Vault): { data: unknown; errors?: Array<{ message: string; path?: string[] }> } {
  const ctx: ExecCtx = { v, variables, errors: [], doc };
  const data = executeSelections({ __type: 'Query' }, op.selections, ctx, []);
  return ctx.errors.length ? { data, errors: ctx.errors } : { data };
}

export function graphqlRoute(v: Vault, raw: Buffer | null): Reply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw === null ? '{}' : raw.toString('utf8'));
  } catch {
    return {
      status: 400,
      body: Buffer.from(JSON.stringify({ errors: [{ message: 'request body is not valid JSON' }] }), 'utf8'),
      contentType: 'application/json',
    };
  }
  const runOne = (body: Record<string, unknown>): Record<string, unknown> => {
    const query = typeof body.query === 'string' ? body.query : '';
    const variables = (body.variables ?? {}) as Record<string, unknown>;
    const operationName = typeof body.operationName === 'string' ? body.operationName : null;
    let doc: DocumentNode;
    try {
      doc = new Parser(tokenize(query)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
    }
    const op = operationName
      ? doc.operations.find((o) => o.name === operationName)
      : doc.operations[0];
    if (!op) return { data: null, errors: [{ message: 'no operation found' }] };
    return runOperation(doc, op, variables, v);
  };
  let result: unknown;
  if (Array.isArray(parsed)) {
    result = parsed.map((item) => runOne(item as Record<string, unknown>));
  } else {
    result = runOne(parsed as Record<string, unknown>);
  }
  return { status: 200, body: Buffer.from(JSON.stringify(result), 'utf8'), contentType: 'application/json' };
}
