// HTTP front door: reads bodies, enforces the bearer token, routes to the four
// surfaces, and stamps every reply with an X-GitHub-Request-Id. The server never
// crashes on a bad request: a malformed body is a 400, anything else a 500.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { makeStore, ownerMatches, type Vault } from './lib/store.ts';
import { infoRefs, receivePack, uploadPack, WireError } from './lib/git.ts';
import { restRoute } from './lib/rest.ts';
import { graphqlRoute } from './lib/graphql.ts';
import { mcpRoute } from './lib/mcp.ts';

export { makeStore };
export type { Vault };

const MAX_BODY = 64 * 1024 * 1024;

function shopToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

/** The bearer <redacted> the request carries, or '' when absent. */
function bearerOf(req: IncomingMessage): string {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match ? match[1] : '';
}

function sendJson(res: ServerResponse, status: number, value: unknown, extra?: Record<string, string>): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  sendRaw(res, status, body, 'application/json', extra);
}

function sendRaw(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  extra?: Record<string, string>,
): void {
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Content-Length': String(body.length),
    'X-GitHub-Request-Id': randomUUID(),
  };
  for (const [key, value] of Object.entries(extra ?? {})) headers[key] = value;
  res.writeHead(status, headers);
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY) {
        tooBig = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) reject(new Error('request body too large'));
      else resolve(chunks.length ? Buffer.concat(chunks) : null);
    });
    req.on('error', reject);
  });
}

function splitPath(req: IncomingMessage): { segs: string[]; query: URLSearchParams; origin: string } {
  // The origin comes from the Host header the client actually dialed; the URL
  // the server sees is only a path, and a hardcoded base would leak localhost
  // into Link headers and resource URLs.
  const host = req.headers.host ?? 'localhost';
  const parsed = new URL(req.url ?? '/', `http://${host}`);
  const segs = parsed.pathname
    .split('/')
    .filter((s) => s !== '')
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  const origin = `http://${parsed.host}`;
  return { segs, query: parsed.searchParams, origin };
}

export function createAppServer(vault: Vault): Server {
  const expected = shopToken();
  const authed = (req: IncomingMessage): boolean => {
    const token = bearerOf(req);
    return expected === '' ? token.length > 0 : token === expected;
  };

  return createServer(async (req, res) => {
    try {
      const { segs, query, origin } = splitPath(req);
      const method = req.method ?? 'GET';

      // Liveness probe, no auth.
      if (method === 'GET' && segs.length === 1 && segs[0] === 'healthz') {
        sendJson(res, 200, { status: 'ok' });
        return;
      }

      const body = await readBody(req);

      // Git smart HTTP: /{owner}/{repo}.git/...
      if (segs.length >= 2 && segs[1].endsWith('.git')) {
        const owner = segs[0];
        const repo = segs[1].slice(0, -'.git'.length);
        if (!authed(req)) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        if (!ownerMatches(vault, owner)) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        const service = query.get('service');
        const wantV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
        if (method === 'GET' && segs.length === 4 && segs[2] === 'info' && segs[3] === 'refs') {
          if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const out = infoRefs(vault, repo, service, wantV2);
          sendRaw(res, out.status, out.body, out.contentType);
          return;
        }
        if (method === 'POST' && segs.length === 3 && segs[2] === 'git-upload-pack') {
          const out = uploadPack(vault, repo, body ?? Buffer.alloc(0), wantV2);
          sendRaw(res, out.status, out.body, out.contentType);
          return;
        }
        if (method === 'POST' && segs.length === 3 && segs[2] === 'git-receive-pack') {
          const out = receivePack(vault, repo, body ?? Buffer.alloc(0));
          sendRaw(res, out.status, out.body, out.contentType);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      // REST v3: /api/v3/...
      if (segs.length >= 2 && segs[0] === 'api' && segs[1] === 'v3') {
        if (!authed(req)) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        const out = restRoute(vault, { method, segs: segs.slice(2), query, raw: body, origin });
        sendRaw(res, out.status, out.body, out.contentType, out.headers);
        return;
      }

      // GraphQL: POST /api/graphql
      if (method === 'POST' && segs.length === 2 && segs[0] === 'api' && segs[1] === 'graphql') {
        if (!authed(req)) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        const out = graphqlRoute(vault, body);
        sendRaw(res, out.status, out.body, out.contentType);
        return;
      }

      // MCP: POST /mcp
      if (method === 'POST' && segs.length === 1 && segs[0] === 'mcp') {
        if (!authed(req)) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        const out = mcpRoute(vault, body);
        sendRaw(res, out.status, out.body, out.contentType);
        return;
      }

      sendJson(res, 404, { message: 'Not Found' });
    } catch (err) {
      if (err instanceof WireError) {
        sendJson(res, 400, { message: err.message });
        return;
      }
      // A handler must never take the server down with it.
      sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' });
    }
  });
}
