// Git smart-HTTP surface: pkt-line framing, packfiles, ref advertisements,
// protocol v2 ls-refs/fetch, v0 fetch, and receive-pack pushes.
// Written from the wire behaviour the suite's client expects; no git binary.

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  ZERO_OID,
  isOid,
  loadObject,
  saveObject,
  peelToCommit,
  fetchPlan,
  readCommit,
  type GitObject,
  type ObjKind,
  type Vault,
} from './store.ts';

export interface WireResult {
  status: number;
  body: Buffer;
  contentType: string;
}

const TYPE_CODE: Record<ObjKind, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjKind> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PKT_MAX = 65520;

/** Thrown when a request body is not a well-formed pkt-line stream. */
export class WireError extends Error {}

// ---- pkt-line ----------------------------------------------------------------

function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length + 4 > PKT_MAX) throw new WireError('pkt-line payload too large');
  const head = Buffer.alloc(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

export type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

/** Decode a whole buffer into packets; a trailing raw section is returned as `rest`. */
export function splitPkts(buf: Buffer): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let at = 0;
  while (at < buf.length) {
    if (at + 4 > buf.length) throw new WireError('truncated pkt-line header');
    const head = buf.subarray(at, at + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new WireError(`bad pkt-line length ${JSON.stringify(head)}`);
    const len = parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      at += 4;
      // A flush ends the command section of a receive-pack request; what follows is the pack.
      return { packets, rest: buf.subarray(at) };
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      at += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'end' });
      at += 4;
      continue;
    }
    if (len < 4 || len > PKT_MAX) throw new WireError(`pkt-line length ${len} out of range`);
    if (at + len > buf.length) throw new WireError('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(at + 4, at + len) });
    at += len;
  }
  return { packets, rest: Buffer.alloc(0) };
}

function dataLines(packets: Pkt[]): string[] {
  const lines: string[] = [];
  for (const p of packets) {
    if (p.kind === 'data') lines.push(p.payload.toString('utf8'));
  }
  return lines;
}

/** Wrap pack bytes in sideband band-1 packets (each <= PKT_MAX incl. framing). */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const chunk = PKT_MAX - 4 - 1;
  for (let at = 0; at < pack.length; at += chunk) {
    const slice = pack.subarray(at, Math.min(at + chunk, pack.length));
    parts.push(pkt(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (pack.length === 0) {
    // A zero-object pack is still 32 bytes, so this never triggers; kept for safety.
    parts.push(pkt(Buffer.from([1])));
  }
  return Buffer.concat(parts);
}

// ---- packfiles ----------------------------------------------------------------

/** Encode a packfile header varint: type in the high bits, size in the low bits. */
function packHeader(type: ObjKind, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let rest = size;
  let first = (code << 4) | (rest & 0x0f);
  rest = Math.floor(rest / 16);
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas), oids sorted for determinism. */
export function buildPack(objects: Map<string, GitObject>): Buffer {
  const list = [...objects.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 4, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(list.length, 8);
  parts.push(head);
  for (const [, obj] of list) {
    parts.push(packHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Parse a packfile the client pushed; verifies the trailer and every entry's size. */
export function parsePack(buf: Buffer): Array<{ type: ObjKind; data: Buffer; oid: string }> {
  if (buf.length < 32) throw new WireError('pack too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new WireError('pack has no PACK header');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new WireError(`pack version ${version} unsupported`);
  const count = buf.readUInt32BE(8);
  const trailerAt = buf.length - 20;
  const trailer = buf.subarray(trailerAt).toString('hex');
  const expect = createHash('sha1').update(buf.subarray(0, trailerAt)).digest('hex');
  if (trailer !== expect) throw new WireError('pack trailer checksum mismatch');
  const out: Array<{ type: ObjKind; data: Buffer; oid: string }> = [];
  let at = 12;
  for (let i = 0; i < count; i += 1) {
    if (at >= trailerAt) throw new WireError('pack truncated');
    let byte = buf[at];
    const first = byte;
    let size = byte & 0x0f;
    let shift = 4;
    at += 1;
    while (byte & 0x80) {
      if (at >= trailerAt) throw new WireError('pack size varint truncated');
      byte = buf[at++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const code = (first >> 4) & 0x07;
    if (code === 6 || code === 7) throw new WireError('delta pack entries are not accepted on push');
    const type = CODE_TYPE[code];
    if (!type) throw new WireError(`pack entry type code ${code} unknown`);
    let inflated: Buffer;
    try {
      const res = inflateSync(buf.subarray(at, trailerAt), { info: true }) as unknown as {
        buffer: Buffer;
        engine: { bytesWritten: number };
      };
      inflated = res.buffer;
      at += res.engine.bytesWritten;
    } catch (err) {
      throw new WireError(`pack entry did not inflate: ${(err as Error).message}`);
    }
    if (inflated.length !== size) throw new WireError('pack entry size mismatch');
    const head = Buffer.from(`${type} ${inflated.length}\0`, 'ascii');
    const oid = createHash('sha1').update(head).update(inflated).digest('hex');
    out.push({ type, data: inflated, oid });
  }
  if (at !== trailerAt) throw new WireError('pack has stray bytes before the trailer');
  return out;
}

// ---- ref advertisements ------------------------------------------------------

function sortedRefNames(v: Vault, repo: string): string[] {
  const table = v.refTable.get(repo);
  if (!table) return [];
  return [...table.keys()].sort();
}

function refOid(v: Vault, repo: string, ref: string): string | undefined {
  return v.refTable.get(repo)?.get(ref);
}

function defaultBranchOf(v: Vault, repo: string): string {
  return v.catalog.get(repo)?.branch ?? 'main';
}

function tipOfDefault(v: Vault, repo: string): string | undefined {
  return refOid(v, repo, `refs/heads/${defaultBranchOf(v, repo)}`);
}

/** Protocol v2 capability advertisement for upload-pack. */
export function v2Advertisement(service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const lines = [
    `# service=${service}\n`,
    'version 2\n',
    'fetch=shallow wait-for-done\n',
    'ls-refs\n',
    'object-format=sha1\n',
    'agent=forge/1.0\n',
  ];
  return Buffer.concat([...lines.map((l) => pkt(l)), FLUSH]);
}

/** Protocol v0 ref advertisement (used for receive-pack, and for v0 upload-pack). */
export function v0Advertisement(
  v: Vault,
  repo: string,
  service: 'git-upload-pack' | 'git-receive-pack',
): Buffer {
  const caps =
    service === 'git-receive-pack'
      ? 'symref=HEAD:refs/heads/main report-status side-band-64k delete-refs ofs-delta agent=forge/1.0'
      : 'symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta shallow multi_ack agent=forge/1.0';
  const parts: Buffer[] = [pkt(`# service=${service}\n`)];
  const names = sortedRefNames(v, repo);
  if (names.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const tip = tipOfDefault(v, repo) ?? ZERO_OID;
    parts.push(pkt(`${tip} HEAD\0${caps}\n`));
    for (const name of names) {
      const oid = refOid(v, repo, name)!;
      parts.push(pkt(`${oid} ${name}\n`));
      const obj = loadObject(v, oid);
      if (name.startsWith('refs/tags/') && obj && obj.type === 'tag') {
        const peeled = peelToCommit(v, oid);
        parts.push(pkt(`${peeled} ${name}^{}\n`));
      }
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

export function infoRefs(
  v: Vault,
  repo: string,
  service: 'git-upload-pack' | 'git-receive-pack',
  wantV2: boolean,
): WireResult {
  if (!v.catalog.has(repo)) {
    return {
      status: 404,
      body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8'),
      contentType: 'application/json',
    };
  }
  if (service === 'git-upload-pack' && wantV2) {
    return { status: 200, body: v2Advertisement(service), contentType: 'application/x-git-upload-pack-advertisement' };
  }
  return {
    status: 200,
    body: v0Advertisement(v, repo, service),
    contentType: `application/x-${service}-advertisement`,
  };
}

// ---- ls-refs (protocol v2) ----------------------------------------------------

export function lsRefs(v: Vault, repo: string, body: Buffer): WireResult {
  const { packets } = splitPkts(body);
  const lines = dataLines(packets);
  if (!lines[0]?.startsWith('command=ls-refs')) throw new WireError('ls-refs needs command=ls-refs');
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const raw of lines.slice(1)) {
    const text = raw.replace(/\n$/, '');
    // Pre-delim lines are agent= / object-format=; the args follow them.
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
    // 'unborn' is ignored: an empty repo advertises no refs at all.
  }
  const keep = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: Buffer[] = [];
  const tip = tipOfDefault(v, repo);
  if (tip && symrefs && keep('HEAD')) {
    out.push(pkt(`${tip} HEAD symref-target:refs/heads/${defaultBranchOf(v, repo)}\n`));
  }
  for (const name of sortedRefNames(v, repo)) {
    if (!keep(name)) continue;
    const oid = refOid(v, repo, name)!;
    let suffix = '';
    const obj = loadObject(v, oid);
    if (peel && name.startsWith('refs/tags/') && obj && obj.type === 'tag') {
      suffix = ` peeled:${peelToCommit(v, oid)}`;
    }
    out.push(pkt(`${oid} ${name}${suffix}\n`));
  }
  out.push(FLUSH);
  return { status: 200, body: Buffer.concat(out), contentType: 'application/x-git-upload-pack-result' };
}

// ---- fetch --------------------------------------------------------------------

interface FetchAsk {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseFetchV2(lines: string[]): FetchAsk {
  if (!lines[0]?.startsWith('command=fetch')) throw new WireError('fetch needs command=fetch');
  const ask: FetchAsk = { wants: [], haves: [], shallow: [], depth: null };
  for (const raw of lines.slice(1)) {
    const text = raw.replace(/\n$/, '');
    if (text.startsWith('want ')) ask.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) ask.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) ask.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) ask.depth = parseInt(text.slice(7).trim(), 10);
    // thin-pack / no-progress / ofs-delta / done / agent= / object-format= need no action.
  }
  return ask;
}

function parseFetchV0(lines: string[]): FetchAsk {
  const ask: FetchAsk = { wants: [], haves: [], shallow: [], depth: null };
  for (const raw of lines) {
    const text = raw.replace(/\n$/, '');
    if (text.startsWith('want ')) {
      const rest = text.slice(5).trim();
      ask.wants.push(rest.split(' ')[0]);
    } else if (text.startsWith('have ')) ask.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) ask.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) ask.depth = parseInt(text.slice(7).trim(), 10);
  }
  return ask;
}

function fetchResponse(v: Vault, repo: string, ask: FetchAsk, v2: boolean): WireResult {
  for (const want of ask.wants) {
    if (!isOid(want)) throw new WireError(`fetch wants a bad object id ${want}`);
  }
  const plan = fetchPlan(v, ask.wants, ask.haves, ask.shallow, ask.depth);
  const pack = buildPack(plan.objects);
  if (v2) {
    const parts: Buffer[] = [pkt('acknowledgments\n'), pkt('NAK\n'), FLUSH];
    if (plan.shallow.length || plan.unshallow.length) {
      parts.push(pkt('shallow-info\n'));
      for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
      parts.push(FLUSH);
    }
    parts.push(pkt('packfile\n'));
    parts.push(sidebandPack(pack));
    parts.push(FLUSH);
    return { status: 200, body: Buffer.concat(parts), contentType: 'application/x-git-upload-pack-result' };
  }
  // v0: plain NAK / shallow lines, then the sideband pack.
  const parts: Buffer[] = [pkt('NAK\n')];
  for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
  parts.push(sidebandPack(pack));
  return { status: 200, body: Buffer.concat(parts), contentType: 'application/x-git-upload-pack-result' };
}

export function uploadPack(v: Vault, repo: string, body: Buffer, wantV2: boolean): WireResult {
  const { packets } = splitPkts(body);
  const lines = dataLines(packets);
  if (lines.length === 0) throw new WireError('upload-pack got an empty request');
  if (lines[0].startsWith('command=ls-refs')) return lsRefs(v, repo, body);
  if (lines[0].startsWith('command=fetch')) {
    return fetchResponse(v, repo, parseFetchV2(lines), true);
  }
  if (lines[0].startsWith('want ')) {
    // A v0 fetch: wants, then a flush, then haves/done. splitPkts stops at the
    // first flush, so re-decode the whole body manually here.
    return fetchResponse(v, repo, parseFetchV0(lines), false);
  }
  throw new WireError(`upload-pack got an unknown command ${JSON.stringify(lines[0].slice(0, 40))}`);
}

// ---- receive-pack -------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function receivePack(v: Vault, repo: string, body: Buffer): WireResult {
  const { packets, rest } = splitPkts(body);
  const lines = dataLines(packets);
  const commands: PushCommand[] = [];
  for (const raw of lines) {
    const text = raw.replace(/\n$/, '');
    if (!text) continue;
    const nul = text.indexOf('\0');
    const head = nul < 0 ? text : text.slice(0, nul);
    const parts = head.split(' ');
    if (parts.length < 3) throw new WireError(`bad push command ${JSON.stringify(text.slice(0, 60))}`);
    const [oldOid, newOid, ref] = parts;
    if (!isOid(oldOid) || !isOid(newOid) || !ref.startsWith('refs/')) {
      throw new WireError(`bad push command ${JSON.stringify(text.slice(0, 60))}`);
    }
    commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) throw new WireError('push with no commands');
  const updates = commands.some((c) => c.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (updates) {
    if (rest.length === 0) {
      unpackOk = false;
      unpackDetail = 'unpacker error';
    } else {
      try {
        const entries = parsePack(rest);
        for (const entry of entries) saveObject(v, entry.type, entry.data);
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : 'unpacker error';
      }
    }
  }
  const table = v.refTable.get(repo) ?? new Map<string, string>();
  v.refTable.set(repo, table);
  const reportLines: string[] = [];
  if (!unpackOk) {
    reportLines.push(`unpack ${unpackDetail}\n`);
    for (const c of commands) reportLines.push(`ng ${c.ref} unpacker error\n`);
  } else {
    reportLines.push('unpack ok\n');
    for (const c of commands) {
      const current = table.get(c.ref);
      if (c.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          reportLines.push(`ng ${c.ref} ref does not exist\n`);
        } else if (c.oldOid !== ZERO_OID && c.oldOid !== current) {
          reportLines.push(`ng ${c.ref} old value does not match\n`);
        } else {
          table.delete(c.ref);
          reportLines.push(`ok ${c.ref}\n`);
        }
        continue;
      }
      // Create or update.
      if (!loadObject(v, c.newOid)) {
        reportLines.push(`ng ${c.ref} object not found\n`);
        continue;
      }
      if (current === undefined) {
        if (c.oldOid !== ZERO_OID) {
          reportLines.push(`ng ${c.ref} old value does not match\n`);
          continue;
        }
        table.set(c.ref, c.newOid);
        reportLines.push(`ok ${c.ref}\n`);
        continue;
      }
      if (c.oldOid !== current) {
        reportLines.push(`ng ${c.ref} old value does not match\n`);
        continue;
      }
      // Fast-forward only: the new tip must descend from the old tip.
      const newObj = loadObject(v, c.newOid);
      if (!newObj || newObj.type !== 'commit') {
        reportLines.push(`ng ${c.ref} new tip is not a commit\n`);
        continue;
      }
      if (!ancestorCheck(v, c.newOid, current)) {
        reportLines.push(`ng ${c.ref} non-fast-forward\n`);
        continue;
      }
      table.set(c.ref, c.newOid);
      reportLines.push(`ok ${c.ref}\n`);
    }
  }
  const reportStream = Buffer.concat(reportLines.map((l) => pkt(l)));
  const framed = Buffer.concat([pkt(Buffer.concat([Buffer.from([1]), reportStream])), FLUSH]);
  return { status: 200, body: framed, contentType: 'application/x-git-receive-pack-result' };
}

/** Local helper: true when `tip` descends from `base` (or equals it). */
function ancestorCheck(v: Vault, tip: string, base: string): boolean {
  if (tip === base) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop()!;
    if (oid === base) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = loadObject(v, oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of readCommit(obj.data).parents) stack.push(parent);
  }
  return false;
}
