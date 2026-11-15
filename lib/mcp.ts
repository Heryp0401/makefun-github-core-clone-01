// Model Context Protocol, modern 2026-07-28 (server/discover) with the legacy
// initialize handshake as a fallback. JSON-RPC 2.0 over Streamable HTTP, stateless
// (no session). Tools act on the same in-memory store as REST/GraphQL, so a repo
// created over MCP reads back over /api/v3 as the same object.

import {
  Store, FIXED_TIME, mergeConflict,
  type Ctx, type HandlerResult, type Repo, type Issue, type Pull,
} from './store.ts';

const SERVER_NAME = 'makefun-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Owner and name as "owner/repo"' },
      },
      required: [],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Owner and name as "owner/repo"' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Owner and name as "owner/repo"' },
        state: { type: 'string', description: 'Issue state: open, closed, or all' },
      },
      required: [],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Owner and name as "owner/repo"' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Owner and name as "owner/repo"' },
        pull_number: { type: 'number', description: 'Pull request number' },
        number: { type: 'number', description: 'Pull request number' },
      },
      required: [],
    },
  },
];

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const owner = store.viewer;
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: FIXED_TIME,
  };
}

function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
  };
}

function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const owner = store.viewer;
  return {
    id: pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${owner}:${pull.baseRef}` },
  };
}

/** Resolve owner + repo from argument synonyms (owner/repo, full_name, repository). */
function resolveRepo(store: Store, args: Record<string, unknown>): { owner: string; name: string; repo: Repo | null } {
  let owner = '';
  let name = '';
  const fullName = typeof args.full_name === 'string' ? args.full_name : typeof args.repository === 'string' ? args.repository : '';
  if (fullName.includes('/')) {
    const [o, n] = fullName.split('/');
    owner = o;
    name = n;
  }
  if (typeof args.owner === 'string' && args.owner) owner = args.owner;
  if (typeof args.repo === 'string' && args.repo) name = args.repo;
  if (typeof args.repo_name === 'string' && args.repo_name) name = args.repo_name;
  if (!owner) owner = store.viewer;
  let repo: Repo | null = null;
  if (name && store.isOwner(owner)) repo = store.getRepo(name) ?? null;
  return { owner, name, repo };
}

function toolResult(result: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

/** Execute one tool call. Returns {result} or {error}. */
function callTool(store: Store, name: string, args: Record<string, unknown>): { result?: Record<string, unknown>; error?: string } {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { error: `unknown tool: ${name}` };

  if (name === 'create_repo') {
    const repoName = typeof args.name === 'string' ? args.name : typeof args.repository_name === 'string' ? args.repository_name : '';
    if (!repoName) return { result: toolError('missing required argument: name') };
    if (store.getRepo(repoName)) return { result: toolError(`repository ${repoName} already exists`) };
    const repo: Repo = {
      id: store.nextRepoId++,
      name: repoName,
      owner: store.viewer,
      description: typeof args.description === 'string' ? args.description : '',
      private: args.private === true,
      defaultBranch: 'main',
      labels: [],
      issues: [],
      pulls: [],
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
      createdSeq: store.seq++,
    };
    store.repos.set(repoName, repo);
    return { result: toolResult(repoJson(store, repo)) };
  }

  if (name === 'get_repo') {
    const { repo } = resolveRepo(store, args);
    if (!repo) return { result: toolError('repository not found') };
    return { result: toolResult(repoJson(store, repo)) };
  }

  if (name === 'create_issue') {
    const { repo } = resolveRepo(store, args);
    if (!repo) return { result: toolError('repository not found') };
    const title = typeof args.title === 'string' ? args.title : '';
    if (!title) return { result: toolError('missing required argument: title') };
    const issue: Issue = {
      number: repo.nextIssue++,
      title,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      labels: [],
      createdSeq: store.seq++,
      comments: [],
      jsonText: null,
    };
    repo.issues.push(issue);
    return { result: toolResult(issueJson(issue)) };
  }

  if (name === 'list_issues') {
    const { repo } = resolveRepo(store, args);
    if (!repo) return { result: toolError('repository not found') };
    const state = typeof args.state === 'string' ? args.state : 'open';
    let list = [...repo.issues];
    if (state === 'open') list = list.filter((i) => i.state === 'open');
    else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
    list.sort((a, b) => a.createdSeq - b.createdSeq);
    return { result: toolResult(list.map(issueJson)) };
  }

  if (name === 'create_pull_request') {
    const { repo } = resolveRepo(store, args);
    if (!repo) return { result: toolError('repository not found') };
    const title = typeof args.title === 'string' ? args.title : '';
    const head = typeof args.head === 'string' ? args.head : typeof args.head_branch === 'string' ? args.head_branch : typeof args.headRef === 'string' ? args.headRef : '';
    const base = typeof args.base === 'string' ? args.base : typeof args.base_branch === 'string' ? args.base_branch : typeof args.baseRef === 'string' ? args.baseRef : '';
    if (!title) return { result: toolError('missing required argument: title') };
    if (!head) return { result: toolError('missing required argument: head') };
    if (!base) return { result: toolError('missing required argument: base') };
    const headSha = store.repoRefs(repo.name).get(`refs/heads/${head}`);
    const baseSha = store.repoRefs(repo.name).get(`refs/heads/${base}`);
    if (!headSha || !baseSha) return { result: toolError('head or base branch does not exist') };
    const dup = repo.pulls.find((p) => p.headRef === head && p.state === 'open');
    if (dup) return { result: toolError('a pull request already exists for this head branch') };
    const pull: Pull = {
      number: repo.nextPull++,
      title,
      body: typeof args.body === 'string' ? args.body : '',
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
    return { result: toolResult(pullJson(store, repo, pull)) };
  }

  if (name === 'merge_pull_request') {
    const { repo } = resolveRepo(store, args);
    if (!repo) return { result: toolError('repository not found') };
    const numRaw = args.pull_number ?? args.number ?? args.pullRequestNumber;
    const num = typeof numRaw === 'number' ? numRaw : typeof numRaw === 'string' ? parseInt(numRaw, 10) : NaN;
    if (!Number.isInteger(num)) return { result: toolError('missing required argument: pull_number') };
    const pull = repo.pulls.find((p) => p.number === num);
    if (!pull) return { result: toolError('pull request not found') };
    if (pull.state !== 'open') return { result: toolError('pull request is already closed') };
    if (mergeConflict(store, repo, pull)) return { result: toolError('merge conflict') };
    const headCommit = store.getObject(pull.headSha);
    if (!headCommit) return { result: toolError('head commit not found') };
    const headTree = store.parseCommit(headCommit.data).tree;
    const currentTip = store.repoRefs(repo.name).get(`refs/heads/${pull.baseRef}`);
    if (!currentTip) return { result: toolError('base branch not found') };
    const mergeSha = store.makeCommit(headTree, [currentTip], `Merge pull request #${pull.number} from ${pull.headRef}`);
    store.repoRefs(repo.name).set(`refs/heads/${pull.baseRef}`, mergeSha);
    store.touchRepo(repo.name);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = FIXED_TIME;
    pull.mergeCommitSha = mergeSha;
    return { result: toolResult({ merged: true, sha: mergeSha, number: pull.number, pull_number: pull.number, id: pull.number, message: 'Pull request successfully merged' }) };
  }

  return { error: `unknown tool: ${name}` };
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export function routeMcp(store: Store, ctx: Ctx): HandlerResult {
  // Non-JSON body: HTTP 400 carrying -32700.
  let body: unknown;
  try {
    body = ctx.body && ctx.body.length > 0 ? JSON.parse(ctx.body.toString('utf8')) : null;
  } catch {
    return {
      status: 400,
      json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: body is not valid JSON' } },
      contentType: 'application/json',
    };
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return {
      status: 400,
      json: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: expected a JSON-RPC object' } },
      contentType: 'application/json',
    };
  }
  const req = body as JsonRpcRequest;
  const id = req.id === undefined ? null : req.id;
  const isNotification = req.id === undefined;

  if (typeof req.method !== 'string') {
    if (isNotification) return { status: 202, json: undefined };
    return { status: 400, json: rpcError(id, -32600, 'Invalid Request: missing method'), contentType: 'application/json' };
  }

  // Notifications (no id): no response body.
  if (isNotification) {
    return { status: 202, json: undefined };
  }

  const params = (req.params ?? {}) as Record<string, unknown>;

  if (req.method === 'server/discover') {
    return {
      status: 200,
      json: rpcResult(id, {
        resultType: 'discover',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: 'A GitHub-compatible git forge. Use tools/list to see the available tools.',
      }),
      contentType: 'application/json',
    };
  }

  if (req.method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : '2025-11-25';
    return {
      status: 200,
      json: rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
      contentType: 'application/json',
    };
  }

  if (req.method === 'ping') {
    return { status: 200, json: rpcResult(id, {}), contentType: 'application/json' };
  }

  if (req.method === 'tools/list') {
    // Deterministic: the same array, byte-identical, on every call.
    return { status: 200, json: rpcResult(id, { tools: TOOLS }), contentType: 'application/json' };
  }

  if (req.method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const { result, error } = callTool(store, name, args);
    if (error) {
      return { status: 200, json: rpcError(id, -32601, error), contentType: 'application/json' };
    }
    return { status: 200, json: rpcResult(id, result), contentType: 'application/json' };
  }

  // Unknown method.
  return { status: 200, json: rpcError(id, -32601, `Method not found: ${req.method}`), contentType: 'application/json' };
}
