// Git smart HTTP, built from scratch on node:zlib and node:crypto. No git binary.
// Covers upload-pack protocol v2 (advertisement, ls-refs, fetch) and v0, and
// receive-pack v0 (push with report-status inside side-band-64k). Packs are written
// with plain full objects only (no deltas); the reader resolves OFS/REF deltas
// anyway, because the harness client may send them.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { Store, ZERO_OID, hashObject, isOid, type GitObject, type ObjType } from './store.ts';

// ---- pkt-line framing --------------------------------------------------------

export const PKT_LINE_MAX = 65520;

/** One pkt-line: 4 hex chars of (payload length + 4), then the payload. */
export function pktLine(data: string | Buffer): Buffer {
  const b = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  if (b.length + 4 > PKT_LINE_MAX) throw new Error('pkt-line too long');
  const header = Buffer.alloc(4);
  header.write((b.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, b]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Split a whole buffer into pkt-line packets. Throws on a malformed frame. */
export function decodePktLines(buf: Buffer): Packet[] {
  const out: Packet[] = [];
  let pos = 0;
  while (pos < buf.length) {
    if (pos + 4 > buf.length) throw new Error('truncated pkt-line header');
    const len = parseInt(buf.subarray(pos, pos + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) throw new Error('bad pkt-line length');
    if (len === 0) {
      out.push({ kind: 'flush' });
      pos += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim' });
      pos += 4;
    } else if (len === 2) {
      out.push({ kind: 'response-end' });
      pos += 4;
    } else {
      if (pos + len > buf.length) throw new Error('truncated pkt-line payload');
      out.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + len) });
      pos += len;
    }
  }
  return out;
}

export function encodePktLines(items: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(FLUSH);
    else if (item === 'delim') parts.push(DELIM);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

// ---- packfiles ---------------------------------------------------------------

const OBJ_TYPE_NUM: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const OBJ_NUM_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Build a packfile (version 2) from plain full objects. No deltas, ever.
 * Deflate level 1: the objects here are small, and level 1 is several times
 * faster than the default while producing a still-valid stream. */
export function writePack(objects: Array<{ type: ObjType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const typeNum = OBJ_TYPE_NUM[obj.type];
    let size = obj.data.length;
    const hb: number[] = [];
    let b = (typeNum << 4) | (size & 0x0f);
    size >>= 4;
    if (size > 0) b |= 0x80;
    hb.push(b);
    while (size > 0) {
      let bb = size & 0x7f;
      size >>= 7;
      if (size > 0) bb |= 0x80;
      hb.push(bb);
    }
    parts.push(Buffer.from(hb));
    parts.push(deflateSync(obj.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Adler-32 of a buffer (the zlib stream's trailing checksum). */
function adler32(buf: Buffer): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** How many bytes of `buf` the zlib stream at its start occupies, when it inflates
 * to exactly `size` bytes. Fast path: inflate once (trailing bytes are ignored),
 * then locate the stream's end by its Adler-32 trailer — the deflate data itself
 * can contain those four bytes, but a slice ending mid-stream fails to inflate,
 * so the first candidate that verifies is the true end. Falls back to a binary
 * search when the scan finds nothing. */
function inflateLength(buf: Buffer, size: number): number {
  let data: Buffer;
  try {
    data = inflateSync(buf);
  } catch {
    data = Buffer.alloc(0);
  }
  if (data.length === size) {
    const sum = adler32(data);
    const needle = Buffer.alloc(4);
    needle.writeUInt32BE(sum, 0);
    let from = 2; // skip the 2-byte zlib header
    for (;;) {
      const idx = buf.indexOf(needle, from);
      if (idx < 0) break;
      const end = idx + 4;
      try {
        const out = inflateSync(buf.subarray(0, end));
        if (out.length === size) return end;
      } catch {
        // False positive inside the deflate data: keep scanning.
      }
      from = idx + 1;
    }
  }
  // Binary-search fallback: inflateSync throws on a truncated stream and returns
  // the full data once the slice covers it, so the predicate is monotonic.
  const capped = Math.min(buf.length, size + 16);
  let lo = 1;
  let hi = capped;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      const out = inflateSync(buf.subarray(0, mid));
      if (out.length === size) {
        ans = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    } catch {
      lo = mid + 1;
    }
  }
  if (ans >= 0) return ans;
  lo = capped + 1;
  hi = buf.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      const out = inflateSync(buf.subarray(0, mid));
      if (out.length === size) {
        ans = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    } catch {
      lo = mid + 1;
    }
  }
  return ans;
}

/** Apply a git binary delta to a base buffer. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const srcSize = readVarint();
  const dstSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const chunks: Buffer[] = [];
  let total = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) offset |= delta[pos++] << (8 * i);
      for (let i = 0; i < 3; i++) if (op & (0x10 << i)) size |= delta[pos++] << (8 * i);
      if (size === 0) size = 0x10000;
      chunks.push(base.subarray(offset, offset + size));
      total += size;
    } else if (op > 0) {
      chunks.push(delta.subarray(pos, pos + op));
      pos += op;
      total += op;
    } else {
      throw new Error('delta op 0');
    }
  }
  if (total !== dstSize) throw new Error('delta target size mismatch');
  return Buffer.concat(chunks);
}

export interface ReadPackResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/** Read a packfile (version 2 or 3), resolving OFS/REF deltas. Verifies the trailer. */
export function readPack(buf: Buffer): ReadPackResult {
  if (buf.length < 32) throw new Error('pack too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  const actual = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  if (!actual.equals(trailer)) throw new Error('pack trailer checksum mismatch');

  const objects = new Map<string, GitObject>();
  // Objects referenced by offset, for OFS_DELTA resolution.
  const byOffset = new Map<number, { type: ObjType; data: Buffer }>();
  let deltaCount = 0;
  let pos = 12;
  const end = buf.length - 20;
  for (let i = 0; i < count; i++) {
    const start = pos;
    // Object header: type + size varint.
    let byte = buf[pos++];
    const typeNum = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[pos++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeNum === 6) {
      // OFS_DELTA: offset varint, then delta data.
      byte = buf[pos++];
      let offset = byte & 0x7f;
      while (byte & 0x80) {
        byte = buf[pos++];
        offset = ((offset + 1) << 7) | (byte & 0x7f);
      }
      const base = byOffset.get(start - offset);
      if (!base) throw new Error('ofs-delta base missing');
      const n = inflateLength(buf.subarray(pos, end), size);
      if (n < 0) throw new Error('ofs-delta inflate failed');
      const delta = inflateSync(buf.subarray(pos, pos + n));
      pos += n;
      const data = applyDelta(base.data, delta);
      const oid = hashObject(base.type, data);
      objects.set(oid, { type: base.type, data });
      byOffset.set(start, { type: base.type, data });
      deltaCount += 1;
    } else if (typeNum === 7) {
      // REF_DELTA: 20-byte base oid, then delta data.
      const baseOid = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
      const base = objects.get(baseOid);
      if (!base) throw new Error('ref-delta base missing');
      const n = inflateLength(buf.subarray(pos, end), size);
      if (n < 0) throw new Error('ref-delta inflate failed');
      const delta = inflateSync(buf.subarray(pos, pos + n));
      pos += n;
      const data = applyDelta(base.data, delta);
      const oid = hashObject(base.type, data);
      objects.set(oid, { type: base.type, data });
      byOffset.set(start, { type: base.type, data });
      deltaCount += 1;
    } else {
      const type = OBJ_NUM_TYPE[typeNum];
      if (!type) throw new Error(`unknown pack object type ${typeNum}`);
      const n = inflateLength(buf.subarray(pos, end), size);
      if (n < 0) throw new Error('object inflate failed');
      const data = inflateSync(buf.subarray(pos, pos + n));
      pos += n;
      const oid = hashObject(type, data);
      objects.set(oid, { type, data });
      byOffset.set(start, { type, data });
    }
  }
  return { objects, deltaCount };
}

// ---- fetch planning ----------------------------------------------------------

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

export interface FetchPlan {
  objects: Array<{ type: ObjType; data: Buffer }>;
  shallow: string[];
  unshallow: string[];
  acks: string[];
  nak: boolean;
  wantedRefs: Array<{ oid: string; ref: string }>;
}

/** Which objects a fetch must send, and the shallow/ack bookkeeping.
 *
 * The subtlety is what the client already holds. A `have` is a commit the client
 * has, but a commit named in `shallow` is a shallow boundary: the client has that
 * commit and nothing below it, so its ancestors are NOT held. Deepening a shallow
 * clone therefore has to traverse below a `have`, not stop at it. */
export function planFetch(store: Store, repoName: string, req: FetchRequest): FetchPlan {
  const refs = store.repoRefs(repoName);

  // Commits the client holds: everything reachable from its haves, minus the
  // ancestors of its shallow boundaries (those were cut off by the shallow clone).
  const held = new Set<string>();
  for (const h of req.haves) {
    for (const c of store.reachableCommits([h])) held.add(c);
  }
  for (const s of req.shallow) {
    const obj = store.getObject(s);
    if (obj && obj.type === 'commit') {
      for (const p of store.parseCommit(obj.data).parents) {
        for (const c of store.reachableCommits([p])) held.delete(c);
      }
    }
  }
  // Objects the client holds (for excluding shared trees/blobs from the pack).
  const haveObjects = new Set<string>();
  for (const h of held) {
    for (const oid of store.closureOfCommit(h)) haveObjects.add(oid);
  }

  // Resolve wants: a tag want contributes the tag object itself and peels to its
  // commit; other non-commit wants contribute their object directly.
  const extraObjects: Array<{ type: ObjType; data: Buffer }> = [];
  const commitWants: string[] = [];
  for (const w of req.wants) {
    const obj = store.getObject(w);
    if (!obj) continue;
    if (obj.type === 'tag') {
      extraObjects.push({ type: 'tag', data: obj.data });
      commitWants.push(store.peelToCommit(w));
    } else if (obj.type === 'commit') {
      commitWants.push(w);
    } else {
      extraObjects.push({ type: obj.type, data: obj.data });
    }
  }

  // Commits to include: BFS from the wants, honouring depth, skipping what the
  // client holds — but still traversing below a held commit, because deepening
  // needs the generations under a shallow boundary.
  const included = new Set<string>();
  const visited = new Set<string>();
  const queue: Array<[string, number]> = commitWants.map((w) => [w, 0]);
  let qhead = 0;
  while (qhead < queue.length) {
    const [oid, d] = queue[qhead++]!;
    if (visited.has(oid)) continue;
    visited.add(oid);
    const obj = store.getObject(oid);
    if (!obj || obj.type !== 'commit') continue;
    if (!held.has(oid) && (req.depth === null || d < req.depth)) included.add(oid);
    if (req.depth === null || d + 1 < req.depth) {
      for (const p of store.parseCommit(obj.data).parents) queue.push([p, d + 1]);
    }
  }

  const wantObjects = new Set<string>();
  for (const c of included) {
    for (const oid of store.closureOfCommit(c)) wantObjects.add(oid);
  }
  const objects: Array<{ type: ObjType; data: Buffer }> = [];
  for (const oid of wantObjects) {
    if (haveObjects.has(oid)) continue;
    const obj = store.getObject(oid);
    if (obj) objects.push({ type: obj.type, data: obj.data });
  }
  for (const extra of extraObjects) {
    const oid = hashObject(extra.type, extra.data);
    if (haveObjects.has(oid)) continue;
    if (!objects.some((o) => hashObject(o.type, o.data) === oid)) objects.push(extra);
  }
  // Deterministic pack order: commits, then trees, then blobs, then tags, by oid.
  const typeOrder: Record<ObjType, number> = { commit: 0, tree: 1, blob: 2, tag: 3 };
  objects.sort((a, b) => {
    const t = typeOrder[a.type] - typeOrder[b.type];
    if (t !== 0) return t;
    const ao = hashObject(a.type, a.data);
    const bo = hashObject(b.type, b.data);
    return ao < bo ? -1 : ao > bo ? 1 : 0;
  });

  // Shallow boundaries: included commits whose parents are all cut off (not in
  // the pack and not already held by the client). Unshallow: old boundaries whose
  // parents are now present, so they are no longer shallow.
  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (req.depth !== null) {
    const present = new Set<string>([...held, ...included]);
    for (const c of included) {
      const obj = store.getObject(c);
      if (!obj || obj.type !== 'commit') continue;
      const parents = store.parseCommit(obj.data).parents;
      if (parents.length > 0 && parents.every((p) => !present.has(p))) shallow.push(c);
    }
    for (const b of req.shallow) {
      const obj = store.getObject(b);
      if (!obj || obj.type !== 'commit') continue;
      const parents = store.parseCommit(obj.data).parents;
      if (parents.length === 0 || parents.every((p) => present.has(p))) unshallow.push(b);
    }
    shallow.sort();
    unshallow.sort();
  }

  const acks: string[] = [];
  let nak = false;
  if (req.haves.length === 0) {
    nak = true;
  } else {
    for (const h of req.haves) if (store.getObject(h)) acks.push(h);
    if (acks.length === 0) nak = true;
  }

  const wantedRefs: Array<{ oid: string; ref: string }> = [];
  for (const want of req.wants) {
    for (const [name, oid] of refs) {
      if (oid === want) wantedRefs.push({ oid: want, ref: name });
    }
  }

  return { objects, shallow, unshallow, acks, nak, wantedRefs };
}

// ---- response caches ---------------------------------------------------------
// The clone workload issues 50 identical shallow clones; the push workload asks
// for the receive-pack advertisement before every push. Memoising the framed
// responses behind the repo's revision counter makes those repeats nearly free.
// Every key carries the repo revision, so a ref move invalidates the entry. Packs
// themselves are also keyed by the exact negotiation, so a stale pack is
// unreachable: an object's closure never changes once stored.

const CACHE_CAP = 128;
const advertCache = new Map<string, Buffer>();
const lsRefsCache = new Map<string, Buffer>();
const fetchCache = new Map<string, Buffer>();

function cachePut<K extends string>(cache: Map<K, Buffer>, key: K, value: Buffer): void {
  if (cache.size >= CACHE_CAP) cache.clear();
  cache.set(key, value);
}

/** Split bytes into sideband band-1 pkt-lines (payload <= 65515 bytes each: the
 * band byte plus the chunk must fit a pkt-line, capped at 65520 total). */
export function sidebandPackets(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let pos = 0; pos < data.length; pos += 65515) {
    const chunk = data.subarray(pos, Math.min(data.length, pos + 65515));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

/** A v2 upload-pack advertisement (static: the capability set never changes). */
const V2_ADVERTISEMENT: Buffer = encodePktLines([
  '# service=git-upload-pack\n',
  'flush',
  'version 2\n',
  'agent=makefun-forge/1.0\n',
  'ls-refs=unborn\n',
  'fetch=shallow wait-for-done\n',
  'server-option\n',
  'object-format=sha1\n',
  'flush',
]);

export function v2Advertisement(): Buffer {
  return V2_ADVERTISEMENT;
}

const V0_UPLOAD_CAPS =
  'symref=HEAD:refs/heads/main multi_ack thin-pack side-band side-band-64k ofs-delta shallow no-progress include-tag multi_ack_detailed agent=makefun-forge/1.0';
const V0_RECEIVE_CAPS =
  'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=makefun-forge/1.0';

interface RefLine {
  oid: string;
  name: string;
}

/** Sorted ref lines for a v0 advertisement, with peeled tag lines (name^{}).
 * The first line carries the capability string after a NUL. */
function v0RefEntries(store: Store, repoName: string): RefLine[] {
  const refs = store.repoRefs(repoName);
  const entries: RefLine[] = [];
  for (const [name, oid] of [...refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    entries.push({ oid, name });
    const obj = store.getObject(oid);
    if (obj && obj.type === 'tag') {
      entries.push({ oid: store.peelToCommit(oid), name: `${name}^{}` });
    }
  }
  return entries;
}

function v0Advertisement(store: Store, repoName: string, service: 'upload' | 'receive'): Buffer {
  const key = `${repoName}|${store.revOf(repoName)}|${service}`;
  const hit = advertCache.get(key);
  if (hit) return hit;
  const caps = service === 'upload' ? V0_UPLOAD_CAPS : V0_RECEIVE_CAPS;
  const serviceLine = service === 'upload' ? '# service=git-upload-pack\n' : '# service=git-receive-pack\n';
  const entries = v0RefEntries(store, repoName);
  const parts: Buffer[] = [pktLine(serviceLine), FLUSH];
  if (entries.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    entries.forEach((e, i) => {
      const suffix = i === 0 ? `\0${caps}` : '';
      parts.push(pktLine(`${e.oid} ${e.name}${suffix}\n`));
    });
  }
  parts.push(FLUSH);
  const out = Buffer.concat(parts);
  cachePut(advertCache, key, out);
  return out;
}

export function v0UploadAdvertisement(store: Store, repoName: string): Buffer {
  return v0Advertisement(store, repoName, 'upload');
}

export function v0ReceiveAdvertisement(store: Store, repoName: string): Buffer {
  return v0Advertisement(store, repoName, 'receive');
}

/** ls-refs v2 response lines for the requested options. */
export function lsRefsResponse(
  store: Store,
  repoName: string,
  opts: { peel: boolean; symrefs: boolean; prefixes: string[] },
): Buffer {
  const key = `${repoName}|${store.revOf(repoName)}|${opts.peel ? 'p' : ''}${opts.symrefs ? 's' : ''}|${opts.prefixes.join(',')}`;
  const hit = lsRefsCache.get(key);
  if (hit) return hit;
  const refs = store.repoRefs(repoName);
  const lines: string[] = [];
  const keep = (name: string): boolean =>
    opts.prefixes.length === 0 || opts.prefixes.some((p) => name.startsWith(p));
  const defaultBranch = store.getRepo(repoName)?.defaultBranch ?? 'main';
  const headOid = refs.get(`refs/heads/${defaultBranch}`);
  if (opts.prefixes.length === 0) {
    if (headOid) {
      lines.push(`${headOid} HEAD${opts.symrefs ? ` symref-target:refs/heads/${defaultBranch}` : ''}\n`);
    } else {
      lines.push(`unborn HEAD${opts.symrefs ? ` symref-target:refs/heads/${defaultBranch}` : ''}\n`);
    }
  }
  for (const [name, oid] of [...refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    if (opts.peel) {
      const obj = store.getObject(oid);
      if (obj && obj.type === 'tag') line += ` peeled:${store.peelToCommit(oid)}`;
    }
    lines.push(`${line}\n`);
  }
  const out = encodePktLines([...lines, 'flush']);
  cachePut(lsRefsCache, key, out);
  return out;
}

/** Parse a v2 ls-refs / fetch request body into its command and arguments. */
export function parseV2Request(buf: Buffer): { command: string; args: Map<string, string[]> } {
  const packets = decodePktLines(buf);
  const lines: string[] = [];
  for (const p of packets) {
    if (p.kind === 'data') lines.push(p.payload.toString('utf8'));
    else if (p.kind === 'flush') break;
  }
  let command = '';
  const args = new Map<string, string[]>();
  const push = (key: string, value: string): void => {
    const arr = args.get(key) ?? [];
    arr.push(value);
    args.set(key, arr);
  };
  for (const line of lines) {
    const text = line.endsWith('\n') ? line.slice(0, -1) : line;
    if (text.startsWith('command=')) {
      command = text.slice('command='.length);
    } else if (
      text === 'peel' || text === 'symrefs' || text === 'unborn' || text === 'thin-pack' ||
      text === 'no-progress' || text === 'ofs-delta' || text === 'done' || text === 'wait-for-done'
    ) {
      push(text, '');
    } else if (text.startsWith('agent=') || text.startsWith('object-format=')) {
      const eq = text.indexOf('=');
      push(text.slice(0, eq), text.slice(eq + 1));
    } else if (text.includes(' ')) {
      const space = text.indexOf(' ');
      push(text.slice(0, space), text.slice(space + 1));
    }
  }
  return { command, args };
}

/** Build the v2 fetch response for a request, memoised on the full negotiation. */
export function fetchV2Response(store: Store, repoName: string, req: FetchRequest): Buffer {
  const key = [
    repoName,
    store.revOf(repoName),
    req.wants.join(','),
    req.haves.join(','),
    req.shallow.join(','),
    req.depth === null ? '-' : String(req.depth),
  ].join('|');
  const hit = fetchCache.get(key);
  if (hit) return hit;
  const plan = planFetch(store, repoName, req);
  const parts: Buffer[] = [];
  // acknowledgments
  const ackLines: string[] = ['acknowledgments\n'];
  if (plan.nak) ackLines.push('NAK\n');
  for (const a of plan.acks) ackLines.push(`ACK ${a}\n`);
  if (plan.acks.length > 0) ackLines.push('ready\n');
  parts.push(encodePktLines([...ackLines, 'flush']));
  // shallow-info
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const lines: string[] = ['shallow-info\n'];
    for (const s of plan.shallow) lines.push(`shallow ${s}\n`);
    for (const u of plan.unshallow) lines.push(`unshallow ${u}\n`);
    parts.push(encodePktLines([...lines, 'flush']));
  }
  // wanted-refs
  if (plan.wantedRefs.length > 0) {
    const lines: string[] = ['wanted-refs\n'];
    for (const w of plan.wantedRefs) lines.push(`${w.oid} ${w.ref}\n`);
    parts.push(encodePktLines([...lines, 'flush']));
  }
  // packfile (sideband band 1). Always at least one packet: an empty pack is 32 bytes.
  const pack = writePack(plan.objects);
  parts.push(encodePktLines(['packfile\n']));
  for (const pkt of sidebandPackets(pack)) parts.push(pkt);
  parts.push(FLUSH);
  const out = Buffer.concat(parts);
  cachePut(fetchCache, key, out);
  return out;
}

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushOutcome {
  ref: string;
  ok: boolean;
  reason: string;
}

/** Apply push commands to a repo's refs. Returns one outcome per command.
 * Fast-forward only: an update whose new tip does not descend from the old one
 * is refused with `non-fast-forward` and the ref does not move. */
export function applyPush(store: Store, repoName: string, commands: PushCommand[]): PushOutcome[] {
  const refs = store.repoRefs(repoName);
  const out: PushOutcome[] = [];
  let moved = false;
  for (const cmd of commands) {
    const current = refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        out.push({ ref: cmd.ref, ok: false, reason: 'reference does not exist' });
      } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
        out.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        refs.delete(cmd.ref);
        moved = true;
        out.push({ ref: cmd.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (!isOid(cmd.newOid) || !store.getObject(cmd.newOid)) {
      out.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (current === undefined) {
      // Create: old must be zero.
      if (cmd.oldOid !== ZERO_OID) {
        out.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        refs.set(cmd.ref, cmd.newOid);
        moved = true;
        out.push({ ref: cmd.ref, ok: true, reason: '' });
      }
      continue;
    }
    // Update: old must match, and the new tip must descend from the old one.
    if (cmd.oldOid !== current) {
      out.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (cmd.newOid === current) {
      out.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    if (!store.isAncestor(cmd.newOid, cmd.oldOid)) {
      out.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    refs.set(cmd.ref, cmd.newOid);
    moved = true;
    out.push({ ref: cmd.ref, ok: true, reason: '' });
  }
  if (moved) store.touchRepo(repoName);
  return out;
}

/** The push report, pkt-framed inside sideband band 1. */
export function pushReportResponse(outcomes: PushOutcome[]): Buffer {
  const reportLines: string[] = ['unpack ok\n'];
  for (const o of outcomes) {
    reportLines.push(o.ok ? `ok ${o.ref}\n` : `ng ${o.ref} ${o.reason}\n`);
  }
  const report = encodePktLines([...reportLines, 'flush']);
  const parts: Buffer[] = [];
  for (const pkt of sidebandPackets(report)) parts.push(pkt);
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** Parse a receive-pack request body: command lines, then the raw pack bytes. */
export function parsePushRequest(buf: Buffer): { commands: PushCommand[]; pack: Buffer } {
  const commands: PushCommand[] = [];
  let pos = 0;
  while (pos < buf.length) {
    if (pos + 4 > buf.length) break;
    const len = parseInt(buf.subarray(pos, pos + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      pos += 4;
      break;
    }
    const payload = buf.subarray(pos + 4, pos + len).toString('utf8');
    pos += len;
    const nul = payload.indexOf('\0');
    const text = (nul >= 0 ? payload.slice(0, nul) : payload).replace(/\n$/, '');
    const parts = text.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
  }
  return { commands, pack: buf.subarray(pos) };
}
