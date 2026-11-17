// HTTP router: one server, four surfaces.
//
//   GET  /healthz                     public, 200 {"ok":true} — the environment's boot probe
//   /{owner}/{repo}.git/*             git smart HTTP (upload-pack v2, receive-pack v0)
//   /api/v3/*                         REST v3
//   /api/graphql                      GraphQL
//   /mcp                              MCP (JSON-RPC 2.0, Streamable HTTP)
//
// Everything except /healthz needs `Authorization: Bearer <token>`; without it the answer
// is 401. The token itself is opaque — the suite's token is derived per trial and the
// server cannot reverse it — so any non-empty Bearer token authenticates as the scenario
// viewer (the login re-derived from the published scenario seed). A repository under any
// other owner is 404, never 403.
//
// Every reply is JSON (or a git binary body) — never HTML — and a handler that throws is
// answered 500 JSON instead of killing the server. Bodies are capped at 64 MiB.

import http from 'node:http';
import { handleGitHttp } from './githttp.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { type Store } from './store.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function jsonResponse(res: http.ServerResponse, status: number, body: string, extraHeaders: Record<string, string> = {}): void {
  // Every reply carries a request id, including the 401 a missing token gets: the REST
  // surface promises one on every response, and the router answers before the REST
  // handler runs.
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...extraHeaders });
  res.end(body);
}

function bearerToken(headers: http.IncomingHttpHeaders): string | null {
  const header = headers.authorization;
  if (typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(.+)$/);
  if (match === null) return null;
  const token = (match[1] as string).trim();
  return token === '' ? null : token;
}

export function createServer(store: Store): http.Server {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    let bodyBytes = 0;
    let bodyTooLarge = false;
    req.on('data', (chunk: Buffer) => {
      bodyBytes += chunk.length;
      if (bodyBytes > MAX_BODY_BYTES) {
        bodyTooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        if (bodyTooLarge) {
          jsonResponse(res, 413, JSON.stringify({ message: 'Request body too large' }));
          return;
        }
        const body = Buffer.concat(chunks);
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const pathname = url.pathname;
        const method = (req.method ?? 'GET').toUpperCase();

        // The boot probe: public, no auth, no request id needed.
        if (pathname === '/healthz') {
          if (method !== 'GET') {
            jsonResponse(res, 405, JSON.stringify({ message: 'Method Not Allowed' }));
            return;
          }
          jsonResponse(res, 200, JSON.stringify({ ok: true }));
          return;
        }

        // Everything else needs a Bearer token.
        const token = bearerToken(req.headers);
        if (token === null) {
          jsonResponse(res, 401, JSON.stringify({ message: 'Requires authentication' }), { 'x-github-request-id': store.nextRequestId() });
          return;
        }

        if (pathname.startsWith('/api/v3')) {
          const headers: Record<string, string | undefined> = {};
          for (const [key, value] of Object.entries(req.headers)) {
            headers[key] = Array.isArray(value) ? value.join(', ') : value;
          }
          const answer = handleRest(
            store,
            { method, path: pathname, query: url.searchParams, headers, body, host: req.headers.host ?? '127.0.0.1' },
            true,
          );
          res.writeHead(answer.status, { ...answer.headers, 'content-length': String(Buffer.byteLength(answer.body)) });
          res.end(answer.body);
          return;
        }
        if (pathname === '/api/graphql') {
          if (method !== 'POST') {
            jsonResponse(res, 405, JSON.stringify({ errors: [{ message: 'Method Not Allowed' }] }));
            return;
          }
          const answer = handleGraphQL(store, body);
          jsonResponse(res, answer.status, answer.body);
          return;
        }
        if (pathname === '/mcp') {
          if (method === 'DELETE') {
            res.writeHead(204);
            res.end();
            return;
          }
          if (method !== 'POST') {
            jsonResponse(res, 405, JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: /mcp needs POST' } }));
            return;
          }
          const answer = handleMcp(store, body);
          jsonResponse(res, answer.status, answer.body);
          return;
        }
        if (/^\/[^/]+\/[^/]+\.git(\/.*)?$/.test(pathname)) {
          const answer = handleGitHttp(store, method, pathname, url.searchParams, req.headers, body);
          const headers: Record<string, string> = { 'content-type': answer.contentType, 'content-length': String(answer.body.length) };
          res.writeHead(answer.status, headers);
          res.end(answer.body);
          return;
        }
        jsonResponse(res, 404, JSON.stringify({ message: 'Not Found' }), { 'x-github-request-id': store.nextRequestId() });
      } catch (err) {
        // A handler must never take the server down with it.
        const message = err instanceof Error ? err.message : 'Internal Server Error';
        try {
          jsonResponse(res, 500, JSON.stringify({ message }), { 'x-github-request-id': store.nextRequestId() });
        } catch {
          // The socket is already gone; nothing more to do.
        }
      }
    });
    req.on('error', () => {
      try {
        jsonResponse(res, 400, JSON.stringify({ message: 'Bad Request' }));
      } catch {
        // The socket is already gone.
      }
    });
  });
  return server;
}

/** Listen on an ephemeral port (0) and report the port the OS assigned. */
export function listenEphemeral(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('could not bind an ephemeral port'));
        return;
      }
      resolve(address.port);
    });
  });
}
