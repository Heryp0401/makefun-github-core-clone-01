// HTTP server: routing, auth, request ids, body reading. Dispatches to the
// REST, GraphQL, MCP and git handlers. Every reply carries a non-empty
// X-GitHub-Request-Id and an explicit Content-Length (no chunked encoding).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Store } from './lib/store.ts';
import { handleRest, parseQuery, type RestResult } from './lib/rest.ts';
import { handleGraphql } from './lib/graphql.ts';
import { handleMcp } from './lib/mcp.ts';
import { handleGit } from './lib/git.ts';

export function makeStore(): Store {
  return new Store();
}

const JSON_TYPE = 'application/json; charset=utf-8';

function send(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string | Buffer,
  reqId: string,
  extraHeaders?: Record<string, string>,
): void {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  const headers: Record<string, string | number> = {
    'Content-Type': contentType,
    'Content-Length': buf.length,
    'X-GitHub-Request-Id': reqId,
  };
  if (extraHeaders) for (const k of Object.keys(extraHeaders)) headers[k] = extraHeaders[k];
  res.writeHead(status, headers);
  res.end(buf);
}

function sendJson(res: ServerResponse, status: number, body: string, reqId: string, extra?: Record<string, string>): void {
  send(res, status, JSON_TYPE, body, reqId, extra);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.alloc(0)));
  });
}

export function createAppServer(store: Store, token: string) {
  let reqId = 0;
  const server = createServer((req, res) => {
    void handleRequest(store, token, req, res, (++reqId).toString(16)).catch((e) => {
      console.error('[forge] handler error', e instanceof Error ? e.stack ?? e.message : e);
      try {
        if (!res.headersSent) sendJson(res, 500, '{"message":"Internal Server Error"}', '0');
        else res.end();
      } catch {
        // ignore
      }
    });
  });
  return server;
}

async function handleRequest(
  store: Store,
  token: string,
  req: IncomingMessage,
  res: ServerResponse,
  reqId: string,
): Promise<void> {
  const url = req.url ?? '/';
  const qIdx = url.indexOf('?');
  const path = qIdx === -1 ? url : url.slice(0, qIdx);
  const qs = qIdx === -1 ? '' : url.slice(qIdx + 1);
  const method = req.method ?? 'GET';

  // Health check (no auth): the harness calls it while booting.
  if (path === '/healthz') {
    sendJson(res, 200, '{"ok":true}', reqId);
    return;
  }

  const authed = (): boolean => {
    if (!token) return true;
    const h = req.headers.authorization;
    return typeof h === 'string' && h === 'Bearer ' + token;
  };

  const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  const body = needsBody ? await readBody(req) : Buffer.alloc(0);

  // REST v3.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!authed()) {
      sendJson(res, 401, '{"message":"Requires authentication"}', reqId);
      return;
    }
    const query = parseQuery(qs);
    const result: RestResult = handleRest(store, method, path.slice(7), query, body, req.headers.host ?? '');
    sendJson(res, result.status, result.body as string, reqId, result.headers);
    return;
  }

  // GraphQL v4.
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 404, '{"message":"Not Found"}', reqId);
      return;
    }
    if (!authed()) {
      sendJson(res, 401, '{"message":"Requires authentication"}', reqId);
      return;
    }
    const result = handleGraphql(store, body);
    sendJson(res, result.status, result.body, reqId);
    return;
  }

  // MCP (Streamable HTTP).
  if (path === '/mcp') {
    if (method === 'DELETE') {
      send(res, 200, JSON_TYPE, '', reqId);
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 404, '{"message":"Not Found"}', reqId);
      return;
    }
    if (!authed()) {
      sendJson(res, 401, '{"message":"Requires authentication"}', reqId);
      return;
    }
    const result = handleMcp(store, body);
    sendJson(res, result.status, result.body, reqId);
    return;
  }

  // Git smart HTTP. Auth is permissive here: the git adapter may present
  // the token as Bearer, as Basic, or not at all; the global 401 rule is
  // enforced on the API surfaces above.
  if (path.includes('.git/') || path.endsWith('.git')) {
    const gitProtocolV2 = (req.headers['git-protocol'] as string | undefined) === 'version=2';
    const query = parseQuery(qs);
    const result = handleGit(store, method, path, query, body, gitProtocolV2);
    send(res, result.status, result.contentType, result.body, reqId);
    return;
  }

  sendJson(res, 404, '{"message":"Not Found"}', reqId);
}
