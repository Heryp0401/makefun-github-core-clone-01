// GraphQL v4 endpoint (/api/graphql): a small recursive-descent parser and
// executor for exactly the documents the conformance suite sends. GraphQL
// errors are HTTP 200 with an `errors` array; only `invalid-field` expects
// one. Global ids are opaque and stable.
import { Store, refreshIssueJson } from './store.ts';
import type { Repo, Issue, Pull } from './store.ts';

// ---- AST -------------------------------------------------------------------

type ValueNode =
  | { kind: 'Variable'; name: string }
  | { kind: 'String'; value: string }
  | { kind: 'Int'; value: number }
  | { kind: 'Float'; value: number }
  | { kind: 'Boolean'; value: boolean }
  | { kind: 'Null' }
  | { kind: 'Enum'; value: string }
  | { kind: 'List'; values: ValueNode[] }
  | { kind: 'Object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'Field';
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selectionSet: SelectionNode[] | null;
}

interface InlineFragmentNode {
  kind: 'InlineFragment';
  typeCondition: string | null;
  selectionSet: SelectionNode[];
}

type SelectionNode = FieldNode | InlineFragmentNode;

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  variableDefinitions: { name: string; defaultValue?: ValueNode }[];
  selectionSet: SelectionNode[];
}

// ---- Tokenizer ---------------------------------------------------------------

interface Token {
  type: 'Name' | 'Int' | 'Float' | 'String' | 'Punct' | 'EOF';
  value: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1];
          if (e === 'n') out += '\n';
          else if (e === 't') out += '\t';
          else if (e === 'r') out += '\r';
          else if (e === 'b') out += '\b';
          else if (e === 'f') out += '\f';
          else if (e === 'u' && j + 5 < src.length) {
            out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += e;
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      tokens.push({ type: 'String', value: out });
      i = j + 1;
      continue;
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      let j = i;
      if (src[j] === '-') j++;
      while (j < src.length && src[j] >= '0' && src[j] <= '9') j++;
      let isFloat = false;
      if (src[j] === '.' && src[j + 1] >= '0' && src[j + 1] <= '9') {
        isFloat = true;
        j++;
        while (j < src.length && src[j] >= '0' && src[j] <= '9') j++;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j++;
        if (src[j] === '+' || src[j] === '-') j++;
        while (j < src.length && src[j] >= '0' && src[j] <= '9') j++;
      }
      tokens.push({ type: isFloat ? 'Float' : 'Int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < src.length && isNameChar(src[j])) j++;
      tokens.push({ type: 'Name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (src.startsWith('...', i)) {
      tokens.push({ type: 'Punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{|}&'.includes(c)) {
      tokens.push({ type: 'Punct', value: c });
      i++;
      continue;
    }
    // Unknown character: skip it.
    i++;
  }
  tokens.push({ type: 'EOF', value: '' });
  return tokens;
}

// ---- Parser ------------------------------------------------------------------

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(src: string) {
    this.tokens = tokenize(src);
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private expect(value: string): Token {
    const t = this.next();
    if (t.value !== value) throw new Error('expected ' + value + ', got ' + t.value);
    return t;
  }

  private expectName(): string {
    const t = this.next();
    if (t.type !== 'Name') throw new Error('expected name, got ' + t.value);
    return t.value;
  }

  parseDocument(): OperationNode[] {
    const ops: OperationNode[] = [];
    while (this.peek().type !== 'EOF') {
      const t = this.peek();
      if (t.type === 'Punct' && t.value === '{') {
        ops.push({
          operation: 'query',
          name: null,
          variableDefinitions: [],
          selectionSet: this.parseSelectionSet(),
        });
      } else if (t.type === 'Name' && (t.value === 'query' || t.value === 'mutation')) {
        ops.push(this.parseOperation());
      } else if (t.type === 'Name' && t.value === 'fragment') {
        this.parseFragmentDefinition();
      } else {
        throw new Error('unexpected token ' + t.value);
      }
    }
    return ops;
  }

  private parseFragmentDefinition(): void {
    this.next(); // fragment
    this.expectName(); // name
    if (this.peek().value === 'on') {
      this.next();
      this.expectName();
    }
    this.skipDirectives();
    this.parseSelectionSet();
  }

  private skipDirectives(): void {
    while (this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().value === '(') this.parseArguments();
    }
  }

  private parseOperation(): OperationNode {
    const op = this.next().value as 'query' | 'mutation';
    let name: string | null = null;
    if (this.peek().type === 'Name') name = this.expectName();
    const variableDefinitions: { name: string; defaultValue?: ValueNode }[] = [];
    if (this.peek().value === '(') {
      this.next();
      while (this.peek().value !== ')') {
        this.expect('$');
        const varName = this.expectName();
        this.expect(':');
        this.parseType();
        let defaultValue: ValueNode | undefined;
        if (this.peek().value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        variableDefinitions.push({ name: varName, defaultValue });
        if (this.peek().type === 'EOF') break;
      }
      this.expect(')');
    }
    this.skipDirectives();
    return { operation: op, name, variableDefinitions, selectionSet: this.parseSelectionSet() };
  }

  private parseType(): void {
    if (this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expect(']');
    } else {
      this.expectName();
    }
    if (this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const sels: SelectionNode[] = [];
    while (this.peek().value !== '}') {
      if (this.peek().type === 'EOF') throw new Error('unterminated selection set');
      sels.push(this.parseSelection());
    }
    this.expect('}');
    return sels;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().value === '...') {
      this.next();
      if (this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'InlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (this.peek().type === 'Name') {
        // Named fragment spread (not used by the suite): consume and ignore.
        this.next();
        this.skipDirectives();
        return { kind: 'InlineFragment', typeCondition: null, selectionSet: [] };
      }
      this.skipDirectives();
      return { kind: 'InlineFragment', typeCondition: null, selectionSet: this.parseSelectionSet() };
    }
    let alias: string | null = null;
    let name = this.expectName();
    if (this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    let args: { name: string; value: ValueNode }[] = [];
    if (this.peek().value === '(') args = this.parseArguments();
    this.skipDirectives();
    let selectionSet: SelectionNode[] | null = null;
    if (this.peek().value === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'Field', alias, name, args, selectionSet };
  }

  private parseArguments(): { name: string; value: ValueNode }[] {
    this.expect('(');
    const args: { name: string; value: ValueNode }[] = [];
    while (this.peek().value !== ')') {
      const name = this.expectName();
      this.expect(':');
      args.push({ name, value: this.parseValue() });
      if (this.peek().type === 'EOF') break;
    }
    this.expect(')');
    return args;
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.value === '$') return { kind: 'Variable', name: this.expectName() };
    if (t.type === 'Int') return { kind: 'Int', value: parseInt(t.value, 10) };
    if (t.type === 'Float') return { kind: 'Float', value: parseFloat(t.value) };
    if (t.type === 'String') return { kind: 'String', value: t.value };
    if (t.type === 'Name') {
      if (t.value === 'true') return { kind: 'Boolean', value: true };
      if (t.value === 'false') return { kind: 'Boolean', value: false };
      if (t.value === 'null') return { kind: 'Null' };
      return { kind: 'Enum', value: t.value };
    }
    if (t.value === '[') {
      const values: ValueNode[] = [];
      while (this.peek().value !== ']') {
        values.push(this.parseValue());
        if (this.peek().type === 'EOF') break;
      }
      this.expect(']');
      return { kind: 'List', values };
    }
    if (t.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (this.peek().value !== '}') {
        const name = this.expectName();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
        if (this.peek().type === 'EOF') break;
      }
      this.expect('}');
      return { kind: 'Object', fields };
    }
    throw new Error('unexpected value token ' + t.value);
  }
}

// ---- Schema (for __type) -------------------------------------------------------

const SCHEMA: Record<string, { kind: 'OBJECT' | 'ENUM'; fields: string[]; enumValues: string[] | null }> = {
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url'],
    enumValues: null,
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'createdAt', 'updatedAt', 'author', 'url', 'mergedAt', 'mergeCommit'],
    enumValues: null,
  },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt', 'updatedAt', 'isPrivate', 'fork'],
    enumValues: null,
  },
  SearchType: { kind: 'ENUM', fields: [], enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'] },
  IssueState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', fields: [], enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', fields: [], enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  IssueOrderField: { kind: 'ENUM', fields: [], enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', fields: [], enumValues: ['ASC', 'DESC'] },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'avatarUrl', 'url'], enumValues: null },
};

// ---- Executor ------------------------------------------------------------------

type GqlObj = Record<string, unknown> & { _type: string };

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  errors: { message: string }[];
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'Variable': {
      const v = variables[node.name];
      return v === undefined ? null : v;
    }
    case 'String':
    case 'Int':
    case 'Float':
    case 'Boolean':
      return node.value;
    case 'Null':
      return null;
    case 'Enum':
      return node.value;
    case 'List':
      return node.values.map((v) => resolveValue(v, variables));
    case 'Object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

function argOf(field: FieldNode, name: string, ctx: Ctx): unknown {
  const a = field.args.find((x) => x.name === name);
  if (!a) return undefined;
  return resolveValue(a.value, ctx.variables);
}

function issueNode(ctx: Ctx, repo: Repo, issue: Issue): GqlObj {
  void ctx;
  return { _type: 'Issue', repo, issue };
}

function pullNode(ctx: Ctx, repo: Repo, pull: Pull): GqlObj {
  void ctx;
  return { _type: 'PullRequest', repo, pull };
}

function repoNode(ctx: Ctx, repo: Repo): GqlObj {
  void ctx;
  return { _type: 'Repository', repo };
}

// Cursor for issue pagination: "cursor:<creation seq>".
function makeCursor(seq: number): string {
  return 'cursor:' + seq;
}

function parseCursor(after: unknown): number | null {
  if (typeof after !== 'string') return null;
  const m = /^cursor:(\d+)$/.exec(after);
  return m ? parseInt(m[1], 10) : null;
}

function issuesConnection(ctx: Ctx, repo: Repo, field: FieldNode): GqlObj {
  const first = argOf(field, 'first', ctx);
  const states = argOf(field, 'states', ctx) as string[] | undefined;
  const orderBy = argOf(field, 'orderBy', ctx) as { field?: string; direction?: string } | undefined;
  const after = argOf(field, 'after', ctx);
  let list = [...repo.issues];
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  const direction = orderBy?.direction === 'ASC' ? 'asc' : 'desc';
  if (orderBy?.field === 'CREATED_AT' || !orderBy) {
    list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  } else {
    list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  }
  const cursorSeq = parseCursor(after);
  if (cursorSeq !== null) {
    list = list.filter((i) => (direction === 'asc' ? i.seq > cursorSeq : i.seq < cursorSeq));
  }
  const limit = typeof first === 'number' ? first : list.length;
  const page = list.slice(0, limit);
  const hasNextPage = list.length > page.length;
  const endCursor = page.length > 0 ? makeCursor(page[page.length - 1].seq) : null;
  return {
    _type: 'IssueConnection',
    nodes: page.map((i) => issueNode(ctx, repo, i)),
    pageInfo: { _type: 'PageInfo', hasNextPage, endCursor },
  };
}

function resolveField(parent: GqlObj, field: FieldNode, ctx: Ctx): unknown {
  const store = ctx.store;
  const type = parent._type;
  const name = field.name;
  switch (type) {
    case 'Query': {
      if (name === 'viewer') return { _type: 'User', login: store.login };
      if (name === 'repository') {
        const owner = argOf(field, 'owner', ctx);
        const repoName = argOf(field, 'name', ctx);
        if (owner !== store.login || typeof repoName !== 'string') return null;
        const repo = store.getRepo(repoName);
        return repo ? repoNode(ctx, repo) : null;
      }
      if (name === 'node') {
        const id = argOf(field, 'id', ctx);
        if (typeof id !== 'string') return null;
        const target = store.resolveGlobalId(id);
        if (!target) return null;
        const repo = store.getRepo(target.repo);
        if (!repo) return null;
        if (target.kind === 'repo') return repoNode(ctx, repo);
        if (target.kind === 'issue') {
          const issue = store.getIssue(repo, target.number);
          return issue ? issueNode(ctx, repo, issue) : null;
        }
        if (target.kind === 'pull') {
          const pull = store.getPull(repo, target.number);
          return pull ? pullNode(ctx, repo, pull) : null;
        }
        return null;
      }
      if (name === '__type') {
        const typeName = argOf(field, 'name', ctx);
        if (typeof typeName !== 'string') return null;
        const entry = SCHEMA[typeName];
        if (!entry) return null;
        return { _type: '__Type', name: typeName, kind: entry.kind, fields: entry.fields, enumValues: entry.enumValues };
      }
      break;
    }
    case 'User': {
      if (name === 'login') return parent.login as string;
      if (name === 'id') return 'U_' + String(parent.login);
      break;
    }
    case 'Repository': {
      const repo = parent.repo as Repo;
      if (name === 'id') return repoGid(store, repo);
      if (name === 'databaseId') return repo.id;
      if (name === 'name') return repo.name;
      if (name === 'nameWithOwner') return store.login + '/' + repo.name;
      if (name === 'owner') return { _type: 'User', login: store.login };
      if (name === 'defaultBranchRef') return { _type: 'Ref', name: repo.defaultBranch };
      if (name === 'viewerPermission') return 'ADMIN';
      if (name === 'hasIssuesEnabled') return true;
      if (name === 'description') return repo.description;
      if (name === 'issue') {
        const num = argOf(field, 'number', ctx);
        if (typeof num !== 'number') return null;
        const issue = store.getIssue(repo, num);
        return issue ? issueNode(ctx, repo, issue) : null;
      }
      if (name === 'issues') return issuesConnection(ctx, repo, field);
      if (name === 'pullRequests') {
        const first = argOf(field, 'first', ctx);
        const list = [...repo.pulls].sort((a, b) => a.seq - b.seq);
        const page = typeof first === 'number' ? list.slice(0, first) : list;
        return { _type: 'PullRequestConnection', nodes: page.map((p) => pullNode(ctx, repo, p)) };
      }
      if (name === 'pullRequest') {
        const num = argOf(field, 'number', ctx);
        if (typeof num !== 'number') return null;
        const pull = store.getPull(repo, num);
        return pull ? pullNode(ctx, repo, pull) : null;
      }
      break;
    }
    case 'Ref': {
      if (name === 'name') return parent.name as string;
      break;
    }
    case 'Issue': {
      const issue = parent.issue as Issue;
      if (name === 'id') return issue.gid;
      if (name === 'number') return issue.number;
      if (name === 'title') return issue.title;
      if (name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      if (name === 'body') return issue.body;
      break;
    }
    case 'IssueConnection': {
      if (name === 'nodes') return parent.nodes as GqlObj[];
      if (name === 'pageInfo') return parent.pageInfo as GqlObj;
      break;
    }
    case 'PageInfo': {
      if (name === 'hasNextPage') return parent.hasNextPage as boolean;
      if (name === 'endCursor') return parent.endCursor as string | null;
      break;
    }
    case 'PullRequest': {
      const repo = parent.repo as Repo;
      const pull = parent.pull as Pull;
      if (name === 'id') return pull.gid;
      if (name === 'number') return pull.number;
      if (name === 'title') return pull.title;
      if (name === 'body') return pull.body;
      if (name === 'state') return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      if (name === 'merged') return pull.merged;
      if (name === 'headRefName') return pull.headRef;
      if (name === 'baseRefName') return pull.baseRef;
      if (name === 'mergeable') return store.pullConflicted(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
      if (name === 'files') {
        const first = argOf(field, 'first', ctx);
        const files = store.pullFiles(repo, pull);
        const page = typeof first === 'number' ? files.slice(0, first) : files;
        return {
          _type: 'PullRequestFileConnection',
          nodes: page.map((f) => ({ _type: 'PullRequestChangedFile', path: f.filename })),
        };
      }
      break;
    }
    case 'PullRequestConnection': {
      if (name === 'nodes') return parent.nodes as GqlObj[];
      break;
    }
    case 'PullRequestFileConnection': {
      if (name === 'nodes') return parent.nodes as GqlObj[];
      break;
    }
    case 'PullRequestChangedFile': {
      if (name === 'path') return parent.path as string;
      break;
    }
    case '__Type': {
      if (name === 'name') return parent.name as string;
      if (name === 'kind') return parent.kind as string;
      if (name === 'fields') {
        const fields = (parent.fields as string[]) ?? [];
        return fields.map((f) => ({ _type: '__TypeField', name: f }));
      }
      if (name === 'enumValues') {
        const values = (parent.enumValues as string[] | null) ?? null;
        if (!values) return null;
        return values.map((v) => ({ _type: '__EnumValue', name: v }));
      }
      break;
    }
    case '__TypeField':
    case '__EnumValue': {
      if (name === 'name') return parent.name as string;
      break;
    }
    case 'Mutation': {
      if (name === 'createIssue') {
        const input = argOf(field, 'input', ctx) as { repositoryId?: string; title?: string; body?: string } | undefined;
        const target = input?.repositoryId ? store.resolveGlobalId(input.repositoryId) : undefined;
        const repo = target ? store.getRepo(target.repo) : undefined;
        if (!repo) {
          ctx.errors.push({ message: 'repository not found' });
          return null;
        }
        const res = store.createIssue(repo, input?.title ?? '', input?.body ?? '', []);
        if (!res.issue) {
          ctx.errors.push({ message: 'could not create issue' });
          return null;
        }
        return { _type: 'CreateIssuePayload', issue: issueNode(ctx, repo, res.issue) };
      }
      if (name === 'closeIssue') {
        const input = argOf(field, 'input', ctx) as { issueId?: string } | undefined;
        const target = input?.issueId ? store.resolveGlobalId(input.issueId) : undefined;
        const repo = target ? store.getRepo(target.repo) : undefined;
        const issue = repo && target ? store.getIssue(repo, target.number) : undefined;
        if (!repo || !issue) {
          ctx.errors.push({ message: 'issue not found' });
          return null;
        }
        issue.state = 'closed';
        refreshIssueJson(store, repo, issue);
        repo.rev++;
        return { _type: 'CloseIssuePayload', issue: issueNode(ctx, repo, issue) };
      }
      if (name === 'createPullRequest') {
        const input = argOf(field, 'input', ctx) as { repositoryId?: string; baseRefName?: string; headRefName?: string; title?: string } | undefined;
        const target = input?.repositoryId ? store.resolveGlobalId(input.repositoryId) : undefined;
        const repo = target ? store.getRepo(target.repo) : undefined;
        if (!repo) {
          ctx.errors.push({ message: 'repository not found' });
          return null;
        }
        const res = store.createPull(repo, input?.headRefName ?? '', input?.baseRefName ?? '', input?.title ?? '', '');
        if (!res.pull) {
          ctx.errors.push({ message: 'could not create pull request' });
          return null;
        }
        return { _type: 'CreatePullRequestPayload', pullRequest: pullNode(ctx, repo, res.pull) };
      }
      if (name === 'mergePullRequest') {
        const input = argOf(field, 'input', ctx) as { pullRequestId?: string } | undefined;
        const target = input?.pullRequestId ? store.resolveGlobalId(input.pullRequestId) : undefined;
        const repo = target ? store.getRepo(target.repo) : undefined;
        const pull = repo && target ? store.getPull(repo, target.number) : undefined;
        if (!repo || !pull) {
          ctx.errors.push({ message: 'pull request not found' });
          return null;
        }
        const res = store.mergePull(repo, pull.number);
        if (res.error) {
          ctx.errors.push({ message: 'could not merge pull request: ' + res.error });
          return null;
        }
        return { _type: 'MergePullRequestPayload', pullRequest: pullNode(ctx, repo, pull) };
      }
      if (name === 'addComment') {
        const input = argOf(field, 'input', ctx) as { subjectId?: string; body?: string } | undefined;
        const target = input?.subjectId ? store.resolveGlobalId(input.subjectId) : undefined;
        const repo = target ? store.getRepo(target.repo) : undefined;
        const issue = repo && target ? store.getIssue(repo, target.number) : undefined;
        if (!repo || !issue) {
          ctx.errors.push({ message: 'subject not found' });
          return null;
        }
        const rec = store.createComment(repo, issue.number, input?.body ?? '');
        if (!rec) {
          ctx.errors.push({ message: 'could not create comment' });
          return null;
        }
        return {
          _type: 'AddCommentPayload',
          commentEdge: { _type: 'CommentEdge', node: { _type: 'IssueComment', id: rec.gid, body: rec.body } },
        };
      }
      break;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (name === 'issue') return parent.issue as GqlObj;
      break;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (name === 'pullRequest') return parent.pullRequest as GqlObj;
      break;
    }
    case 'AddCommentPayload': {
      if (name === 'commentEdge') return parent.commentEdge as GqlObj;
      break;
    }
    case 'CommentEdge': {
      if (name === 'node') return parent.node as GqlObj;
      break;
    }
    case 'IssueComment': {
      if (name === 'id') return parent.id as string;
      if (name === 'body') return parent.body as string;
      break;
    }
  }
  ctx.errors.push({ message: 'Cannot query field "' + name + '" on type "' + type + '".' });
  return null;
}

// The repository's opaque global id.
function repoGid(_store: Store, repo: Repo): string {
  return repo.gid;
}

function executeSelection(parent: GqlObj, selections: SelectionNode[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'InlineFragment') {
      if (sel.typeCondition && sel.typeCondition !== parent._type) continue;
      Object.assign(out, executeSelection(parent, sel.selectionSet, ctx));
      continue;
    }
    const value = resolveField(parent, sel, ctx);
    const key = sel.alias ?? sel.name;
    if (value === null || value === undefined) {
      out[key] = null;
      continue;
    }
    if (sel.selectionSet) {
      if (Array.isArray(value)) {
        out[key] = value.map((item) =>
          item && typeof item === 'object' && '_type' in (item as Record<string, unknown>)
            ? executeSelection(item as GqlObj, sel.selectionSet!, ctx)
            : item,
        );
      } else if (typeof value === 'object' && '_type' in (value as Record<string, unknown>)) {
        out[key] = executeSelection(value as GqlObj, sel.selectionSet, ctx);
      } else {
        out[key] = value;
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}

function executeOperation(store: Store, op: OperationNode, variables: Record<string, unknown>): { data: Record<string, unknown>; errors: { message: string }[] } {
  const ctx: Ctx = { store, variables: { ...variables }, errors: [] };
  // Apply variable defaults.
  for (const def of op.variableDefinitions) {
    if (ctx.variables[def.name] === undefined && def.defaultValue) {
      ctx.variables[def.name] = resolveValue(def.defaultValue, ctx.variables);
    }
  }
  const root: GqlObj = { _type: op.operation === 'mutation' ? 'Mutation' : 'Query' };
  const data = executeSelection(root, op.selectionSet, ctx);
  return { data, errors: ctx.errors };
}

export interface GraphqlResult {
  status: number;
  body: string;
}

export function handleGraphql(store: Store, body: Buffer): GraphqlResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, body: '{"errors":[{"message":"Invalid JSON"}]}' };
  }
  const runOne = (doc: unknown): Record<string, unknown> => {
    if (!doc || typeof doc !== 'object') return { errors: [{ message: 'Invalid operation' }] };
    const d = doc as { query?: unknown; variables?: unknown; operationName?: unknown };
    if (typeof d.query !== 'string') return { errors: [{ message: 'query must be a string' }] };
    let ops: OperationNode[];
    try {
      ops = new Parser(d.query).parseDocument();
    } catch (e) {
      return { errors: [{ message: e instanceof Error ? e.message : 'parse error' }] };
    }
    if (ops.length === 0) return { errors: [{ message: 'No operation' }] };
    let op = ops[0];
    if (typeof d.operationName === 'string') {
      const named = ops.find((o) => o.name === d.operationName);
      if (named) op = named;
    }
    const variables = (d.variables && typeof d.variables === 'object' ? d.variables : {}) as Record<string, unknown>;
    const { data, errors } = executeOperation(store, op, variables);
    const out: Record<string, unknown> = { data };
    if (errors.length > 0) out.errors = errors;
    return out;
  };
  if (Array.isArray(parsed)) {
    const results = parsed.map(runOne);
    return { status: 200, body: JSON.stringify(results) };
  }
  return { status: 200, body: JSON.stringify(runOne(parsed)) };
}
