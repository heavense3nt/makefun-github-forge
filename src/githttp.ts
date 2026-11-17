// Git smart HTTP: the `/{owner}/{repo}.git` surface.
//
//   GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack|git-receive-pack
//        v2 advertisement when `Git-Protocol: version=2` is sent (upload-pack only),
//        otherwise the v0 advertisement with its `# service=...` preamble.
//   POST /{owner}/{repo}.git/git-upload-pack
//        protocol v2: ls-refs and fetch, in sections (acknowledgments, shallow-info,
//        packfile with side-band-64k framing).
//   POST /{owner}/{repo}.git/git-receive-pack
//        protocol v0 command list + pack, answered with a report-status stream inside
//        side-band-64k band 1. Every push fast-forwards or is refused per ref with
//        `ng <ref> non-fast-forward`; a refused push still unpacks and stores its objects.
//
// A missing repository is 404 on both services; a request without the bearer token is
// 401. Repositories belong to the login the token names, so any other owner is 404.

import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  collectReachable,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  readPack,
  writePack,
  type GitObject,
} from './gitcore.ts';
import { VIEWER_LOGIN } from './scenario.ts';
import { type Repo, type Store } from './store.ts';

export const AGENT_NAME = 'makefun-git-forge/1.0';

const UPLOAD_CAPS_V0 = `symref=HEAD:refs/heads/main side-band-64k ofs-delta agent=${AGENT_NAME}`;
const RECEIVE_CAPS_V0 = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT_NAME} symref=HEAD:refs/heads/main`;

export interface GitRequest {
  owner: string;
  repo: string;
  service: 'git-upload-pack' | 'git-receive-pack';
}

export type GitResponse =
  | { status: number; contentType: string; body: Buffer }
  | { status: number; contentType: string; body: string };

function text(status: number, body: string): GitResponse {
  return { status, contentType: 'application/json', body: JSON.stringify({ message: body }) };
}

/** The repository a git request names, or the reason it cannot be served. */
function findRepo(store: Store, owner: string, name: string): Repo | { status: number; message: string } {
  if (owner !== VIEWER_LOGIN) return { status: 404, message: 'Not Found' };
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return { status: 404, message: 'Not Found' };
  return repo;
}

/** Refs sorted by name, with peeled targets for annotated tags. */
function sortedRefs(repo: Repo): Array<{ name: string; oid: string; peeled?: string }> {
  const out: Array<{ name: string; oid: string; peeled?: string }> = [];
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name) as string;
    const entry: { name: string; oid: string; peeled?: string } = { name, oid };
    const object = repo.objects.get(oid);
    if (object && object.type === 'tag') {
      entry.peeled = parseTag(object.data).object;
    }
    out.push(entry);
  }
  return out;
}

/** The v0 advertisement: preamble, flush, ref lines (first carries the capabilities). */
function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\u0000${caps}\n`);
  } else {
    lines.push(`${headOid} HEAD\u0000${caps}\n`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      if (ref.peeled !== undefined) lines.push(`${ref.oid} ${ref.name}^{}\n`);
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

/** The v2 advertisement for upload-pack: `version 2` then one capability per line. */
function advertisementV2(): Buffer {
  return encodePktLines([
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    `agent=${AGENT_NAME}\n`,
    'flush',
  ]);
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(store: Store, owner: string, repoName: string, service: string | null, gitProtocol: string | null): GitResponse {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return text(400, 'unknown service');
  }
  const found = findRepo(store, owner, repoName);
  if ('status' in found) return text(found.status, found.message);
  const repo = found;
  if (service === 'git-upload-pack' && gitProtocol === 'version=2') {
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertisementV2() };
  }
  const contentType =
    service === 'git-upload-pack' ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement';
  return { status: 200, contentType, body: advertisementV0(repo, service) };
}

// ---------------------------------------------------------------------------------------------
// upload-pack: ls-refs and fetch (protocol v2)
// ---------------------------------------------------------------------------------------------

interface LsRefsOptions {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

/** Parse a v2 ls-refs request body into its options. */
function parseLsRefs(body: Buffer): LsRefsOptions | null {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return null;
  }
  const options: LsRefsOptions = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  let seenCommand = false;
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    if (!seenCommand) {
      // Real git sends `command=ls-refs` with a trailing newline; accept either form.
      if (line.trim() !== 'command=ls-refs') return null;
      seenCommand = true;
      continue;
    }
    if (!seenDelim) continue;
    const option = line.trim();
    if (option === 'peel') options.peel = true;
    else if (option === 'symrefs') options.symrefs = true;
    else if (option === 'unborn') options.unborn = true;
    else if (option.startsWith('ref-prefix ')) options.prefixes.push(option.slice('ref-prefix '.length));
  }
  return seenCommand ? options : null;
}

/** POST git-upload-pack: ls-refs. */
function handleLsRefs(repo: Repo, body: Buffer): GitResponse {
  const options = parseLsRefs(body);
  if (options === null) return text(400, 'bad ls-refs request');
  const lines: Array<string | 'flush'> = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  const hasPrefix = options.prefixes.length > 0;
  const matches = (name: string): boolean => !hasPrefix || options.prefixes.some((prefix) => name.startsWith(prefix));
  // The HEAD line is a ref named HEAD: it answers only when HEAD itself matches a
  // requested prefix (a clone asks for HEAD, refs/heads/ and refs/tags/ together; a
  // single refs/heads/ prefix must NOT see it).
  if (matches('HEAD')) {
    if (headOid === undefined) {
      if (options.unborn) lines.push(`unborn HEAD symref-target:${headRef}\n`);
    } else if (options.symrefs) {
      lines.push(`${headOid} HEAD symref-target:${headRef}\n`);
    } else {
      lines.push(`${headOid} HEAD\n`);
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (options.peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: encodePktLines(lines) };
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

/** Parse a v2 fetch request body. */
function parseFetch(body: Buffer): FetchRequest | null {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return null;
  }
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, done: false };
  let seenCommand = false;
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    if (!seenCommand) {
      // Real git sends `command=fetch` with no trailing newline; the kit's client sends
      // one. Accept either.
      if (line.trim() !== 'command=fetch') return null;
      seenCommand = true;
      continue;
    }
    if (!seenDelim) continue;
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isSafeInteger(n) && n > 0) request.depth = n;
    } else if (line.trim() === 'done') request.done = true;
  }
  return seenCommand ? request : null;
}

/** POST git-upload-pack: fetch. */
function handleFetch(repo: Repo, body: Buffer): GitResponse {
  const request = parseFetch(body);
  if (request === null) return text(400, 'bad fetch request');
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const wants = request.wants.filter((oid) => isObjectId(oid) && repo.objects.has(oid));
  // The depth-limited closure from the wants (no exclusion yet): the shallow boundary
  // is read off this walk, so a have that is also a want must not cut the walk short.
  const wantReach = collectReachable(wants, lookup, { maxDepth: request.depth ?? undefined });
  // The client's held set: the closure of its haves, stopping at its shallow boundary —
  // a shallow commit is held, but the history below it is not, so a deepen must still
  // deliver the parent below the boundary.
  const haveReach = collectReachable(request.haves, lookup, { shallowBoundary: request.shallow });
  const sendOids = [...wantReach].filter((oid) => !haveReach.has(oid)).sort();
  const send: GitObject[] = [];
  for (const oid of sendOids) {
    const object = repo.objects.get(oid);
    if (object) send.push(object);
  }

  // Shallow boundaries: commits in the depth-limited closure whose parents were cut off.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (request.depth !== null || request.shallow.length > 0) {
    for (const oid of wantReach) {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.length === 0) continue;
      const cut = parents.some((parent) => !wantReach.has(parent));
      if (cut) shallow.push(oid);
    }
    shallow.sort();
    for (const oid of request.shallow) {
      if (wantReach.has(oid) && !shallow.includes(oid)) unshallow.push(oid);
    }
    unshallow.sort();
  }

  const parts: Buffer[] = [];
  // The acknowledgments section exists only while negotiation is open. When the client
  // sent `done` (a fresh clone, or a fetch with nothing more to negotiate), git goes
  // straight to the packfile section and dies on any other line first — so the section
  // is omitted entirely. Without `done`, the section carries the common commits the
  // client's haves share with the wants (ACK) plus `ready` when a pack follows, and it
  // ends with a FLUSH when no pack follows (NAK only).
  let readySent = false;
  if (!request.done) {
    const ackLines: string[] = [];
    for (const have of request.haves) {
      if (!isObjectId(have) || !repo.objects.has(have)) continue;
      const firstWant = wants[0] ?? '';
      if (firstWant !== '' && (wantReach.has(have) || isAncestor(lookup, have, firstWant))) {
        if (!ackLines.includes(`ACK ${have}`)) ackLines.push(`ACK ${have}`);
      }
    }
    ackLines.sort();
    if (ackLines.length > 0) {
      const ackSection: Array<string | 'delim'> = ['acknowledgments\n', ...ackLines.map((line) => `${line}\n`), 'ready\n', 'delim'];
      parts.push(encodePktLines(ackSection));
      readySent = true;
    } else {
      parts.push(encodePktLines(['acknowledgments\n', 'NAK\n', 'flush']));
    }
  }
  // A pack follows when there are objects to send (a `done` request), or when `ready`
  // was sent (the client is already on its way to the packfile section — send an empty
  // pack rather than nothing when the wants are already held).
  const packFollows = request.done ? send.length > 0 : readySent;
  if (packFollows && (request.depth !== null || request.shallow.length > 0)) {
    const info: Array<string | 'delim'> = ['shallow-info\n'];
    for (const oid of shallow) info.push(`shallow ${oid}\n`);
    for (const oid of unshallow) info.push(`unshallow ${oid}\n`);
    info.push('delim');
    parts.push(encodePktLines(info));
  }
  if (packFollows) {
    const pack = writePack(send);
    parts.push(encodePktLine('packfile\n'));
    const CHUNK = 65515;
    for (let offset = 0; offset < pack.length; offset += CHUNK) {
      const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
      parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
    }
  }
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

/** POST /{owner}/{repo}.git/git-upload-pack: ls-refs or fetch by the first command line. */
export function handleUploadPack(store: Store, owner: string, repoName: string, body: Buffer): GitResponse {
  const found = findRepo(store, owner, repoName);
  if ('status' in found) return text(found.status, found.message);
  const repo = found;
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return text(400, 'bad pkt-line stream');
  }
  const first = packets.find((packet) => packet.kind === 'data');
  const command = first && first.kind === 'data' ? first.payload.toString('utf8').trim() : '';
  if (command === 'command=ls-refs') return handleLsRefs(repo, body);
  if (command === 'command=fetch') return handleFetch(repo, body);
  return text(400, 'unknown upload-pack command');
}

// ---------------------------------------------------------------------------------------------
// receive-pack: command list + pack, report-status in side-band-64k
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Split a receive-pack body at the first flush packet: commands, then the pack bytes. */
function splitCommands(body: Buffer): { commands: PushCommand[]; capabilities: Set<string>; pack: Buffer } | null {
  let offset = 0;
  const commands: PushCommand[] = [];
  const capabilities = new Set<string>();
  let first = true;
  while (offset + 4 <= body.length) {
    const head = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) return null;
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      offset += 4;
      return { commands, capabilities, pack: body.subarray(offset) };
    }
    if (length === 1 || length === 2 || length === 3 || length > 65520 || offset + length > body.length) return null;
    const payload = body.subarray(offset + 4, offset + length).toString('utf8');
    offset += length;
    let line = payload;
    if (first) {
      first = false;
      const nul = line.indexOf('\u0000');
      if (nul >= 0) {
        for (const cap of line.slice(nul + 1).trim().split(/\s+/)) if (cap !== '') capabilities.add(cap);
        line = line.slice(0, nul);
      }
    }
    const textLine = line.replace(/\n$/, '');
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/\S+)$/.exec(textLine);
    if (match === null) return null;
    commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
  }
  return null;
}

/** POST /{owner}/{repo}.git/git-receive-pack. */
export function handleReceivePack(store: Store, owner: string, repoName: string, body: Buffer): GitResponse {
  const found = findRepo(store, owner, repoName);
  if ('status' in found) return text(found.status, found.message);
  const repo = found;
  const split = splitCommands(body);
  if (split === null || split.commands.length === 0) return text(400, 'bad receive-pack request');
  const sideband = split.capabilities.has('side-band-64k');

  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (split.pack.length > 0) {
    try {
      const read = readPack(split.pack, { resolveBase: (oid) => repo.objects.get(oid) });
      if (!read.checksumOk) throw new Error('pack trailer checksum mismatch');
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = (err as Error).message;
    }
  }

  if (unpackOk) {
    for (const command of split.commands) {
      const current = repo.refs.get(command.ref);
      const isDelete = command.newOid === ZERO_OID;
      const isCreate = command.oldOid === ZERO_OID;
      if (isDelete) {
        if (current === undefined) {
          reportLines.push(`ok ${command.ref}`);
        } else if (command.oldOid === ZERO_OID || command.oldOid === current) {
          repo.refs.delete(command.ref);
          reportLines.push(`ok ${command.ref}`);
        } else {
          reportLines.push(`ng ${command.ref} non-fast-forward`);
        }
        continue;
      }
      if (current === undefined) {
        if (!isCreate) {
          reportLines.push(`ng ${command.ref} non-fast-forward`);
          continue;
        }
        if (!repo.objects.has(command.newOid)) {
          reportLines.push(`ng ${command.ref} object not found`);
          continue;
        }
        repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}`);
        continue;
      }
      if (command.oldOid !== current) {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
      if (command.newOid === current) {
        reportLines.push(`ok ${command.ref}`);
        continue;
      }
      if (!repo.objects.has(command.newOid)) {
        reportLines.push(`ng ${command.ref} object not found`);
        continue;
      }
      const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
      if (!isAncestor(lookup, command.oldOid, command.newOid)) {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}`);
    }
  }

  const reportText = [`unpack ${unpackOk ? 'ok' : unpackDetail}`, ...reportLines].map((line) => `${line}\n`);
  const reportStream = encodePktLines([...reportText, 'flush']);
  let responseBody: Buffer;
  if (sideband) {
    const parts: Buffer[] = [];
    const CHUNK = 65515;
    for (let offset = 0; offset < reportStream.length; offset += CHUNK) {
      const slice = reportStream.subarray(offset, Math.min(reportStream.length, offset + CHUNK));
      parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
    }
    parts.push(PKT_FLUSH);
    responseBody = Buffer.concat(parts);
  } else {
    responseBody = Buffer.concat([reportStream, PKT_FLUSH]);
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: responseBody };
}

/** A hex digest check, for the pack-integrity style verification of an inbound pack. */
export function packDigest(pack: Buffer): string {
  return hashObject('blob', pack);
}

// ---------------------------------------------------------------------------------------------
// dispatcher: one git URL space, three endpoints
// ---------------------------------------------------------------------------------------------

/**
 * Route a git smart-HTTP request by its path suffix. A missing repository is 404 on every
 * endpoint; a malformed body is 400 — and the server stays up either way.
 */
export function handleGitHttp(
  store: Store,
  method: string,
  path: string,
  query: URLSearchParams,
  headers: Record<string, string | string[] | undefined>,
  body: Buffer,
): GitResponse {
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (match === null) return text(404, 'Not Found');
  const owner = match[1] as string;
  const repoName = match[2] as string;
  const suffix = match[3] ?? '';
  if (suffix === '/info/refs') {
    if (method !== 'GET') return text(405, 'Method Not Allowed');
    const service = query.get('service');
    const protocol = headers['git-protocol'];
    const gitProtocol = typeof protocol === 'string' ? protocol : null;
    return handleInfoRefs(store, owner, repoName, service, gitProtocol);
  }
  if (suffix === '/git-upload-pack') {
    if (method !== 'POST') return text(405, 'Method Not Allowed');
    return handleUploadPack(store, owner, repoName, body);
  }
  if (suffix === '/git-receive-pack') {
    if (method !== 'POST') return text(405, 'Method Not Allowed');
    return handleReceivePack(store, owner, repoName, body);
  }
  return text(404, 'Not Found');
}
