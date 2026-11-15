// Entrypoint: create the store, start the server on an ephemeral port,
// register the port with the harness, long-poll /done and exit 0 when done.
import { makeStore, createAppServer } from './app.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/$/, '');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function register(port: number): Promise<void> {
  // Retry with exponential backoff (200 ms -> 400 ms -> ... capped at 2 s):
  // the harness is usually up already, but a cold start can lag a few
  // seconds, and a fixed retry loop would hammer it.
  let delay = 200;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const r = await fetch(ENV_URL + '/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok) return;
    } catch {
      // The harness may not be listening yet; retry.
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }
  console.error('[forge] could not register with the harness');
}

async function waitDone(): Promise<void> {
  for (;;) {
    await sleep(500);
    try {
      const r = await fetch(ENV_URL + '/done', { signal: AbortSignal.timeout(2000) });
      const j = (await r.json()) as { done?: boolean };
      if (j && j.done === true) return;
    } catch {
      // Transient; keep polling.
    }
  }
}

const store = makeStore();
const server = createAppServer(store, TOKEN);

server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  console.error('[forge] listening on 127.0.0.1:' + port);
  if (!ENV_URL) {
    console.error('[forge] MAKEFUN_ENV_URL is not set; serving without registering');
    return;
  }
  void (async () => {
    await register(port);
    await waitDone();
    server.close(() => process.exit(0));
    // Fall back to a forced exit if close hangs.
    setTimeout(() => process.exit(0), 1000).unref();
  })();
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
