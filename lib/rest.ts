// REST v3 handlers (/api/v3). Every handler returns {status, body, headers}
// where body is a pre-built JSON string (or a Buffer) so the hot paths never
// re-serialize. 4xx bodies are {"message": string}.
import {
  Store,
  FIXED_TIME,
  refreshIssueJson,
  repoJson,
} from './store.ts';
import type { Repo, Pull } from './store.ts';

export interface RestResult {
  status: number;
  body: string | Buffer;
  headers?: Record<string, string>;
}

const NOT_FOUND = '{"message":"Not Found"}';
const UNAUTH = '{"message":"Requires authentication"}';

export function notFound(): RestResult {
  return { status: 404, body: NOT_FOUND };
}

function msg(status: number, message: string): RestResult {
  return { status, body: JSON.stringify({ message }) };
}

function json(status: number, value: unknown): RestResult {
  return { status, body: JSON.stringify(value) };
}

// Percent-decode one path segment (lenient: bad escapes stay as-is).
function decode(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

// Minimal query parsing: only the keys the checks use.
export function parseQuery(qs: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!qs) return out;
  for (const part of qs.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq === -1) out.set(decode(part), '');
    else out.set(decode(part.slice(0, eq)), decode(part.slice(eq + 1)));
  }
  return out;
}

function parseIntParam(q: Map<string, string>, name: string, fallback: number): number {
  const v = q.get(name);
  if (v === undefined || v === '') return fallback;
  const n = parseInt(v, 10);
  return Number.isNaN(n) || n < 1 ? fallback : n;
}

// Build a Link header for a paginated list. `base` is the path + the
// query string without the page parameter.
function linkHeader(host: string, base: string, page: number, perPage: number, total: number): string | null {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (lastPage <= 1) return null;
  const url = (p: number): string => 'http://' + host + base + (base.includes('?') ? '&' : '?') + 'page=' + p;
  const parts: string[] = [];
  if (page < lastPage) {
    parts.push('<' + url(page + 1) + '>; rel="next"');
    parts.push('<' + url(lastPage) + '>; rel="last"');
  } else {
    parts.push('<' + url(1) + '>; rel="first"');
    if (page > 1) parts.push('<' + url(page - 1) + '>; rel="prev"');
  }
  return parts.join(', ');
}

function pageOf<T>(items: T[], page: number, perPage: number): T[] {
  const start = (page - 1) * perPage;
  return items.slice(start, start + perPage);
}

// The viewer login owns every repo; any other owner is a 404, never a 403.
function resolveRepo(store: Store, owner: string, name: string): Repo | null {
  if (owner !== store.login) return null;
  return store.getRepo(name) ?? null;
}

function repoNotFound(): RestResult {
  return notFound();
}

// Parse a JSON request body. Returns {ok, value} or {ok:false} on bad JSON.
// An empty body is an empty object.
export function parseJsonBody(body: Buffer): { ok: boolean; value?: Record<string, unknown> } {
  if (body.length === 0) return { ok: true, value: {} };
  try {
    const v = JSON.parse(body.toString('utf8'));
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return { ok: true, value: {} };
    return { ok: true, value: v as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function bool(v: unknown): boolean {
  return v === true;
}

export function handleRest(
  store: Store,
  method: string,
  path: string,
  query: Map<string, string>,
  body: Buffer,
  host: string,
): RestResult {
  // path is the part after "/api/v3" ("" or "/..." ).
  const p = path === '' ? '/' : path;
  const segs = p.split('/').filter((s) => s !== '');
  // Root and meta.
  if (segs.length === 0) {
    if (method === 'GET') {
      return {
        status: 200,
        body: '{"current_user_url":"/api/v3/user","repository_url":"/api/v3/repos/{owner}/{repo}"}',
        headers: { 'X-OAuth-Scopes': 'repo, read:org' },
      };
    }
    return notFound();
  }
  if (segs.length === 1 && segs[0] === 'meta') {
    if (method === 'GET') return json(200, { installed_version: '1.0.0' });
    return notFound();
  }
  if (segs.length === 1 && segs[0] === 'user') {
    if (method === 'GET') {
      return json(200, {
        login: store.login,
        id: 1,
        type: 'User',
        avatar_url: '',
        html_url: 'https://github.com/' + store.login,
        url: '/api/v3/users/' + store.login,
      });
    }
    return notFound();
  }
  // /user/repos
  if (segs.length === 2 && segs[0] === 'user' && segs[1] === 'repos') {
    if (method === 'GET') {
      const perPage = parseIntParam(query, 'per_page', 30);
      const page = parseIntParam(query, 'page', 1);
      const all = [...store.repos.values()];
      const items = pageOf(all, page, perPage);
      const headers: Record<string, string> = {};
      const link = linkHeader(host, '/api/v3/user/repos?per_page=' + perPage, page, perPage, all.length);
      if (link) headers.Link = link;
      return { status: 200, body: '[' + items.map((r) => r.json).join(',') + ']', headers };
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) return msg(400, 'Invalid JSON');
      const v = parsed.value!;
      const name = str(v.name);
      if (!name) return msg(422, 'name is required');
      if (store.getRepo(name)) return msg(422, 'Repository already exists');
      const repo = store.createRepo(name, str(v.description), bool(v.private));
      if (!repo) return msg(422, 'Repository already exists');
      return { status: 201, body: repo.json };
    }
    return notFound();
  }
  // /repos/{owner}/{repo}[/...]
  if (segs[0] === 'repos' && segs.length >= 3) {
    const owner = decode(segs[1]);
    const repoName = decode(segs[2]);
    const repo = resolveRepo(store, owner, repoName);
    if (!repo) return repoNotFound();
    const tail = segs.slice(3);
    // /repos/{o}/{r}
    if (tail.length === 0) {
      if (method === 'GET') return { status: 200, body: repo.json };
      if (method === 'PATCH') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) return msg(400, 'Invalid JSON');
        const v = parsed.value!;
        if (typeof v.description === 'string') repo.description = v.description;
        repo.json = repoJson(store, repo);
        repo.rev++;
        return { status: 200, body: repo.json };
      }
      if (method === 'DELETE') {
        store.deleteRepo(repoName);
        return { status: 204, body: '' };
      }
      return notFound();
    }
    const sub = tail[0];
    // branches
    if (sub === 'branches') {
      if (tail.length === 1 && method === 'GET') {
        const list = [...repo.refs.keys()]
          .filter((n) => n.startsWith('refs/heads/'))
          .sort()
          .map((n) => ({ name: n.slice(11), commit: { sha: repo.refs.get(n) }, protected: false }));
        return json(200, list);
      }
      if (tail.length === 2 && method === 'GET') {
        const sha = repo.refs.get('refs/heads/' + decode(tail[1]));
        if (!sha) return notFound();
        return json(200, { name: decode(tail[1]), commit: { sha }, protected: false });
      }
      return notFound();
    }
    // commits
    if (sub === 'commits' && tail.length === 1 && method === 'GET') {
      const shaParam = query.get('sha');
      const tip = shaParam
        ? repo.refs.get('refs/heads/' + shaParam) ?? repo.refs.get(shaParam) ?? null
        : repo.refs.get('refs/heads/' + repo.defaultBranch) ?? null;
      const list = store.listCommitsFrom(tip).map((c) => ({
        sha: c.sha,
        commit: {
          message: c.message,
          author: { name: store.login, email: 'adaiversen@users.noreply.github.com', date: FIXED_TIME },
          committer: { name: store.login, email: 'adaiversen@users.noreply.github.com', date: FIXED_TIME },
        },
      }));
      return json(200, list);
    }
    // git/refs
    if (sub === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) return msg(400, 'Invalid JSON');
        const v = parsed.value!;
        const ref = str(v.ref);
        const sha = str(v.sha);
        if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) return msg(422, 'Invalid ref or sha');
        const existing = repo.refs.get(ref);
        if (existing) return json(201, { ref, object: { sha: existing } });
        repo.refs.set(ref, sha);
        repo.rev++;
        return json(201, { ref, object: { sha } });
      }
      if (method === 'GET' && tail.length >= 3) {
        const ref = 'refs/' + tail.slice(2).map(decode).join('/');
        const sha = repo.refs.get(ref);
        if (!sha) return notFound();
        return json(200, { ref, object: { sha } });
      }
      return notFound();
    }
    // contents
    if (sub === 'contents') {
      const contentPath = tail.slice(1).map(decode).join('/');
      if (method === 'GET') {
        const ref = query.get('ref');
        const got = store.getContents(repo, contentPath, ref);
        if (got === null) return notFound();
        return json(200, got);
      }
      if (method === 'PUT') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) return msg(400, 'Invalid JSON');
        const v = parsed.value!;
        const contentB64 = str(v.content);
        let content: Buffer;
        try {
          content = Buffer.from(contentB64, 'base64');
        } catch {
          return msg(422, 'Invalid base64 content');
        }
        const res = store.putContents(
          repo,
          contentPath,
          content,
          str(v.message),
          typeof v.branch === 'string' ? v.branch : undefined,
          typeof v.sha === 'string' ? v.sha : undefined,
        );
        if (res.error === 'stale') return msg(409, 'sha does not match the current blob');
        return json(res.created ? 201 : 200, {
          content: { name: contentPath.split('/').pop(), path: contentPath, sha: res.contentSha, size: content.length, encoding: 'base64' },
          commit: { sha: res.commitSha, message: str(v.message) },
        });
      }
      if (method === 'DELETE') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) return msg(400, 'Invalid JSON');
        const v = parsed.value!;
        const res = store.deleteContents(
          repo,
          contentPath,
          str(v.message),
          typeof v.branch === 'string' ? v.branch : undefined,
          typeof v.sha === 'string' ? v.sha : undefined,
        );
        if (res.error === 'not-found') return notFound();
        if (res.error === 'stale') return msg(409, 'sha does not match the current blob');
        return json(200, { commit: { sha: res.commitSha } });
      }
      return notFound();
    }
    // labels
    if (sub === 'labels' && tail.length === 1 && method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) return msg(400, 'Invalid JSON');
      const v = parsed.value!;
      const name = str(v.name);
      if (!name) return msg(422, 'name is required');
      const label = store.createLabel(repo, name, str(v.color));
      return json(201, { name: label.name, color: label.color, description: '' });
    }
    // issues
    if (sub === 'issues') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          const perPage = parseIntParam(query, 'per_page', 30);
          const page = parseIntParam(query, 'page', 1);
          let list = [...repo.issues];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          if (sort === 'created') {
            list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          }
          const total = list.length;
          const items = pageOf(list, page, perPage);
          const headers: Record<string, string> = {};
          const link = linkHeader(
            host,
            '/api/v3/repos/' + owner + '/' + repoName + '/issues?state=' + state + '&per_page=' + perPage,
            page,
            perPage,
            total,
          );
          if (link) headers.Link = link;
          return { status: 200, body: '[' + items.map((i) => i.json).join(',') + ']', headers };
        }
        if (method === 'POST') {
          const parsed = parseJsonBody(body);
          if (!parsed.ok) return msg(400, 'Invalid JSON');
          const v = parsed.value!;
          const labels = Array.isArray(v.labels) ? v.labels.filter((x): x is string => typeof x === 'string') : [];
          const res = store.createIssue(repo, str(v.title), str(v.body), labels);
          if (res.badLabel) return msg(422, 'Unknown label: ' + res.badLabel);
          return { status: 201, body: res.issue!.json };
        }
        return notFound();
      }
      const num = parseInt(tail[1], 10);
      if (Number.isNaN(num)) return notFound();
      const issue = store.getIssue(repo, num);
      if (tail.length === 2) {
        if (!issue) return notFound();
        if (method === 'GET') return { status: 200, body: issue.json };
        if (method === 'PATCH') {
          const parsed = parseJsonBody(body);
          if (!parsed.ok) return msg(400, 'Invalid JSON');
          const v = parsed.value!;
          if (v.state === 'closed' || v.state === 'open') issue.state = v.state;
          if (typeof v.title === 'string') issue.title = v.title;
          if (typeof v.body === 'string') issue.body = v.body;
          refreshIssueJson(store, repo, issue);
          repo.rev++;
          return { status: 200, body: issue.json };
        }
        return notFound();
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (!issue) return notFound();
        if (method === 'GET') {
          const list = repo.comments.get(num) ?? [];
          return json(200, list.map((c) => ({ id: c.id, body: c.body, user: { login: store.login }, created_at: FIXED_TIME })));
        }
        if (method === 'POST') {
          const parsed = parseJsonBody(body);
          if (!parsed.ok) return msg(400, 'Invalid JSON');
          const rec = store.createComment(repo, num, str(parsed.value!.body));
          if (!rec) return notFound();
          return json(201, { id: rec.id, body: rec.body, user: { login: store.login }, created_at: FIXED_TIME });
        }
        return notFound();
      }
      return notFound();
    }
    // pulls
    if (sub === 'pulls') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const perPage = parseIntParam(query, 'per_page', 30);
          const page = parseIntParam(query, 'page', 1);
          let list = [...repo.pulls];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          const total = list.length;
          const items = pageOf(list, page, perPage);
          const headers: Record<string, string> = {};
          const link = linkHeader(
            host,
            '/api/v3/repos/' + owner + '/' + repoName + '/pulls?state=' + state + '&per_page=' + perPage,
            page,
            perPage,
            total,
          );
          if (link) headers.Link = link;
          return { status: 200, body: '[' + items.map((p) => pullJson(store, repo, p)).join(',') + ']', headers };
        }
        if (method === 'POST') {
          const parsed = parseJsonBody(body);
          if (!parsed.ok) return msg(400, 'Invalid JSON');
          const v = parsed.value!;
          const res = store.createPull(repo, str(v.head), str(v.base), str(v.title), str(v.body));
          if (res.error) return msg(422, 'Head or base branch not found');
          return json(201, pullObject(store, repo, res.pull!));
        }
        return notFound();
      }
      const num = parseInt(tail[1], 10);
      if (Number.isNaN(num)) return notFound();
      const pull = store.getPull(repo, num);
      if (tail.length === 2) {
        if (!pull) return notFound();
        if (method === 'GET') return json(200, pullObject(store, repo, pull));
        return notFound();
      }
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        if (!pull) return notFound();
        return json(200, store.pullFiles(repo, pull));
      }
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        if (!pull) return notFound();
        const parsed = parseJsonBody(body);
        if (!parsed.ok) return msg(400, 'Invalid JSON');
        const res = store.mergePull(repo, num);
        if (res.error === 'not-found') return notFound();
        if (res.error === 'already-merged') return msg(405, 'Pull request already merged');
        if (res.error === 'conflict') return msg(405, 'Merge conflict');
        return json(200, { sha: res.sha, merged: true, message: 'Pull request successfully merged' });
      }
      return notFound();
    }
  }
  return notFound();
}

function pullObject(store: Store, repo: Repo, pull: Pull): unknown {
  // Head/base shas track the live ref tips (GitHub updates them as the
  // branches move); the stored shas are the creation-time fallback.
  const headSha = repo.refs.get('refs/heads/' + pull.headRef) ?? pull.headSha;
  const baseSha = repo.refs.get('refs/heads/' + pull.baseRef) ?? pull.baseSha;
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: headSha, label: store.login + ':' + pull.headRef },
    base: { ref: pull.baseRef, sha: baseSha, label: store.login + ':' + pull.baseRef },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeSha,
    user: { login: store.login },
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
  };
}

function pullJson(store: Store, repo: Repo, pull: Pull): string {
  return JSON.stringify(pullObject(store, repo, pull));
}

export { UNAUTH };
