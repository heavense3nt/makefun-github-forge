// GitHub REST v3: the `/api/v3` surface.
//
// Every reply is application/json (never HTML) and carries a non-empty
// X-GitHub-Request-Id. An error carries a JSON body with a string `message`. A request
// without the bearer token is 401; a repository belongs to the login the token names,
// so the same name under another owner is 404, never 403. A malformed JSON body is 400.
//
// Routes: the root and meta reads, user/repos (create + paginated list), repos (read,
// patch, delete), branches, commits, git refs, contents, labels, issues (+ comments)
// and pull requests (+ files, merge).

import { parseCommit } from './gitcore.ts';
import { VIEWER_ID, VIEWER_LOGIN } from './scenario.ts';
import { FIXED_ISO, globalId, type Issue, type Pull, type Repo, type Store } from './store.ts';

export interface RestRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  body: Buffer;
  host: string;
}

export interface RestResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

function json(status: number, value: unknown, extraHeaders: Record<string, string> = {}): RestResponse {
  return { status, headers: { ...JSON_HEADERS, ...extraHeaders }, body: JSON.stringify(value) };
}

function error(status: number, message: string): RestResponse {
  return json(status, { message });
}

function requestId(store: Store): Record<string, string> {
  return { 'x-github-request-id': store.nextRequestId() };
}

/** Parse a request body as JSON: null when there is no body, or an Error on bad JSON. */
function parseBody(request: RestRequest): unknown | Error | null {
  if (request.body.length === 0) return null;
  try {
    return JSON.parse(request.body.toString('utf8')) as unknown;
  } catch {
    return new Error('malformed JSON body');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function base64Of(data: Buffer): string {
  return data.toString('base64');
}

function base64ToBuffer(text: string): Buffer | null {
  try {
    return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------------------------

function repoJson(store: Store, repo: Repo, host: string): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `http://${host}/${repo.owner}/${repo.name}`,
    url: `http://${host}/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    fork: false,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    license: null,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.restId,
    node_id: globalId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    user: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' },
    assignees: [],
    comments: issue.comments.length,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: issue.state === 'closed' ? FIXED_ISO : null,
    html_url: `http://${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = store.pullHeadSha(repo, pull);
  return {
    id: pull.restId,
    node_id: globalId('PullRequest', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: store.pullMergeable(repo, pull),
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseShaAtCreation, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: pull.state === 'closed' ? FIXED_ISO : null,
    html_url: `http://${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function paginate<T>(items: readonly T[], query: URLSearchParams): { page: T[]; totalPages: number; pageNum: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const pageNum = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), totalPages, pageNum, perPage };
}

function linkHeader(host: string, path: string, query: URLSearchParams, pageNum: number, perPage: number, totalPages: number): string | null {
  const links: string[] = [];
  const build = (page: number, rel: string): string => {
    const q = new URLSearchParams(query);
    q.set('per_page', String(perPage));
    q.set('page', String(page));
    return `<http://${host}${path}?${q.toString()}>; rel="${rel}"`;
  };
  if (pageNum < totalPages) links.push(build(pageNum + 1, 'next'));
  if (pageNum > 1) links.push(build(pageNum - 1, 'prev'));
  if (totalPages > 1) {
    links.push(build(1, 'first'));
    links.push(build(totalPages, 'last'));
  }
  return links.length === 0 ? null : links.join(', ');
}

// ---------------------------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------------------------

/** Handle one REST request. `authorized` is false when the bearer token is missing/wrong. */
export function handleRest(store: Store, request: RestRequest, authorized: boolean): RestResponse {
  const rid = requestId(store);
  const segments = request.path.split('/').filter((part) => part !== '');
  // /api/v3 is segments[0..1]; the rest is the route.
  if (segments[0] !== 'api' || segments[1] !== 'v3') return { ...error(404, 'Not Found'), headers: { ...JSON_HEADERS, ...rid } };
  const route = segments.slice(2);
  const method = request.method;

  // Public reads: the root and meta.
  if (method === 'GET' && route.length === 0) {
    return json(
      200,
      {
        current_user_url: `http://${request.host}/api/v3/user`,
        repository_url: `http://${request.host}/api/v3/repos/{owner}/{repo}`,
        user_url: `http://${request.host}/api/v3/users/{user}`,
      },
      { ...rid, 'x-oauth-scopes': 'repo, user' },
    );
  }
  if (method === 'GET' && route.length === 1 && route[0] === 'meta') {
    return json(200, { installed_version: '1.0.0', verifiable_password_authentication: false }, rid);
  }

  if (!authorized) return { ...error(401, 'Requires authentication'), headers: { ...JSON_HEADERS, ...rid } };

  const parsed = parseBody(request);
  if (parsed instanceof Error) return { ...error(400, 'malformed JSON body'), headers: { ...JSON_HEADERS, ...rid } };
  const body = isRecord(parsed) ? parsed : {};

  const withRid = (response: RestResponse): RestResponse => ({ ...response, headers: { ...response.headers, ...rid } });

  // GET /user
  if (method === 'GET' && route.length === 1 && route[0] === 'user') {
    return withRid(json(200, { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.invalid` }));
  }

  // POST /user/repos
  if (method === 'POST' && route.length === 2 && route[0] === 'user' && route[1] === 'repos') {
    const name = typeof body.name === 'string' ? body.name : '';
    if (name === '' || /[^A-Za-z0-9._-]/.test(name) || name.length > 100) {
      return withRid(error(422, 'name is required'));
    }
    const description = typeof body.description === 'string' ? body.description : '';
    const isPrivate = body.private === true;
    const repo = store.createRepo(VIEWER_LOGIN, name, description, isPrivate);
    if (repo === null) return withRid(error(422, `Repository ${VIEWER_LOGIN}/${name} already exists`));
    return withRid(json(201, repoJson(store, repo, request.host)));
  }

  // GET /user/repos (paginated)
  if (method === 'GET' && route.length === 2 && route[0] === 'user' && route[1] === 'repos') {
    const all = store.listUserRepos(VIEWER_LOGIN);
    const { page, totalPages, pageNum, perPage } = paginate(all, request.query);
    const link = linkHeader(request.host, request.path, request.query, pageNum, perPage, totalPages);
    const headers: Record<string, string> = { ...rid };
    if (link !== null) headers.link = link;
    return { status: 200, headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(page.map((repo) => repoJson(store, repo, request.host))) };
  }

  // /repos/{owner}/{name}[...]
  if (route.length >= 3 && route[0] === 'repos') {
    const owner = decodeURIComponent(route[1] as string);
    const name = decodeURIComponent(route[2] as string);
    if (owner !== VIEWER_LOGIN) return withRid(error(404, 'Not Found'));
    const repo = store.getRepo(owner, name);
    const rest = route.slice(3);
    if (repo === undefined) {
      // A create through POST /user/repos is the only creation path; anything else on a
      // missing repository is a 404 (except the paginated user list above).
      return withRid(error(404, 'Not Found'));
    }
    return withRid(handleRepoRoute(store, request, repo, rest, body));
  }

  return withRid(error(404, 'Not Found'));
}

function handleRepoRoute(store: Store, request: RestRequest, repo: Repo, rest: string[], body: Record<string, unknown>): RestResponse {
  const method = request.method;
  const owner = repo.owner;
  const name = repo.name;

  // GET /repos/{o}/{r}
  if (method === 'GET' && rest.length === 0) return json(200, repoJson(store, repo, request.host));

  // PATCH /repos/{o}/{r}
  if (method === 'PATCH' && rest.length === 0) {
    if (typeof body.description === 'string') repo.description = body.description;
    if (typeof body.private === 'boolean') repo.isPrivate = body.private;
    return json(200, repoJson(store, repo, request.host));
  }

  // DELETE /repos/{o}/{r}
  if (method === 'DELETE' && rest.length === 0) {
    store.deleteRepo(owner, name);
    return { status: 204, headers: { ...JSON_HEADERS }, body: '' };
  }

  // GET /repos/{o}/{r}/branches
  if (method === 'GET' && rest.length === 1 && rest[0] === 'branches') {
    const branches = [...repo.refs.keys()]
      .filter((ref) => ref.startsWith('refs/heads/'))
      .sort()
      .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref) as string } }));
    return json(200, branches);
  }

  // GET /repos/{o}/{r}/branches/{branch}
  if (method === 'GET' && rest.length === 2 && rest[0] === 'branches') {
    const branch = decodeURIComponent(rest[1] as string);
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (sha === undefined) return error(404, 'Branch not found');
    return json(200, { name: branch, commit: { sha } });
  }

  // GET /repos/{o}/{r}/commits
  if (method === 'GET' && rest.length === 1 && rest[0] === 'commits') {
    const ref = request.query.get('sha') ?? undefined;
    const tip = store.resolveRef(repo, ref);
    if (tip === undefined) return error(404, 'Not Found');
    const commits = store.listCommits(repo, tip).map((sha) => {
      const object = repo.objects.get(sha);
      let message = '';
      let author = '';
      let committer = '';
      if (object && object.type === 'commit') {
        const parsed = parseCommit(object.data);
        message = parsed.message;
        author = parsed.author;
        committer = parsed.committer;
      }
      return { sha, commit: { message, author, committer } };
    });
    return json(200, commits);
  }

  // POST /repos/{o}/{r}/git/refs
  if (method === 'POST' && rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs') {
    const ref = typeof body.ref === 'string' ? body.ref : '';
    const sha = typeof body.sha === 'string' ? body.sha : '';
    if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) return error(422, 'invalid ref or sha');
    if (repo.refs.has(ref)) return error(422, 'ref already exists');
    if (!repo.objects.has(sha)) return error(422, 'object not found');
    repo.refs.set(ref, sha);
    return json(201, { ref, object: { sha, type: 'commit' } });
  }

  // GET /repos/{o}/{r}/git/refs/heads/{branch} (branch names may contain slashes)
  if (method === 'GET' && rest.length >= 4 && rest[0] === 'git' && rest[1] === 'refs' && rest[2] === 'heads') {
    const branch = rest.slice(3).map((part) => decodeURIComponent(part)).join('/');
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (sha === undefined) return error(404, 'Not Found');
    return json(200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
  }

  // contents
  if (rest.length >= 1 && rest[0] === 'contents') {
    return handleContents(store, request, repo, rest.slice(1), body);
  }

  // labels
  if (rest.length === 1 && rest[0] === 'labels') {
    if (method === 'POST') {
      const labelName = typeof body.name === 'string' ? body.name : '';
      const color = typeof body.color === 'string' ? body.color : 'ededed';
      if (labelName === '') return error(422, 'name is required');
      const label = store.createLabel(repo, labelName, color);
      return json(201, { name: label.name, color: label.color });
    }
    if (method === 'GET') {
      return json(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
    }
  }

  // issues
  if (rest.length >= 1 && rest[0] === 'issues') {
    return handleIssues(store, request, repo, rest.slice(1), body);
  }

  // pulls
  if (rest.length >= 1 && rest[0] === 'pulls') {
    return handlePulls(store, request, repo, rest.slice(1), body);
  }

  return error(404, 'Not Found');
}

function handleContents(store: Store, request: RestRequest, repo: Repo, rest: string[], body: Record<string, unknown>): RestResponse {
  const method = request.method;
  const path = rest.map((part) => decodeURIComponent(part)).join('/');
  const ref = request.query.get('ref') ?? undefined;

  if (method === 'GET') {
    const tip = store.resolveRef(repo, ref);
    if (tip === undefined) return error(404, 'Not Found');
    const read = store.readPath(repo, tip, path);
    if (read === null) return error(404, 'Not Found');
    if (read.kind === 'file') {
      const blob = repo.objects.get(read.oid);
      const content = blob ? base64Of(blob.data) : '';
      return json(200, {
        type: 'file',
        encoding: 'base64',
        content,
        sha: read.oid,
        size: read.size,
        name: path.split('/').pop() ?? path,
        path,
      });
    }
    return json(
      200,
      read.entries.map((entry) => ({ type: entry.type, name: entry.name, path: entry.path, sha: entry.oid })),
    );
  }

  if (method === 'PUT') {
    const message = typeof body.message === 'string' ? body.message : '';
    const contentB64 = typeof body.content === 'string' ? body.content : '';
    const branch = typeof body.branch === 'string' ? body.branch : undefined;
    const sha = typeof body.sha === 'string' ? body.sha : undefined;
    const content = base64ToBuffer(contentB64);
    if (content === null) return error(422, 'content is not valid base64');
    const result = store.commitFile(repo, { branch, path, content, message, sha });
    if ('error' in result) {
      if (result.error === 'stale-sha') return error(409, 'sha does not match the current file');
      if (result.error === 'exists') return error(422, 'file already exists; pass its sha to update it');
      return error(404, 'Not Found');
    }
    const status = sha === undefined ? 201 : 200;
    return json(status, {
      content: { name: path.split('/').pop() ?? path, path, sha: result.contentSha, size: content.length, encoding: 'base64' },
      commit: { sha: result.commitSha, message },
    });
  }

  if (method === 'DELETE') {
    const message = typeof body.message === 'string' ? body.message : '';
    const sha = typeof body.sha === 'string' ? body.sha : undefined;
    const branch = typeof body.branch === 'string' ? body.branch : undefined;
    const result = store.deleteFile(repo, { branch, path, message, sha });
    if ('error' in result) {
      if (result.error === 'stale-sha') return error(409, 'sha does not match the current file');
      return error(404, 'Not Found');
    }
    return json(200, { commit: { sha: result.commitSha, message } });
  }

  return error(404, 'Not Found');
}

function handleIssues(store: Store, request: RestRequest, repo: Repo, rest: string[], body: Record<string, unknown>): RestResponse {
  const method = request.method;

  // POST /issues, GET /issues
  if (rest.length === 0) {
    if (method === 'POST') {
      const title = typeof body.title === 'string' ? body.title : '';
      const issueBody = typeof body.body === 'string' ? body.body : '';
      const labels = Array.isArray(body.labels) ? body.labels.filter((entry): entry is string => typeof entry === 'string') : [];
      if (title === '') return error(422, 'title is required');
      const created = store.createIssue(repo, { title, body: issueBody, labels });
      if ('error' in created) return error(422, created.error);
      return json(201, issueJson(repo, created));
    }
    if (method === 'GET') {
      const all = store.listIssues(repo, {
        state: request.query.get('state') ?? undefined,
        sort: request.query.get('sort') ?? undefined,
        direction: request.query.get('direction') ?? undefined,
      });
      const { page, totalPages, pageNum, perPage } = paginate(all, request.query);
      const link = linkHeader(request.host, request.path, request.query, pageNum, perPage, totalPages);
      const headers: Record<string, string> = {};
      if (link !== null) headers.link = link;
      return { status: 200, headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(page.map((issue) => issueJson(repo, issue))) };
    }
    return error(404, 'Not Found');
  }

  const number = Number.parseInt(rest[0] as string, 10);
  if (!Number.isSafeInteger(number) || number <= 0) return error(404, 'Not Found');
  const issue = store.getIssue(repo, number);

  // GET /issues/{n}, PATCH /issues/{n}
  if (rest.length === 1) {
    if (issue === undefined) return error(404, 'Not Found');
    if (method === 'GET') return json(200, issueJson(repo, issue));
    if (method === 'PATCH') {
      if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      return json(200, issueJson(repo, issue));
    }
    return error(404, 'Not Found');
  }

  // /issues/{n}/comments
  if (rest.length === 2 && rest[1] === 'comments') {
    if (issue === undefined) return error(404, 'Not Found');
    if (method === 'POST') {
      const commentBody = typeof body.body === 'string' ? body.body : '';
      const comment = store.createComment(repo, number, commentBody);
      if (comment === null) return error(404, 'Not Found');
      return json(201, { id: comment.id, body: comment.body, user: { login: repo.owner, type: 'User' }, created_at: FIXED_ISO, updated_at: FIXED_ISO });
    }
    if (method === 'GET') {
      return json(200, issue.comments.map((comment) => ({ id: comment.id, body: comment.body, user: { login: repo.owner, type: 'User' }, created_at: FIXED_ISO, updated_at: FIXED_ISO })));
    }
    return error(404, 'Not Found');
  }

  return error(404, 'Not Found');
}

function handlePulls(store: Store, request: RestRequest, repo: Repo, rest: string[], body: Record<string, unknown>): RestResponse {
  const method = request.method;

  // POST /pulls, GET /pulls
  if (rest.length === 0) {
    if (method === 'POST') {
      const title = typeof body.title === 'string' ? body.title : '';
      const pullBody = typeof body.body === 'string' ? body.body : '';
      const head = typeof body.head === 'string' ? body.head : '';
      const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
      if (title === '' || head === '') return error(422, 'title and head are required');
      const created = store.createPull(repo, { head, base, title, body: pullBody });
      if ('error' in created) return error(422, created.error);
      return json(201, pullJson(store, repo, created));
    }
    if (method === 'GET') {
      const state = request.query.get('state') ?? 'open';
      const all = store.listPulls(repo, state);
      const { page, totalPages, pageNum, perPage } = paginate(all, request.query);
      const link = linkHeader(request.host, request.path, request.query, pageNum, perPage, totalPages);
      const headers: Record<string, string> = {};
      if (link !== null) headers.link = link;
      return { status: 200, headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(page.map((pull) => pullJson(store, repo, pull))) };
    }
    return error(404, 'Not Found');
  }

  const number = Number.parseInt(rest[0] as string, 10);
  if (!Number.isSafeInteger(number) || number <= 0) return error(404, 'Not Found');
  const pull = store.getPull(repo, number);

  // GET /pulls/{n}
  if (rest.length === 1) {
    if (pull === undefined) return error(404, 'Not Found');
    if (method === 'GET') return json(200, pullJson(store, repo, pull));
    return error(404, 'Not Found');
  }

  // GET /pulls/{n}/files
  if (rest.length === 2 && rest[1] === 'files') {
    if (pull === undefined) return error(404, 'Not Found');
    if (method === 'GET') return json(200, store.pullFiles(repo, pull));
    return error(404, 'Not Found');
  }

  // PUT /pulls/{n}/merge
  if (rest.length === 2 && rest[1] === 'merge') {
    if (pull === undefined) return error(404, 'Not Found');
    if (method !== 'PUT') return error(404, 'Not Found');
    const merged = store.mergePull(repo, pull);
    if ('error' in merged) {
      if (merged.error === 'conflict') return error(405, 'merge conflict');
      if (merged.error === 'closed') return error(405, 'pull request is already closed');
      return error(404, 'Not Found');
    }
    return json(200, { sha: merged.sha, merged: true, message: merged.message });
  }

  return error(404, 'Not Found');
}
