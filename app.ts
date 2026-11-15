// HTTP server: routing, auth, and response framing for the git / REST / GraphQL /
// MCP surfaces. The harness token (MAKEFUN_SHOP_TOKEN) is the only credential;
// every surface except /healthz and the two public REST roots requires it.
//
// Hot-path discipline: no `new URL()` per request (the path and query are split
// by hand), no header copying (Node already lowercases req.headers), and the
// request id is a counter, not a UUID — the timed workloads are 2,000 sequential
// reads and 200 sequential writes, so every microsecond of framing counts.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Store, queryParam, type Ctx, type HandlerResult } from './lib/store.ts';
import {
  v2Advertisement,
  v0UploadAdvertisement,
  v0ReceiveAdvertisement,
  lsRefsResponse,
  parseV2Request,
  fetchV2Response,
  parsePushRequest,
  readPack,
  applyPush,
  pushReportResponse,
} from './lib/git.ts';
import { routeRest } from './lib/rest.ts';
import { routeGraphQL } from './lib/graphql.ts';
import { routeMcp } from './lib/mcp.ts';

export function makeStore(): Store {
  return new Store();
}

function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

/** The bearer token from an Authorization header, or ''. */
function bearerToken(header: string | string[] | undefined): string {
  if (typeof header !== 'string') return '';
  const m = /^Bearer\s+(.+)$/.exec(header.trim());
  return m ? m[1] : '';
}

/** Cheap non-empty request ids: a counter is all the wire rules require. */
let requestSeq = 0;
function nextRequestId(): string {
  requestSeq += 1;
  return `req-${requestSeq}`;
}

function sendResult(res: ServerResponse, result: HandlerResult): void {
  const headers: Record<string, string> = {
    'x-github-request-id': nextRequestId(),
    ...result.headers,
  };
  if (result.raw !== undefined) {
    headers['content-type'] = result.contentType ?? 'application/octet-stream';
    res.writeHead(result.status, headers);
    res.end(result.raw);
    return;
  }
  if (result.text !== undefined) {
    headers['content-type'] = result.contentType ?? 'application/json; charset=utf-8';
    res.writeHead(result.status, headers);
    res.end(result.text);
    return;
  }
  headers['content-type'] = result.contentType ?? 'application/json; charset=utf-8';
  res.writeHead(result.status, headers);
  if (result.status === 204 || result.json === undefined) {
    res.end();
  } else {
    res.end(JSON.stringify(result.json));
  }
}

function notFound(): HandlerResult {
  return { status: 404, json: { message: 'Not Found' } };
}

function unauthorized(): HandlerResult {
  return { status: 401, json: { message: 'Requires authentication' } };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Split a raw request target into decoded path segments and a raw query string. */
function splitTarget(raw: string): { segments: string[]; queryStr: string } {
  const q = raw.indexOf('?');
  const path = q < 0 ? raw : raw.slice(0, q);
  const queryStr = q < 0 ? '' : raw.slice(q + 1);
  const parts = path.split('/');
  const segments: string[] = [];
  for (const part of parts) {
    if (part.length === 0) continue;
    // Most segments are plain ASCII; only decode when percent-encoded.
    if (part.indexOf('%') < 0) {
      segments.push(part);
    } else {
      try {
        segments.push(decodeURIComponent(part));
      } catch {
        segments.push(part);
      }
    }
  }
  return { segments, queryStr };
}

/** Handle one request. Returns the result to send. */
async function handle(store: Store, req: IncomingMessage): Promise<HandlerResult> {
  const { segments, queryStr } = splitTarget(req.url ?? '/');
  const method = (req.method ?? 'GET').toUpperCase();
  const headers = req.headers;
  const origin = `http://${headers.host ?? '127.0.0.1'}`;
  const body = method === 'GET' || method === 'HEAD' ? null : await readBody(req);

  const ctx: Ctx = { method, segments, queryStr, headers, body, origin };

  // /healthz: no auth.
  if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
    return { status: 200, json: { ok: true } };
  }

  // Public REST roots: no auth.
  if (method === 'GET' && segments.length === 2 && segments[0] === 'api' && segments[1] === 'v3') {
    return routeRest(store, ctx) ?? notFound();
  }
  if (method === 'GET' && segments.length === 3 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'meta') {
    return routeRest(store, ctx) ?? notFound();
  }

  // Everything else needs the token.
  const expected = expectedToken();
  const token = bearerToken(headers.authorization);
  const authed = expected === '' ? token.length > 0 : token === expected;
  if (!authed) return unauthorized();

  // Git smart HTTP: /{owner}/{repo}.git/{info/refs|git-upload-pack|git-receive-pack}
  if (segments.length >= 3 && segments[1].endsWith('.git')) {
    const owner = segments[0];
    const repoName = segments[1].slice(0, -'.git'.length);
    const action = segments[2];
    if (!store.isOwner(owner)) return notFound();
    const repo = store.getRepo(repoName);
    if (!repo) return notFound();

    if (method === 'GET' && action === 'info' && segments[3] === 'refs') {
      const service = queryParam(queryStr, 'service') ?? '';
      if (service === 'git-upload-pack') {
        const proto = typeof headers['git-protocol'] === 'string' ? headers['git-protocol'] : '';
        if (proto.includes('version=2')) {
          return { status: 200, raw: v2Advertisement(), contentType: 'application/x-git-upload-pack-advertisement' };
        }
        return { status: 200, raw: v0UploadAdvertisement(store, repoName), contentType: 'application/x-git-upload-pack-advertisement' };
      }
      if (service === 'git-receive-pack') {
        return { status: 200, raw: v0ReceiveAdvertisement(store, repoName), contentType: 'application/x-git-receive-pack-advertisement' };
      }
      return { status: 400, json: { message: 'service is required' } };
    }

    if (method === 'POST' && action === 'git-upload-pack') {
      try {
        const parsed = parseV2Request(body ?? Buffer.alloc(0));
        if (parsed.command === 'ls-refs') {
          const peel = parsed.args.has('peel');
          const symrefs = parsed.args.has('symrefs');
          const prefixes = parsed.args.get('ref-prefix') ?? [];
          return {
            status: 200,
            raw: lsRefsResponse(store, repoName, { peel, symrefs, prefixes }),
            contentType: 'application/x-git-upload-pack-result',
          };
        }
        if (parsed.command === 'fetch') {
          const deepen = parsed.args.get('deepen')?.[0];
          const req2 = {
            wants: parsed.args.get('want') ?? [],
            haves: parsed.args.get('have') ?? [],
            shallow: parsed.args.get('shallow') ?? [],
            depth: deepen !== undefined ? parseInt(deepen, 10) : null,
          };
          return {
            status: 200,
            raw: fetchV2Response(store, repoName, req2),
            contentType: 'application/x-git-upload-pack-result',
          };
        }
        return { status: 400, json: { message: `unknown command ${parsed.command}` } };
      } catch (e) {
        // A malformed upload-pack request must not kill the server.
        return { status: 400, json: { message: e instanceof Error ? e.message : 'bad request' } };
      }
    }

    if (method === 'POST' && action === 'git-receive-pack') {
      try {
        const { commands, pack } = parsePushRequest(body ?? Buffer.alloc(0));
        if (pack.length > 0) {
          const { objects } = readPack(pack);
          for (const [oid, obj] of objects) {
            if (!store.getObject(oid)) store.objects.set(oid, obj);
          }
        }
        const outcomes = applyPush(store, repoName, commands);
        return {
          status: 200,
          raw: pushReportResponse(outcomes),
          contentType: 'application/x-git-receive-pack-result',
        };
      } catch (e) {
        return { status: 400, json: { message: e instanceof Error ? e.message : 'bad request' } };
      }
    }
    return notFound();
  }

  // REST v3.
  if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
    return routeRest(store, ctx) ?? notFound();
  }

  // GraphQL v4.
  if (method === 'POST' && segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
    return routeGraphQL(store, ctx);
  }

  // MCP.
  if (method === 'POST' && segments.length === 1 && segments[0] === 'mcp') {
    return routeMcp(store, ctx);
  }

  return notFound();
}

export function createAppServer(store: Store): ReturnType<typeof createServer> {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const result = await handle(store, req);
        sendResult(res, result);
      } catch (e) {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': nextRequestId() });
          res.end(JSON.stringify({ message: e instanceof Error ? e.message : 'internal error' }));
        } else {
          res.end();
        }
      }
    })();
  });
  return server;
}
