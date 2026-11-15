// In-memory vault for the forge: git objects, refs, repositories, issues, pulls.
// Nothing touches disk on the request path, so the timed workloads (thousands of
// issue reads/writes, hundreds of pushes, dozens of clones) stay fast. Every
// timestamp the vault emits is fixed, so two runs leave byte-identical state.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0000000000000000000000000000000000000000';
/** The single instant every created_at / merged_at / author date reports. */
export const FIXED_EPOCH = 1704067200;
export const FIXED_TIME = '2026-01-01T00:00:00Z';
/** The identity stamped on commits the forge itself authors (contents API, merges). */
const FORGE_AUTHOR = 'Forge <forge@forge.invalid>';

/** A git object id: sha1("<type> <len>\0<data>"). */
export function oidOf(type: ObjKind, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

export type ObjKind = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjKind;
  data: Buffer;
}

export interface TreeItem {
  mode: string;
  name: string;
  oid: string;
}

export interface LabelRec {
  name: string;
  color: string;
}

export interface CommentRec {
  id: number;
  body: string;
}

export interface IssueRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  order: number;
  comments: CommentRec[];
}

export interface PullRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  headRef: string;
  baseRef: string;
  headTip: string;
  baseTip: string;
  order: number;
}

export interface RepoRec {
  id: number;
  name: string;
  owner: string;
  about: string;
  isPrivate: boolean;
  branch: string;
  labels: Map<string, LabelRec>;
  issues: IssueRec[];
  pulls: PullRec[];
  nextIssue: number;
  nextPull: number;
  nextComment: number;
  order: number;
}

/** One file of a commit's flattened tree: the blob id and its bytes. */
export interface FlatFile {
  blob: string;
  bytes: Buffer;
}

export interface Vault {
  objects: Map<string, GitObject>;
  /** repo name -> (ref name -> commit oid); covers refs/heads/* and refs/tags/*. */
  refTable: Map<string, Map<string, string>>;
  catalog: Map<string, RepoRec>;
  /** The token owner's login, learned from the first owner segment any request names.
   * The token itself is opaque; the git checks (which run first) always name the
   * viewer, so this is set before GraphQL or MCP ever need it. */
  ownerLogin: string | null;
  nextRepoId: number;
  clock: number;
}

export function makeStore(): Vault {
  return {
    objects: new Map(),
    refTable: new Map(),
    catalog: new Map(),
    ownerLogin: null,
    nextRepoId: 5000,
    clock: 0,
  };
}

/** The viewer login as the world sees it (a placeholder until the first owner is seen). */
export function viewerName(v: Vault): string {
  return v.ownerLogin ?? 'viewer';
}

/** Learn the owner from a request path segment; repos made before learning are re-owned. */
export function claimOwner(v: Vault, owner: string): void {
  if (v.ownerLogin !== null) return;
  v.ownerLogin = owner;
  for (const repo of v.catalog.values()) repo.owner = owner;
}

/** True when `owner` is the token owner's login; a first-seen owner is learned. */
export function ownerMatches(v: Vault, owner: string): boolean {
  if (v.ownerLogin === null) {
    claimOwner(v, owner);
    return true;
  }
  return owner === v.ownerLogin;
}

export function repoByName(v: Vault, name: string): RepoRec | undefined {
  return v.catalog.get(name);
}

export function refsOf(v: Vault, name: string): Map<string, string> {
  let table = v.refTable.get(name);
  if (!table) {
    table = new Map();
    v.refTable.set(name, table);
  }
  return table;
}

/** The tip commit of a branch, or undefined when the branch does not exist. */
export function branchTip(v: Vault, repo: RepoRec, branch: string): string | undefined {
  return refsOf(v, repo.name).get(`refs/heads/${branch}`);
}

/** Store an object, returning its id (idempotent: an existing id is a no-op). */
export function saveObject(v: Vault, type: ObjKind, data: Buffer): string {
  const oid = oidOf(type, data);
  if (!v.objects.has(oid)) v.objects.set(oid, { type, data });
  return oid;
}

export function loadObject(v: Vault, oid: string): GitObject | undefined {
  return v.objects.get(oid);
}

// ---- trees ------------------------------------------------------------------

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function treeKey(item: TreeItem): string {
  return item.mode === '40000' ? `${item.name}/` : item.name;
}

export function decodeTree(data: Buffer): TreeItem[] {
  const items: TreeItem[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const nul = space < 0 ? -1 : data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    items.push({
      mode: data.subarray(at, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    at = nul + 21;
  }
  return items;
}

export function encodeTree(v: Vault, items: TreeItem[]): string {
  const sorted = [...items].sort((a, b) => (treeKey(a) < treeKey(b) ? -1 : treeKey(a) > treeKey(b) ? 1 : 0));
  const chunks: Buffer[] = [];
  for (const item of sorted) {
    chunks.push(Buffer.from(`${item.mode} ${item.name}\0`, 'utf8'));
    chunks.push(Buffer.from(item.oid, 'hex'));
  }
  return saveObject(v, 'tree', Buffer.concat(chunks));
}

/** Build nested trees from a flat path -> blob-oid map; returns the root tree oid. */
export function treeFromPaths(v: Vault, files: Map<string, string>): string {
  const build = (dir: string): string => {
    const items: TreeItem[] = [];
    const subdirs = new Set<string>();
    for (const path of files.keys()) {
      if (!path.startsWith(dir)) continue;
      const rest = path.slice(dir.length);
      const slash = rest.indexOf('/');
      if (slash < 0) items.push({ mode: '100644', name: rest, oid: files.get(path)! });
      else subdirs.add(rest.slice(0, slash));
    }
    for (const sub of subdirs) items.push({ mode: '40000', name: sub, oid: build(`${dir}${sub}/`) });
    return encodeTree(v, items);
  };
  return build('');
}

/** The flat file map of a commit: path -> blob id + bytes. */
export function flattenCommit(v: Vault, commitOid: string): Map<string, FlatFile> {
  const out = new Map<string, FlatFile>();
  const commit = loadObject(v, commitOid);
  if (!commit || commit.type !== 'commit') return out;
  const { tree } = readCommit(commit.data);
  const walk = (treeOid: string, prefix: string): void => {
    const treeObj = loadObject(v, treeOid);
    if (!treeObj || treeObj.type !== 'tree') return;
    for (const item of decodeTree(treeObj.data)) {
      if (item.mode === '40000') walk(item.oid, `${prefix}${item.name}/`);
      else {
        const blob = loadObject(v, item.oid);
        if (blob) out.set(`${prefix}${item.name}`, { blob: item.oid, bytes: blob.data });
      }
    }
  };
  walk(tree, '');
  return out;
}

/** Look one path up in a commit's tree; null when the path is absent or a directory. */
export function fileAtPath(v: Vault, commitOid: string, path: string): FlatFile | null {
  const flat = flattenCommit(v, commitOid);
  return flat.get(path) ?? null;
}

/** List one directory of a commit's tree: files and subdirectories directly under it. */
export function dirAtPath(
  v: Vault,
  commitOid: string,
  dir: string,
): Array<{ name: string; path: string; oid: string; kind: 'file' | 'dir' }> {
  const flat = flattenCommit(v, commitOid);
  const prefix = dir === '' ? '' : `${dir}/`;
  const seen = new Map<string, { name: string; path: string; oid: string; kind: 'file' | 'dir' }>();
  for (const [path, file] of flat) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      seen.set(rest, { name: rest, path, oid: file.blob, kind: 'file' });
    } else {
      const name = rest.slice(0, slash);
      if (!seen.has(name)) {
        // The directory's tree oid: resolve it from the commit's tree walk.
        seen.set(name, { name, path: `${prefix}${name}`, oid: '', kind: 'dir' });
      }
    }
  }
  // Fill directory oids by walking the tree objects directly.
  const commit = loadObject(v, commitOid);
  if (commit && commit.type === 'commit') {
    const { tree } = readCommit(commit.data);
    const fill = (treeOid: string, cur: string): void => {
      const treeObj = loadObject(v, treeOid);
      if (!treeObj || treeObj.type !== 'tree') return;
      for (const item of decodeTree(treeObj.data)) {
        if (item.mode !== '40000') continue;
        const full = cur === '' ? item.name : `${cur}/${item.name}`;
        const entry = seen.get(item.name);
        if (cur === dir && entry && entry.kind === 'dir') entry.oid = item.oid;
        if (cur === '' && dir === '' && entry && entry.kind === 'dir') entry.oid = item.oid;
        void full;
      }
    };
    fill(tree, '');
    // For a nested dir, walk down to it first.
    if (dir !== '') {
      let cur = tree;
      let ok = true;
      for (const part of dir.split('/')) {
        const obj = loadObject(v, cur);
        if (!obj || obj.type !== 'tree') {
          ok = false;
          break;
        }
        const next = decodeTree(obj.data).find((e) => e.name === part && e.mode === '40000');
        if (!next) {
          ok = false;
          break;
        }
        cur = next.oid;
      }
      if (ok) fill(cur, dir);
    }
  }
  return [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}

// ---- commits and tags -------------------------------------------------------

/** Author a commit object; returns its oid. Parents are listed in order. */
export function authorCommit(v: Vault, treeOid: string, parents: string[], message: string): string {
  const lines: string[] = [`tree ${treeOid}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${FORGE_AUTHOR} ${FIXED_EPOCH} +0000`);
  lines.push(`committer ${FORGE_AUTHOR} ${FIXED_EPOCH} +0000`);
  const body = `${lines.join('\n')}\n\n${message}`;
  return saveObject(v, 'commit', Buffer.from(body, 'utf8'));
}

/** Parse a commit object: tree, parents, message. */
export function readCommit(data: Buffer): { tree: string; parents: string[]; message: string } {
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

/** Parse an annotated tag object: the object it points at and its type. */
export function readTag(data: Buffer): { object: string; type: string } {
  const text = data.toString('utf8');
  let object = '';
  let type = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line === '') break;
  }
  return { object, type };
}

/** Follow tag objects until a commit (or a non-tag object); at most 10 hops. */
export function peelToCommit(v: Vault, oid: string): string {
  let cur = oid;
  for (let hop = 0; hop < 10; hop += 1) {
    const obj = loadObject(v, cur);
    if (!obj) return cur;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') {
      cur = readTag(obj.data).object;
      continue;
    }
    return cur;
  }
  return cur;
}

// ---- reachability -----------------------------------------------------------

/** All commit oids reachable from `tips` by following parents. */
export function ancestorCommits(v: Vault, tips: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = loadObject(v, oid);
    if (!obj || obj.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of readCommit(obj.data).parents) stack.push(parent);
  }
  return seen;
}

/** Whether `maybeAncestor` is an ancestor of (or equal to) `tip`. */
export function isAncestorOf(v: Vault, tip: string, maybeAncestor: string): boolean {
  if (tip === maybeAncestor) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop()!;
    if (oid === maybeAncestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = loadObject(v, oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of readCommit(obj.data).parents) stack.push(parent);
  }
  return false;
}

/** All object oids in a commit's closure (the commit, its trees and blobs, recursive). */
export function closureOf(v: Vault, commitOid: string): Set<string> {
  const out = new Set<string>();
  const commit = loadObject(v, commitOid);
  if (!commit) return out;
  out.add(commitOid);
  const { tree } = readCommit(commit.data);
  const walkTree = (treeOid: string): void => {
    if (out.has(treeOid)) return;
    out.add(treeOid);
    const treeObj = loadObject(v, treeOid);
    if (!treeObj || treeObj.type !== 'tree') return;
    for (const item of decodeTree(treeObj.data)) {
      if (item.mode === '40000') walkTree(item.oid);
      else out.add(item.oid);
    }
  };
  walkTree(tree);
  return out;
}

/**
 * The objects a fetch must deliver for `wants`, with an optional depth cap.
 * Returns the object map plus the shallow boundary (commits whose parents were cut)
 * and the previously-shallow commits that are now fully included (unshallow).
 * `held` lists the commits the client already has (its `have` lines); without a depth
 * cap the whole closure of each held commit is excluded, with a cap only the held
 * commit's own tree is excluded (a shallow clone never held the parents).
 */
export function fetchPlan(
  v: Vault,
  wants: string[],
  held: string[],
  shallowNow: string[],
  depth: number | null,
): { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[] } {
  // Generation of every reachable commit: the want is generation 0, its parents 1, ...
  // A want may be an annotated tag: the tag object itself is delivered, and the
  // generation walk starts at the commit it peels to.
  const generation = new Map<string, number>();
  const extraIncluded = new Set<string>();
  const queue: Array<[string, number]> = [];
  for (const want of wants) {
    let cur = want;
    for (let hop = 0; hop < 10; hop += 1) {
      const obj = loadObject(v, cur);
      if (!obj || obj.type !== 'tag') break;
      extraIncluded.add(cur);
      cur = readTag(obj.data).object;
    }
    queue.push([cur, 0]);
  }
  const commits = new Set<string>();
  while (queue.length) {
    const [oid, gen] = queue.shift()!;
    if (generation.has(oid)) continue;
    const obj = loadObject(v, oid);
    if (!obj || obj.type !== 'commit') continue;
    generation.set(oid, gen);
    commits.add(oid);
    if (depth !== null && gen >= depth - 1) continue;
    for (const parent of readCommit(obj.data).parents) queue.push([parent, gen + 1]);
  }
  // With a depth cap, only generations below the cap are included.
  const included = new Set<string>();
  for (const [oid, gen] of generation) {
    if (depth === null || gen < depth) included.add(oid);
  }
  const shallow: string[] = [];
  if (depth !== null) {
    for (const oid of included) {
      if (generation.get(oid) === depth - 1) shallow.push(oid);
    }
  }
  const unshallow: string[] = [];
  for (const old of shallowNow) {
    if (included.has(old)) unshallow.push(old);
  }
  // Objects the client already holds. A held tag means the client already has
  // the tag and its target's closure.
  const excluded = new Set<string>();
  for (const hold of held) {
    let cur = hold;
    for (let hop = 0; hop < 10; hop += 1) {
      const obj = loadObject(v, cur);
      if (!obj || obj.type !== 'tag') break;
      excluded.add(cur);
      cur = readTag(obj.data).object;
    }
    if (depth === null) {
      for (const oid of closureOf(v, cur)) excluded.add(oid);
      for (const oid of ancestorCommits(v, [cur])) {
        for (const extra of closureOf(v, oid)) excluded.add(extra);
      }
    } else {
      // A shallow holder only ever had the commit's own tree.
      for (const oid of closureOf(v, cur)) excluded.add(oid);
    }
  }
  const objects = new Map<string, GitObject>();
  for (const oid of included) {
    for (const member of closureOf(v, oid)) {
      if (excluded.has(member)) continue;
      const obj = loadObject(v, member);
      if (obj) objects.set(member, obj);
    }
  }
  // Tag objects the wants named are delivered even though they are not commits.
  for (const oid of extraIncluded) {
    if (excluded.has(oid)) continue;
    const obj = loadObject(v, oid);
    if (obj) objects.set(oid, obj);
  }
  return { objects, shallow, unshallow };
}

/** The per-file change between two trees: added / modified / removed paths. */
export function diffTrees(
  v: Vault,
  baseTip: string,
  headTip: string,
): Array<{ path: string; status: 'added' | 'modified' | 'removed'; base: string | null; head: string | null }> {
  const baseFiles = flattenCommit(v, baseTip);
  const headFiles = flattenCommit(v, headTip);
  const out: Array<{ path: string; status: 'added' | 'modified' | 'removed'; base: string | null; head: string | null }> = [];
  for (const [path, file] of headFiles) {
    const prev = baseFiles.get(path);
    if (!prev) out.push({ path, status: 'added', base: null, head: file.blob });
    else if (prev.blob !== file.blob) out.push({ path, status: 'modified', base: prev.blob, head: file.blob });
  }
  for (const [path, file] of baseFiles) {
    if (!headFiles.has(path)) out.push({ path, status: 'removed', base: file.blob, head: null });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : 1));
  return out;
}
