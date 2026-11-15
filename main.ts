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

/** Shut the server down cleanly (the harness ends a trial with SIGTERM). */
let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => {
    process.exit(0);
  });
  // If close hangs, force the exit shortly after.
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

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
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ port }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        console.error(`register rejected with HTTP ${res.status}`);
        process.exit(1);
      }
      console.error(`register got HTTP ${res.status}; retrying in ${delay}ms`);
    } catch (e) {
      console.error(`register failed (${e instanceof Error ? e.message : String(e)}); retrying in ${delay}ms`);
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }
}

/** Long-poll GET /done until the harness reports the suite finished. */
async function waitForDone(): Promise<void> {
  for (;;) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      let res: Response;
      try {
        res = await fetch(`${envUrl}/done`, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      } else {
        console.error(`done poll got HTTP ${res.status}; retrying`);
      }
    } catch (e) {
      console.error(`done poll failed (${e instanceof Error ? e.message : String(e)}); retrying`);
    }
    await sleep(250);
  }
}

server.listen(0, async () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  if (!port) {
    console.error('could not determine the listening port');
    process.exit(1);
  }
  console.error(`forge listening on port ${port}`);
  await register(port);
  console.error(`forge registered with harness at ${envUrl}`);
  await waitForDone();
  shutdown();
});
