// REST v3 API: repositories, issues, pull requests and contents, under /api/v3.
// Every reply is JSON with an X-GitHub-Request-Id (added by the server layer);
// 4xx bodies are {"message": ...}. Auth is enforced by the server layer.

import {
  FIXED_TIME,
  ZERO_OID,
  authorCommit,
  branchTip,
  diffTrees,
  dirAtPath,
  fileAtPath,
  flattenCommit,
  isOid,
  loadObject,
  ownerMatches,
  readCommit,
  refsOf,
  repoByName,
  saveObject,
  treeFromPaths,
  viewerName,
  type IssueRec,
  type PullRec,
  type RepoRec,
  type Vault,
} from './store.ts';

export interface Reply {
  status: number;
  body: Buffer;
  contentType: string;
  headers?: Record<string, string>;
}

export interface RestReq {
  method: string;
  /** Path segments after /api/v3 (already URL-decoded). */
  segs: string[];
  query: URLSearchParams;
  /** Raw request body (null when none). */
  raw: Buffer | null;
  origin: string;
}

function json(status: number, value: unknown, extra?: Record<string, string>): Reply {
  return {
    status,
    body: Buffer.from(JSON.stringify(value), 'utf8'),
    contentType: 'application/json',
    headers: extra,
  };
}

function fail(status: number, message: string): Reply {
  return json(status, { message });
}

function parseJson(raw: Buffer | null): { ok: true; value: unknown } | { ok: false } {
  if (raw === null || raw.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

// ---- shapes -------------------------------------------------------------------

export function repoShape(v: Vault, repo: RepoRec): Record<string, unknown> {
  const owner = viewerName(v);
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: 1, type: 'User' },
    private: repo.isPrivate,
    description: repo.about,
    default_branch: repo.branch,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
  };
}

export function issueShape(v: Vault, repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  void v;
  void repo;
  return {
    id: repo.id * 100000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
  };
}

export function pullShape(v: Vault, repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const owner = viewerName(v);
  return {
    id: repo.id * 100000 + pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeSha,
    head: { ref: pull.headRef, sha: pull.headTip, label: `${owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseTip, label: `${owner}:${pull.baseRef}` },
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
  };
}

/** A repo must exist under the viewer; otherwise 404 (never 403). */
function lookupRepo(v: Vault, owner: string, name: string): RepoRec | null {
  if (!ownerMatches(v, owner)) return null;
  return repoByName(v, name) ?? null;
}

// ---- contents: commit a file change onto a branch ------------------------------

/**
 * Apply one file write to a branch: create the blob, rebuild the trees, author a
 * commit and move the branch. `baseBranch` is the branch a brand-new branch forks
 * from. Returns the blob and commit ids plus whether the file already existed.
 */
function writeFileOnBranch(
  v: Vault,
  repo: RepoRec,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
  baseBranch: string,
): { blob: string; commit: string; existed: boolean } {
  let tip = branchTip(v, repo, branch);
  if (tip === undefined) {
    // A new branch forks from the base branch (or from nothing when unborn).
    tip = branchTip(v, repo, baseBranch);
  }
  const flat = tip === undefined ? new Map<string, string>() : new Map<string, string>();
  if (tip !== undefined) {
    for (const [p, file] of flattenCommit(v, tip)) flat.set(p, file.blob);
  }
  const existed = flat.has(path);
  const blob = saveObject(v, 'blob', content);
  flat.set(path, blob);
  const tree = treeFromPaths(v, flat);
  const commit = authorCommit(v, tree, tip === undefined ? [] : [tip], message);
  refsOf(v, repo.name).set(`refs/heads/${branch}`, commit);
  return { blob, commit, existed };
}

function removeFileOnBranch(
  v: Vault,
  repo: RepoRec,
  branch: string,
  path: string,
  message: string,
): { commit: string } | null {
  const tip = branchTip(v, repo, branch);
  if (tip === undefined) return null;
  const flat = new Map<string, string>();
  for (const [p, file] of flattenCommit(v, tip)) flat.set(p, file.blob);
  if (!flat.has(path)) return null;
  flat.delete(path);
  const tree = treeFromPaths(v, flat);
  const commit = authorCommit(v, tree, [tip], message);
  refsOf(v, repo.name).set(`refs/heads/${branch}`, commit);
  return { commit };
}

// ---- the router -----------------------------------------------------------------

export function restRoute(v: Vault, req: RestReq): Reply {
  const { method, segs, query } = req;
  const parsed = parseJson(req.raw);
  if (!parsed.ok) return fail(400, 'malformed JSON body');
  const body = asRecord(parsed.value);

  // Root and meta (no repo in the path).
  if (method === 'GET' && segs.length === 0) {
    return json(200, {}, { 'X-OAuth-Scopes': 'repo' });
  }
  if (method === 'GET' && segs.length === 1 && segs[0] === 'meta') {
    return json(200, { installed_version: '1.0.0' });
  }
  if (method === 'GET' && segs.length === 1 && segs[0] === 'user') {
    const login = viewerName(v);
    return json(200, { login, id: 1, type: 'User', name: login });
  }

  // POST /user/repos — create a repository under the viewer.
  if (method === 'POST' && segs.length === 2 && segs[0] === 'user' && segs[1] === 'repos') {
    const name = str(body.name);
    if (!name) return fail(422, 'name is required');
    if (repoByName(v, name)) return fail(422, 'name already exists on this account');
    const repo: RepoRec = {
      id: v.nextRepoId,
      name,
      owner: viewerName(v),
      about: str(body.description),
      isPrivate: bool(body.private, false),
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
    v.catalog.set(name, repo);
    return json(201, repoShape(v, repo));
  }

  // GET /user/repos — paginated list of the viewer's repositories.
  if (method === 'GET' && segs.length === 2 && segs[0] === 'user' && segs[1] === 'repos') {
    const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') ?? '30', 10) || 30));
    const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
    const all = [...v.catalog.values()].sort((a, b) => a.order - b.order);
    const pages = Math.max(1, Math.ceil(all.length / perPage));
    const slice = all.slice((page - 1) * perPage, page * perPage);
    const base = `${req.origin}/api/v3/user/repos?per_page=${perPage}`;
    const links: string[] = [];
    if (page < pages) links.push(`<${base}&page=${page + 1}>; rel="next"`);
    if (page > 1) links.push(`<${base}&page=${page - 1}>; rel="prev"`);
    links.push(`<${base}&page=${pages}>; rel="last"`);
    links.push(`<${base}&page=1>; rel="first"`);
    const reply = json(200, slice.map((repo) => repoShape(v, repo)));
    return { ...reply, headers: { Link: links.join(', ') } };
  }

  // Everything below is /repos/{owner}/{name}[...].
  if (segs.length < 3 || segs[0] !== 'repos') return fail(404, 'Not Found');
  const [owner, name] = [segs[1], segs[2]];
  const rest = segs.slice(3);

  // GET /repos/{o}/{r}
  if (method === 'GET' && rest.length === 0) {
    const repo = lookupRepo(v, owner, name);
    if (!repo) return fail(404, 'Not Found');
    return json(200, repoShape(v, repo));
  }
  // PATCH /repos/{o}/{r}
  if (method === 'PATCH' && rest.length === 0) {
    const repo = lookupRepo(v, owner, name);
    if (!repo) return fail(404, 'Not Found');
    if (typeof body.description === 'string') repo.about = body.description;
    return json(200, repoShape(v, repo));
  }
  // DELETE /repos/{o}/{r}
  if (method === 'DELETE' && rest.length === 0) {
    const repo = lookupRepo(v, owner, name);
    if (!repo) return fail(404, 'Not Found');
    v.catalog.delete(name);
    v.refTable.delete(name);
    return { status: 204, body: Buffer.alloc(0), contentType: 'application/json' };
  }

  // The repo must exist for the routes below.
  const repo = lookupRepo(v, owner, name);
  if (!repo) return fail(404, 'Not Found');

  // POST /repos/{o}/{r}/git/refs — create a branch ref.
  if (method === 'POST' && rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs') {
    const ref = str(body.ref);
    const sha = str(body.sha);
    if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) return fail(422, 'invalid ref');
    if (!isOid(sha)) return fail(422, 'invalid sha');
    const obj = loadObject(v, sha);
    if (!obj || obj.type !== 'commit') return fail(422, 'sha is not a commit');
    const table = refsOf(v, name);
    if (table.has(ref)) return fail(422, 'reference already exists');
    table.set(ref, sha);
    return json(201, { ref, object: { sha, type: 'commit' } });
  }
  // GET /repos/{o}/{r}/git/refs/heads/{branch}
  if (method === 'GET' && rest.length === 4 && rest[0] === 'git' && rest[1] === 'refs' && rest[2] === 'heads') {
    const ref = `refs/heads/${rest[3]}`;
    const oid = refsOf(v, name).get(ref);
    if (!oid) return fail(404, 'Not Found');
    return json(200, { ref, object: { sha: oid, type: 'commit' } });
  }
  // GET /repos/{o}/{r}/branches
  if (method === 'GET' && rest.length === 1 && rest[0] === 'branches') {
    const out: Array<Record<string, unknown>> = [];
    for (const [ref, oid] of refsOf(v, name)) {
      if (!ref.startsWith('refs/heads/')) continue;
      out.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid } });
    }
    out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return json(200, out);
  }
  // GET /repos/{o}/{r}/branches/{branch}
  if (method === 'GET' && rest.length === 2 && rest[0] === 'branches') {
    const oid = refsOf(v, name).get(`refs/heads/${rest[1]}`);
    if (!oid) return fail(404, 'Not Found');
    return json(200, { name: rest[1], commit: { sha: oid } });
  }
  // GET /repos/{o}/{r}/commits[?sha=<ref>]
  if (method === 'GET' && rest.length === 1 && rest[0] === 'commits') {
    const refName = query.get('sha');
    let tip: string | undefined;
    if (refName) {
      tip = refsOf(v, name).get(`refs/heads/${refName}`) ?? (isOid(refName) ? refName : undefined);
    } else {
      tip = branchTip(v, repo, repo.branch);
    }
    if (!tip) return json(200, []);
    const out: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = loadObject(v, oid);
      if (!obj || obj.type !== 'commit') continue;
      const parsed = readCommit(obj.data);
      out.push({
        sha: oid,
        commit: {
          message: parsed.message,
          author: { name: 'Forge', email: 'forge@forge.invalid', date: FIXED_TIME },
          committer: { name: 'Forge', email: 'forge@forge.invalid', date: FIXED_TIME },
        },
      });
      for (const parent of parsed.parents) stack.push(parent);
    }
    // Newest first: the walk above is tip-first, so the order is already newest-first
    // for a linear history; sort by discovery order (stack order) is preserved.
    return json(200, out);
  }

  // Contents: /repos/{o}/{r}/contents/{path...}
  if (rest.length >= 2 && rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    return contentsRoute(v, repo, method, path, query, body);
  }

  // POST /repos/{o}/{r}/labels
  if (method === 'POST' && rest.length === 1 && rest[0] === 'labels') {
    const labelName = str(body.name);
    if (!labelName) return fail(422, 'name is required');
    const color = str(body.color, 'ededed');
    repo.labels.set(labelName, { name: labelName, color });
    return json(201, { name: labelName, color });
  }

  // Issues.
  if (rest.length >= 1 && rest[0] === 'issues') {
    return issuesRoute(v, repo, method, rest.slice(1), query, body);
  }
  // Pulls.
  if (rest.length >= 1 && rest[0] === 'pulls') {
    return pullsRoute(v, repo, method, rest.slice(1), query, body);
  }

  return fail(404, 'Not Found');
}

// ---- contents -------------------------------------------------------------------

function contentsRoute(
  v: Vault,
  repo: RepoRec,
  method: string,
  path: string,
  query: URLSearchParams,
  body: Record<string, unknown>,
): Reply {
  const branch = str(query.get('branch') ?? body.branch, repo.branch);
  const refName = query.get('ref');
  const readBranch = refName ?? branch;
  const tip = branchTip(v, repo, readBranch);

  if (method === 'PUT') {
    const message = str(body.message, 'update');
    const contentB64 = str(body.content);
    if (contentB64 === '') return fail(422, 'content is required');
    const content = Buffer.from(contentB64.replace(/[\r\n\t ]/g, ''), 'base64');
    const sha = str(body.sha);
    if (tip !== undefined && sha !== '') {
      const current = fileAtPath(v, tip, path);
      if (current && current.blob !== sha) return fail(409, 'sha does not match the current file');
      if (!current && sha !== '') return fail(409, 'sha does not match the current file');
    }
    const { blob, commit, existed } = writeFileOnBranch(v, repo, branch, path, content, message, repo.branch);
    return json(existed ? 200 : 201, {
      content: { name: path.split('/').pop(), path, sha: blob, size: content.length, encoding: 'base64' },
      commit: { sha: commit, message },
    });
  }

  if (method === 'GET') {
    if (tip === undefined) return fail(404, 'Not Found');
    const file = fileAtPath(v, tip, path);
    if (file) {
      return json(200, {
        type: 'file',
        encoding: 'base64',
        content: file.bytes.toString('base64'),
        sha: file.blob,
        size: file.bytes.length,
        name: path.split('/').pop(),
        path,
      });
    }
    // A directory listing, or 404 when the path is absent entirely.
    const entries = dirAtPath(v, tip, path);
    if (entries.length === 0) return fail(404, 'Not Found');
    return json(200, entries.map((e) => ({ type: e.kind, name: e.name, path: e.path, sha: e.oid || ZERO_OID })));
  }

  if (method === 'DELETE') {
    const sha = str(body.sha);
    if (tip === undefined) return fail(404, 'Not Found');
    const current = fileAtPath(v, tip, path);
    if (!current) return fail(404, 'Not Found');
    if (sha !== '' && current.blob !== sha) return fail(409, 'sha does not match the current file');
    const message = str(body.message, 'delete');
    const made = removeFileOnBranch(v, repo, branch, path, message);
    if (!made) return fail(404, 'Not Found');
    return json(200, { commit: { sha: made.commit, message } });
  }

  return fail(404, 'Not Found');
}

// ---- issues -----------------------------------------------------------------------

function issuesRoute(
  v: Vault,
  repo: RepoRec,
  method: string,
  rest: string[],
  query: URLSearchParams,
  body: Record<string, unknown>,
): Reply {
  // POST /issues — create.
  if (method === 'POST' && rest.length === 0) {
    const title = str(body.title);
    const text = str(body.body);
    const labels = Array.isArray(body.labels) ? body.labels.map((l) => String(l)) : [];
    for (const label of labels) {
      if (!repo.labels.has(label)) return fail(422, `label ${label} does not exist`);
    }
    const issue: IssueRec = {
      number: repo.nextIssue++,
      title,
      body: text,
      state: 'open',
      labels,
      order: v.clock++,
      comments: [],
    };
    repo.issues.push(issue);
    return json(201, issueShape(v, repo, issue));
  }
  // GET /issues — list, filtered and sorted.
  if (method === 'GET' && rest.length === 0) {
    const state = query.get('state') ?? 'open';
    const sort = query.get('sort') ?? 'created';
    const direction = query.get('direction') ?? 'desc';
    let list = [...repo.issues];
    if (state !== 'all') list = list.filter((i) => i.state === state);
    if (sort === 'created') {
      list.sort((a, b) => (direction === 'asc' ? a.order - b.order : b.order - a.order));
    }
    const perPage = parseInt(query.get('per_page') ?? '30', 10) || 30;
    return json(200, list.slice(0, perPage).map((i) => issueShape(v, repo, i)));
  }
  const num = parseInt(rest[0] ?? '', 10);
  const issue = repo.issues.find((i) => i.number === num);
  if (!issue) return fail(404, 'Not Found');
  // GET /issues/{n}
  if (method === 'GET' && rest.length === 1) return json(200, issueShape(v, repo, issue));
  // PATCH /issues/{n}
  if (method === 'PATCH' && rest.length === 1) {
    if (body.state === 'closed' || body.state === 'open') issue.state = body.state;
    if (typeof body.title === 'string') issue.title = body.title;
    if (typeof body.body === 'string') issue.body = body.body;
    return json(200, issueShape(v, repo, issue));
  }
  // POST /issues/{n}/comments
  if (method === 'POST' && rest.length === 2 && rest[1] === 'comments') {
    const comment = { id: repo.nextComment++, body: str(body.body) };
    issue.comments.push(comment);
    return json(201, { id: comment.id, body: comment.body });
  }
  // GET /issues/{n}/comments
  if (method === 'GET' && rest.length === 2 && rest[1] === 'comments') {
    return json(200, issue.comments.map((c) => ({ id: c.id, body: c.body })));
  }
  return fail(404, 'Not Found');
}

// ---- pulls --------------------------------------------------------------------------

function pullConflict(v: Vault, repo: RepoRec, pull: PullRec): boolean {
  const baseTip = branchTip(v, repo, pull.baseRef);
  if (baseTip === undefined || baseTip === pull.baseTip) return false;
  const changes = diffTrees(v, pull.baseTip, pull.headTip);
  const baseNow = flattenCommit(v, baseTip);
  const baseThen = flattenCommit(v, pull.baseTip);
  const headNow = flattenCommit(v, pull.headTip);
  for (const change of changes) {
    const thenBlob = baseThen.get(change.path)?.blob ?? null;
    const nowBlob = baseNow.get(change.path)?.blob ?? null;
    const headBlob = headNow.get(change.path)?.blob ?? null;
    if (nowBlob !== thenBlob && headBlob !== thenBlob) return true;
  }
  return false;
}

function pullsRoute(
  v: Vault,
  repo: RepoRec,
  method: string,
  rest: string[],
  query: URLSearchParams,
  body: Record<string, unknown>,
): Reply {
  // POST /pulls — create.
  if (method === 'POST' && rest.length === 0) {
    const headRef = str(body.head);
    const baseRef = str(body.base);
    const headTip = branchTip(v, repo, headRef);
    const baseTip = branchTip(v, repo, baseRef);
    if (headTip === undefined || baseTip === undefined) return fail(422, 'head or base branch does not exist');
    const pull: PullRec = {
      number: repo.nextPull++,
      title: str(body.title),
      body: str(body.body),
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
    return json(201, pullShape(v, repo, pull));
  }
  // GET /pulls — list (default state is open only).
  if (method === 'GET' && rest.length === 0) {
    const state = query.get('state') ?? 'open';
    let list = [...repo.pulls];
    if (state !== 'all') list = list.filter((p) => p.state === state);
    const perPage = parseInt(query.get('per_page') ?? '30', 10) || 30;
    return json(200, list.slice(0, perPage).map((p) => pullShape(v, repo, p)));
  }
  const num = parseInt(rest[0] ?? '', 10);
  const pull = repo.pulls.find((p) => p.number === num);
  if (!pull) return fail(404, 'Not Found');
  // GET /pulls/{n}
  if (method === 'GET' && rest.length === 1) return json(200, pullShape(v, repo, pull));
  // GET /pulls/{n}/files
  if (method === 'GET' && rest.length === 2 && rest[1] === 'files') {
    const changes = diffTrees(v, pull.baseTip, pull.headTip);
    const out = changes.map((c) => {
      const headBytes = c.head ? loadObject(v, c.head)?.data ?? Buffer.alloc(0) : Buffer.alloc(0);
      const baseBytes = c.base ? loadObject(v, c.base)?.data ?? Buffer.alloc(0) : Buffer.alloc(0);
      const linesOf = (b: Buffer): number => (b.length === 0 ? 0 : b.toString('utf8').split('\n').length);
      const status = c.status === 'removed' ? 'removed' : c.status === 'added' ? 'added' : 'modified';
      const additions = c.status === 'removed' ? 0 : linesOf(headBytes);
      const deletions = c.status === 'added' ? 0 : linesOf(baseBytes);
      return {
        filename: c.path,
        status,
        additions,
        deletions,
        changes: additions + deletions,
      };
    });
    return json(200, out);
  }
  // PUT /pulls/{n}/merge — squash merge onto the base branch.
  if (method === 'PUT' && rest.length === 2 && rest[1] === 'merge') {
    if (pull.merged) return fail(405, 'pull request is already merged');
    if (pullConflict(v, repo, pull)) return fail(405, 'merge conflict');
    const baseTip = branchTip(v, repo, pull.baseRef);
    if (baseTip === undefined) return fail(404, 'base branch does not exist');
    const headFlat = flattenCommit(v, pull.headTip);
    const files = new Map<string, string>();
    for (const [path, file] of headFlat) files.set(path, file.blob);
    const tree = treeFromPaths(v, files);
    const message = `Merge pull request #${pull.number}: ${pull.title}`;
    const commit = authorCommit(v, tree, [baseTip], message);
    refsOf(v, repo.name).set(`refs/heads/${pull.baseRef}`, commit);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = FIXED_TIME;
    pull.mergeSha = commit;
    return json(200, { sha: commit, merged: true, message });
  }
  return fail(404, 'Not Found');
}
