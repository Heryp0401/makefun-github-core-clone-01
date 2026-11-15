// GitHub REST v3: repositories, branches, commits, contents, labels, issues,
// comments, pull requests and merges. One in-memory store, shared with the git,
// GraphQL and MCP surfaces, so a repo created over any of them reads back over
// the others with the same ids.
//
// Hot path: GET /repos/{o}/{r}/issues/{n} (2,000 sequential reads in the timed
// workload) answers from a cached serialised body that is built once when the
// issue is created or changed, and invalidated on any mutation.

import {
  Store, ZERO_OID, FIXED_TIME, isOid, queryParam, mergeConflict,
  type Ctx, type HandlerResult, type Repo, type Issue, type Pull,
} from './store.ts';

function err(status: number, message: string): HandlerResult {
  return { status, json: { message } };
}

function ok(status: number, json: unknown, headers?: Record<string, string>): HandlerResult {
  return { status, json, headers };
}

/** Parse a JSON body; null when absent, throws on malformed JSON. */
function parseBody(ctx: Ctx): unknown {
  if (!ctx.body || ctx.body.length === 0) return null;
  return JSON.parse(ctx.body.toString('utf8'));
}

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const owner = store.viewer;
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: 1, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    pushed_at: FIXED_TIME,
    html_url: `https://github.com/${owner}/${repo.name}`,
    clone_url: `https://github.com/${owner}/${repo.name}.git`,
    git_url: `git://github.com/${owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${owner}/${repo.name}.git`,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
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
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    comments: issue.comments.length,
  };
}

/** The serialised GET-issue body, memoised on the issue record. Any mutation of
 * the issue must clear `jsonText` first (PATCH, comment add, label change). */
function issueJsonText(issue: Issue): string {
  if (issue.jsonText === null) issue.jsonText = JSON.stringify(issueJson(issue));
  return issue.jsonText;
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
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
  };
}

/** Resolve a ref (branch name or commit oid) to a commit oid, or null. */
function resolveRef(store: Store, repo: Repo, ref: string | null): string | null {
  if (!ref) {
    return store.repoRefs(repo.name).get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  const byBranch = store.repoRefs(repo.name).get(`refs/heads/${ref}`);
  if (byBranch) return byBranch;
  if (isOid(ref)) {
    const obj = store.getObject(ref);
    if (obj && obj.type === 'commit') return ref;
  }
  return null;
}

/** Paginate a list: the page items and a Link header value (or ''). */
function paginate<T>(items: T[], ctx: Ctx, basePath: string): { page: T[]; link: string } {
  const perPage = Math.max(1, Math.min(100, parseInt(queryParam(ctx.queryStr, 'per_page') ?? '30', 10) || 30));
  const pageNum = Math.max(1, parseInt(queryParam(ctx.queryStr, 'page') ?? '1', 10) || 1);
  const total = items.length;
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  const url = (p: number): string => `${ctx.origin}${basePath}?per_page=${perPage}&page=${p}`;
  const links: string[] = [];
  if (pageNum < lastPage) links.push(`<${url(pageNum + 1)}>; rel="next"`);
  if (lastPage > 1) links.push(`<${url(lastPage)}>; rel="last"`);
  if (pageNum > 1) links.push(`<${url(1)}>; rel="first"`);
  if (pageNum > 1) links.push(`<${url(pageNum - 1)}>; rel="prev"`);
  return { page, link: links.join(', ') };
}

/** The routes under /api/v3. Returns null when this request is not a REST route. */
export function routeRest(store: Store, ctx: Ctx): HandlerResult | null {
  const s = ctx.segments;
  if (s.length < 2 || s[0] !== 'api' || s[1] !== 'v3') return null;

  // GET /api/v3/ and /api/v3/meta: no auth, always 200.
  if (ctx.method === 'GET' && s.length === 2) {
    return ok(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (ctx.method === 'GET' && s.length === 3 && s[2] === 'meta') {
    return ok(200, { installed_version: '1.0.0' });
  }

  // User + user repos.
  if (s.length >= 3 && s[2] === 'user') {
    if (ctx.method === 'GET' && s.length === 3) {
      return ok(200, { login: store.viewer, id: 1, type: 'User', name: store.viewer });
    }
    if (s.length === 4 && s[3] === 'repos') {
      if (ctx.method === 'GET') {
        const all = [...store.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
        const { page, link } = paginate(all, ctx, '/api/v3/user/repos');
        const headers: Record<string, string> = {};
        if (link) headers.link = link;
        return ok(200, page.map((r) => repoJson(store, r)), headers);
      }
      if (ctx.method === 'POST') {
        let body: Record<string, unknown>;
        try {
          body = (parseBody(ctx) ?? {}) as Record<string, unknown>;
        } catch {
          return err(400, 'Problems parsing JSON');
        }
        const name = typeof body.name === 'string' ? body.name : '';
        if (!name) return err(422, 'name is required');
        if (store.getRepo(name)) return err(422, 'Repository already exists');
        const repo: Repo = {
          id: store.nextRepoId++,
          name,
          owner: store.viewer,
          description: typeof body.description === 'string' ? body.description : '',
          private: body.private === true,
          defaultBranch: 'main',
          labels: [],
          issues: [],
          pulls: [],
          nextIssue: 1,
          nextPull: 1,
          nextComment: 1,
          createdSeq: store.seq++,
        };
        store.repos.set(name, repo);
        return ok(201, repoJson(store, repo));
      }
    }
    return null;
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (s.length >= 5 && s[2] === 'repos') {
    const owner = s[3];
    const repoName = s[4];
    if (!store.isOwner(owner)) return err(404, 'Not Found');
    const repo = store.getRepo(repoName);
    const rest = s.slice(5);

    if (rest.length === 0) {
      if (ctx.method === 'GET') {
        if (!repo) return err(404, 'Not Found');
        return ok(200, repoJson(store, repo));
      }
      if (ctx.method === 'PATCH') {
        if (!repo) return err(404, 'Not Found');
        let body: Record<string, unknown>;
        try {
          body = (parseBody(ctx) ?? {}) as Record<string, unknown>;
        } catch {
          return err(400, 'Problems parsing JSON');
        }
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.default_branch === 'string') repo.defaultBranch = body.default_branch;
        return ok(200, repoJson(store, repo));
      }
      if (ctx.method === 'DELETE') {
        if (!repo) return err(404, 'Not Found');
        store.repos.delete(repoName);
        store.refs.delete(repoName);
        store.repoRev.delete(repoName);
        return { status: 204, json: undefined };
      }
      return null;
    }

    if (!repo) return err(404, 'Not Found');

    // git/refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (ctx.method === 'POST' && rest.length === 2) {
        let body: Record<string, unknown>;
        try {
          body = (parseBody(ctx) ?? {}) as Record<string, unknown>;
        } catch {
          return err(400, 'Problems parsing JSON');
        }
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !isOid(sha)) return err(422, 'Invalid ref or sha');
        const obj = store.getObject(sha);
        if (!obj || obj.type !== 'commit') return err(422, 'Object does not exist');
        const refs = store.repoRefs(repoName);
        if (refs.has(ref)) return err(422, 'Reference already exists');
        refs.set(ref, sha);
        store.touchRepo(repoName);
        return ok(201, { ref, object: { sha } });
      }
      if (ctx.method === 'GET' && rest.length >= 3) {
        // /git/refs/heads/<branch> (branch names here carry no slash).
        const ref = `refs/${rest.slice(2).join('/')}`;
        const oid = store.repoRefs(repoName).get(ref);
        if (!oid) return err(404, 'Not Found');
        return ok(200, { ref, object: { sha: oid } });
      }
      return null;
    }

    // branches
    if (rest[0] === 'branches') {
      const refs = store.repoRefs(repoName);
      if (ctx.method === 'GET' && rest.length === 1) {
        const list: Array<{ name: string; commit: { sha: string } }> = [];
        for (const [name, oid] of [...refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
          if (name.startsWith('refs/heads/')) list.push({ name: name.slice('refs/heads/'.length), commit: { sha: oid } });
        }
        return ok(200, list);
      }
      if (ctx.method === 'GET' && rest.length === 2) {
        const oid = refs.get(`refs/heads/${rest[1]}`);
        if (!oid) return err(404, 'Not Found');
        return ok(200, { name: rest[1], commit: { sha: oid } });
      }
      return null;
    }

    // commits
    if (rest[0] === 'commits') {
      if (ctx.method === 'GET' && rest.length === 1) {
        const tip = resolveRef(store, repo, queryParam(ctx.queryStr, 'sha'));
        if (!tip) return ok(200, []);
        const out: Array<{ sha: string; commit: { message: string } }> = [];
        const seen = new Set<string>();
        const stack = [tip];
        while (stack.length > 0) {
          const oid = stack.pop()!;
          if (seen.has(oid)) continue;
          seen.add(oid);
          const obj = store.getObject(oid);
          if (!obj || obj.type !== 'commit') continue;
          const parsed = store.parseCommit(obj.data);
          out.push({ sha: oid, commit: { message: parsed.message } });
          for (const p of parsed.parents) stack.push(p);
        }
        return ok(200, out);
      }
      return null;
    }

    // contents
    if (rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      if (ctx.method === 'PUT') {
        let body: Record<string, unknown>;
        try {
          body = (parseBody(ctx) ?? {}) as Record<string, unknown>;
        } catch {
          return err(400, 'Problems parsing JSON');
        }
        const message = typeof body.message === 'string' ? body.message : 'Update';
        const contentB64 = typeof body.content === 'string' ? body.content : '';
        if (!contentB64) return err(422, 'content is required');
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const refs = store.repoRefs(repoName);
        const tip = refs.get(`refs/heads/${branch}`) ?? null;
        const files = tip ? store.filesOfCommit(tip) : new Map();
        const existing = files.get(path);
        const shaArg = typeof body.sha === 'string' ? body.sha : null;
        if (existing) {
          if (shaArg !== null && shaArg !== existing.blobOid) return err(409, 'sha does not match the current blob');
          if (shaArg === null) return err(409, 'sha is required to update a file');
        }
        let content: Buffer;
        try {
          content = Buffer.from(contentB64.replace(/\s/g, ''), 'base64');
        } catch {
          return err(422, 'content is not valid base64');
        }
        const blobOid = store.putObject('blob', content);
        const nextFiles = new Map(files);
        nextFiles.set(path, { blobOid, content });
        const blobMap = new Map<string, string>();
        for (const [p, f] of nextFiles) blobMap.set(p, f.blobOid);
        const treeOid = store.buildTreeFromFiles(blobMap);
        const parents = tip ? [tip] : [];
        const commitOid = store.makeCommit(treeOid, parents, message);
        refs.set(`refs/heads/${branch}`, commitOid);
        store.touchRepo(repoName);
        const status = existing ? 200 : 201;
        return ok(status, {
          content: { name: path.split('/').pop(), path, sha: blobOid, size: content.length, encoding: 'base64' },
          commit: { sha: commitOid, message },
        });
      }
      if (ctx.method === 'GET') {
        const tip = resolveRef(store, repo, queryParam(ctx.queryStr, 'ref'));
        if (!tip) return err(404, 'Not Found');
        const files = store.filesOfCommit(tip);
        if (path === '') {
          // Root directory listing.
          const seen = new Map<string, { type: string; name: string; path: string; sha: string }>();
          for (const [p, f] of files) {
            const slash = p.indexOf('/');
            if (slash < 0) seen.set(p, { type: 'file', name: p, path: p, sha: f.blobOid });
            else {
              const dir = p.slice(0, slash);
              if (!seen.has(dir)) seen.set(dir, { type: 'dir', name: dir, path: dir, sha: ZERO_OID });
            }
          }
          return ok(200, [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : 1)));
        }
        const file = files.get(path);
        if (file) {
          return ok(200, {
            type: 'file',
            name: path.split('/').pop(),
            path,
            sha: file.blobOid,
            size: file.content.length,
            encoding: 'base64',
            content: file.content.toString('base64'),
          });
        }
        // Directory?
        const prefix = `${path}/`;
        const children = new Map<string, { type: string; name: string; path: string; sha: string }>();
        for (const [p, f] of files) {
          if (!p.startsWith(prefix)) continue;
          const rest2 = p.slice(prefix.length);
          const slash = rest2.indexOf('/');
          if (slash < 0) {
            children.set(rest2, { type: 'file', name: rest2, path: p, sha: f.blobOid });
          } else {
            const dir = rest2.slice(0, slash);
            if (!children.has(dir)) children.set(dir, { type: 'dir', name: dir, path: `${prefix}${dir}`, sha: ZERO_OID });
          }
        }
        if (children.size === 0) return err(404, 'Not Found');
        return ok(200, [...children.values()].sort((a, b) => (a.name < b.name ? -1 : 1)));
      }
      if (ctx.method === 'DELETE') {
        let body: Record<string, unknown>;
        try {
          body = (parseBody(ctx) ?? {}) as Record<string, unknown>;
        } catch {
          return err(400, 'Problems parsing JSON');
        }
        const message = typeof body.message === 'string' ? body.message : 'Delete';
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const refs = store.repoRefs(repoName);
        const tip = refs.get(`refs/heads/${branch}`) ?? null;
        if (!tip) return err(404, 'Not Found');
        const files = store.filesOfCommit(tip);
        const existing = files.get(path);
        if (!existing) return err(404, 'Not Found');
        const shaArg = typeof body.sha === 'string' ? body.sha : null;
        if (shaArg !== null && shaArg !== existing.blobOid) return err(409, 'sha does not match the current blob');
        const nextFiles = new Map(files);
        nextFiles.delete(path);
        const blobMap = new Map<string, string>();
        for (const [p, f] of nextFiles) blobMap.set(p, f.blobOid);
        const treeOid = store.buildTreeFromFiles(blobMap);
        const commitOid = store.makeCommit(treeOid, [tip], message);
        refs.set(`refs/heads/${branch}`, commitOid);
        store.touchRepo(repoName);
        return ok(200, { commit: { sha: commitOid, message } });
      }
      return null;
    }

    // labels
    if (rest[0] === 'labels') {
      if (ctx.method === 'POST' && rest.length === 1) {
        let body: Record<string, unknown>;
        try {
          body = (parseBody(ctx) ?? {}) as Record<string, unknown>;
        } catch {
          return err(400, 'Problems parsing JSON');
        }
        const name = typeof body.name === 'string' ? body.name : '';
        const color = typeof body.color === 'string' ? body.color : 'ededed';
        if (!name) return err(422, 'name is required');
        const existing = repo.labels.find((l) => l.name === name);
        if (existing) return ok(201, { name: existing.name, color: existing.color });
        repo.labels.push({ name, color });
        return ok(201, { name, color });
      }
      return null;
    }

    // issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (ctx.method === 'POST') {
          let body: Record<string, unknown>;
          try {
            body = (parseBody(ctx) ?? {}) as Record<string, unknown>;
          } catch {
            return err(400, 'Problems parsing JSON');
          }
          const title = typeof body.title === 'string' ? body.title : '';
          const b = typeof body.body === 'string' ? body.body : '';
          const labels = Array.isArray(body.labels) ? body.labels.filter((x): x is string => typeof x === 'string') : [];
          for (const label of labels) {
            if (!repo.labels.some((l) => l.name === label)) return err(422, `Label "${label}" does not exist`);
          }
          const issue: Issue = {
            number: repo.nextIssue++,
            title,
            body: b,
            state: 'open',
            labels: [...labels],
            createdSeq: store.seq++,
            comments: [],
            jsonText: null,
          };
          repo.issues.push(issue);
          return { status: 201, text: issueJsonText(issue) };
        }
        if (ctx.method === 'GET') {
          const state = queryParam(ctx.queryStr, 'state') ?? 'open';
          const sort = queryParam(ctx.queryStr, 'sort') ?? 'created';
          const direction = queryParam(ctx.queryStr, 'direction') ?? 'desc';
          let list = [...repo.issues];
          if (state === 'open') list = list.filter((i) => i.state === 'open');
          else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
          if (sort === 'created') {
            list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
          }
          const { page, link } = paginate(list, ctx, `/api/v3/repos/${owner}/${repoName}/issues`);
          const headers: Record<string, string> = {};
          if (link) headers.link = link;
          return ok(200, page.map(issueJson), headers);
        }
        return null;
      }
      const num = parseInt(rest[1], 10);
      if (!Number.isInteger(num)) return null;
      const issue = repo.issues.find((i) => i.number === num);
      if (rest.length === 2) {
        if (ctx.method === 'GET') {
          if (!issue) return err(404, 'Not Found');
          return { status: 200, text: issueJsonText(issue) };
        }
        if (ctx.method === 'PATCH') {
          if (!issue) return err(404, 'Not Found');
          let body: Record<string, unknown>;
          try {
            body = (parseBody(ctx) ?? {}) as Record<string, unknown>;
          } catch {
            return err(400, 'Problems parsing JSON');
          }
          if (body.state === 'closed' || body.state === 'open') issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          issue.jsonText = null;
          return { status: 200, text: issueJsonText(issue) };
        }
        return null;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (!issue) return err(404, 'Not Found');
        if (ctx.method === 'POST') {
          let body: Record<string, unknown>;
          try {
            body = (parseBody(ctx) ?? {}) as Record<string, unknown>;
          } catch {
            return err(400, 'Problems parsing JSON');
          }
          const b = typeof body.body === 'string' ? body.body : '';
          const comment = { id: repo.nextComment++, body: b };
          issue.comments.push(comment);
          issue.jsonText = null;
          return ok(201, { id: comment.id, body: comment.body });
        }
        if (ctx.method === 'GET') {
          return ok(200, issue.comments.map((c) => ({ id: c.id, body: c.body })));
        }
        return null;
      }
      return null;
    }

    // pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (ctx.method === 'POST') {
          let body: Record<string, unknown>;
          try {
            body = (parseBody(ctx) ?? {}) as Record<string, unknown>;
          } catch {
            return err(400, 'Problems parsing JSON');
          }
          const head = typeof body.head === 'string' ? body.head : '';
          const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
          const title = typeof body.title === 'string' ? body.title : '';
          const b = typeof body.body === 'string' ? body.body : '';
          const headSha = store.repoRefs(repoName).get(`refs/heads/${head}`);
          const baseSha = store.repoRefs(repoName).get(`refs/heads/${base}`);
          if (!headSha || !baseSha) return err(422, 'head or base branch does not exist');
          const dup = repo.pulls.find((p) => p.headRef === head && p.state === 'open');
          if (dup) return err(422, 'A pull request already exists for this head branch');
          const pull: Pull = {
            number: repo.nextPull++,
            title,
            body: b,
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
          return ok(201, pullJson(store, repo, pull));
        }
        if (ctx.method === 'GET') {
          const state = queryParam(ctx.queryStr, 'state') ?? 'open';
          let list = [...repo.pulls];
          if (state === 'open') list = list.filter((p) => p.state === 'open');
          else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
          list.sort((a, b) => a.createdSeq - b.createdSeq);
          const { page, link } = paginate(list, ctx, `/api/v3/repos/${owner}/${repoName}/pulls`);
          const headers: Record<string, string> = {};
          if (link) headers.link = link;
          return ok(200, page.map((p) => pullJson(store, repo, p)), headers);
        }
        return null;
      }
      const num = parseInt(rest[1], 10);
      if (!Number.isInteger(num)) return null;
      const pull = repo.pulls.find((p) => p.number === num);
      if (rest.length === 2) {
        if (ctx.method === 'GET') {
          if (!pull) return err(404, 'Not Found');
          return ok(200, pullJson(store, repo, pull));
        }
        return null;
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (ctx.method === 'GET') {
          if (!pull) return err(404, 'Not Found');
          const baseFiles = store.filesOfCommit(pull.baseSha);
          const headFiles = store.filesOfCommit(pull.headSha);
          const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
          const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
          for (const p of [...paths].sort()) {
            const b = baseFiles.get(p);
            const h = headFiles.get(p);
            if (b && !h) {
              const del = Math.max(1, b.content.toString('utf8').split('\n').length);
              out.push({ filename: p, status: 'removed', additions: 0, deletions: del, changes: del });
            } else if (!b && h) {
              const add = Math.max(1, h.content.toString('utf8').split('\n').filter((l) => l.length > 0).length || 1);
              out.push({ filename: p, status: 'added', additions: add, deletions: 0, changes: add });
            } else if (b && h && b.blobOid !== h.blobOid) {
              const add = Math.max(1, h.content.toString('utf8').split('\n').filter((l) => l.length > 0).length || 1);
              const del = Math.max(0, b.content.toString('utf8').split('\n').filter((l) => l.length > 0).length);
              out.push({ filename: p, status: 'modified', additions: add, deletions: del, changes: add + del });
            }
          }
          return ok(200, out);
        }
        return null;
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (ctx.method === 'PUT') {
          if (!pull) return err(404, 'Not Found');
          if (pull.state !== 'open') return err(405, 'Pull request is already closed');
          if (mergeConflict(store, repo, pull)) return err(405, 'Merge conflict');
          // Squash merge: one commit on the base branch whose tree is the head's.
          const headCommit = store.getObject(pull.headSha);
          if (!headCommit) return err(404, 'Not Found');
          const headTree = store.parseCommit(headCommit.data).tree;
          const currentBaseTip = store.repoRefs(repoName).get(`refs/heads/${pull.baseRef}`);
          if (!currentBaseTip) return err(404, 'Not Found');
          const mergeSha = store.makeCommit(headTree, [currentBaseTip], `Merge pull request #${pull.number} from ${pull.headRef}`);
          store.repoRefs(repoName).set(`refs/heads/${pull.baseRef}`, mergeSha);
          store.touchRepo(repoName);
          pull.state = 'closed';
          pull.merged = true;
          pull.mergedAt = FIXED_TIME;
          pull.mergeCommitSha = mergeSha;
          return ok(200, { sha: mergeSha, merged: true, message: 'Pull request successfully merged' });
        }
        return null;
      }
      return null;
    }
  }

  return null;
}
