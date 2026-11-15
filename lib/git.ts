// Git smart HTTP: protocol v2 (ls-refs / fetch) and protocol v0
// (upload-pack / receive-pack), packfile generation and parsing.
// Wire formats follow gitprotocol-v2 and gitprotocol-pack (git-scm.com).
import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  Store,
  ZERO_SHA,
  adler32,
  parseTree,
} from './store.ts';
import type { Repo, ObjType } from './store.ts';

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');
const AGENT = 'forge/1.0';

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

export function pktFlush(): Buffer {
  return FLUSH;
}

export interface PktLine {
  kind: 'data' | 'delim' | 'flush';
  payload: Buffer;
}

// Parse pkt-lines from `buf` starting at `start`. Stops at a flush packet
// (0000), a response-end packet (0002) or the end of the buffer. Returns the
// lines and the offset just past the terminating packet (or buf.length).
export function parsePktLines(buf: Buffer, start = 0): { lines: PktLine[]; next: number } {
  const lines: PktLine[] = [];
  let pos = start;
  while (pos + 4 <= buf.length) {
    const len = parseInt(buf.toString('ascii', pos, pos + 4), 16);
    if (Number.isNaN(len) || len < 0) break;
    if (len === 0 || len === 2) {
      lines.push({ kind: 'flush', payload: Buffer.alloc(0) });
      return { lines, next: pos + 4 };
    }
    if (len === 1) {
      lines.push({ kind: 'delim', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (pos + len > buf.length) break;
    lines.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + len) });
    pos += len;
  }
  return { lines, next: pos };
}

// Wrap `data` into sideband pkt-lines (band byte + payload), chunked so no
// pkt-line exceeds `maxChunk` bytes of payload.
export function sidebandWrap(band: number, data: Buffer, maxChunk = 32768): Buffer {
  if (data.length === 0) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  for (let off = 0; off < data.length; off += maxChunk) {
    const chunk = data.subarray(off, Math.min(data.length, off + maxChunk));
    const head = Buffer.alloc(5);
    head.write((chunk.length + 5).toString(16).padStart(4, '0'), 'ascii');
    head[4] = band;
    parts.push(head, chunk);
  }
  return Buffer.concat(parts);
}

// Demultiplex sideband pkt-lines: concatenate the band-1 payloads. Stops at
// a bare flush packet. Returns the demultiplexed bytes and the offset past
// the terminating flush.
export function demuxSideband(buf: Buffer, start = 0): { data: Buffer; next: number } {
  const parts: Buffer[] = [];
  let pos = start;
  while (pos + 4 <= buf.length) {
    const len = parseInt(buf.toString('ascii', pos, pos + 4), 16);
    if (Number.isNaN(len) || len === 0) return { data: Buffer.concat(parts), next: pos + 4 };
    if (len < 5 || pos + len > buf.length) break;
    const band = buf[pos + 4];
    if (band === 1) parts.push(buf.subarray(pos + 5, pos + len));
    pos += len;
  }
  return { data: Buffer.concat(parts), next: pos };
}

// Inflate the zlib stream starting at `start`. inflateSync ignores trailing
// bytes, so the stream end is located with an Adler-32 scan: the true end is
// the first position whose next 4 bytes are the Adler-32 of the output and
// whose slice inflates cleanly to the same output.
function inflateAt(buf: Buffer, start: number): { data: Buffer; next: number } {
  const out = inflateSync(buf.subarray(start));
  const adler = adler32(out);
  for (let i = start; i + 4 <= buf.length; i++) {
    if (buf.readUInt32BE(i) !== adler) continue;
    try {
      const cand = inflateSync(buf.subarray(start, i + 4));
      if (cand.equals(out)) return { data: out, next: i + 4 };
    } catch {
      // Truncated candidate; keep scanning.
    }
  }
  throw new Error('deflate stream end not found');
}

function readVarint(buf: Buffer, pos: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let p = pos;
  while (true) {
    const b = buf[p++];
    value |= (b & 0x7f) << shift;
    shift += 7;
    if ((b & 0x80) === 0) break;
  }
  return { value, next: p };
}

// Apply a git delta to `base`.
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const srcSize = readVarint(delta, pos);
  pos = srcSize.next;
  const tgtSize = readVarint(delta, pos);
  pos = tgtSize.next;
  void srcSize.value;
  void tgtSize.value;
  const parts: Buffer[] = [];
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[pos++];
      if (op & 0x02) offset |= delta[pos++] << 8;
      if (op & 0x04) offset |= delta[pos++] << 16;
      if (op & 0x08) offset |= delta[pos++] << 24;
      if (op & 0x10) size = delta[pos++];
      if (op & 0x20) size |= delta[pos++] << 8;
      if (op & 0x40) size |= delta[pos++] << 16;
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(offset, offset + size));
    } else if (op !== 0) {
      parts.push(delta.subarray(pos, pos + op));
      pos += op;
    } else {
      throw new Error('invalid delta opcode 0');
    }
  }
  return Buffer.concat(parts);
}

const TYPE_BY_NUM: (ObjType | null)[] = [null, 'commit', 'tree', 'blob', 'tag', null, null, null];
const NUM_BY_TYPE: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

// Encode a pack object header (type + size varint).
function packObjectHeader(typeNum: number, size: number): Buffer {
  const bytes: number[] = [];
  let b0 = (typeNum << 4) | (size & 15);
  size >>>= 4;
  if (size) b0 |= 0x80;
  bytes.push(b0);
  while (size) {
    let b = size & 0x7f;
    size >>>= 7;
    if (size) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

// Parse a packfile, store every object, and return the object shas.
// Supports non-delta objects plus ofs-delta and ref-delta.
export function readPack(store: Store, buf: Buffer): { shas: string[]; error?: string } {
  try {
    if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'PACK') {
      return { shas: [], error: 'not a packfile' };
    }
    const version = buf.readUInt32BE(4);
    if (version !== 2) return { shas: [], error: 'unsupported pack version' };
    const count = buf.readUInt32BE(8);
    const shas: string[] = [];
    const byPos = new Map<number, { type: ObjType; data: Buffer; sha: string }>();
    const bySha = new Map<string, { type: ObjType; data: Buffer; sha: string }>();
    let pos = 12;
    for (let n = 0; n < count; n++) {
      const objStart = pos;
      let b = buf[pos];
      const typeNum = (b >> 4) & 7;
      let size = b & 15;
      let shift = 4;
      pos++;
      while (b & 0x80) {
        b = buf[pos++];
        size |= (b & 0x7f) << shift;
        shift += 7;
      }
      void size;
      if (typeNum === 6) {
        // ofs-delta: negative-offset varint, then the delta.
        let offset = 0;
        let bb = buf[pos++];
        offset = bb & 0x7f;
        while (bb & 0x80) {
          bb = buf[pos++];
          offset = ((offset + 1) << 7) | (bb & 0x7f);
        }
        const basePos = objStart - offset;
        const base = byPos.get(basePos);
        if (!base) return { shas, error: 'ofs-delta base not found' };
        const inf = inflateAt(buf, pos);
        pos = inf.next;
        const data = applyDelta(base.data, inf.data);
        const sha = store.putObject(base.type, data);
        const rec = { type: base.type, data, sha };
        byPos.set(objStart, rec);
        bySha.set(sha, rec);
        shas.push(sha);
      } else if (typeNum === 7) {
        // ref-delta: 20-byte base sha, then the delta.
        const baseSha = buf.subarray(pos, pos + 20).toString('hex');
        pos += 20;
        const base = store.getObject(baseSha) ?? bySha.get(baseSha);
        if (!base) return { shas, error: 'ref-delta base not found' };
        const inf = inflateAt(buf, pos);
        pos = inf.next;
        const data = applyDelta(base.data, inf.data);
        const sha = store.putObject(base.type, data);
        const rec = { type: base.type, data, sha };
        byPos.set(objStart, rec);
        bySha.set(sha, rec);
        shas.push(sha);
      } else {
        const type = TYPE_BY_NUM[typeNum];
        if (!type) return { shas, error: 'unknown object type ' + typeNum };
        const inf = inflateAt(buf, pos);
        pos = inf.next;
        const sha = store.putObject(type, inf.data);
        const rec = { type, data: inf.data, sha };
        byPos.set(objStart, rec);
        bySha.set(sha, rec);
        shas.push(sha);
      }
    }
    return { shas };
  } catch (e) {
    return { shas: [], error: e instanceof Error ? e.message : 'pack parse error' };
  }
}

// Build a packfile for `wants` (minus everything reachable from `haves`),
// limited to `depth` commit levels (0 = unlimited). `tagRefs` lists the
// repo's annotated tags ({tag sha, peeled target}); when it is given, tags
// whose target is in the pack are included too (the `include-tag` request).
// `shallows` are the client's shallow boundaries: a have that is shallow
// means the client has that commit but NOT its parents, so the exclusion
// walk must stop there (this is what makes `deepen` deliver new parents).
// Returns the pack bytes, the shallow-boundary commit shas and the included
// commit shas. Results are cached: objects are immutable, so a pack for the
// same (wants, haves, depth, tags, shallows) never changes.
export function buildPack(
  store: Store,
  wants: string[],
  haves: string[],
  depth: number,
  tagRefs?: { sha: string; target: string }[],
  shallows?: string[],
): { pack: Buffer; shallow: string[]; included: string[] } {
  const tagKey = tagRefs ? tagRefs.map((t) => t.sha).join(',') : '';
  const shallowKey = shallows ? shallows.join(',') : '';
  const key = wants.join(',') + '|' + depth + '|' + haves.join(',') + '|' + tagKey + '|' + shallowKey;
  const cached = store.packs.get(key);
  if (cached) return cached;

  // Full object set reachable from the haves (excluded from the pack).
  // The walk stops at shallow boundaries: the client has a shallow commit
  // itself, but not its parents, so those parents must stay sendable.
  const shallowSet = new Set(shallows ?? []);
  const excluded = new Set<string>();
  {
    const stack = [...haves];
    const seenCommits = new Set<string>();
    while (stack.length > 0) {
      const sha = stack.pop()!;
      if (seenCommits.has(sha)) continue;
      seenCommits.add(sha);
      const meta = store.commitMetaOf(sha);
      if (!meta) continue;
      excluded.add(sha);
      // Trees + blobs of this commit.
      const treeStack = [meta.tree];
      while (treeStack.length > 0) {
        const t = treeStack.pop()!;
        if (excluded.has(t)) continue;
        excluded.add(t);
        const obj = store.getObject(t);
        if (!obj || obj.type !== 'tree') continue;
        for (const e of parseTree(obj.data)) {
          if (e.mode === '40000') treeStack.push(e.sha);
          else excluded.add(e.sha);
        }
      }
      // A shallow have is a boundary the client does not see past: its
      // parents are NOT in the client's possession, so do not exclude them.
      if (!shallowSet.has(sha)) {
        for (const p of meta.parents) stack.push(p);
      }
    }
  }

  // Walk the wants with depth tracking. Boundary commits are the included
  // commits whose parents are not included (deepen limit or have exclusion).
  // A wanted tag object is included and its target is walked at the same
  // depth; a wanted tree/blob is included as-is.
  const includedCommits: string[] = [];
  const shallow: string[] = [];
  const extraObjects: { type: ObjType; sha: string }[] = [];
  {
    const seen = new Set<string>();
    const queue: { sha: string; depth: number }[] = [];
    for (const w of wants) {
      const obj = store.getObject(w);
      if (!obj) continue;
      if (obj.type === 'tag') {
        if (!excluded.has(w)) extraObjects.push({ type: 'tag', sha: w });
        const target = store.tagTargetOf(w);
        if (target) queue.push({ sha: target, depth: 0 });
      } else if (obj.type === 'commit') {
        queue.push({ sha: w, depth: 0 });
      } else if (!excluded.has(w)) {
        extraObjects.push({ type: obj.type, sha: w });
      }
    }
    let qi = 0;
    while (qi < queue.length) {
      const { sha, depth: d } = queue[qi++];
      if (seen.has(sha)) continue;
      seen.add(sha);
      const meta = store.commitMetaOf(sha);
      if (!meta) continue;
      if (depth > 0 && d >= depth) continue;
      // A commit the client already has is not re-sent, but the walk must
      // still pass through it when it is a shallow boundary: the client
      // does NOT have that boundary's parents (that is what a deepen is
      // for). A non-shallow excluded commit's parents are already on the
      // client, so the walk stops there.
      if (excluded.has(sha) && !shallowSet.has(sha)) continue;
      includedCommits.push(sha);
      const parentsIncluded = depth === 0 || d + 1 < depth;
      if (!parentsIncluded) shallow.push(sha);
      for (const p of meta.parents) queue.push({ sha: p, depth: d + 1 });
    }
  }

  // Collect trees + blobs of the included commits.
  const objects: { type: ObjType; sha: string; data: Buffer }[] = [];
  const seenObj = new Set<string>(excluded);
  for (const extra of extraObjects) {
    if (seenObj.has(extra.sha)) continue;
    const obj = store.getObject(extra.sha);
    if (!obj) continue;
    seenObj.add(extra.sha);
    objects.push({ type: extra.type, sha: extra.sha, data: obj.data });
  }
  for (const sha of includedCommits) {
    const obj = store.getObject(sha);
    if (!obj || seenObj.has(sha)) continue;
    seenObj.add(sha);
    objects.push({ type: 'commit', sha, data: obj.data });
    const meta = store.commitMetaOf(sha);
    if (!meta) continue;
    const treeStack = [meta.tree];
    while (treeStack.length > 0) {
      const t = treeStack.pop()!;
      if (seenObj.has(t)) continue;
      const tobj = store.getObject(t);
      if (!tobj || tobj.type !== 'tree') continue;
      seenObj.add(t);
      objects.push({ type: 'tree', sha: t, data: tobj.data });
      for (const e of parseTree(tobj.data)) {
        if (e.mode === '40000') treeStack.push(e.sha);
        else if (!seenObj.has(e.sha)) {
          const bobj = store.getObject(e.sha);
          if (bobj) {
            seenObj.add(e.sha);
            objects.push({ type: 'blob', sha: e.sha, data: bobj.data });
          }
        }
      }
    }
  }

  // include-tag: add annotated tags whose target is in the pack.
  if (tagRefs) {
    for (const t of tagRefs) {
      if (seenObj.has(t.sha) || !seenObj.has(t.target)) continue;
      const obj = store.getObject(t.sha);
      if (!obj || obj.type !== 'tag') continue;
      seenObj.add(t.sha);
      objects.push({ type: 'tag', sha: t.sha, data: obj.data });
    }
  }

  // Serialize the pack (non-delta, deflate level 1).
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const o of objects) {
    parts.push(packObjectHeader(NUM_BY_TYPE[o.type], o.data.length));
    parts.push(deflateSync(o.data, { level: 1 }));
  }
  const withoutTrailer = Buffer.concat(parts);
  const pack = Buffer.concat([withoutTrailer, sha1OfBuffer(withoutTrailer)]);
  const result = { pack, shallow, included: includedCommits };
  store.packs.set(key, result);
  return result;
}

function sha1OfBuffer(buf: Buffer): Buffer {
  return createHash('sha1').update(buf).digest();
}

// ---- reference listings ----------------------------------------------------

// All refs of a repo, sorted by name. Annotated tags carry their peeled target.
export function listRefs(store: Store, repo: Repo): { name: string; sha: string; peeled?: string }[] {
  const names = [...repo.refs.keys()].sort();
  const out: { name: string; sha: string; peeled?: string }[] = [];
  for (const name of names) {
    const sha = repo.refs.get(name)!;
    const entry: { name: string; sha: string; peeled?: string } = { name, sha };
    if (name.startsWith('refs/tags/')) {
      const obj = store.getObject(sha);
      if (obj && obj.type === 'tag') {
        const target = store.tagTargetOf(sha);
        if (target) entry.peeled = target;
      }
    }
    out.push(entry);
  }
  return out;
}

// v2 capability advertisement (static; identical for every repo).
const V2_ADVERTISEMENT: Buffer = Buffer.concat([
  pktLine('version 2\n'),
  pktLine('agent=' + AGENT + '\n'),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow wait-for-done sideband-all\n'),
  pktLine('server-option\n'),
  pktLine('object-format=sha1\n'),
  FLUSH,
]);

// v0 upload-pack capabilities (first ref line carries them after a NUL).
const V0_UPLOAD_CAPS = 'multi_ack side-band-64k ofs-delta shallow agent=' + AGENT;
const V0_RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=' + AGENT;

// v0 advertisement for a service. `caps` go on the first ref line (or on a
// capabilities^{} line when the repo has no refs yet).
function v0Advertisement(store: Store, repo: Repo, service: string, caps: string): Buffer {
  const parts: Buffer[] = [pktLine('# service=' + service + '\n'), FLUSH];
  const refs = listRefs(store, repo);
  if (refs.length === 0) {
    parts.push(pktLine(ZERO_SHA + ' capabilities^{}\0' + caps + '\n'));
  } else {
    const headSha = repo.refs.get(repo.head) ?? refs[0].sha;
    parts.push(pktLine(headSha + ' HEAD\0' + caps + '\n'));
    for (const r of refs) {
      parts.push(pktLine(r.sha + ' ' + r.name + '\n'));
      if (r.peeled) parts.push(pktLine(r.peeled + ' ' + r.name + '^{}\n'));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---- v2 commands ------------------------------------------------------------

export interface FetchArgs {
  wants: string[];
  haves: string[];
  done: boolean;
  sidebandAll: boolean;
  waitForDone: boolean;
  deepen: number;
  deepenRelative: boolean;
  shallows: string[];
  includeTag: boolean;
}

function parseFetchArgs(lines: PktLine[]): FetchArgs {
  const args: FetchArgs = {
    wants: [],
    haves: [],
    done: false,
    sidebandAll: false,
    waitForDone: false,
    deepen: 0,
    deepenRelative: false,
    shallows: [],
    includeTag: false,
  };
  for (const l of lines) {
    if (l.kind !== 'data') continue;
    const s = l.payload.toString('utf8').replace(/\n$/, '');
    if (s.startsWith('want ')) args.wants.push(s.slice(5).trim());
    else if (s.startsWith('have ')) args.haves.push(s.slice(5).trim());
    else if (s === 'done') args.done = true;
    else if (s === 'sideband-all') args.sidebandAll = true;
    else if (s === 'wait-for-done') args.waitForDone = true;
    else if (s === 'include-tag') args.includeTag = true;
    else if (s === 'deepen-relative') args.deepenRelative = true;
    else if (s.startsWith('deepen ')) args.deepen = parseInt(s.slice(7), 10) || 0;
    else if (s.startsWith('shallow ')) args.shallows.push(s.slice(8).trim());
  }
  return args;
}

// Distance (in commits, tip inclusive) from `tip` down to the nearest
// shallow boundary. 0 when no boundary is reachable from the tip.
function depthToShallow(store: Store, tip: string, shallowSet: Set<string>): number {
  const seen = new Set<string>();
  const queue: { sha: string; depth: number }[] = [{ sha: tip, depth: 1 }];
  let qi = 0;
  while (qi < queue.length) {
    const { sha, depth: d } = queue[qi++];
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (shallowSet.has(sha)) return d;
    const meta = store.commitMetaOf(sha);
    if (!meta) continue;
    for (const p of meta.parents) queue.push({ sha: p, depth: d + 1 });
  }
  return 0;
}

// Effective pack depth for a fetch. A `deepen-relative` request deepens an
// already-shallow clone by N more generations, so the absolute depth is the
// client's current shallow depth plus N; a plain `deepen` is absolute.
function effectiveDepth(store: Store, args: FetchArgs): number {
  if (args.deepen <= 0) return 0;
  if (!args.deepenRelative) return args.deepen;
  const shallowSet = new Set(args.shallows);
  let current = 0;
  for (const w of args.wants) {
    current = Math.max(current, depthToShallow(store, w, shallowSet));
  }
  return current > 0 ? current + args.deepen : args.deepen;
}

// The repo's annotated tags as {tag sha, peeled target} for include-tag.
function repoTagRefs(store: Store, repo: Repo): { sha: string; target: string }[] {
  const out: { sha: string; target: string }[] = [];
  for (const [name, sha] of repo.refs) {
    if (!name.startsWith('refs/tags/')) continue;
    if (store.getObject(sha)?.type === 'tag') {
      const target = store.tagTargetOf(sha);
      if (target) out.push({ sha, target });
    }
  }
  return out;
}

// ls-refs response. `args` are the request's argument lines.
function lsRefsResponse(store: Store, repo: Repo, argLines: PktLine[]): Buffer {
  let symrefs = false;
  let peel = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const l of argLines) {
    if (l.kind !== 'data') continue;
    const s = l.payload.toString('utf8').replace(/\n$/, '');
    if (s === 'symrefs') symrefs = true;
    else if (s === 'peel') peel = true;
    else if (s === 'unborn') unborn = true;
    else if (s.startsWith('ref-prefix ')) prefixes.push(s.slice(11));
  }
  const matches = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const headSha = repo.refs.get(repo.head);
  const headTarget = repo.head;
  if (headSha) {
    if (matches('HEAD') || prefixes.length === 0) {
      parts.push(pktLine(headSha + ' HEAD symref-target:' + headTarget + '\n'));
    }
  } else if (unborn) {
    parts.push(pktLine('unborn HEAD symref-target:' + headTarget + '\n'));
  }
  for (const r of listRefs(store, repo)) {
    if (!matches(r.name)) continue;
    let line = r.sha + ' ' + r.name;
    if (r.peeled && peel) line += ' peeled:' + r.peeled;
    parts.push(pktLine(line + '\n'));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// fetch response. Sections are separated by delimiter packets; the packfile
// section is always sideband-multiplexed. With sideband-all, every other
// section line is banded too.
function fetchResponse(store: Store, repo: Repo, args: FetchArgs): Buffer {
  const parts: Buffer[] = [];
  const band = (s: string): Buffer =>
    args.sidebandAll ? pktLine(Buffer.concat([Buffer.from([1]), Buffer.from(s, 'utf8')])) : pktLine(s);
  if (args.wants.length === 0) {
    parts.push(band('acknowledgments\n'));
    parts.push(band('NAK\n'));
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }
  // Acknowledgements are omitted when the client sent "done".
  if (!args.done) {
    parts.push(band('acknowledgments\n'));
    const common = args.haves.filter((h) => store.getObject(h));
    if (common.length === 0) parts.push(band('NAK\n'));
    else for (const h of common) parts.push(band('ACK ' + h + '\n'));
    if (!args.waitForDone) parts.push(band('ready\n'));
    parts.push(DELIM);
  }
  const { pack, shallow, included } = buildPack(
    store,
    args.wants,
    args.haves,
    effectiveDepth(store, args),
    args.includeTag ? repoTagRefs(store, repo) : undefined,
    args.shallows,
  );
  // Shallow-info: boundary commits, plus unshallow lines for client-declared
  // shallow commits whose parents are now included in the pack.
  const unshallow: string[] = [];
  for (const s of args.shallows) {
    if (included.includes(s) && !shallow.includes(s)) unshallow.push(s);
  }
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(band('shallow-info\n'));
    for (const s of shallow) parts.push(band('shallow ' + s + '\n'));
    for (const s of unshallow) parts.push(band('unshallow ' + s + '\n'));
    parts.push(DELIM);
  }
  parts.push(band('packfile\n'));
  parts.push(sidebandWrap(1, pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---- v0 upload-pack ----------------------------------------------------------

function v0UploadPack(store: Store, repo: Repo, body: Buffer): Buffer {
  const { lines, next } = parsePktLines(body);
  void next;
  const wants: string[] = [];
  const haves: string[] = [];
  let done = false;
  let deepen = 0;
  let deepenRelative = false;
  let sideband = false;
  let includeTag = false;
  const shallows: string[] = [];
  let first = true;
  for (const l of lines) {
    if (l.kind !== 'data') continue;
    let s = l.payload.toString('utf8').replace(/\n$/, '');
    if (first && s.includes(' ')) {
      // First want line may carry capabilities after a space.
      const sp = s.indexOf(' ');
      const caps = s.slice(sp + 1);
      if (caps.includes('side-band-64k')) sideband = true;
      if (caps.includes('include-tag')) includeTag = true;
      s = s.slice(0, sp);
    }
    first = false;
    if (s.startsWith('want ')) wants.push(s.slice(5).trim());
    else if (s.startsWith('have ')) haves.push(s.slice(5).trim());
    else if (s === 'done') done = true;
    else if (s === 'include-tag') includeTag = true;
    else if (s === 'deepen-relative') deepenRelative = true;
    else if (s.startsWith('shallow ')) shallows.push(s.slice(8).trim());
    else if (s.startsWith('deepen ')) deepen = parseInt(s.slice(7), 10) || 0;
  }
  void done;
  const parts: Buffer[] = [];
  if (haves.length > 0) {
    const common = haves.filter((h) => store.getObject(h));
    if (common.length === 0) parts.push(pktLine('NAK\n'));
    else for (const h of common) parts.push(pktLine('ACK ' + h + '\n'));
  }
  const effDepth = (() => {
    if (deepen <= 0) return 0;
    if (!deepenRelative) return deepen;
    const shallowSet = new Set(shallows);
    let current = 0;
    for (const w of wants) current = Math.max(current, depthToShallow(store, w, shallowSet));
    return current > 0 ? current + deepen : deepen;
  })();
  const { pack, shallow } = buildPack(
    store,
    wants,
    haves,
    effDepth,
    includeTag ? repoTagRefs(store, repo) : undefined,
    shallows,
  );
  for (const s of shallow) parts.push(pktLine('shallow ' + s + '\n'));
  if (sideband) {
    parts.push(sidebandWrap(1, pack));
    parts.push(FLUSH);
  } else {
    parts.push(pack);
  }
  return Buffer.concat(parts);
}

// ---- v0 receive-pack ----------------------------------------------------------

export interface RefUpdate {
  oldSha: string;
  newSha: string;
  ref: string;
}

function parseRefUpdates(body: Buffer): { updates: RefUpdate[]; caps: string; packStart: number } {
  const { lines, next } = parsePktLines(body);
  const updates: RefUpdate[] = [];
  let caps = '';
  for (const l of lines) {
    if (l.kind !== 'data') continue;
    let payload = l.payload;
    // Tolerate a sideband band byte on the ref-update lines.
    if (payload.length > 0 && payload[0] === 1 && payload.length > 1 && payload[1] >= 0x30 && payload[1] <= 0x66) {
      payload = payload.subarray(1);
    }
    let s = payload.toString('utf8').replace(/\n$/, '');
    if (caps === '' && s.includes('\0')) {
      const nul = s.indexOf('\0');
      caps = s.slice(nul + 1);
      s = s.slice(0, nul);
    }
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(s);
    if (m) updates.push({ oldSha: m[1], newSha: m[2], ref: m[3] });
  }
  return { updates, caps, packStart: next };
}

function v0ReceivePack(store: Store, repo: Repo, body: Buffer): Buffer {
  const { updates, caps, packStart } = parseRefUpdates(body);
  const useSideband = caps.includes('side-band-64k');
  const reportStatus = caps.includes('report-status');
  const report: string[] = [];
  let unpackError = '';
  // The pack follows the ref-update flush: raw ("PACK...") or sidebanded.
  let packBuf = body.subarray(packStart);
  if (packBuf.length > 0 && packBuf.toString('ascii', 0, 4) !== 'PACK') {
    const demuxed = demuxSideband(body, packStart);
    packBuf = demuxed.data;
  }
  if (packBuf.length > 0) {
    const res = readPack(store, packBuf);
    if (res.error) unpackError = res.error;
  }
  // Validate + apply each ref update (fast-forward only).
  const results: { ref: string; ok: boolean; reason: string }[] = [];
  for (const u of updates) {
    if (unpackError) {
      results.push({ ref: u.ref, ok: false, reason: unpackError });
      continue;
    }
    const current = repo.refs.get(u.ref);
    if (u.newSha === ZERO_SHA) {
      // Delete.
      if (!current) {
        results.push({ ref: u.ref, ok: false, reason: 'ref does not exist' });
      } else if (u.oldSha !== ZERO_SHA && u.oldSha !== current) {
        results.push({ ref: u.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(u.ref);
        results.push({ ref: u.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (!store.getObject(u.newSha)) {
      results.push({ ref: u.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (!current) {
      if (u.oldSha !== ZERO_SHA) {
        results.push({ ref: u.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.set(u.ref, u.newSha);
        results.push({ ref: u.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (u.oldSha !== current) {
      results.push({ ref: u.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (u.newSha === current) {
      results.push({ ref: u.ref, ok: true, reason: '' });
      continue;
    }
    if (!store.isAncestor(current, u.newSha)) {
      results.push({ ref: u.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(u.ref, u.newSha);
    results.push({ ref: u.ref, ok: true, reason: '' });
  }
  if (results.some((r) => r.ok)) repo.rev++;
  if (!reportStatus) {
    // No report requested: git still ends the sideband stream with a flush.
    return useSideband ? FLUSH : Buffer.alloc(0);
  }
  report.push('unpack ' + (unpackError || 'ok') + '\n');
  for (const r of results) {
    report.push(r.ok ? 'ok ' + r.ref + '\n' : 'ng ' + r.ref + ' ' + r.reason + '\n');
  }
  const reportBuf = Buffer.concat([...report.map((s) => pktLine(s)), FLUSH]);
  if (useSideband) {
    // git's receive-pack sends the whole report through sideband band 1,
    // then a bare flush packet.
    return Buffer.concat([sidebandWrap(1, reportBuf, 65515), FLUSH]);
  }
  return reportBuf;
}

// ---- dispatcher ---------------------------------------------------------------

export interface GitResult {
  status: number;
  contentType: string;
  body: Buffer;
}

const JSON_404 = Buffer.from('{"message":"Not Found"}', 'utf8');

export function handleGit(
  store: Store,
  method: string,
  path: string,
  query: Map<string, string>,
  body: Buffer,
  gitProtocolV2: boolean,
): GitResult {
  // path: /{owner}/{repo}.git[/...]
  const m = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (!m) return { status: 404, contentType: 'application/json', body: JSON_404 };
  const repoName = decodeURIComponent(m[2]);
  const repo = store.getRepo(repoName);
  if (!repo) return { status: 404, contentType: 'application/json', body: JSON_404 };
  const rest = m[3] ?? '';
  if (method === 'GET' && rest === '/info/refs') {
    const service = query.get('service') ?? '';
    if (service === 'git-upload-pack') {
      if (gitProtocolV2) {
        return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: V2_ADVERTISEMENT };
      }
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v0Advertisement(store, repo, service, V0_UPLOAD_CAPS) };
    }
    if (service === 'git-receive-pack') {
      return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: v0Advertisement(store, repo, service, V0_RECEIVE_CAPS) };
    }
    return { status: 404, contentType: 'application/json', body: JSON_404 };
  }
  if (method === 'POST' && rest === '/git-upload-pack') {
    // v2 if the client asked for it, or if the body starts with a command= line.
    let isV2 = gitProtocolV2;
    if (!isV2) {
      const parsed = parsePktLines(body);
      const firstLine = parsed.lines.find((l) => l.kind === 'data');
      if (firstLine && firstLine.payload.toString('utf8').startsWith('command=')) isV2 = true;
    }
    if (isV2) {
      const { lines } = parsePktLines(body);
      // command line, capability lines, delim, args, flush.
      const delimIdx = lines.findIndex((l) => l.kind === 'delim');
      const commandLine = lines.find((l) => l.kind === 'data');
      const command = commandLine ? commandLine.payload.toString('utf8').replace(/\n$/, '') : '';
      const argLines = delimIdx >= 0 ? lines.slice(delimIdx + 1) : [];
      if (command === 'command=ls-refs') {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefsResponse(store, repo, argLines) };
      }
      if (command === 'command=fetch') {
        const args = parseFetchArgs(argLines);
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchResponse(store, repo, args) };
      }
      return { status: 400, contentType: 'application/json', body: Buffer.from('{"message":"unknown command"}', 'utf8') };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: v0UploadPack(store, repo, body) };
  }
  if (method === 'POST' && rest === '/git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: v0ReceivePack(store, repo, body) };
  }
  return { status: 404, contentType: 'application/json', body: JSON_404 };
}
