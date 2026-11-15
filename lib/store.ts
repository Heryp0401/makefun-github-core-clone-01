// In-memory state for the forge: git objects and refs, repositories, issues and
// pull requests. Nothing here touches the disk on the request path, so the timed
// workloads (2,000 issue reads, 200 issue writes, 200 pushes, 50 clones) stay fast.
// All served timestamps are fixed: two runs of the suite must export identical
// bytes, so no wall-clock time ever enters a response.

import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export const ZERO_OID = '0000000000000000000000000000000000000000';
/** The one timestamp every created_at / merged_at / author date carries. */
export const FIXED_TIME = '2026-01-01T00:00:00Z';
const FIXED_EPOCH = 1704067200;

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

/** sha1("<type> <len>\0<data>"), the git object id. */
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

const OID_RE = /^[0-9a-f]{40}$/;
export function isOid(s: string): boolean {
  return OID_RE.test(s);
}

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  comments: Comment[];
  /** Serialised REST body for GET /issues/{n}; cleared whenever the issue changes. */
  jsonText: string | null;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  createdSeq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  labels: Label[];
  issues: Issue[];
  pulls: Pull[];
  nextIssue: number;
  nextPull: number;
  nextComment: number;
  createdSeq: number;
}

/** One file in a commit's tree: its blob id and bytes. */
export interface FileEntry {
  blobOid: string;
  content: Buffer;
}

export interface HandlerResult {
  status: number;
  /** JSON body, serialised by the server. Mutually exclusive with `text`/`raw`. */
  json?: unknown;
  /** Pre-serialised JSON body (hot-path cache hit). Mutually exclusive with `json`. */
  text?: string;
  /** Raw body bytes (git protocol, already framed). */
  raw?: Buffer;
  contentType?: string;
  headers?: Record<string, string>;
}

/** What a handler sees of one HTTP request. */
export interface Ctx {
  method: string;
  /** Decoded path segments, e.g. ['api', 'v3', 'repos', 'owner', 'name', 'issues']. */
  segments: string[];
  /** Raw query string without the leading '?', or ''. */
  queryStr: string;
  headers: IncomingHttpHeaders;
  /** Raw request body (null when none). */
  body: Buffer | null;
  /** Origin of the request (http://host), for absolute Link URLs. */
  origin: string;
}

/** Read one query parameter out of a raw query string, without building a URL. */
export function queryParam(queryStr: string, name: string): string | null {
  if (queryStr === '') return null;
  const needle = `${name}=`;
  let at = 0;
  for (;;) {
    const i = queryStr.indexOf(needle, at);
    if (i < 0) return null;
    if (i === 0 || queryStr[i - 1] === '&') {
      const end = queryStr.indexOf('&', i + needle.length);
      const raw = end < 0 ? queryStr.slice(i + needle.length) : queryStr.slice(i + needle.length, end);
      try {
        return decodeURIComponent(raw.replace(/\+/g, ' '));
      } catch {
        return raw;
      }
    }
    at = i + needle.length;
  }
}

export class Store {
  objects = new Map<string, GitObject>();
  /** repo name -> (ref name -> commit oid). Covers refs/heads/* and refs/tags/*. */
  refs = new Map<string, Map<string, string>>();
  repos = new Map<string, Repo>();
  /** Bumped whenever a repo's refs move; git response caches key on it. */
  repoRev = new Map<string, number>();
  /** The token owner's login, learned from the first owner segment in any request
   * path. The token itself is opaque, and the git checks (which run first) always
   * name the viewer, so this is set before GraphQL/MCP ever need it. */
  viewerLogin: string | null = null;
  nextRepoId = 5000;
  seq = 0;

  learnOwner(owner: string): void {
    if (this.viewerLogin === null) this.viewerLogin = owner;
  }

  /** True when `owner` is the token owner's login. A first-seen owner is learned. */
  isOwner(owner: string): boolean {
    if (this.viewerLogin === null) {
      this.viewerLogin = owner;
      for (const repo of this.repos.values()) repo.owner = owner;
      return true;
    }
    return owner === this.viewerLogin;
  }

  get viewer(): string {
    return this.viewerLogin ?? 'viewer';
  }

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  repoRefs(name: string): Map<string, string> {
    let m = this.refs.get(name);
    if (!m) {
      m = new Map();
      this.refs.set(name, m);
    }
    return m;
  }

  /** Note that a repo's refs changed (push, merge, contents write, ref create). */
  touchRepo(name: string): void {
    this.repoRev.set(name, (this.repoRev.get(name) ?? 0) + 1);
  }

  revOf(name: string): number {
    return this.repoRev.get(name) ?? 0;
  }

  /** Store an object, returning its id. */
  putObject(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  // ---- trees and commits ----------------------------------------------------

  /** Parse a tree object into [mode, name, oid] entries. */
  parseTree(data: Buffer): Array<{ mode: string; name: string; oid: string }> {
    const entries: Array<{ mode: string; name: string; oid: string }> = [];
    let pos = 0;
    while (pos < data.length) {
      const space = data.indexOf(0x20, pos);
      if (space < 0) break;
      const nul = data.indexOf(0x00, space + 1);
      if (nul < 0 || nul + 21 > data.length) break;
      entries.push({
        mode: data.subarray(pos, space).toString('ascii'),
        name: data.subarray(space + 1, nul).toString('utf8'),
        oid: data.subarray(nul + 1, nul + 21).toString('hex'),
      });
      pos = nul + 21;
    }
    return entries;
  }

  /** Build a tree object from entries (sorted in git order: dirs sort as name/). */
  buildTree(entries: Array<{ mode: string; name: string; oid: string }>): string {
    const sorted = [...entries].sort((a, b) => {
      const an = a.mode === '40000' ? `${a.name}/` : a.name;
      const bn = b.mode === '40000' ? `${b.name}/` : b.name;
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    const parts: Buffer[] = [];
    for (const e of sorted) {
      parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
      parts.push(Buffer.from(e.oid, 'hex'));
    }
    return this.putObject('tree', Buffer.concat(parts));
  }

  /** Build nested trees from a flat path -> blob-oid map; returns the root tree oid. */
  buildTreeFromFiles(files: Map<string, string>): string {
    const build = (dir: string): string => {
      const entries: Array<{ mode: string; name: string; oid: string }> = [];
      const subdirs = new Set<string>();
      for (const path of files.keys()) {
        if (!path.startsWith(dir)) continue;
        const rest = path.slice(dir.length);
        const slash = rest.indexOf('/');
        if (slash < 0) {
          entries.push({ mode: '100644', name: rest, oid: files.get(path)! });
        } else {
          subdirs.add(rest.slice(0, slash));
        }
      }
      for (const sub of subdirs) {
        entries.push({ mode: '40000', name: sub, oid: build(`${dir}${sub}/`) });
      }
      return this.buildTree(entries);
    };
    return build('');
  }

  /** Create a commit object; returns its oid. */
  makeCommit(treeOid: string, parents: string[], message: string): string {
    const lines: string[] = [`tree ${treeOid}`];
    for (const p of parents) lines.push(`parent ${p}`);
    lines.push(`author Forge <forge@example.invalid> ${FIXED_EPOCH} +0000`);
    lines.push(`committer Forge <forge@example.invalid> ${FIXED_EPOCH} +0000`);
    return this.putObject('commit', Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8'));
  }

  /** Parse a commit object: tree, parents, message. */
  parseCommit(data: Buffer): { tree: string; parents: string[]; message: string } {
    const text = data.toString('utf8');
    const blank = text.indexOf('\n\n');
    const head = blank < 0 ? text : text.slice(0, blank);
    const message = blank < 0 ? '' : text.slice(blank + 2);
    let tree = '';
    const parents: string[] = [];
    for (const line of head.split('\n')) {
      if (line.startsWith('tree ')) tree = line.slice(5).trim();
      else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    }
    return { tree, parents, message };
  }

  /** Parse an annotated tag object: the object it points at, and that object's type. */
  parseTag(data: Buffer): { object: string; type: string } {
    const text = data.toString('utf8');
    let object = '';
    let type = '';
    for (const line of text.split('\n')) {
      if (line === '') break;
      if (line.startsWith('object ')) object = line.slice(7).trim();
      else if (line.startsWith('type ')) type = line.slice(5).trim();
    }
    return { object, type };
  }

  /** The flat file map of a commit: path -> {blobOid, content}. */
  filesOfCommit(commitOid: string): Map<string, FileEntry> {
    const out = new Map<string, FileEntry>();
    const commit = this.getObject(commitOid);
    if (!commit || commit.type !== 'commit') return out;
    const { tree } = this.parseCommit(commit.data);
    const walk = (treeOid: string, prefix: string): void => {
      const treeObj = this.getObject(treeOid);
      if (!treeObj || treeObj.type !== 'tree') return;
      for (const e of this.parseTree(treeObj.data)) {
        if (e.mode === '40000') {
          walk(e.oid, `${prefix}${e.name}/`);
        } else {
          const blob = this.getObject(e.oid);
          if (blob) out.set(`${prefix}${e.name}`, { blobOid: e.oid, content: blob.data });
        }
      }
    };
    walk(tree, '');
    return out;
  }

  /** All commit oids reachable from `tips`, following parents. */
  reachableCommits(tips: string[]): Set<string> {
    const seen = new Set<string>();
    const stack = [...tips];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      const obj = this.getObject(oid);
      if (!obj || obj.type !== 'commit') continue;
      seen.add(oid);
      for (const p of this.parseCommit(obj.data).parents) stack.push(p);
    }
    return seen;
  }

  /** Whether `ancestor` is an ancestor of (or equal to) `descendant`. Walks from the
   * descendant and stops as soon as it finds the ancestor, so a fast-forward push
   * on a long linear history costs one step, not a full traversal. */
  isAncestor(descendant: string, ancestor: string): boolean {
    if (descendant === ancestor) return true;
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = this.getObject(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of this.parseCommit(obj.data).parents) stack.push(p);
    }
    return false;
  }

  /** All object oids in a commit's closure (commit + trees + blobs, recursive). */
  closureOfCommit(commitOid: string): Set<string> {
    const out = new Set<string>();
    const commit = this.getObject(commitOid);
    if (!commit) return out;
    out.add(commitOid);
    const { tree } = this.parseCommit(commit.data);
    const walkTree = (treeOid: string): void => {
      if (out.has(treeOid)) return;
      out.add(treeOid);
      const treeObj = this.getObject(treeOid);
      if (!treeObj || treeObj.type !== 'tree') return;
      for (const e of this.parseTree(treeObj.data)) {
        if (e.mode === '40000') walkTree(e.oid);
        else out.add(e.oid);
      }
    };
    walkTree(tree);
    return out;
  }

  /** Peel a tag (or any ref target) to the commit it ultimately points at. */
  peelToCommit(oid: string): string {
    let cur = oid;
    for (let i = 0; i < 10; i++) {
      const obj = this.getObject(cur);
      if (!obj) return cur;
      if (obj.type === 'commit') return cur;
      if (obj.type === 'tag') {
        cur = this.parseTag(obj.data).object;
        continue;
      }
      return cur;
    }
    return cur;
  }
}

// ---- merge helpers shared by REST, GraphQL and MCP ---------------------------

/** True when merging `pull` would conflict: a file the head changed (against the
 * merge-base, which is the base sha the PR was opened against) was also changed
 * on the base branch since then. */
export function mergeConflict(store: Store, repo: Repo, pull: Pull): boolean {
  const baseFiles = store.filesOfCommit(pull.baseSha);
  const headFiles = store.filesOfCommit(pull.headSha);
  const currentTip = store.repoRefs(repo.name).get(`refs/heads/${pull.baseRef}`);
  if (!currentTip) return false;
  const currentFiles = store.filesOfCommit(currentTip);
  const changed = new Set<string>();
  for (const [p, h] of headFiles) {
    const b = baseFiles.get(p);
    if (!b || b.blobOid !== h.blobOid) changed.add(p);
  }
  for (const p of baseFiles.keys()) if (!headFiles.has(p)) changed.add(p);
  for (const p of changed) {
    if ((baseFiles.get(p)?.blobOid ?? null) !== (currentFiles.get(p)?.blobOid ?? null)) return true;
  }
  return false;
}

/** Paths whose content differs between the PR's base and head, sorted. */
export function pullChangedPaths(store: Store, repo: Repo, pull: Pull): string[] {
  const baseFiles = store.filesOfCommit(pull.baseSha);
  const headFiles = store.filesOfCommit(pull.headSha);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  const out: string[] = [];
  for (const p of [...paths].sort()) {
    const b = baseFiles.get(p);
    const h = headFiles.get(p);
    if (!b || !h || b.blobOid !== h.blobOid) out.push(p);
  }
  return out;
}
