// The forge's in-memory store: repositories, git objects, refs, issues, pull requests.
//
// One Store holds every repository the trial creates. Repositories are born through the
// REST surface only; their files live as git objects (a PUT /contents commit is a real
// commit), so the git, REST, GraphQL and MCP surfaces all read the same truth.
//
// Determinism: nothing here reads a clock or randomness. Server-made commits carry the
// forge's fixed timestamp; ids are sequential counters in creation order; every timestamp
// string the API emits is the scenario epoch. Two runs that send the same requests in the
// same order build the same store, byte for byte.

import {
  FORGE_EPOCH_SEC,
  FORGE_IDENTITY,
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitcore.ts';

/** The one timestamp string the API emits, ever (2025-01-01T00:00:00.000Z). */
export const FIXED_ISO = '2025-01-01T00:00:00.000Z';

export interface Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch: string;
  readonly createdSeq: number;
  /** refname -> commit oid (refs/heads/*, refs/tags/*). */
  readonly refs: Map<string, string>;
  /** oid -> object. */
  readonly objects: Map<string, GitObject>;
  /** label name -> {name, color}. */
  readonly labels: Map<string, { name: string; color: string }>;
  readonly issues: Issue[];
  readonly pulls: Pull[];
  /** Next shared issue/PR number. */
  nextNumber: number;
  /** Next comment id (global counter lives on the store). */
  nextCommentSeq: number;
}

export interface Issue {
  readonly number: number;
  readonly restId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly seq: number;
  readonly comments: Comment[];
}

export interface Comment {
  readonly id: number;
  body: string;
  readonly seq: number;
}

export interface Pull {
  readonly number: number;
  readonly restId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly headRef: string;
  readonly baseRef: string;
  /** The base tip at creation (the merge-base for the fixture histories). */
  readonly baseShaAtCreation: string;
  readonly seq: number;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

/** Opaque Relay-style global ids: deterministic, stable, never the plain number. */
export function globalId(kind: 'Repository' | 'Issue' | 'PullRequest' | 'IssueComment', repoId: number, n?: number): string {
  const raw = n === undefined ? `${kind}:${repoId}` : `${kind}:${repoId}:${n}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/** Parse a global id back into its parts, or null. */
export function parseGlobalId(id: string): { kind: string; repoId: number; n: number | null } | null {
  try {
    const raw = Buffer.from(id, 'base64url').toString('utf8');
    const parts = raw.split(':');
    if (parts.length < 2 || parts.length > 3) return null;
    const kind = parts[0] as string;
    const repoId = Number(parts[1]);
    if (!Number.isSafeInteger(repoId) || repoId <= 0) return null;
    const n = parts.length === 3 ? Number(parts[2]) : null;
    if (n !== null && (!Number.isSafeInteger(n) || n <= 0)) return null;
    if (kind !== 'Repository' && kind !== 'Issue' && kind !== 'PullRequest' && kind !== 'IssueComment') return null;
    return { kind, repoId, n };
  } catch {
    return null;
  }
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextRepoSeq = 1;
  private nextRestId = 1;
  private nextCommentId = 1;
  private requestSeq = 1;

  /** A deterministic request id for X-GitHub-Request-Id (req-1, req-2, ...). */
  nextRequestId(): string {
    return `req-${this.requestSeq++}`;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  getRepoById(id: number): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }

  listUserRepos(owner: string): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner === owner).sort((a, b) => a.createdSeq - b.createdSeq);
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(this.key(owner, name))) return null;
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdSeq: this.nextRepoSeq++,
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
      nextCommentSeq: 1,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  // -------------------------------------------------------------------------------------------
  // git objects and refs
  // -------------------------------------------------------------------------------------------

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  /** Resolve a ref name, a branch name, or a commit oid to a commit oid. */
  resolveRef(repo: Repo, ref: string | undefined): string | undefined {
    if (ref === undefined) return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (isObjectId(ref)) return repo.objects.has(ref) ? ref : undefined;
    if (ref.startsWith('refs/')) return repo.refs.get(ref);
    return repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
  }

  // -------------------------------------------------------------------------------------------
  // trees and contents
  // -------------------------------------------------------------------------------------------

  /** The flat path map of a tree: path -> {oid, mode}. */
  flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, at: string): void => {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = at === '' ? entry.name : `${at}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, prefix);
    return out;
  }

  /** Build (and store) the nested trees for a flat path map; returns the root tree oid. */
  buildTreeFromFlat(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
    const build = (dir: string): string => {
      const entries: TreeEntry[] = [];
      const subdirs = new Set<string>();
      for (const [path, value] of flat) {
        if (!path.startsWith(dir)) continue;
        const rest = path.slice(dir.length);
        const slash = rest.indexOf('/');
        if (slash === -1) {
          entries.push({ mode: value.mode, name: rest, oid: value.oid });
        } else {
          subdirs.add(rest.slice(0, slash));
        }
      }
      for (const sub of subdirs) {
        const subOid = build(dir === '' ? `${sub}/` : `${dir}${sub}/`);
        entries.push({ mode: '40000', name: sub, oid: subOid });
      }
      const data = buildTree(entries);
      return this.putObject(repo, 'tree', data);
    };
    return build('');
  }

  /** The tree oid at a directory path below a root tree, or null. */
  treeOidAtPath(repo: Repo, treeOid: string, segments: string[]): string | null {
    let current = treeOid;
    for (const segment of segments) {
      const object = repo.objects.get(current);
      if (!object || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
      if (!entry || entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return current;
  }

  /** Read one path at a commit: a file, a directory listing, or null when absent. */
  readPath(
    repo: Repo,
    commitOid: string,
    path: string,
  ): { kind: 'file'; oid: string; size: number } | { kind: 'dir'; entries: Array<{ name: string; path: string; oid: string; type: 'file' | 'dir' }> } | null {
    const commit = repo.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return null;
    const treeOid = parseCommit(commit.data).tree;
    if (path === '') {
      const flat = this.flattenTree(repo, treeOid);
      const top = new Map<string, { oid: string; type: 'file' | 'dir' }>();
      for (const [p, value] of flat) {
        const slash = p.indexOf('/');
        if (slash === -1) top.set(p, { oid: value.oid, type: 'file' });
        else top.set(p.slice(0, slash), { oid: this.treeOidAtPath(repo, treeOid, [p.slice(0, slash)]) ?? '', type: 'dir' });
      }
      const entries = [...top.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([name, value]) => ({ name, path: name, oid: value.oid, type: value.type }));
      return { kind: 'dir', entries };
    }
    const flat = this.flattenTree(repo, treeOid);
    const file = flat.get(path);
    if (file) {
      const blob = repo.objects.get(file.oid);
      return { kind: 'file', oid: file.oid, size: blob ? blob.data.length : 0 };
    }
    const prefix = `${path}/`;
    const children = new Map<string, { oid: string; type: 'file' | 'dir' }>();
    for (const [p, value] of flat) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) children.set(rest, { oid: value.oid, type: 'file' });
      else children.set(rest.slice(0, slash), { oid: this.treeOidAtPath(repo, treeOid, [...path.split('/'), rest.slice(0, slash)]) ?? '', type: 'dir' });
    }
    if (children.size === 0) return null;
    const entries = [...children.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([name, value]) => ({ name, path: `${path}/${name}`, oid: value.oid, type: value.type }));
    return { kind: 'dir', entries };
  }

  /** The blob oid at a path on a commit, or null. */
  blobAtPath(repo: Repo, commitOid: string, path: string): string | null {
    const read = this.readPath(repo, commitOid, path);
    return read !== null && read.kind === 'file' ? read.oid : null;
  }

  /**
   * Commit one file on a branch: creates the branch from the default tip when it does not
   * exist yet, creates the repository's first commit when it is unborn. Returns the commit
   * and blob shas, or an error string ('stale-sha' | 'exists' | 'no-branch').
   */
  commitFile(
    repo: Repo,
    options: { branch?: string; path: string; content: Buffer; message: string; sha?: string },
  ): { commitSha: string; contentSha: string } | { error: string } {
    const branch = options.branch ?? repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    let parent = repo.refs.get(ref);
    if (parent === undefined) {
      if (repo.refs.size === 0 && branch === repo.defaultBranch) {
        parent = undefined;
      } else if (repo.refs.size === 0) {
        return { error: 'no-branch' };
      } else {
        parent = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (parent === undefined) return { error: 'no-branch' };
      }
    }
    const contentSha = this.putObject(repo, 'blob', options.content);
    if (parent !== undefined) {
      const current = this.blobAtPath(repo, parent, options.path);
      if (current !== null && options.sha === undefined) return { error: 'exists' };
      if (options.sha !== undefined && current !== options.sha) return { error: 'stale-sha' };
    }
    const baseTree = parent === undefined ? null : parseCommit((repo.objects.get(parent) as GitObject).data).tree;
    const flat = baseTree === null ? new Map() : this.flattenTree(repo, baseTree);
    flat.set(options.path, { oid: contentSha, mode: '100644' });
    const treeOid = this.buildTreeFromFlat(repo, flat);
    const commitData = buildCommit({
      tree: treeOid,
      parents: parent === undefined ? [] : [parent],
      message: options.message,
      timestamp: FORGE_EPOCH_SEC,
    });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(ref, commitSha);
    return { commitSha, contentSha };
  }

  /** Delete one file on a branch with a commit; errors: 'not-found' | 'stale-sha' | 'no-branch'. */
  deleteFile(
    repo: Repo,
    options: { branch?: string; path: string; message: string; sha?: string },
  ): { commitSha: string } | { error: string } {
    const branch = options.branch ?? repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    const parent = repo.refs.get(ref);
    if (parent === undefined) return { error: 'no-branch' };
    const current = this.blobAtPath(repo, parent, options.path);
    if (current === null) return { error: 'not-found' };
    if (options.sha !== undefined && options.sha !== current) return { error: 'stale-sha' };
    const baseTree = parseCommit((repo.objects.get(parent) as GitObject).data).tree;
    const flat = this.flattenTree(repo, baseTree);
    flat.delete(options.path);
    const treeOid = this.buildTreeFromFlat(repo, flat);
    const commitData = buildCommit({ tree: treeOid, parents: [parent], message: options.message, timestamp: FORGE_EPOCH_SEC });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(ref, commitSha);
    return { commitSha };
  }

  /** Commits reachable from a tip, newest first (depth-first, first parent first). */
  listCommits(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      seen.add(oid);
      out.push(oid);
      const parents = parseCommit(object.data).parents;
      for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
    }
    return out;
  }

  /** The merge-base of two commits: the first common ancestor found walking both sides. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const fromA = new Set<string>();
    const queueA = [a];
    while (queueA.length > 0) {
      const oid = queueA.pop() as string;
      if (fromA.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      fromA.add(oid);
      for (const parent of parseCommit(object.data).parents) queueA.push(parent);
    }
    const queueB = [b];
    const seenB = new Set<string>();
    while (queueB.length > 0) {
      const oid = queueB.pop() as string;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      if (fromA.has(oid)) return oid;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueB.push(parent);
    }
    return null;
  }

  // -------------------------------------------------------------------------------------------
  // issues, labels, comments
  // -------------------------------------------------------------------------------------------

  createLabel(repo: Repo, name: string, color: string): { name: string; color: string } {
    const existing = repo.labels.get(name);
    if (existing) return existing;
    const label = { name, color };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, input: { title: string; body: string; labels?: string[] }): Issue | { error: string } {
    for (const label of input.labels ?? []) {
      if (!repo.labels.has(label)) return { error: `unknown label ${label}` };
    }
    const issue: Issue = {
      number: repo.nextNumber++,
      restId: this.nextRestId++,
      title: input.title,
      body: input.body,
      state: 'open',
      labels: [...(input.labels ?? [])],
      seq: repo.nextNumber,
      comments: [],
    };
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  listIssues(repo: Repo, options: { state?: string; sort?: string; direction?: string }): Issue[] {
    let list = [...repo.issues];
    const state = options.state ?? 'open';
    if (state !== 'all') list = list.filter((issue) => issue.state === state);
    const direction = options.direction ?? 'desc';
    list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
    return list;
  }

  createComment(repo: Repo, issueNumber: number, body: string): Comment | null {
    const issue = this.getIssue(repo, issueNumber);
    if (!issue) return null;
    const comment: Comment = { id: this.nextCommentId++, body, seq: repo.nextCommentSeq++ };
    issue.comments.push(comment);
    return comment;
  }

  // -------------------------------------------------------------------------------------------
  // pull requests
  // -------------------------------------------------------------------------------------------

  createPull(
    repo: Repo,
    input: { head: string; base: string; title: string; body: string },
  ): Pull | { error: string } {
    const headTip = repo.refs.get(`refs/heads/${input.head}`);
    if (headTip === undefined) return { error: `unknown head branch ${input.head}` };
    const baseTip = repo.refs.get(`refs/heads/${input.base}`);
    if (baseTip === undefined) return { error: `unknown base branch ${input.base}` };
    for (const pull of repo.pulls) {
      if (pull.state === 'open' && pull.headRef === input.head && pull.baseRef === input.base) {
        return { error: 'a pull request is already open for this head and base' };
      }
    }
    const pull: Pull = {
      number: repo.nextNumber++,
      restId: this.nextRestId++,
      title: input.title,
      body: input.body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: input.head,
      baseRef: input.base,
      baseShaAtCreation: baseTip,
      seq: repo.nextNumber,
    };
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  listPulls(repo: Repo, state: string): Pull[] {
    const list = [...repo.pulls];
    if (state === 'all') return list.sort((a, b) => b.seq - a.seq);
    if (state === 'closed') return list.filter((pull) => pull.state === 'closed').sort((a, b) => b.seq - a.seq);
    return list.filter((pull) => pull.state === 'open').sort((a, b) => b.seq - a.seq);
  }

  /** The files a pull request changes: merge-base tree vs head tip tree, line-counted. */
  pullFiles(repo: Repo, pull: Pull): PullFile[] {
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    if (headTip === undefined) return [];
    const baseOid = this.mergeBase(repo, headTip, pull.baseShaAtCreation) ?? pull.baseShaAtCreation;
    const baseCommit = repo.objects.get(baseOid);
    const headCommit = repo.objects.get(headTip);
    if (!baseCommit || !headCommit) return [];
    const baseFlat = this.flattenTree(repo, parseCommit(baseCommit.data).tree);
    const headFlat = this.flattenTree(repo, parseCommit(headCommit.data).tree);
    const files: PullFile[] = [];
    const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
    for (const path of [...paths].sort()) {
      const base = baseFlat.get(path);
      const head = headFlat.get(path);
      if (base !== undefined && head !== undefined && base.oid === head.oid) continue;
      const baseText = base === undefined ? '' : (repo.objects.get(base.oid)?.data.toString('utf8') ?? '');
      const headText = head === undefined ? '' : (repo.objects.get(head.oid)?.data.toString('utf8') ?? '');
      const { additions, deletions } = diffLines(baseText, headText);
      files.push({
        filename: path,
        status: base === undefined ? 'added' : head === undefined ? 'removed' : 'modified',
        additions,
        deletions,
        changes: additions + deletions,
      });
    }
    return files;
  }

  /** Whether a pull request can merge cleanly (file-level three-way, no content merge). */
  pullMergeable(repo: Repo, pull: Pull): boolean {
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return false;
    const baseOid = this.mergeBase(repo, headTip, baseTip);
    if (baseOid === null) return false;
    const baseCommit = repo.objects.get(baseOid);
    const headCommit = repo.objects.get(headTip);
    const tipCommit = repo.objects.get(baseTip);
    if (!baseCommit || !headCommit || !tipCommit) return false;
    const ancestorFlat = this.flattenTree(repo, parseCommit(baseCommit.data).tree);
    const headFlat = this.flattenTree(repo, parseCommit(headCommit.data).tree);
    const tipFlat = this.flattenTree(repo, parseCommit(tipCommit.data).tree);
    const paths = new Set([...ancestorFlat.keys(), ...headFlat.keys(), ...tipFlat.keys()]);
    for (const path of paths) {
      const ancestor = ancestorFlat.get(path)?.oid ?? null;
      const head = headFlat.get(path)?.oid ?? null;
      const tip = tipFlat.get(path)?.oid ?? null;
      const headChanged = head !== ancestor;
      const tipChanged = tip !== ancestor;
      if (headChanged && tipChanged && head !== tip) return false;
    }
    return true;
  }

  /**
   * Squash-merge a pull request onto its base branch: one commit whose tree is the base tip
   * tree with the head's changes applied. Errors: 'not-found' | 'closed' | 'conflict'.
   */
  mergePull(repo: Repo, pull: Pull): { sha: string; message: string } | { error: string } {
    if (pull.state !== 'open') return { error: 'closed' };
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return { error: 'not-found' };
    if (!this.pullMergeable(repo, pull)) return { error: 'conflict' };
    const baseOid = this.mergeBase(repo, headTip, baseTip) ?? pull.baseShaAtCreation;
    const ancestorCommit = repo.objects.get(baseOid);
    const headCommit = repo.objects.get(headTip);
    const tipCommit = repo.objects.get(baseTip);
    if (!ancestorCommit || !headCommit || !tipCommit) return { error: 'not-found' };
    const ancestorFlat = this.flattenTree(repo, parseCommit(ancestorCommit.data).tree);
    const headFlat = this.flattenTree(repo, parseCommit(headCommit.data).tree);
    const tipFlat = this.flattenTree(repo, parseCommit(tipCommit.data).tree);
    const merged = new Map(tipFlat);
    const paths = new Set([...ancestorFlat.keys(), ...headFlat.keys()]);
    for (const path of paths) {
      const ancestor = ancestorFlat.get(path)?.oid ?? null;
      const head = headFlat.get(path)?.oid ?? null;
      if (head === ancestor) continue;
      if (head === null) merged.delete(path);
      else merged.set(path, { oid: head, mode: headFlat.get(path)?.mode ?? '100644' });
    }
    const treeOid = this.buildTreeFromFlat(repo, merged);
    const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`;
    const commitData = buildCommit({
      tree: treeOid,
      parents: [baseTip],
      message,
      timestamp: FORGE_EPOCH_SEC,
    });
    const sha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = FIXED_ISO;
    pull.mergeCommitSha = sha;
    return { sha, message };
  }

  /** The head branch tip a pull request was opened from (frozen at creation for the REST shape). */
  pullHeadSha(repo: Repo, pull: Pull): string {
    return repo.refs.get(`refs/heads/${pull.headRef}`) ?? '';
  }

  /** The base branch tip at creation. */
  pullBaseSha(_repo: Repo, pull: Pull): string {
    return pull.baseShaAtCreation;
  }
}

/** A small line diff: lines in the new text that the old text lacks, and vice versa. */
export function diffLines(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const oldCounts = new Map<string, number>();
  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  const newCounts = new Map<string, number>();
  for (const line of newLines) newCounts.set(line, (newCounts.get(line) ?? 0) + 1);
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of newCounts) {
    const old = oldCounts.get(line) ?? 0;
    if (count > old) additions += count - old;
  }
  for (const [line, count] of oldCounts) {
    const newer = newCounts.get(line) ?? 0;
    if (count > newer) deletions += count - newer;
  }
  return { additions, deletions };
}

/** The ancestor set of a commit, for fast-forward checks. */
export function commitAncestors(repo: Repo, tip: string): Set<string> {
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return seen;
}

export { ZERO_OID, isAncestor, collectReachable, parseTag };
