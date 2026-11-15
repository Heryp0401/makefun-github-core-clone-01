// GitHub GraphQL v4, for the documents gh and github-mcp-server actually send.
// A small parser for the GraphQL subset those documents use (operations, variables,
// aliases, inline fragments, input objects, inline enum lists, nulls, batches) plus
// an executor over the same in-memory store the REST surface uses. Global ids are
// opaque base64 and stable across reads.

import {
  Store, FIXED_TIME, mergeConflict, pullChangedPaths,
  type Ctx, type HandlerResult, type Repo, type Issue, type Pull,
} from './store.ts';

// ---- global ids -------------------------------------------------------------

function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`).toString('base64');
}

function parseGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

// ---- tokenizer --------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'ellipsis' };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i++;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '.' && src[i + 1] === '.' && src[i + 2] === '.') {
      tokens.push({ kind: 'ellipsis' });
      i += 3;
      continue;
    }
    if ('{}():!=$[]@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i++;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      let isFloat = false;
      if (src[j] === '-') j++;
      while (j < src.length && /[0-9]/.test(src[j])) j++;
      if (src[j] === '.') {
        isFloat = true;
        j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j++;
        if (src[j] === '+' || src[j] === '-') j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      const num = Number(src.slice(i, j));
      tokens.push(isFloat ? { kind: 'float', value: num } : { kind: 'int', value: num });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < src.length && /[_A-Za-z0-9]/.test(src[j])) j++;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`GraphQL: unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

// ---- AST --------------------------------------------------------------------

export interface ValueNode {
  kind: 'variable' | 'string' | 'int' | 'float' | 'boolean' | 'null' | 'enum' | 'list' | 'object';
  value?: unknown;
  items?: ValueNode[];
  fields?: Array<{ name: string; value: ValueNode }>;
}

export interface FieldNode {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[];
}

export type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inlineFragment'; typeCondition: string | null; selections: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

export interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  variables: Array<{ name: string; type: string }>;
  selections: SelectionNode[];
}

export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string; selections: SelectionNode[] }>;
}

class Parser {
  private pos = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new Error('GraphQL: unexpected end of document');
    this.pos++;
    return t;
  }
  private isPunct(value: string): boolean {
    const t = this.peek();
    return t !== undefined && t.kind === 'punct' && t.value === value;
  }
  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`GraphQL: expected '${value}'`);
  }
  private expectName(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error('GraphQL: expected a name');
    return t.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string; selections: SelectionNode[] }>();
    while (this.pos < this.tokens.length) {
      const t = this.peek()!;
      if (t.kind === 'punct' && t.value === '{') {
        operations.push({ operation: 'query', name: null, variables: [], selections: this.parseSelectionSet() });
        continue;
      }
      if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
        const kind = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        const nt = this.peek();
        if (nt && nt.kind === 'name') name = this.next().value as string;
        const variables: Array<{ name: string; type: string }> = [];
        if (this.isPunct('(')) {
          this.next();
          while (!this.isPunct(')')) {
            this.expectPunct('$');
            const varName = this.expectName();
            this.expectPunct(':');
            const type = this.parseType();
            variables.push({ name: varName, type });
            if (this.isPunct('=')) {
              this.next();
              this.parseValue();
            }
          }
          this.expectPunct(')');
        }
        operations.push({ operation: kind, name, variables, selections: this.parseSelectionSet() });
        continue;
      }
      if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('GraphQL: expected "on" in fragment');
        const typeCondition = this.expectName();
        fragments.set(fragName, { typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`GraphQL: unexpected token ${JSON.stringify(t)}`);
    }
    return { operations, fragments };
  }

  private parseType(): string {
    let type = '';
    const t = this.next();
    if (t.kind === 'punct' && t.value === '[') {
      type = `[${this.parseType()}]`;
    } else if (t.kind === 'name') {
      type = t.value;
    } else {
      throw new Error('GraphQL: expected a type');
    }
    if (this.isPunct('!')) {
      this.next();
      type += '!';
    }
    return type;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.isPunct('}')) {
      const t = this.peek()!;
      if (t.kind === 'ellipsis') {
        this.next();
        const nt = this.peek();
        if (nt && nt.kind === 'name' && nt.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          selections.push({ kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() });
        } else if (nt && nt.kind === 'name') {
          selections.push({ kind: 'fragmentSpread', name: this.next().value as string });
        } else {
          selections.push({ kind: 'inlineFragment', typeCondition: null, selections: this.parseSelectionSet() });
        }
        continue;
      }
      if (t.kind === 'name') {
        let alias: string | null = null;
        let name = this.next().value as string;
        if (this.isPunct(':')) {
          this.next();
          alias = name;
          name = this.expectName();
        }
        const args: Array<{ name: string; value: ValueNode }> = [];
        if (this.isPunct('(')) {
          this.next();
          while (!this.isPunct(')')) {
            const argName = this.expectName();
            this.expectPunct(':');
            args.push({ name: argName, value: this.parseValue() });
          }
          this.expectPunct(')');
        }
        // Directives (not used by the suite's documents): skip @name[(args)].
        while (this.isPunct('@')) {
          this.next();
          this.expectName();
          if (this.isPunct('(')) {
            this.next();
            while (!this.isPunct(')')) {
              this.expectName();
              this.expectPunct(':');
              this.parseValue();
            }
            this.expectPunct(')');
          }
        }
        let sub: SelectionNode[] = [];
        if (this.isPunct('{')) {
          sub = this.parseSelectionSet();
        }
        selections.push({ kind: 'field', field: { alias, name, args, selections: sub } });
        continue;
      }
      throw new Error(`GraphQL: unexpected token in selection set ${JSON.stringify(t)}`);
    }
    this.expectPunct('}');
    return selections;
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') {
      return { kind: 'variable', value: this.expectName() };
    }
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: t.value };
    if (t.kind === 'float') return { kind: 'float', value: t.value };
    if (t.kind === 'punct' && t.value === '[') {
      const items: ValueNode[] = [];
      while (!this.isPunct(']')) {
        items.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.isPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`GraphQL: unexpected value token ${JSON.stringify(t)}`);
  }
}

// ---- values -----------------------------------------------------------------

type GqlValue =
  | { __typename: string; __data: unknown }
  | string
  | number
  | boolean
  | null
  | GqlValue[]
  | { [key: string]: GqlValue };

function isGqlObject(v: GqlValue): v is { __typename: string; __data: unknown } {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && '__typename' in v;
}

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.value as string];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return (node.items ?? []).map((item) => valueOf(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields ?? []) out[f.name] = valueOf(f.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = valueOf(a.value, variables);
  return out;
}

// ---- schema -----------------------------------------------------------------

// The fields each type answers. Unknown fields are reported, never invented.
const SCHEMA: Record<string, Set<string>> = {
  Query: new Set(['viewer', 'repository', 'node', '__type', '__schema']),
  User: new Set(['login']),
  Repository: new Set([
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
    'description', 'createdAt', 'updatedAt',
  ]),
  Ref: new Set(['name']),
  Issue: new Set(['id', 'number', 'title', 'state', 'body']),
  IssueConnection: new Set(['nodes', 'pageInfo', 'totalCount']),
  PageInfo: new Set(['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor']),
  PullRequest: new Set([
    'id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName',
    'mergeable', 'files',
  ]),
  PullRequestConnection: new Set(['nodes', 'totalCount']),
  PullRequestChangedFileConnection: new Set(['nodes']),
  PullRequestChangedFile: new Set(['path']),
  IssueComment: new Set(['id', 'body']),
  CommentEdge: new Set(['node']),
  CreateIssuePayload: new Set(['issue']),
  CloseIssuePayload: new Set(['issue']),
  CreatePullRequestPayload: new Set(['pullRequest']),
  MergePullRequestPayload: new Set(['pullRequest']),
  AddCommentPayload: new Set(['commentEdge']),
  __Type: new Set(['name', 'kind', 'fields', 'enumValues', 'description']),
  __Field: new Set(['name', 'description']),
  __EnumValue: new Set(['name', 'description']),
  __Schema: new Set(['types', 'queryType', 'mutationType']),
};

const INTROSPECTION_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
    'description',
  ],
  User: ['login', 'id'],
  Ref: ['name'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  PullRequestConnection: ['nodes', 'totalCount'],
  PullRequestChangedFile: ['path'],
  IssueComment: ['id', 'body'],
};

const INTROSPECTION_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---- executor ---------------------------------------------------------------

interface ExecCtx {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, { typeCondition: string; selections: SelectionNode[] }>;
  errors: Array<{ message: string }>;
}

function gqlIssue(repo: Repo, issue: Issue): GqlValue {
  return { __typename: 'Issue', __data: { repo, issue } };
}

function gqlPull(repo: Repo, pull: Pull): GqlValue {
  return { __typename: 'PullRequest', __data: { repo, pull } };
}

function gqlRepo(repo: Repo): GqlValue {
  return { __typename: 'Repository', __data: { repo } };
}

function findRepoByDatabaseId(store: Store, dbid: number): Repo | null {
  for (const repo of store.repos.values()) if (repo.id === dbid) return repo;
  return null;
}

function issueStateUpper(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullStateUpper(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function resolveField(ctx: ExecCtx, parentType: string, parent: GqlValue, field: FieldNode): GqlValue {
  const store = ctx.store;
  const args = argsOf(field, ctx.variables);

  // Query root.
  if (parentType === 'Query') {
    if (field.name === 'viewer') {
      return { __typename: 'User', __data: { login: store.viewer } };
    }
    if (field.name === 'repository') {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      if (!store.isOwner(owner)) return null;
      const repo = store.getRepo(name);
      return repo ? gqlRepo(repo) : null;
    }
    if (field.name === 'node') {
      const parsed = parseGlobalId(String(args.id ?? ''));
      if (!parsed) return null;
      if (parsed.kind === 'Repository') {
        const repo = findRepoByDatabaseId(store, parseInt(parsed.key, 10));
        return repo ? gqlRepo(repo) : null;
      }
      if (parsed.kind === 'Issue') {
        const [repoId, num] = parsed.key.split(':');
        const repo = findRepoByDatabaseId(store, parseInt(repoId ?? '', 10));
        const issue = repo?.issues.find((i) => i.number === parseInt(num ?? '', 10));
        return repo && issue ? gqlIssue(repo, issue) : null;
      }
      if (parsed.kind === 'PullRequest') {
        const [repoId, num] = parsed.key.split(':');
        const repo = findRepoByDatabaseId(store, parseInt(repoId ?? '', 10));
        const pull = repo?.pulls.find((p) => p.number === parseInt(num ?? '', 10));
        return repo && pull ? gqlPull(repo, pull) : null;
      }
      return null;
    }
    if (field.name === '__type') {
      const name = String(args.name ?? '');
      return { __typename: '__Type', __data: { name } };
    }
    if (field.name === '__schema') {
      return { __typename: '__Schema', __data: {} };
    }
  }

  if (!isGqlObject(parent)) return null;
  const data = parent.__data as Record<string, unknown>;

  switch (parentType) {
    case 'User':
      if (field.name === 'login') return String(data.login ?? '');
      break;
    case 'Repository': {
      const repo = data.repo as Repo;
      switch (field.name) {
        case 'id': return globalId('Repository', String(repo.id));
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${store.viewer}/${repo.name}`;
        case 'owner': return { __typename: 'User', __data: { login: store.viewer } };
        case 'defaultBranchRef': {
          const tip = store.repoRefs(repo.name).get(`refs/heads/${repo.defaultBranch}`);
          if (!tip) return null;
          return { __typename: 'Ref', __data: { name: repo.defaultBranch } };
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'description': return repo.description;
        case 'createdAt': return FIXED_TIME;
        case 'updatedAt': return FIXED_TIME;
        case 'issue': {
          const issue = repo.issues.find((i) => i.number === Number(args.number));
          return issue ? gqlIssue(repo, issue) : null;
        }
        case 'issues': {
          let list = [...repo.issues];
          const states = args.states as string[] | undefined;
          if (Array.isArray(states) && states.length > 0) {
            const wanted = new Set(states.map((s) => String(s).toUpperCase()));
            list = list.filter((i) => wanted.has(issueStateUpper(i)));
          }
          const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
          const direction = String(orderBy?.direction ?? 'DESC').toUpperCase();
          list.sort((a, b) => (direction === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
          const first = typeof args.first === 'number' ? args.first : list.length;
          const after = args.after == null ? null : String(args.after);
          let startIdx = 0;
          if (after) {
            try {
              const cursorNum = parseInt(Buffer.from(after, 'base64').toString('utf8').replace('cursor:', ''), 10);
              const idx = list.findIndex((i) => i.number === cursorNum);
              if (idx >= 0) startIdx = idx + 1;
            } catch {
              startIdx = 0;
            }
          }
          const page = list.slice(startIdx, startIdx + first);
          const hasNext = startIdx + page.length < list.length;
          const endCursor = page.length > 0 ? Buffer.from(`cursor:${page[page.length - 1].number}`).toString('base64') : null;
          return {
            __typename: 'IssueConnection',
            __data: { nodes: page.map((i) => gqlIssue(repo, i)), pageInfo: { hasNextPage: hasNext, endCursor } },
          };
        }
        case 'pullRequests': {
          const first = typeof args.first === 'number' ? args.first : repo.pulls.length;
          const nodes = [...repo.pulls].sort((a, b) => b.createdSeq - a.createdSeq).slice(0, first).map((p) => gqlPull(repo, p));
          return { __typename: 'PullRequestConnection', __data: { nodes } };
        }
        case 'pullRequest': {
          const pull = repo.pulls.find((p) => p.number === Number(args.number));
          return pull ? gqlPull(repo, pull) : null;
        }
      }
      break;
    }
    case 'Ref':
      if (field.name === 'name') return String(data.name ?? '');
      break;
    case 'Issue': {
      const issue = (data as { issue: Issue }).issue;
      const repo = (data as { repo: Repo }).repo;
      switch (field.name) {
        case 'id': return globalId('Issue', `${repo.id}:${issue.number}`);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'state': return issueStateUpper(issue);
        case 'body': return issue.body;
      }
      break;
    }
    case 'IssueConnection': {
      const conn = data as { nodes: GqlValue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
      if (field.name === 'nodes') return conn.nodes;
      if (field.name === 'pageInfo') return { __typename: 'PageInfo', __data: conn.pageInfo };
      if (field.name === 'totalCount') return conn.nodes.length;
      break;
    }
    case 'PageInfo': {
      const info = data as { hasNextPage: boolean; endCursor: string | null };
      if (field.name === 'hasNextPage') return info.hasNextPage;
      if (field.name === 'endCursor') return info.endCursor;
      if (field.name === 'hasPreviousPage') return false;
      if (field.name === 'startCursor') return null;
      break;
    }
    case 'PullRequest': {
      const pull = (data as { pull: Pull }).pull;
      const repo = (data as { repo: Repo }).repo;
      switch (field.name) {
        case 'id': return globalId('PullRequest', `${repo.id}:${pull.number}`);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pullStateUpper(pull);
        case 'merged': return pull.merged;
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'mergeable': return mergeConflict(store, repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
        case 'files': {
          const first = typeof args.first === 'number' ? args.first : 100;
          const nodes = pullChangedPaths(store, repo, pull).slice(0, first).map((path) => ({ __typename: 'PullRequestChangedFile', __data: { path } }) as GqlValue);
          return { __typename: 'PullRequestChangedFileConnection', __data: { nodes } };
        }
      }
      break;
    }
    case 'PullRequestConnection': {
      const conn = data as { nodes: GqlValue[] };
      if (field.name === 'nodes') return conn.nodes;
      if (field.name === 'totalCount') return conn.nodes.length;
      break;
    }
    case 'PullRequestChangedFileConnection': {
      const conn = data as { nodes: GqlValue[] };
      if (field.name === 'nodes') return conn.nodes;
      break;
    }
    case 'PullRequestChangedFile':
      if (field.name === 'path') return String((data as { path: string }).path ?? '');
      break;
    case 'IssueComment':
      if (field.name === 'id') return String(data.id ?? '');
      if (field.name === 'body') return String(data.body ?? '');
      break;
    case 'CommentEdge':
      if (field.name === 'node') return (data as { node: GqlValue }).node;
      break;
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
      if (field.name === 'issue') return (data as { issue: GqlValue }).issue;
      break;
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
      if (field.name === 'pullRequest') return (data as { pullRequest: GqlValue }).pullRequest;
      break;
    case 'AddCommentPayload':
      if (field.name === 'commentEdge') return (data as { commentEdge: GqlValue }).commentEdge;
      break;
    case '__Type': {
      const typeName = String((data as { name: string }).name ?? '');
      if (field.name === 'name') return typeName;
      if (field.name === 'kind') {
        if (INTROSPECTION_ENUMS[typeName]) return 'ENUM';
        return 'OBJECT';
      }
      if (field.name === 'fields') {
        const names = INTROSPECTION_FIELDS[typeName] ?? [...(SCHEMA[typeName] ?? [])];
        return names.map((n) => ({ __typename: '__Field', __data: { name: n } }) as GqlValue);
      }
      if (field.name === 'enumValues') {
        const names = INTROSPECTION_ENUMS[typeName] ?? [];
        return names.map((n) => ({ __typename: '__EnumValue', __data: { name: n } }) as GqlValue);
      }
      if (field.name === 'description') return null;
      break;
    }
    case '__Field':
      if (field.name === 'name') return String(data.name ?? '');
      if (field.name === 'description') return null;
      break;
    case '__EnumValue':
      if (field.name === 'name') return String(data.name ?? '');
      if (field.name === 'description') return null;
      break;
    case '__Schema':
      if (field.name === 'types') return [];
      if (field.name === 'queryType') return { __typename: '__Type', __data: { name: 'Query' } };
      if (field.name === 'mutationType') return { __typename: '__Type', __data: { name: 'Mutation' } };
      break;
    case 'Mutation': {
      // Mutations are resolved in executeOperation (they need creation side effects).
      break;
    }
  }
  return null;
}

/** Execute one operation document against the store. */
function executeOperation(store: Store, doc: DocumentNode, op: OperationNode, variables: Record<string, unknown>): Record<string, unknown> {
  const ctx: ExecCtx = { store, variables, fragments: doc.fragments, errors: [] };

  // Mutations: resolve the single top-level field with creation side effects.
  if (op.operation === 'mutation') {
    const data: Record<string, unknown> = {};
    for (const sel of op.selections) {
      if (sel.kind !== 'field') continue;
      const field = sel.field;
      const args = argsOf(field, variables);
      const input = (args.input ?? {}) as Record<string, unknown>;
      if (field.name === 'createIssue') {
        const parsed = parseGlobalId(String(input.repositoryId ?? ''));
        const repo = parsed?.kind === 'Repository' ? findRepoByDatabaseId(store, parseInt(parsed.key, 10)) : null;
        if (!repo) {
          ctx.errors.push({ message: 'repository not found' });
          return { data: null, errors: ctx.errors };
        }
        const issue: Issue = {
          number: repo.nextIssue++,
          title: String(input.title ?? ''),
          body: String(input.body ?? ''),
          state: 'open',
          labels: [],
          createdSeq: store.seq++,
          comments: [],
          jsonText: null,
        };
        repo.issues.push(issue);
        const payload: GqlValue = { __typename: 'CreateIssuePayload', __data: { issue: gqlIssue(repo, issue) } };
        data[field.alias ?? field.name] = resolveSelections(ctx, 'CreateIssuePayload', payload, field.selections);
        continue;
      }
      if (field.name === 'closeIssue') {
        const parsed = parseGlobalId(String(input.issueId ?? ''));
        let found: { repo: Repo; issue: Issue } | null = null;
        if (parsed?.kind === 'Issue') {
          const [repoId, num] = parsed.key.split(':');
          const repo = findRepoByDatabaseId(store, parseInt(repoId ?? '', 10));
          const issue = repo?.issues.find((i) => i.number === parseInt(num ?? '', 10));
          if (repo && issue) found = { repo, issue };
        }
        if (!found) {
          ctx.errors.push({ message: 'issue not found' });
          return { data: null, errors: ctx.errors };
        }
        found.issue.state = 'closed';
        found.issue.jsonText = null;
        const payload: GqlValue = { __typename: 'CloseIssuePayload', __data: { issue: gqlIssue(found.repo, found.issue) } };
        data[field.alias ?? field.name] = resolveSelections(ctx, 'CloseIssuePayload', payload, field.selections);
        continue;
      }
      if (field.name === 'createPullRequest') {
        const parsed = parseGlobalId(String(input.repositoryId ?? ''));
        const repo = parsed?.kind === 'Repository' ? findRepoByDatabaseId(store, parseInt(parsed.key, 10)) : null;
        if (!repo) {
          ctx.errors.push({ message: 'repository not found' });
          return { data: null, errors: ctx.errors };
        }
        const head = String(input.headRefName ?? '');
        const base = String(input.baseRefName ?? '');
        const headSha = store.repoRefs(repo.name).get(`refs/heads/${head}`);
        const baseSha = store.repoRefs(repo.name).get(`refs/heads/${base}`);
        if (!headSha || !baseSha) {
          ctx.errors.push({ message: 'head or base branch does not exist' });
          return { data: null, errors: ctx.errors };
        }
        const dup = repo.pulls.find((p) => p.headRef === head && p.state === 'open');
        if (dup) {
          ctx.errors.push({ message: 'a pull request already exists for this head branch' });
          return { data: null, errors: ctx.errors };
        }
        const pull: Pull = {
          number: repo.nextPull++,
          title: String(input.title ?? ''),
          body: String((input as Record<string, unknown>).body ?? ''),
          state: 'open',
          merged: false,
          mergedAt: null,
          mergeCommitSha: null,
          headRef: head,
          baseRef: base,
          headSha,
          baseSha,
          createdSeq: store.seq++,
        };
        repo.pulls.push(pull);
        const payload: GqlValue = { __typename: 'CreatePullRequestPayload', __data: { pullRequest: gqlPull(repo, pull) } };
        data[field.alias ?? field.name] = resolveSelections(ctx, 'CreatePullRequestPayload', payload, field.selections);
        continue;
      }
      if (field.name === 'mergePullRequest') {
        const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
        let found: { repo: Repo; pull: Pull } | null = null;
        if (parsed?.kind === 'PullRequest') {
          const [repoId, num] = parsed.key.split(':');
          const repo = findRepoByDatabaseId(store, parseInt(repoId ?? '', 10));
          const pull = repo?.pulls.find((p) => p.number === parseInt(num ?? '', 10));
          if (repo && pull) found = { repo, pull };
        }
        if (!found) {
          ctx.errors.push({ message: 'pull request not found' });
          return { data: null, errors: ctx.errors };
        }
        const { repo, pull } = found;
        if (pull.state !== 'open') {
          ctx.errors.push({ message: 'pull request is already closed' });
          return { data: null, errors: ctx.errors };
        }
        if (mergeConflict(store, repo, pull)) {
          ctx.errors.push({ message: 'merge conflict' });
          return { data: null, errors: ctx.errors };
        }
        const headCommit = store.getObject(pull.headSha);
        if (!headCommit) {
          ctx.errors.push({ message: 'head commit not found' });
          return { data: null, errors: ctx.errors };
        }
        const headTree = store.parseCommit(headCommit.data).tree;
        const currentTip = store.repoRefs(repo.name).get(`refs/heads/${pull.baseRef}`);
        if (!currentTip) {
          ctx.errors.push({ message: 'base branch not found' });
          return { data: null, errors: ctx.errors };
        }
        const mergeSha = store.makeCommit(headTree, [currentTip], `Merge pull request #${pull.number} from ${pull.headRef}`);
        store.repoRefs(repo.name).set(`refs/heads/${pull.baseRef}`, mergeSha);
        store.touchRepo(repo.name);
        pull.state = 'closed';
        pull.merged = true;
        pull.mergedAt = FIXED_TIME;
        pull.mergeCommitSha = mergeSha;
        const payload: GqlValue = { __typename: 'MergePullRequestPayload', __data: { pullRequest: gqlPull(repo, pull) } };
        data[field.alias ?? field.name] = resolveSelections(ctx, 'MergePullRequestPayload', payload, field.selections);
        continue;
      }
      if (field.name === 'addComment') {
        const parsed = parseGlobalId(String(input.subjectId ?? ''));
        let found: { repo: Repo; issue: Issue } | null = null;
        if (parsed?.kind === 'Issue') {
          const [repoId, num] = parsed.key.split(':');
          const repo = findRepoByDatabaseId(store, parseInt(repoId ?? '', 10));
          const issue = repo?.issues.find((i) => i.number === parseInt(num ?? '', 10));
          if (repo && issue) found = { repo, issue };
        }
        if (!found) {
          ctx.errors.push({ message: 'issue not found' });
          return { data: null, errors: ctx.errors };
        }
        const comment = { id: found.repo.nextComment++, body: String(input.body ?? '') };
        found.issue.comments.push(comment);
        found.issue.jsonText = null;
        const node: GqlValue = {
          __typename: 'IssueComment',
          __data: { id: globalId('IssueComment', `${found.repo.id}:${found.issue.number}:${comment.id}`), body: comment.body },
        };
        const payload: GqlValue = { __typename: 'AddCommentPayload', __data: { commentEdge: { __typename: 'CommentEdge', __data: { node } } } };
        data[field.alias ?? field.name] = resolveSelections(ctx, 'AddCommentPayload', payload, field.selections);
        continue;
      }
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
      return { data: null, errors: ctx.errors };
    }
    if (ctx.errors.length > 0) return { data: null, errors: ctx.errors };
    return { data };
  }

  // Queries.
  const root: GqlValue = { __typename: 'Query', __data: {} };
  const data = resolveSelections(ctx, 'Query', root, op.selections);
  if (ctx.errors.length > 0) return { data: null, errors: ctx.errors };
  return { data };
}

/** Resolve a selection set against a parent value. Returns a plain JSON object. */
function resolveSelections(ctx: ExecCtx, parentType: string, parent: GqlValue, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'inlineFragment') {
      if (sel.typeCondition === null || (isGqlObject(parent) && parent.__typename === sel.typeCondition)) {
        Object.assign(out, resolveSelections(ctx, parentType, parent, sel.selections));
      }
      continue;
    }
    if (sel.kind === 'fragmentSpread') {
      const frag = ctx.fragments.get(sel.name);
      if (!frag) continue;
      if (isGqlObject(parent) && parent.__typename === frag.typeCondition) {
        Object.assign(out, resolveSelections(ctx, parentType, parent, frag.selections));
      }
      continue;
    }
    const field = sel.field;
    const allowed = SCHEMA[parentType];
    if (!allowed || !allowed.has(field.name)) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${parentType}".` });
      continue;
    }
    const value = resolveField(ctx, parentType, parent, field);
    const key = field.alias ?? field.name;
    if (field.selections.length === 0) {
      out[key] = value;
    } else if (value === null) {
      out[key] = null;
    } else if (Array.isArray(value)) {
      out[key] = value.map((item) => {
        if (isGqlObject(item)) return resolveSelections(ctx, item.__typename, item, field.selections);
        return item;
      });
    } else if (isGqlObject(value)) {
      out[key] = resolveSelections(ctx, value.__typename, value, field.selections);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Handle one GraphQL operation body (object or batch array). */
export function routeGraphQL(store: Store, ctx: Ctx): HandlerResult {
  let body: unknown;
  try {
    body = ctx.body && ctx.body.length > 0 ? JSON.parse(ctx.body.toString('utf8')) : null;
  } catch {
    return { status: 400, json: { errors: [{ message: 'Problems parsing JSON' }] } };
  }
  const runOne = (opBody: unknown): Record<string, unknown> => {
    if (typeof opBody !== 'object' || opBody === null) {
      return { errors: [{ message: 'Request body must be a GraphQL operation object' }] };
    }
    const { query, variables, operationName } = opBody as { query?: unknown; variables?: unknown; operationName?: unknown };
    if (typeof query !== 'string') {
      return { errors: [{ message: 'Request body must carry a query string' }] };
    }
    let doc: DocumentNode;
    try {
      doc = new Parser(tokenize(query)).parseDocument();
    } catch (e) {
      return { errors: [{ message: `GraphQL parse error: ${e instanceof Error ? e.message : String(e)}` }] };
    }
    const vars = (variables ?? {}) as Record<string, unknown>;
    let op = doc.operations[0];
    if (typeof operationName === 'string') {
      op = doc.operations.find((o) => o.name === operationName) ?? op;
    }
    if (!op) return { errors: [{ message: 'No operation in document' }] };
    try {
      return executeOperation(store, doc, op, vars);
    } catch (e) {
      return { errors: [{ message: e instanceof Error ? e.message : String(e) }] };
    }
  };
  if (Array.isArray(body)) {
    return { status: 200, json: body.map(runOne) };
  }
  return { status: 200, json: runOne(body) };
}
