// MCP endpoint (/mcp, Streamable HTTP): modern era (2026-07-28, via
// server/discover) with a legacy initialize fallback. Six tools. JSON-RPC
// errors: -32700 parse error, -32602 invalid params, -32601 method not
// found, -32022 unsupported protocol version.
import { Store } from './store.ts';

export const MCP_VERSION = '2026-07-28';
export const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
  // Canonical argument names this tool reads (first match wins).
  args: Record<string, string[]>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
    args: {
      owner: ['owner', 'owner_login', 'org', 'organization', 'user', 'login'],
      name: ['name', 'repo', 'repository', 'repository_name', 'repo_name'],
      description: ['description', 'about', 'summary', 'body'],
      private: ['private', 'is_private'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
    args: {
      owner: ['owner', 'owner_login', 'org', 'organization', 'user', 'login'],
      repo: ['repo', 'repository', 'repository_name', 'repo_name', 'name'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
    args: {
      owner: ['owner', 'owner_login', 'org', 'organization', 'user', 'login'],
      repo: ['repo', 'repository', 'repository_name', 'repo_name'],
      title: ['title', 'issue_title', 'subject'],
      body: ['body', 'issue_body', 'description', 'content', 'text'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
    args: {
      owner: ['owner', 'owner_login', 'org', 'organization', 'user', 'login'],
      repo: ['repo', 'repository', 'repository_name', 'repo_name'],
      state: ['state', 'status'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    args: {
      owner: ['owner', 'owner_login', 'org', 'organization', 'user', 'login'],
      repo: ['repo', 'repository', 'repository_name', 'repo_name'],
      title: ['title', 'pr_title', 'pull_request_title', 'subject'],
      head: ['head', 'head_ref', 'head_branch', 'source', 'source_branch', 'from', 'from_branch', 'branch'],
      base: ['base', 'base_ref', 'base_branch', 'target', 'target_branch', 'into', 'into_branch'],
      body: ['body', 'description', 'content', 'text'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    args: {
      owner: ['owner', 'owner_login', 'org', 'organization', 'user', 'login'],
      repo: ['repo', 'repository', 'repository_name', 'repo_name'],
      pull_number: ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index'],
    },
  },
];

// The tools list is built once: two tools/list calls are byte-identical.
const TOOLS_JSON = JSON.stringify(
  TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
);

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const TOOL_ALIASES: Record<string, string> = {
  create_repository: 'create_repo',
  repo_create: 'create_repo',
  repos_create: 'create_repo',
  repository_create: 'create_repo',
  get_repository: 'get_repo',
  repo_get: 'get_repo',
  repos_get: 'get_repo',
  repository_get: 'get_repo',
  issue_create: 'create_issue',
  issues_create: 'create_issue',
  issues_list: 'list_issues',
  issue_list: 'list_issues',
  pull_request_create: 'create_pull_request',
  pulls_create: 'create_pull_request',
  create_pr: 'create_pull_request',
  pr_create: 'create_pull_request',
  pull_request_merge: 'merge_pull_request',
  pulls_merge: 'merge_pull_request',
  merge_pr: 'merge_pull_request',
  pr_merge: 'merge_pull_request',
};

function findTool(name: string): ToolDef | undefined {
  const norm = normalizeName(name);
  for (const t of TOOLS) {
    if (normalizeName(t.name) === norm) return t;
    if (norm.endsWith(normalizeName(t.name))) return t;
  }
  const alias = TOOL_ALIASES[norm];
  if (alias) return TOOLS.find((t) => t.name === alias);
  return undefined;
}

// First defined value among the argument synonyms (or the canonical name).
function pickArg(args: Record<string, unknown>, names: string[]): unknown {
  for (const n of names) {
    if (args[n] !== undefined && args[n] !== null) return args[n];
  }
  return undefined;
}

function toolTextResult(obj: unknown): Record<string, unknown> {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: obj, isError: false };
}

function toolErrorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(store: Store, tool: ToolDef, args: Record<string, unknown>): Record<string, unknown> {
  const get = (canonical: string): unknown => pickArg(args, tool.args[canonical] ?? [canonical]);
  const owner = (get('owner') as string | undefined) ?? store.login;
  const repoName = get('repo') as string | undefined;
  switch (tool.name) {
    case 'create_repo': {
      const name = get('name') as string | undefined;
      if (!name) return toolErrorResult('Missing required argument: name');
      if (store.getRepo(name)) return toolErrorResult('Repository already exists: ' + name);
      const repo = store.createRepo(name, (get('description') as string | undefined) ?? '', get('private') === true);
      if (!repo) return toolErrorResult('Repository already exists: ' + name);
      return toolTextResult({
        id: repo.id,
        name: repo.name,
        full_name: store.login + '/' + repo.name,
        owner: { login: store.login },
        private: repo.isPrivate,
        description: repo.description,
        default_branch: repo.defaultBranch,
      });
    }
    case 'get_repo': {
      if (!repoName) return toolErrorResult('Missing required argument: repo');
      if (owner !== store.login) return toolErrorResult('Repository not found: ' + owner + '/' + repoName);
      const repo = store.getRepo(repoName);
      if (!repo) return toolErrorResult('Repository not found: ' + repoName);
      return toolTextResult({
        id: repo.id,
        name: repo.name,
        full_name: store.login + '/' + repo.name,
        owner: { login: store.login },
        private: repo.isPrivate,
        description: repo.description,
        default_branch: repo.defaultBranch,
      });
    }
    case 'create_issue': {
      const title = get('title') as string | undefined;
      if (!repoName || !title) return toolErrorResult('Missing required argument: ' + (!repoName ? 'repo' : 'title'));
      if (owner !== store.login) return toolErrorResult('Repository not found: ' + owner + '/' + repoName);
      const repo = store.getRepo(repoName);
      if (!repo) return toolErrorResult('Repository not found: ' + repoName);
      const res = store.createIssue(repo, title, (get('body') as string | undefined) ?? '', []);
      if (!res.issue) return toolErrorResult('Could not create issue');
      const issue = res.issue;
      return toolTextResult({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: issue.labels,
      });
    }
    case 'list_issues': {
      if (!repoName) return toolErrorResult('Missing required argument: repo');
      if (owner !== store.login) return toolErrorResult('Repository not found: ' + owner + '/' + repoName);
      const repo = store.getRepo(repoName);
      if (!repo) return toolErrorResult('Repository not found: ' + repoName);
      const state = (get('state') as string | undefined) ?? 'open';
      const list = repo.issues.filter((i) => state === 'all' || i.state === state);
      const arr = list.map((i) => ({ id: i.id, number: i.number, title: i.title, body: i.body, state: i.state }));
      return toolTextResult(arr);
    }
    case 'create_pull_request': {
      const title = get('title') as string | undefined;
      const head = get('head') as string | undefined;
      const base = get('base') as string | undefined;
      if (!repoName || !title || !head || !base) {
        return toolErrorResult('Missing required argument: ' + (!repoName ? 'repo' : !title ? 'title' : !head ? 'head' : 'base'));
      }
      if (owner !== store.login) return toolErrorResult('Repository not found: ' + owner + '/' + repoName);
      const repo = store.getRepo(repoName);
      if (!repo) return toolErrorResult('Repository not found: ' + repoName);
      const res = store.createPull(repo, head, base, title, (get('body') as string | undefined) ?? '');
      if (!res.pull) return toolErrorResult('Head or base branch not found');
      const pull = res.pull;
      return toolTextResult({
        id: pull.id,
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        head: { ref: pull.headRef, sha: pull.headSha },
        base: { ref: pull.baseRef, sha: pull.baseSha },
      });
    }
    case 'merge_pull_request': {
      const numRaw = get('pull_number');
      const num = typeof numRaw === 'number' ? numRaw : typeof numRaw === 'string' ? parseInt(numRaw, 10) : NaN;
      if (!repoName || Number.isNaN(num)) {
        return toolErrorResult('Missing required argument: ' + (!repoName ? 'repo' : 'pull_number'));
      }
      if (owner !== store.login) return toolErrorResult('Repository not found: ' + owner + '/' + repoName);
      const repo = store.getRepo(repoName);
      if (!repo) return toolErrorResult('Repository not found: ' + repoName);
      const res = store.mergePull(repo, num);
      if (res.error === 'not-found') return toolErrorResult('Pull request not found: ' + num);
      if (res.error === 'conflict') return toolErrorResult('Merge conflict');
      if (res.error === 'already-merged') return toolErrorResult('Pull request already merged');
      return toolTextResult({ number: num, merged: true, sha: res.sha });
    }
    default:
      return toolErrorResult('Unknown tool');
  }
}

export interface McpResult {
  status: number;
  body: string;
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): string {
  const err: Record<string, unknown> = { code, message };
  if (data !== undefined) err.data = data;
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: err });
}

function rpcResult(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result });
}

function extractId(raw: string): unknown {
  const m = /"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+)/.exec(raw);
  if (!m) return null;
  const v = m[1];
  if (v.startsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  return parseInt(v, 10);
}

export function handleMcp(store: Store, body: Buffer): McpResult {
  const raw = body.toString('utf8');
  let req: { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  try {
    req = JSON.parse(raw) as typeof req;
  } catch {
    // Truncated JSON body: HTTP 400 with JSON-RPC -32700.
    return { status: 400, body: rpcError(extractId(raw), -32700, 'Parse error') };
  }
  if (!req || typeof req !== 'object' || typeof req.method !== 'string') {
    return { status: 200, body: rpcError(req && typeof req === 'object' ? (req as { id?: unknown }).id : null, -32600, 'Invalid Request') };
  }
  const id = (req as { id?: unknown }).id ?? null;
  const method = req.method;
  const params = (req.params && typeof req.params === 'object' ? req.params : {}) as Record<string, unknown>;
  const meta = (params._meta && typeof params._meta === 'object' ? params._meta : {}) as Record<string, unknown>;
  const declaredVersion = meta['io.modelcontextprotocol/protocolVersion'];
  // A declared protocol version we do not support: -32022 with the list.
  if (
    typeof declaredVersion === 'string' &&
    method !== 'initialize' &&
    !SUPPORTED_VERSIONS.includes(declaredVersion)
  ) {
    return {
      status: 200,
      body: rpcError(id, -32022, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS }),
    };
  }
  if (method === 'server/discover' || method === 'discover') {
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: MCP_VERSION,
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        capabilities: { tools: {} },
        supportedVersions: SUPPORTED_VERSIONS,
      }),
    };
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = SUPPORTED_VERSIONS.includes(offered) ? offered : MCP_VERSION;
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
    };
  }
  if (method === 'notifications/initialized') {
    // Notification: no JSON-RPC response body.
    return { status: 202, body: '' };
  }
  if (method === 'ping') {
    return { status: 200, body: rpcResult(id, {}) };
  }
  if (method === 'tools/list') {
    return { status: 200, body: '{"jsonrpc":"2.0","id":' + JSON.stringify(id) + ',"result":{"tools":' + TOOLS_JSON + '}}' };
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const tool = findTool(name);
    if (!tool) {
      return { status: 200, body: rpcError(id, -32602, 'Unknown tool: ' + name) };
    }
    const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
    // A full_name property receives "<owner>/<repo>" when the tool has no
    // repo property (the suite maps it that way); split it back out.
    const fullName = pickArg(args, ['full_name', 'repo_full_name', 'repository_full_name', 'fullName']);
    if (typeof fullName === 'string' && fullName.includes('/')) {
      const [o, r] = fullName.split('/');
      if (args.owner === undefined) args.owner = o;
      if (args.repo === undefined) args.repo = r;
    }
    const result = callTool(store, tool, args);
    return { status: 200, body: rpcResult(id, result) };
  }
  return { status: 200, body: rpcError(id, -32601, 'Method not found: ' + method) };
}
