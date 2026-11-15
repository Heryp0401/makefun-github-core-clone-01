// In-memory store for the forge: repositories, issues, pull requests and the
// git object database. Everything is deterministic: fixed timestamps, a fixed
// author identity, no wall clock and no Math.random in any served data.
import { createHash } from 'node:crypto';

export const FIXED_TIME = '2026-01-01T00:00:00Z';
export const FIXED_EPOCH = 1767225600; // 2026-01-01T00:00:00Z
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_EMAIL = 'adaiversen@users.noreply.github.com';
export const ZERO_SHA = '0000000000000000000000000000000000000000';
export const DEFAULT_BRANCH = 'main';

export function sha1Hex(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

// SHA-1 of a git object: sha1("<type> <len>\0" + payload).
export function gitObjectSha(type: string, data: Buffer): string {
  const head = Buffer.from(type + ' ' + data.length + '\0', 'ascii');
  return sha1Hex(Buffer.concat([head, data]));
}

// Adler-32 checksum (the trailing checksum of a zlib deflate stream).
export function adler32(buf: Buffer): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export interface CommitMeta {
  tree: string;
  parents: string[];
  message: string;
}

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  gid: string;
  json: string;
}

export interface CommentRec {
  id: number;
  body: string;
  gid: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  seq: number;
  gid: string;
}

export interface Repo {
  id: number;
  name: string;
  gid: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  head: string;
  issues: Issue[];
  issueSeq: number;
  pulls: Pull[];
  pullSeq: number;
  labels: Map<string, Label>;
  comments: Map<number, CommentRec[]>;
  commentSeq: number;
  rev: number;
  json: string;
  treeCache: Map<string, Map<string, string>>;
}

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

// Parse a raw commit object into its tree, parents and message.
export function parseCommit(data: Buffer): CommitMeta {
  const text = data.toString('utf8');
  const meta: CommitMeta = { tree: '', parents: [], message: '' };
  const headEnd = text.indexOf('\n\n');
  const head = headEnd === -1 ? text : text.slice(0, headEnd);
  meta.message = headEnd === -1 ? '' : text.slice(headEnd + 2).replace(/\n$/, '');
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) meta.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) meta.parents.push(line.slice(7).trim());
  }
  return meta;
}

// Parse a raw tree object into [{mode, name, sha}].
export function parseTree(data: Buffer): { mode: string; name: string; sha: string }[] {
  const out: { mode: string; name: string; sha: string }[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp === -1) break;
    const nul = data.indexOf(0, sp);
    if (nul === -1 || nul + 21 > data.length) break;
    out.push({
      mode: data.toString('ascii', i, sp),
      name: data.toString('utf8', sp + 1, nul),
      sha: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    i = nul + 21;
  }
  return out;
}

// Parse a raw tag object; returns the sha of the object it points at.
export function parseTagTarget(data: Buffer): string {
  const text = data.toString('utf8');
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) return line.slice(7).trim();
    if (line === '') break;
  }
  return '';
}

// Count lines of a buffer (a trailing newline does not create an extra line).
export function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
  return buf[buf.length - 1] === 0x0a ? n : n + 1;
}

// Multiset line difference: how many lines of `next` are not in `prev`
// (additions) and how many lines of `prev` are not in `next` (deletions).
export function lineDiff(prev: Buffer, next: Buffer): { additions: number; deletions: number } {
  const prevLines = prev.length === 0 ? [] : prev.toString('utf8').split('\n');
  const nextLines = next.length === 0 ? [] : next.toString('utf8').split('\n');
  if (prevLines.length > 0 && prevLines[prevLines.length - 1] === '') prevLines.pop();
  if (nextLines.length > 0 && nextLines[nextLines.length - 1] === '') nextLines.pop();
  const counts = new Map<string, number>();
  for (const l of prevLines) counts.set(l, (counts.get(l) ?? 0) + 1);
  let additions = 0;
  for (const l of nextLines) {
    const c = counts.get(l) ?? 0;
    if (c > 0) counts.set(l, c - 1);
    else additions++;
  }
  let deletions = 0;
  for (const c of counts.values()) deletions += c;
  return { additions, deletions };
}

export class Store {
  login = VIEWER_LOGIN;
  repos = new Map<string, Repo>();
  objects = new Map<string, GitObject>();
  globalIds = new Map<string, { kind: string; repo: string; number: number }>();
  packs = new Map<string, { pack: Buffer; shallow: string[]; included: string[] }>();
  nextRepoId = 1;
  nextIssueId = 1;
  nextPullId = 1;
  nextCommentId = 1;
  seq = 0;

  // ---- git objects -------------------------------------------------------

  putObject(type: ObjType, data: Buffer): string {
    const sha = gitObjectSha(type, data);
    if (!this.objects.has(sha)) this.objects.set(sha, { type, data });
    if (type === 'commit') {
      if (!this.sharedCommitMeta.has(sha)) this.sharedCommitMeta.set(sha, parseCommit(data));
    } else if (type === 'tag') {
      const target = parseTagTarget(data);
      if (target) this.sharedTagTarget.set(sha, target);
    }
    return sha;
  }

  sharedCommitMeta = new Map<string, CommitMeta>();
  sharedTagTarget = new Map<string, string>();

  getObject(sha: string): GitObject | undefined {
    return this.objects.get(sha);
  }

  commitMetaOf(sha: string): CommitMeta | undefined {
    return this.sharedCommitMeta.get(sha);
  }

  tagTargetOf(sha: string): string | undefined {
    return this.sharedTagTarget.get(sha);
  }

  // Build the nested tree objects for a flat path -> blob map; returns the
  // root tree sha. Empty map -> the empty tree.
  buildTree(pathMap: Map<string, string>): string {
    // Group paths by their first segment.
    const build = (paths: [string, string][]): string => {
      const files: { name: string; sha: string }[] = [];
      const dirs = new Map<string, [string, string][]>();
      for (const [p, sha] of paths) {
        const slash = p.indexOf('/');
        if (slash === -1) files.push({ name: p, sha });
        else {
          const dir = p.slice(0, slash);
          const rest = p.slice(slash + 1);
          let list = dirs.get(dir);
          if (!list) {
            list = [];
            dirs.set(dir, list);
          }
          list.push([rest, sha]);
        }
      }
      // Git sorts tree entries by name, directories as if suffixed with '/'.
      const entries: { mode: string; name: string; sha: string }[] = [];
      for (const f of files) entries.push({ mode: '100644', name: f.name, sha: f.sha });
      for (const [dir, list] of dirs) {
        entries.push({ mode: '40000', name: dir, sha: build(list) });
      }
      entries.sort((a, b) => {
        const an = a.mode === '40000' ? a.name + '/' : a.name;
        const bn = b.mode === '40000' ? b.name + '/' : b.name;
        return an < bn ? -1 : an > bn ? 1 : 0;
      });
      const parts: Buffer[] = [];
      for (const e of entries) {
        parts.push(Buffer.from(e.mode + ' ' + e.name + '\0', 'utf8'));
        parts.push(Buffer.from(e.sha, 'hex'));
      }
      return this.putObject('tree', Buffer.concat(parts));
    };
    return build([...pathMap.entries()]);
  }

  // Flatten a tree object into a path -> blob sha map (recursive).
  flattenTree(treeSha: string, prefix = '', out = new Map<string, string>()): Map<string, string> {
    const obj = this.objects.get(treeSha);
    if (!obj || obj.type !== 'tree') return out;
    for (const e of parseTree(obj.data)) {
      const path = prefix ? prefix + '/' + e.name : e.name;
      if (e.mode === '40000') this.flattenTree(e.sha, path, out);
      else out.set(path, e.sha);
    }
    return out;
  }

  // Flattened tree for a commit (cached per repo).
  treeMapOf(repo: Repo, commitSha: string): Map<string, string> {
    let m = repo.treeCache.get(commitSha);
    if (m) return m;
    const meta = this.commitMetaOf(commitSha);
    m = meta ? this.flattenTree(meta.tree) : new Map<string, string>();
    repo.treeCache.set(commitSha, m);
    return m;
  }

  // Create a commit object on top of `parentSha` (or none) with the given
  // flat tree; returns the commit sha. Deterministic author/committer/time.
  createCommit(repo: Repo, message: string, treeMap: Map<string, string>, parentSha: string | null): string {
    const treeSha = this.buildTree(treeMap);
    let text = 'tree ' + treeSha + '\n';
    if (parentSha) text += 'parent ' + parentSha + '\n';
    text +=
      'author ' + this.login + ' <' + VIEWER_EMAIL + '> ' + FIXED_EPOCH + ' +0000\n' +
      'committer ' + this.login + ' <' + VIEWER_EMAIL + '> ' + FIXED_EPOCH + ' +0000\n' +
      '\n' + message + '\n';
    const sha = this.putObject('commit', Buffer.from(text, 'utf8'));
    this.seq++;
    return sha;
  }

  // Is `anc` an ancestor of `desc` (or equal)? Walks all parents.
  isAncestor(anc: string, desc: string): boolean {
    if (anc === desc) return true;
    const seen = new Set<string>();
    const stack = [desc];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === anc) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const meta = this.commitMetaOf(cur);
      if (meta) for (const p of meta.parents) stack.push(p);
    }
    return false;
  }

  // Nearest common ancestor of two commits (first-parent walk of `a` into a
  // set, then walk `b`). Falls back to null when there is none.
  mergeBase(a: string, b: string): string | null {
    const ancestors = new Set<string>();
    let cur: string | null = a;
    while (cur) {
      ancestors.add(cur);
      const meta = this.commitMetaOf(cur);
      cur = meta && meta.parents.length > 0 ? meta.parents[0] : null;
    }
    cur = b;
    while (cur) {
      if (ancestors.has(cur)) return cur;
      const meta = this.commitMetaOf(cur);
      cur = meta && meta.parents.length > 0 ? meta.parents[0] : null;
    }
    return null;
  }

  // Commits reachable from `tip`, newest first (first-parent walk).
  listCommitsFrom(tip: string | null): { sha: string; message: string }[] {
    const out: { sha: string; message: string }[] = [];
    let cur = tip;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const meta = this.commitMetaOf(cur);
      if (!meta) break;
      out.push({ sha: cur, message: meta.message });
      cur = meta.parents.length > 0 ? meta.parents[0] : null;
    }
    return out;
  }

  // ---- global ids (GraphQL, opaque + stable) ------------------------------

  makeGlobalId(kind: string, repo: string, number: number): string {
    const prefix = kind === 'repo' ? 'R_' : kind === 'issue' ? 'I_' : kind === 'pull' ? 'P_' : 'C_';
    const gid = prefix + sha1Hex(kind + ':' + repo + ':' + number).slice(0, 20);
    this.globalIds.set(gid, { kind, repo, number });
    return gid;
  }

  resolveGlobalId(gid: string): { kind: string; repo: string; number: number } | undefined {
    return this.globalIds.get(gid);
  }

  // ---- repositories -------------------------------------------------------

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(name)) return null;
    const id = this.nextRepoId++;
    const repo: Repo = {
      id,
      name,
      gid: '',
      description: description ?? '',
      isPrivate: !!isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      refs: new Map<string, string>(),
      head: 'refs/heads/' + DEFAULT_BRANCH,
      issues: [],
      issueSeq: 1,
      pulls: [],
      pullSeq: 1,
      labels: new Map<string, Label>(),
      comments: new Map<number, CommentRec[]>(),
      commentSeq: 1,
      rev: 1,
      json: '',
      treeCache: new Map<string, Map<string, string>>(),
    };
    repo.json = repoJson(this, repo);
    this.repos.set(name, repo);
    repo.gid = this.makeGlobalId('repo', name, id);
    return repo;
  }

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  // ---- issues / labels / comments ------------------------------------------

  createLabel(repo: Repo, name: string, color: string): Label {
    let label = repo.labels.get(name);
    if (!label) {
      label = { name, color: color || 'ededed' };
      repo.labels.set(name, label);
      repo.rev++;
    }
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): { issue?: Issue; badLabel?: string } {
    for (const name of labelNames) {
      if (!repo.labels.has(name)) return { badLabel: name };
    }
    const number = repo.issueSeq++;
    this.seq++;
    const id = this.nextIssueId++;
    const gid = this.makeGlobalId('issue', repo.name, number);
    const issue: Issue = {
      id,
      number,
      title: title ?? '',
      body: body ?? '',
      state: 'open',
      labels: [...labelNames],
      seq: this.seq,
      gid,
      json: '',
    };
    issue.json = issueJson(this, repo, issue);
    repo.issues.push(issue);
    repo.rev++;
    return { issue };
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    // Issues are appended in number order (numbers are sequential from 1),
    // so the number indexes the array directly.
    const issue = repo.issues[number - 1];
    return issue && issue.number === number ? issue : undefined;
  }

  createComment(repo: Repo, issueNumber: number, body: string): CommentRec | null {
    const issue = this.getIssue(repo, issueNumber);
    if (!issue) return null;
    const id = this.nextCommentId++;
    const rec: CommentRec = { id, body: body ?? '', gid: this.makeGlobalId('comment', repo.name, id) };
    let list = repo.comments.get(issueNumber);
    if (!list) {
      list = [];
      repo.comments.set(issueNumber, list);
    }
    list.push(rec);
    repo.rev++;
    return rec;
  }

  // ---- pull requests ---------------------------------------------------------

  createPull(repo: Repo, headRef: string, baseRef: string, title: string, body: string): { pull?: Pull; error?: string } {
    const headSha = repo.refs.get('refs/heads/' + headRef);
    if (!headSha) return { error: 'head-not-found' };
    const baseSha = repo.refs.get('refs/heads/' + baseRef);
    if (!baseSha) return { error: 'base-not-found' };
    const number = repo.pullSeq++;
    this.seq++;
    const id = this.nextPullId++;
    const pull: Pull = {
      id,
      number,
      title: title ?? '',
      body: body ?? '',
      state: 'open',
      headRef,
      baseRef,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeSha: null,
      seq: this.seq,
      gid: this.makeGlobalId('pull', repo.name, number),
    };
    repo.pulls.push(pull);
    repo.rev++;
    return { pull };
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    // Pulls are appended in number order (numbers are sequential from 1),
    // so the number indexes the array directly.
    const pull = repo.pulls[number - 1];
    return pull && pull.number === number ? pull : undefined;
  }

  // Files changed between the merge base of head/base and the head tip.
  pullFiles(repo: Repo, pull: Pull): FileChange[] {
    const headSha = repo.refs.get('refs/heads/' + pull.headRef) ?? pull.headSha;
    const baseSha = repo.refs.get('refs/heads/' + pull.baseRef) ?? pull.baseSha;
    const base = this.mergeBase(headSha, baseSha) ?? baseSha;
    return this.diffFiles(repo, base, headSha);
  }

  // Diff two commits' flattened trees.
  diffFiles(repo: Repo, baseSha: string, headSha: string): FileChange[] {
    const baseMap = this.treeMapOf(repo, baseSha);
    const headMap = this.treeMapOf(repo, headSha);
    const out: FileChange[] = [];
    const paths = new Set<string>([...baseMap.keys(), ...headMap.keys()]);
    for (const path of paths) {
      const b = baseMap.get(path);
      const h = headMap.get(path);
      if (b === h) continue;
      if (b === undefined && h !== undefined) {
        const blob = this.objects.get(h);
        const lines = blob ? countLines(blob.data) : 0;
        out.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
      } else if (b !== undefined && h === undefined) {
        const blob = this.objects.get(b);
        const lines = blob ? countLines(blob.data) : 0;
        out.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
      } else if (b !== undefined && h !== undefined) {
        const prev = this.objects.get(b)?.data ?? Buffer.alloc(0);
        const next = this.objects.get(h)?.data ?? Buffer.alloc(0);
        const d = lineDiff(prev, next);
        out.push({ filename: path, status: 'modified', additions: d.additions, deletions: d.deletions, changes: d.additions + d.deletions });
      }
    }
    out.sort((x, y) => (x.filename < y.filename ? -1 : 1));
    return out;
  }

  // True when the base branch moved a file the PR also touches, differently.
  pullConflicted(repo: Repo, pull: Pull): boolean {
    const headSha = repo.refs.get('refs/heads/' + pull.headRef) ?? pull.headSha;
    const baseSha = repo.refs.get('refs/heads/' + pull.baseRef) ?? pull.baseSha;
    const base = this.mergeBase(headSha, baseSha);
    if (!base) return false;
    const baseMap = this.treeMapOf(repo, base);
    const headMap = this.treeMapOf(repo, headSha);
    const currentMap = this.treeMapOf(repo, baseSha);
    const paths = new Set<string>([...baseMap.keys(), ...headMap.keys()]);
    for (const path of paths) {
      const atBase = baseMap.get(path);
      const atHead = headMap.get(path);
      if (atBase === atHead) continue;
      const atCurrent = currentMap.get(path);
      if (atCurrent !== atBase && atCurrent !== atHead) return true;
    }
    return false;
  }

  mergePull(repo: Repo, number: number): { sha?: string; error?: string } {
    const pull = this.getPull(repo, number);
    if (!pull) return { error: 'not-found' };
    if (pull.merged || pull.state === 'closed') return { error: 'already-merged' };
    if (this.pullConflicted(repo, pull)) return { error: 'conflict' };
    const baseSha = repo.refs.get('refs/heads/' + pull.baseRef);
    const headSha = repo.refs.get('refs/heads/' + pull.headRef);
    if (!baseSha || !headSha) return { error: 'not-found' };
    // Squash-merge: base tree with the PR's changed files applied.
    const base = this.mergeBase(headSha, baseSha) ?? baseSha;
    const baseMap = this.treeMapOf(repo, base);
    const headMap = this.treeMapOf(repo, headSha);
    const newMap = new Map<string, string>(this.treeMapOf(repo, baseSha));
    for (const path of new Set<string>([...baseMap.keys(), ...headMap.keys()])) {
      const atBase = baseMap.get(path);
      const atHead = headMap.get(path);
      if (atBase === atHead) continue;
      if (atHead === undefined) newMap.delete(path);
      else newMap.set(path, atHead);
    }
    const message = 'Merge pull request #' + number + ' from ' + pull.headRef;
    const mergeSha = this.createCommit(repo, message, newMap, baseSha);
    repo.refs.set('refs/heads/' + pull.baseRef, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = FIXED_TIME;
    pull.mergeSha = mergeSha;
    pull.baseSha = mergeSha;
    repo.rev++;
    return { sha: mergeSha };
  }

  // ---- contents --------------------------------------------------------------

  // Write a file on a branch (creating the branch from the default tip when
  // it does not exist yet). Returns the blob sha and commit sha.
  putContents(
    repo: Repo,
    path: string,
    content: Buffer,
    message: string,
    branch: string | undefined,
    sha: string | undefined,
  ): { contentSha?: string; commitSha?: string; created?: boolean; error?: string } {
    const branchName = branch || repo.defaultBranch;
    let tip = repo.refs.get('refs/heads/' + branchName);
    if (!tip) {
      // Branch does not exist: start it from the default branch tip.
      tip = repo.refs.get('refs/heads/' + repo.defaultBranch) ?? null;
      if (!tip && branchName !== repo.defaultBranch) {
        // Unborn repo: the new branch starts empty.
        tip = null;
      }
    }
    const treeMap = tip ? new Map<string, string>(this.treeMapOf(repo, tip)) : new Map<string, string>();
    const current = treeMap.get(path);
    if (current !== undefined) {
      if (sha !== undefined && sha !== current) return { error: 'stale' };
    }
    const created = current === undefined;
    const blobSha = this.putObject('blob', content);
    treeMap.set(path, blobSha);
    const commitSha = this.createCommit(repo, message || 'Update ' + path, treeMap, tip);
    repo.refs.set('refs/heads/' + branchName, commitSha);
    repo.rev++;
    return { contentSha: blobSha, commitSha, created };
  }

  deleteContents(
    repo: Repo,
    path: string,
    message: string,
    branch: string | undefined,
    sha: string | undefined,
  ): { commitSha?: string; error?: string } {
    const branchName = branch || repo.defaultBranch;
    const tip = repo.refs.get('refs/heads/' + branchName);
    if (!tip) return { error: 'not-found' };
    const treeMap = new Map<string, string>(this.treeMapOf(repo, tip));
    const current = treeMap.get(path);
    if (current === undefined) return { error: 'not-found' };
    if (sha !== undefined && sha !== current) return { error: 'stale' };
    treeMap.delete(path);
    const commitSha = this.createCommit(repo, message || 'Delete ' + path, treeMap, tip);
    repo.refs.set('refs/heads/' + branchName, commitSha);
    repo.rev++;
    return { commitSha };
  }

  // Directory listing for the entries directly under `prefix` ('' = root).
  dirEntries(treeMap: Map<string, string>, prefix: string): { type: string; name: string; path: string; sha: string; size: number }[] {
    const files = new Map<string, string>();
    const dirs = new Set<string>();
    for (const [p, sha] of treeMap) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (rest === '') continue;
      const slash = rest.indexOf('/');
      if (slash === -1) files.set(rest, sha);
      else dirs.add(rest.slice(0, slash));
    }
    const out: { type: string; name: string; path: string; sha: string; size: number }[] = [];
    for (const [name, sha] of files) {
      const blob = this.objects.get(sha);
      out.push({ type: 'file', name, path: prefix + name, sha, size: blob ? blob.data.length : 0 });
    }
    for (const name of dirs) {
      // Real subtree sha: build the tree for the paths under this directory.
      const sub = new Map<string, string>();
      const dirPrefix = prefix + name + '/';
      for (const [p, sha] of treeMap) {
        if (p.startsWith(dirPrefix)) sub.set(p.slice(dirPrefix.length), sha);
      }
      out.push({ type: 'dir', name, path: prefix + name, sha: this.buildTree(sub), size: 0 });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : 1));
    return out;
  }

  // Read a file or a directory listing at a ref (default: default branch).
  getContents(repo: Repo, path: string, ref: string | undefined): unknown {
    const branchName = ref || repo.defaultBranch;
    const tip = repo.refs.get('refs/heads/' + branchName) ?? repo.refs.get(ref ?? '');
    if (!tip) return null;
    const treeMap = this.treeMapOf(repo, tip);
    if (path === '' || path === '/') {
      return this.dirEntries(treeMap, '');
    }
    const blobSha = treeMap.get(path);
    if (blobSha !== undefined) {
      const blob = this.objects.get(blobSha);
      const data = blob ? blob.data : Buffer.alloc(0);
      return {
        type: 'file',
        encoding: 'base64',
        content: data.toString('base64'),
        sha: blobSha,
        size: data.length,
        name: path.split('/').pop(),
        path,
      };
    }
    // Directory?
    const prefix = path.endsWith('/') ? path : path + '/';
    let isDir = false;
    for (const p of treeMap.keys()) {
      if (p.startsWith(prefix)) {
        isDir = true;
        break;
      }
    }
    if (!isDir) return null;
    return this.dirEntries(treeMap, prefix);
  }
}

// Cached JSON for a repository object (rebuilt when the repo changes).
export function repoJson(store: Store, repo: Repo): string {
  return JSON.stringify({
    id: repo.id,
    name: repo.name,
    full_name: store.login + '/' + repo.name,
    owner: { login: store.login, id: 1, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    html_url: 'https://github.com/' + store.login + '/' + repo.name,
    url: '/repos/' + store.login + '/' + repo.name,
  });
}

// Cached JSON for an issue object.
export function issueJson(store: Store, repo: Repo, issue: Issue): string {
  return JSON.stringify({
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((n) => {
      const l = repo.labels.get(n);
      return { name: n, color: l ? l.color : 'ededed' };
    }),
    user: { login: store.login },
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    html_url: 'https://github.com/' + store.login + '/' + repo.name + '/issues/' + issue.number,
    url: '/repos/' + store.login + '/' + repo.name + '/issues/' + issue.number,
  });
}

// Refresh an issue's cached JSON after a state change.
export function refreshIssueJson(store: Store, repo: Repo, issue: Issue): void {
  issue.json = issueJson(store, repo, issue);
}
