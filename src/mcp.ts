// MCP at /mcp: JSON-RPC 2.0 over Streamable HTTP, modern era revision 2026-07-28.
//
// No handshake and no session: every request declares its revision in `_meta` and in the
// `MCP-Protocol-Version` header, and `server/discover` answers the server's identity,
// capabilities and supported revisions in one call. The legacy handshake era is answered
// too (`initialize` + `notifications/initialized`), so an older client still connects.
//
// Six tools, canonical property names so the suite can fill every argument from its own
// schema map: create_repo, get_repo, create_issue, list_issues, create_pull_request and
// merge_pull_request. The tools list is one frozen constant — two `tools/list` calls are
// byte-identical. Every tool result carries both a text block and a `structuredContent`
// object with the same JSON, so the suite reads ids and numbers either way.
//
// Errors: an unknown method is -32601, an unknown tool -32602, a tool call missing a
// required argument is a tool-level error (`isError: true`) — never an HTTP 500. A body
// that is not JSON is HTTP 400 with JSON-RPC -32700. No Authorization header is 401.
// A notification (a request with no `id`) is answered 202 with an empty body.

import { VIEWER_LOGIN } from './scenario.ts';
import { type Store } from './store.ts';

export const MCP_REVISION = '2026-07-28';
export const MCP_SUPPORTED_REVISIONS: readonly string[] = ['2026-07-28', '2025-11-25', '2025-06-18'];

const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';

// ---------------------------------------------------------------------------------------------
// the tool catalogue: one frozen constant, serialized the same way every time
// ---------------------------------------------------------------------------------------------

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: boolean;
  };
}

const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login that owns the repository.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login that owns the repository.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login that owns the repository.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login that owns the repository.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login that owns the repository.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

const TOOLS_LIST_JSON = JSON.stringify({ tools: TOOLS });

function toolResult(payload: Record<string, unknown>, isError = false): Record<string, unknown> {
  const text = JSON.stringify(payload);
  const result: Record<string, unknown> = { content: [{ type: 'text', text }], structuredContent: payload };
  if (isError) result.isError = true;
  return result;
}

function toolError(message: string): Record<string, unknown> {
  return toolResult({ error: message }, true);
}

// ---------------------------------------------------------------------------------------------
// tools/call implementations (the store is the same one REST writes)
// ---------------------------------------------------------------------------------------------

function missingArg(tool: ToolDefinition, args: Record<string, unknown>): string | null {
  for (const name of tool.inputSchema.required) {
    if (args[name] === undefined || args[name] === null || args[name] === '') return name;
  }
  return null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) {
    return { __rpcError: { code: -32602, message: `unknown tool: ${name}` } };
  }
  const missing = missingArg(tool, args);
  if (missing !== null) {
    return toolError(`missing required argument: ${missing}`);
  }
  switch (name) {
    case 'create_repo': {
      const created = store.createRepo(VIEWER_LOGIN, String(args.name), typeof args.description === 'string' ? args.description : '', args.private === true);
      if ('error' in created) return toolError(created.error);
      return toolResult({
        id: created.id,
        name: created.name,
        full_name: `${created.owner}/${created.name}`,
        private: created.isPrivate,
        description: created.description,
        default_branch: created.defaultBranch,
      });
    }
    case 'get_repo': {
      const owner = String(args.owner);
      const repo = store.getRepo(owner, String(args.repo));
      if (repo === undefined) return toolError(`repository not found: ${owner}/${args.repo}`);
      return toolResult({
        id: repo.id,
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        private: repo.isPrivate,
        description: repo.description,
        default_branch: repo.defaultBranch,
      });
    }
    case 'create_issue': {
      const owner = String(args.owner);
      const repo = store.getRepo(owner, String(args.repo));
      if (repo === undefined) return toolError(`repository not found: ${owner}/${args.repo}`);
      const created = store.createIssue(repo, { title: String(args.title), body: typeof args.body === 'string' ? args.body : '' });
      if ('error' in created) return toolError(created.error);
      return toolResult({
        number: created.number,
        title: created.title,
        body: created.body,
        state: created.state,
        repository: `${repo.owner}/${repo.name}`,
      });
    }
    case 'list_issues': {
      const owner = String(args.owner);
      const repo = store.getRepo(owner, String(args.repo));
      if (repo === undefined) return toolError(`repository not found: ${owner}/${args.repo}`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = store.listIssues(repo, state === 'all' ? 'all' : state === 'closed' ? 'closed' : 'open');
      return toolResult({
        issues: issues.map((issue) => ({ number: issue.number, title: issue.title, body: issue.body, state: issue.state })),
      });
    }
    case 'create_pull_request': {
      const owner = String(args.owner);
      const repo = store.getRepo(owner, String(args.repo));
      if (repo === undefined) return toolError(`repository not found: ${owner}/${args.repo}`);
      const created = store.createPull(repo, {
        head: String(args.head),
        base: String(args.base),
        title: String(args.title),
        body: '',
      });
      if ('error' in created) return toolError(created.error);
      return toolResult({
        number: created.number,
        title: created.title,
        state: created.state,
        head: created.headRef,
        base: created.baseRef,
        repository: `${repo.owner}/${repo.name}`,
      });
    }
    case 'merge_pull_request': {
      const owner = String(args.owner);
      const repo = store.getRepo(owner, String(args.repo));
      if (repo === undefined) return toolError(`repository not found: ${owner}/${args.repo}`);
      const pull = store.getPull(repo, Number(args.pull_number));
      if (pull === undefined) return toolError(`pull request not found: ${args.pull_number}`);
      const merged = store.mergePull(repo, pull);
      if ('error' in merged) return toolError(merged.error);
      return toolResult({ number: pull.number, merged: true, sha: merged.sha, state: 'closed' });
    }
    default:
      return { __rpcError: { code: -32602, message: `unknown tool: ${name}` } };
  }
}

// ---------------------------------------------------------------------------------------------
// JSON-RPC 2.0
// ---------------------------------------------------------------------------------------------

export interface McpBody {
  status: number;
  body: string;
}

function rpcResult(id: unknown, result: unknown): McpBody {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, result }) };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): McpBody {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, error }) };
}

function negotiatedRevision(params: unknown): string {
  if (typeof params === 'object' && params !== null) {
    const version = (params as Record<string, unknown>).protocolVersion;
    if (typeof version === 'string' && (MCP_SUPPORTED_REVISIONS as readonly string[]).includes(version)) return version;
  }
  return MCP_REVISION;
}

export function handleMcp(store: Store, rawBody: Buffer): McpBody {
  let request: unknown;
  try {
    request = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return {
      status: 400,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: the request body is not valid JSON' } }),
    };
  }
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return {
      status: 400,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: expected a JSON-RPC object' } }),
    };
  }
  const record = request as Record<string, unknown>;
  const id = record.id === undefined ? null : record.id;
  const isNotification = record.id === undefined;
  const method = typeof record.method === 'string' ? record.method : '';
  const params = record.params === undefined ? {} : record.params;

  if (isNotification) {
    // A notification gets no JSON-RPC answer: 202 with an empty body.
    return { status: 202, body: '' };
  }

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: [...MCP_SUPPORTED_REVISIONS],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      });
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: negotiatedRevision(params),
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    case 'tools/list':
      return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, result: JSON.parse(TOOLS_LIST_JSON) }) };
    case 'tools/call': {
      if (typeof params !== 'object' || params === null || Array.isArray(params)) {
        return rpcError(id, -32602, 'Invalid params: tools/call needs a name and arguments');
      }
      const callParams = params as Record<string, unknown>;
      const toolName = typeof callParams.name === 'string' ? callParams.name : '';
      const args = (callParams.arguments ?? {}) as Record<string, unknown>;
      const outcome = callTool(store, toolName, typeof args === 'object' && args !== null ? args : {});
      if ('__rpcError' in outcome) {
        const rpcErr = outcome.__rpcError as { code: number; message: string };
        return rpcError(id, rpcErr.code, rpcErr.message);
      }
      return rpcResult(id, outcome);
    }
    case 'ping':
      return rpcResult(id, {});
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
