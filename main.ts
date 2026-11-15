// Entry point: start the forge on an ephemeral port, register that port with the
// harness, then wait for the harness to say the suite is done. The forge is one
// process and one in-memory store; it exits cleanly only after /done says so.

import { createAppServer, makeStore } from './app.ts';

const envUrl = process.env.MAKEFUN_ENV_URL ?? '';
if (!envUrl) {
  console.error('MAKEFUN_ENV_URL is not set');
  process.exit(1);
}

const store = makeStore();
const server = createAppServer(store);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** POST {port} to the harness register endpoint, retrying on transient failures. */
async function register(port: number): Promise<void> {
  let delay = 250;
  for (;;) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      let res: Response;
      try {
        res = await fetch(`${envUrl}/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (res.ok) return;
      console.error(`register answered HTTP ${res.status}; retrying`);
    } catch (err) {
      console.error(`register failed: ${err instanceof Error ? err.message : String(err)}; retrying`);
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 5000);
  }
}

/** Long-poll the harness until it reports the suite is finished. */
async function waitForDone(): Promise<void> {
  for (;;) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      let res: Response;
      try {
        res = await fetch(`${envUrl}/done`, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      if (res.ok) {
        const data = (await res.json()) as { done?: boolean };
        if (data.done === true) return;
      }
    } catch {
      // A failed poll is transient; keep waiting.
    }
    await sleep(1000);
  }
}

const host = process.env.MAKEFUN_ENV_HOST ?? '0.0.0.0';

// A local runner (or the pod) may stop the entry with a signal; shut the server
// down cleanly instead of dying mid-request, and never let an unhandled rejection
// take the forge down silently.
let shuttingDown = false;
function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 2000).unref();
}
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
process.on('unhandledRejection', (reason) => {
  console.error('unhandled rejection:', reason instanceof Error ? reason.message : String(reason));
});

server.listen(0, host, () => {
  const address = server.address();
  if (!address || typeof address === 'string') {
    console.error('could not determine the listening port');
    process.exit(1);
  }
  const port = address.port;
  console.error(`forge listening on ${host}:${port}`);
  register(port)
    .then(() => waitForDone())
    .then(() => {
      server.close(() => process.exit(0));
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
});
