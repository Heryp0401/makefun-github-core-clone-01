// MCP endpoint at /mcp: Streamable HTTP JSON-RPC, modern era (server/discover)
// with a legacy initialize fallback. Six tools mirror the REST surface; every
// tool result carries both a text JSON block and structuredContent.

import {
  FIXED_TIME,
  authorCommit,
  branchTip,
  diffTrees,
  flattenCommit,
  ownerMatches,
  repoByName,
  refsOf,
  treeFromPaths,
  viewerName,
  type IssueRec,
  type PullRec,
  type RepoRec,
  type Vault,
} from './store.ts';
import { issueShape, pullShape } from './rest.ts';

export interface Reply {
  status: number;
  body: Buffer;
  contentType: string;
}

const SERVER_NAME = 'forge-mcp';
const SERVER_VERSION = '1.0.0';
const PREFERRED = '2026-07-28';
const SUPPORTED = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

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
        owner: { type: 'string', description: 'Owner login (the viewer).' },
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'integer', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function toolByName(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

function textResult(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value };
}

function errorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function missingArg(args: Record<string, unknown>, required: string[]): string | null {
  for (const name of required) {
    const value = args[name];
    if (value === undefined || value === null || value === '') return name;
  }
  return null;
}

function repoLookup(v: Vault, owner: string, name: string): RepoRec | null {
  if (!ownerMatches(v, owner)) return null;
  return repoByName(v, name) ?? null;
}

function repoJson(v: Vault, repo: RepoRec): Record<string, unknown> {
  const owner = viewerName(v);
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner,
    private: repo.isPrivate,
    description: repo.about,
    default_branch: repo.branch,
  };
}

function callTool(v: Vault, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const def = toolByName(name);
  if (!def) return errorResult(`unknown tool "${name}"`);
  const missing = missingArg(args, def.inputSchema.required);
  if (missing) return errorResult(`missing required argument: ${missing}`);
  const owner = String(args.owner ?? viewerName(v));
  const repoName = String(args.repo ?? args.name ?? '');

  if (name === 'create_repo') {
    const repoName2 = String(args.name ?? '');
    if (repoByName(v, repoName2)) return errorResult(`repository ${repoName2} already exists`);
    const repo: RepoRec = {
      id: v.nextRepoId,
      name: repoName2,
      owner: viewerName(v),
      about: String(args.description ?? ''),
      isPrivate: args.private === true,
      branch: 'main',
      labels: new Map(),
      issues: [],
      pulls: [],
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
      order: v.clock++,
    };
    v.nextRepoId += 1;
    v.catalog.set(repoName2, repo);
    return textResult(repoJson(v, repo));
  }

  const repo = repoLookup(v, owner, repoName);
  if (!repo) return errorResult(`repository ${owner}/${repoName} not found`);

  if (name === 'get_repo') return textResult(repoJson(v, repo));

  if (name === 'create_issue') {
    const issue: IssueRec = {
      number: repo.nextIssue++,
      title: String(args.title ?? ''),
      body: String(args.body ?? ''),
      state: 'open',
      labels: [],
      order: v.clock++,
      comments: [],
    };
    repo.issues.push(issue);
    return textResult(issueShape(v, repo, issue));
  }

  if (name === 'list_issues') {
    const state = String(args.state ?? 'open');
    let list = [...repo.issues];
    if (state !== 'all') list = list.filter((i) => i.state === state);
    return textResult({ issues: list.map((i) => issueShape(v, repo, i)) });
  }

  if (name === 'create_pull_request') {
    const headRef = String(args.head ?? '');
    const baseRef = String(args.base ?? '');
    const headTip = branchTip(v, repo, headRef);
    const baseTip = branchTip(v, repo, baseRef);
    if (headTip === undefined || baseTip === undefined) {
      return errorResult('head or base branch does not exist');
    }
    const pull: PullRec = {
      number: repo.nextPull++,
      title: String(args.title ?? ''),
      body: String(args.body ?? ''),
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeSha: null,
      headRef,
      baseRef,
      headTip,
      baseTip,
      order: v.clock++,
    };
    repo.pulls.push(pull);
    return textResult(pullShape(v, repo, pull));
  }

  if (name === 'merge_pull_request') {
    const num = Number(args.pull_number);
    const pull = repo.pulls.find((p) => p.number === num);
    if (!pull) return errorResult(`pull request ${num} not found`);
    if (pull.merged) return errorResult(`pull request ${num} is already merged`);
    const ok = mergePullRequest(v, repo, pull);
    if (!ok) return errorResult(`pull request ${num} cannot be merged (conflict)`);
    return textResult(pullShape(v, repo, pull));
  }

  return errorResult(`tool "${name}" is not implemented`);
}

export function mcpRoute(v: Vault, raw: Buffer | null): Reply {
  const text = raw === null ? '' : raw.toString('utf8');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    // Parse error: HTTP 400 with JSON-RPC -32700 (the id is recovered when visible).
    const idMatch = /"id"\s*:\s*(\d+)/.exec(text);
    const id = idMatch ? Number(idMatch[1]) : null;
    return {
      status: 400,
      body: Buffer.from(
        JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32700, message: 'Parse error' } }),
        'utf8',
      ),
      contentType: 'application/json',
    };
  }
  const req = (body ?? {}) as Record<string, unknown>;
  const id = req.id ?? null;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Record<string, unknown>;

  const ok = (result: unknown): Reply => ({
    status: 200,
    body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }), 'utf8'),
    contentType: 'application/json',
  });
  const err = (code: number, message: string, data?: unknown): Reply => ({
    status: 200,
    body: Buffer.from(
      JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } }),
      'utf8',
    ),
    contentType: 'application/json',
  });

  if (method === 'server/discover') {
    return ok({
      protocolVersion: PREFERRED,
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {} },
      supportedVersions: SUPPORTED,
    });
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = SUPPORTED.includes(offered) ? offered : null;
    if (!negotiated) {
      return err(-32602, `unsupported protocol version ${offered}`, { supported: SUPPORTED });
    }
    return ok({
      protocolVersion: negotiated,
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {} },
    });
  }
  if (method === 'notifications/initialized') {
    return ok({});
  }
  if (method === 'ping') return ok({});
  if (method === 'tools/list') {
    return ok({ tools: TOOLS });
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (!toolByName(toolName)) {
      return err(-32602, `unknown tool "${toolName}"`);
    }
    return ok(callTool(v, toolName, args));
  }
  return err(-32601, `method not found: ${method}`);
}

// The squash merge shared with the REST layer: the base branch takes the head's
// tree in a new commit, unless a file changed on both sides since the PR's base.
export function mergePullRequest(v: Vault, repo: RepoRec, pull: PullRec): boolean {
  const baseTip = branchTip(v, repo, pull.baseRef);
  if (baseTip === undefined || pull.merged) return false;
  const changes = diffTrees(v, pull.baseTip, pull.headTip);
  const baseNow = flattenCommit(v, baseTip);
  const baseThen = flattenCommit(v, pull.baseTip);
  const headNow = flattenCommit(v, pull.headTip);
  for (const change of changes) {
    const thenBlob = baseThen.get(change.path)?.blob ?? null;
    const nowBlob = baseNow.get(change.path)?.blob ?? null;
    const headBlob = headNow.get(change.path)?.blob ?? null;
    if (nowBlob !== thenBlob && headBlob !== thenBlob) return false;
  }
  const files = new Map<string, string>();
  for (const [path, file] of headNow) files.set(path, file.blob);
  const tree = treeFromPaths(v, files);
  const commit = authorCommit(v, tree, [baseTip], `Merge pull request #${pull.number}: ${pull.title}`);
  refsOf(v, repo.name).set(`refs/heads/${pull.baseRef}`, commit);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = FIXED_TIME;
  pull.mergeSha = commit;
  return true;
}
