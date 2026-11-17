// Entrypoint: node --experimental-strip-types main.ts
//
// Two modes, picked by environment:
//
//   MAKEFUN_ENV_URL set   — the graded run. Bind an ephemeral port, POST {"port"} to
//                           $MAKEFUN_ENV_URL/register, then long-poll GET $MAKEFUN_ENV_URL/done
//                           and exit 0 when it answers {"done": true}.
//   MAKEFUN_ENV_URL unset — standalone mode (local development and the kit's run.ts):
//                           bind an ephemeral port, print it, and serve until SIGINT/SIGTERM.
//
// The forge is one process with an in-memory store: git smart HTTP, REST v3, GraphQL and
// MCP all read and write the same Store, so a push, a REST call and an MCP tool call see
// each other's objects immediately. Nothing is persisted — the suite's state is the
// conformance run itself, and every response is deterministic (fixed commit timestamps,
// counter request ids, deterministic global ids), so two runs export the same state.

import { createServer, listenEphemeral } from './src/server.ts';
import { Store } from './src/store.ts';

function envUrl(): string | null {
  const value = process.env.MAKEFUN_ENV_URL;
  if (value === undefined || value === '') return null;
  return value.replace(/\/+$/, '');
}

async function postRegister(base: string, port: number): Promise<void> {
  // The environment is expected to be listening already, but a retry loop costs nothing
  // and covers a slow start: keep trying for up to 30 s before giving up.
  const deadline = Date.now() + 30_000;
  let lastError: unknown = null;
  for (;;) {
    try {
      const response = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        throw new Error(`register answered HTTP ${response.status}`);
      }
      return;
    } catch (err) {
      lastError = err;
      if (Date.now() >= deadline) {
        throw new Error(`register failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

async function pollDone(base: string): Promise<void> {
  for (;;) {
    let done = false;
    try {
      const response = await fetch(`${base}/done`, { signal: AbortSignal.timeout(60_000) });
      if (response.ok) {
        const payload = (await response.json()) as { done?: unknown };
        done = payload.done === true;
      }
    } catch {
      // The environment may restart or the long-poll may time out; keep polling.
      done = false;
    }
    if (done) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function main(): Promise<void> {
  const store = new Store();
  const server = createServer(store);
  const port = await listenEphemeral(server);
  const base = envUrl();

  if (base === null) {
    console.log(`github-core-clone-forge listening on http://127.0.0.1:${port} (standalone)`);
  } else {
    await postRegister(base, port);
    await pollDone(base);
    // The run is over: stop accepting, let in-flight requests drain, then exit 0.
    // closeAllConnections first: close() alone waits for idle keep-alive sockets
    // (the suite leaves one open), which would hold the process past the drain.
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      setTimeout(resolve, 1000);
    });
    process.exit(0);
  }

  const shutdown = (): void => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
