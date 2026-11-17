// GraphQL v4: a small document parser and executor for the shapes gh and
// github-mcp-server actually send.
//
// Supported: queries and mutations, named operations, variables (string/int/enum/
// input-object/list values), aliases, inline fragments (`... on Repository`) and
// named fragment spreads, operation batching (a JSON array of documents in one body).
// Unknown fields are GraphQL errors, never HTTP errors: a 200 whose body carries an
// `errors` array naming the field. An unauthenticated request is 401.
//
// The schema surface: Query.viewer / repository / node / __type, Repository and its
// issue/pull-request connections (states filter, orderBy CREATED_AT, cursor pages),
// Issue / PullRequest reads, and the createIssue / closeIssue / createPullRequest /
// mergePullRequest / addComment mutations — all backed by the same store the REST
// surface writes, so a mutation's result reads back over REST unchanged.

import { VIEWER_ID, VIEWER_LOGIN } from './scenario.ts';
import { globalId, parseGlobalId, type Issue, type Pull, type Repo, type Store } from './store.ts';

// ---------------------------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1] as string;
          const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };
          out += map[esc] ?? esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (input[j] === '-') j += 1;
      let isFloat = false;
      while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      if (input[j] === '.' && /[0-9]/.test(input[j + 1] as string)) {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < input.length && isNameChar(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at ${i}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// parser (the subset the suite's documents use)
// ---------------------------------------------------------------------------------------------

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[];
}

export interface FragmentSpreadNode {
  kind: 'fragmentSpread';
  name: string;
}

export interface InlineFragmentNode {
  kind: 'inlineFragment';
  typeCondition: string | null;
  selections: SelectionNode[];
}

export type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

export interface OperationNode {
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: Array<{ name: string; type: string; defaultValue?: ValueNode }>;
  selections: SelectionNode[];
}

export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, SelectionNode[]>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.kind} ${'value' in token ? token.value : ''}`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${token.kind}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        this.expectName();
        const selections = this.parseSelectionSet();
        fragments.set(name, selections);
        continue;
      }
      operations.push(this.parseOperation());
    }
    return { operations, fragments };
  }

  private parseOperation(): OperationNode {
    let operation: 'query' | 'mutation' | 'subscription' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      operation = this.next().value as 'query' | 'mutation' | 'subscription';
      if (this.peek().kind === 'name') name = this.next().value as string;
    } else if (token.kind === 'punct' && token.value === '{') {
      // Anonymous shorthand.
    } else {
      throw new Error('expected an operation');
    }
    const variables: OperationNode['variables'] = [];
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        const type = this.parseType();
        let defaultValue: ValueNode | undefined;
        if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '=') {
          this.next();
          defaultValue = this.parseValue(true);
        }
        variables.push({ name: varName, type, defaultValue });
      }
      this.expectPunct(')');
    }
    const selections = this.parseSelectionSet();
    return { operation, name, variables, selections };
  }

  private parseType(): string {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '[') {
      const inner = this.parseType();
      this.expectPunct(']');
      let out = `[${inner}]`;
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '!') {
        this.next();
        out += '!';
      }
      return out;
    }
    if (token.kind !== 'name') throw new Error('expected a type name');
    let out = token.value;
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '!') {
      this.next();
      out += '!';
    }
    return out;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const nextToken = this.peek();
      if (nextToken.kind === 'name' && nextToken.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (nextToken.kind === 'name') {
        return { kind: 'fragmentSpread', name: this.next().value as string };
      }
      return { kind: 'inlineFragment', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: FieldNode['args'] = [];
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue(false) });
      }
      this.expectPunct(')');
    }
    let selections: SelectionNode[] = [];
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', name, alias, args, selections };
  }

  private parseValue(isConst: boolean): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      if (isConst) throw new Error('a variable is not allowed in a constant value');
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ']')) {
        values.push(this.parseValue(isConst));
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue(isConst) });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${token.kind}`);
  }
}

export function parseDocument(query: string): DocumentNode {
  return new Parser(lex(query)).parseDocument();
}

// ---------------------------------------------------------------------------------------------
// values
// ---------------------------------------------------------------------------------------------

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function resolveArgs(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------------------------------------
// schema (for __type introspection)
// ---------------------------------------------------------------------------------------------

const SCHEMA_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'description', 'private', 'issue', 'issues', 'pullRequest', 'pullRequests',
    'createdAt', 'updatedAt',
  ],
  Ref: ['name', 'target'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'url', 'repository'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  IssueCommentEdge: ['node', 'cursor'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRefOid', 'baseRefOid', 'files', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit', 'author',
  ],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changes'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues'],
  __Field: ['name', 'description', 'type'],
  __EnumValue: ['name', 'description'],
};

const SCHEMA_ENUMS: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

// ---------------------------------------------------------------------------------------------
// resolved values: every node carries its type and its store object
// ---------------------------------------------------------------------------------------------

type NodeValue =
  | { __typename: 'User'; login: string; id: number }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Ref'; name: string; repo: Repo }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'IssueConnection'; repo: Repo; nodes: Issue[]; hasNextPage: boolean; endCursor: string | null }
  | { __typename: 'IssueEdge'; repo: Repo; issue: Issue; cursor: string }
  | { __typename: 'IssueComment'; repo: Repo; comment: { id: number; body: string } }
  | { __typename: 'IssueCommentEdge'; repo: Repo; comment: { id: number; body: string } }
  | { __typename: 'PullRequest'; repo: Repo; pull: Pull }
  | { __typename: 'PullRequestConnection'; repo: Repo; nodes: Pull[]; hasNextPage: boolean; endCursor: string | null }
  | { __typename: 'PullRequestChangedFileConnection'; repo: Repo; pull: Pull; nodes: Array<{ path: string; additions: number; deletions: number; changes: number }> }
  | { __typename: 'PullRequestChangedFile'; path: string; additions: number; deletions: number; changes: number }
  | { __typename: 'PageInfo'; hasNextPage: boolean; hasPreviousPage: boolean; endCursor: string | null; startCursor: string | null }
  | { __typename: 'CreateIssuePayload'; repo: Repo; issue: Issue }
  | { __typename: 'CloseIssuePayload'; repo: Repo; issue: Issue }
  | { __typename: 'CreatePullRequestPayload'; repo: Repo; pull: Pull }
  | { __typename: 'MergePullRequestPayload'; repo: Repo; pull: Pull }
  | { __typename: 'AddCommentPayload'; repo: Repo; comment: { id: number; body: string } }
  | { __typename: '__Type'; name: string };

function cursorOf(seq: number): string {
  return Buffer.from(`cursor:${seq}`, 'utf8').toString('base64url');
}

function seqOfCursor(cursor: string | null | undefined): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!raw.startsWith('cursor:')) return null;
    const n = Number(raw.slice('cursor:'.length));
    return Number.isSafeInteger(n) ? n : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------------------------

export interface GraphQLExecution {
  data: Record<string, unknown> | null;
  errors: Array<{ message: string }>;
}

class Executor {
  private errors: Array<{ message: string }> = [];
  private readonly store: Store;
  private readonly variables: Record<string, unknown>;
  private readonly fragments: Map<string, SelectionNode[]>;

  constructor(store: Store, variables: Record<string, unknown>, fragments: Map<string, SelectionNode[]>) {
    this.store = store;
    this.variables = variables;
    this.fragments = fragments;
  }

  run(operation: OperationNode): GraphQLExecution {
    this.errors = [];
    const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
    const data = this.resolveSelections(null, rootType, operation.selections);
    return { data, errors: this.errors };
  }

  private resolveSelections(parent: NodeValue | null, parentType: string, selections: SelectionNode[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind === 'fragmentSpread') {
        const fragment = this.fragments.get(selection.name);
        if (fragment) Object.assign(out, this.resolveSelections(parent, parentType, fragment));
        continue;
      }
      if (selection.kind === 'inlineFragment') {
        const actualType = parent === null ? parentType : parent.__typename;
        if (selection.typeCondition === null || selection.typeCondition === actualType) {
          Object.assign(out, this.resolveSelections(parent, parentType, selection.selections));
        }
        continue;
      }
      const field = selection;
      const responseKey = field.alias ?? field.name;
      const known = SCHEMA_FIELDS[parentType] ?? [];
      if (!known.includes(field.name)) {
        this.errors.push({ message: `Cannot query field "${field.name}" on type "${parentType}".` });
        out[responseKey] = null;
        continue;
      }
      const args = resolveArgs(field, this.variables);
      const value = this.resolveField(parent, parentType, field.name, args, field.selections);
      out[responseKey] = value;
    }
    return out;
  }

  private resolveNested(value: NodeValue | null, selections: SelectionNode[]): unknown {
    if (value === null) return null;
    if (selections.length === 0) return null;
    return this.resolveSelections(value, value.__typename, selections);
  }

  private resolveList(items: NodeValue[], selections: SelectionNode[]): unknown[] {
    return items.map((item) => this.resolveNested(item, selections));
  }

  private resolveField(parent: NodeValue | null, parentType: string, fieldName: string, args: Record<string, unknown>, selections: SelectionNode[]): unknown {
    // Root fields.
    if (parent === null) {
      if (parentType === 'Query') return this.resolveQueryField(fieldName, args, selections);
      if (parentType === 'Mutation') return this.resolveMutationField(fieldName, args, selections);
      return null;
    }
    switch (parent.__typename) {
      case 'User': {
        if (fieldName === 'login') return parent.login;
        if (fieldName === 'name') return parent.login;
        if (fieldName === 'email') return `${parent.login}@example.invalid`;
        if (fieldName === 'id') return globalId('Repository', parent.id);
        return null;
      }
      case 'Repository': {
        const repo = parent.repo;
        switch (fieldName) {
          case 'id':
            return globalId('Repository', repo.id);
          case 'databaseId':
            return repo.id;
          case 'name':
            return repo.name;
          case 'nameWithOwner':
            return `${repo.owner}/${repo.name}`;
          case 'owner':
            return this.resolveNested({ __typename: 'User', login: repo.owner, id: VIEWER_ID }, selections);
          case 'defaultBranchRef': {
            const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
            if (tip === undefined) return null;
            return this.resolveNested({ __typename: 'Ref', name: repo.defaultBranch, repo }, selections);
          }
          case 'viewerPermission':
            return 'ADMIN';
          case 'hasIssuesEnabled':
            return true;
          case 'description':
            return repo.description;
          case 'private':
            return repo.isPrivate;
          case 'createdAt':
          case 'updatedAt':
            return '2025-01-01T00:00:00.000Z';
          case 'issue': {
            const issue = this.store.getIssue(repo, Number(args.number));
            if (issue === undefined) return null;
            return this.resolveNested({ __typename: 'Issue', repo, issue }, selections);
          }
          case 'issues':
            return this.resolveNested(this.issuesConnection(repo, args), selections);
          case 'pullRequest': {
            const pull = this.store.getPull(repo, Number(args.number));
            if (pull === undefined) return null;
            return this.resolveNested({ __typename: 'PullRequest', repo, pull }, selections);
          }
          case 'pullRequests':
            return this.resolveNested(this.pullsConnection(repo, args), selections);
          default:
            return null;
        }
      }
      case 'Ref': {
        if (fieldName === 'name') return parent.name;
        if (fieldName === 'target') return null;
        return null;
      }
      case 'Issue': {
        const issue = parent.issue;
        switch (fieldName) {
          case 'id':
            return globalId('Issue', parent.repo.id, issue.number);
          case 'number':
            return issue.number;
          case 'title':
            return issue.title;
          case 'body':
            return issue.body;
          case 'state':
            return issue.state === 'open' ? 'OPEN' : 'CLOSED';
          case 'createdAt':
          case 'updatedAt':
            return '2025-01-01T00:00:00.000Z';
          case 'closedAt':
            return issue.state === 'closed' ? '2025-01-01T00:00:00.000Z' : null;
          case 'author':
            return this.resolveNested({ __typename: 'User', login: parent.repo.owner, id: VIEWER_ID }, selections);
          case 'labels':
            return issue.labels.map((name) => ({ name }));
          case 'comments':
            return this.resolveList(
              issue.comments.map((comment) => ({ __typename: 'IssueComment', repo: parent.repo, comment }) as NodeValue),
              selections,
            );
          case 'url':
            return `http://${parent.repo.owner}/${parent.repo.name}/issues/${issue.number}`;
          case 'repository':
            return this.resolveNested({ __typename: 'Repository', repo: parent.repo }, selections);
          default:
            return null;
        }
      }
      case 'IssueConnection': {
        switch (fieldName) {
          case 'nodes':
            return this.resolveList(parent.nodes.map((issue) => ({ __typename: 'Issue', repo: parent.repo, issue }) as NodeValue), selections);
          case 'edges':
            return this.resolveList(
              parent.nodes.map((issue) => ({ __typename: 'IssueEdge', repo: parent.repo, issue, cursor: cursorOf(issue.seq) }) as NodeValue),
              selections,
            );
          case 'pageInfo':
            return this.resolveNested(
              { __typename: 'PageInfo', hasNextPage: parent.hasNextPage, hasPreviousPage: false, endCursor: parent.endCursor, startCursor: parent.nodes.length > 0 ? cursorOf(parent.nodes[0]?.seq ?? 0) : null },
              selections,
            );
          case 'totalCount':
            return parent.nodes.length;
          default:
            return null;
        }
      }
      case 'IssueEdge': {
        if (fieldName === 'node') return this.resolveNested({ __typename: 'Issue', repo: parent.repo, issue: parent.issue }, selections);
        if (fieldName === 'cursor') return parent.cursor;
        return null;
      }
      case 'IssueComment': {
        if (fieldName === 'id') return globalId('IssueComment', parent.repo.id, parent.comment.id);
        if (fieldName === 'body') return parent.comment.body;
        if (fieldName === 'author') return this.resolveNested({ __typename: 'User', login: parent.repo.owner, id: VIEWER_ID }, selections);
        if (fieldName === 'createdAt') return '2025-01-01T00:00:00.000Z';
        return null;
      }
      case 'IssueCommentEdge': {
        if (fieldName === 'node') return this.resolveNested({ __typename: 'IssueComment', repo: parent.repo, comment: parent.comment }, selections);
        if (fieldName === 'cursor') return cursorOf(parent.comment.id);
        return null;
      }
      case 'PullRequest': {
        const pull = parent.pull;
        switch (fieldName) {
          case 'id':
            return globalId('PullRequest', parent.repo.id, pull.number);
          case 'number':
            return pull.number;
          case 'title':
            return pull.title;
          case 'body':
            return pull.body;
          case 'state':
            return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
          case 'merged':
            return pull.merged;
          case 'mergeable':
            return this.store.pullMergeable(parent.repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
          case 'headRefName':
            return pull.headRef;
          case 'baseRefName':
            return pull.baseRef;
          case 'headRefOid':
            return this.store.pullHeadSha(parent.repo, pull);
          case 'baseRefOid':
            return pull.baseShaAtCreation;
          case 'files': {
            const files = this.store.pullFiles(parent.repo, pull);
            const first = typeof args.first === 'number' ? args.first : files.length;
            const nodes = files.slice(0, first).map((file) => ({ __typename: 'PullRequestChangedFile', path: file.filename, additions: file.additions, deletions: file.deletions, changes: file.changes }) as NodeValue);
            return this.resolveNested(
              { __typename: 'PullRequestChangedFileConnection', repo: parent.repo, pull, nodes } as NodeValue,
              selections,
            );
          }
          case 'createdAt':
          case 'updatedAt':
            return '2025-01-01T00:00:00.000Z';
          case 'mergedAt':
            return pull.mergedAt;
          case 'mergeCommit':
            return pull.mergeCommitSha;
          case 'author':
            return this.resolveNested({ __typename: 'User', login: parent.repo.owner, id: VIEWER_ID }, selections);
          default:
            return null;
        }
      }
      case 'PullRequestConnection': {
        switch (fieldName) {
          case 'nodes':
            return this.resolveList(parent.nodes.map((pull) => ({ __typename: 'PullRequest', repo: parent.repo, pull }) as NodeValue), selections);
          case 'edges':
            return [];
          case 'pageInfo':
            return this.resolveNested(
              { __typename: 'PageInfo', hasNextPage: parent.hasNextPage, hasPreviousPage: false, endCursor: parent.endCursor, startCursor: null },
              selections,
            );
          case 'totalCount':
            return parent.nodes.length;
          default:
            return null;
        }
      }
      case 'PullRequestChangedFileConnection': {
        if (fieldName === 'nodes') return this.resolveList(parent.nodes, selections);
        if (fieldName === 'pageInfo') {
          return this.resolveNested({ __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, endCursor: null, startCursor: null }, selections);
        }
        return null;
      }
      case 'PullRequestChangedFile': {
        if (fieldName === 'path') return parent.path;
        if (fieldName === 'additions') return parent.additions;
        if (fieldName === 'deletions') return parent.deletions;
        if (fieldName === 'changes') return parent.changes;
        return null;
      }
      case 'PageInfo': {
        if (fieldName === 'hasNextPage') return parent.hasNextPage;
        if (fieldName === 'hasPreviousPage') return parent.hasPreviousPage;
        if (fieldName === 'endCursor') return parent.endCursor;
        if (fieldName === 'startCursor') return parent.startCursor;
        return null;
      }
      case 'CreateIssuePayload': {
        if (fieldName === 'issue') return this.resolveNested({ __typename: 'Issue', repo: parent.repo, issue: parent.issue }, selections);
        return null;
      }
      case 'CloseIssuePayload': {
        if (fieldName === 'issue') return this.resolveNested({ __typename: 'Issue', repo: parent.repo, issue: parent.issue }, selections);
        return null;
      }
      case 'CreatePullRequestPayload':
      case 'MergePullRequestPayload': {
        if (fieldName === 'pullRequest') return this.resolveNested({ __typename: 'PullRequest', repo: parent.repo, pull: parent.pull }, selections);
        return null;
      }
      case 'AddCommentPayload': {
        if (fieldName === 'commentEdge') {
          return this.resolveNested({ __typename: 'IssueCommentEdge', repo: parent.repo, comment: parent.comment }, selections);
        }
        return null;
      }
      case '__Type': {
        if (fieldName === 'name') return parent.name;
        if (fieldName === 'kind') return SCHEMA_ENUMS[parent.name] !== undefined ? 'ENUM' : 'OBJECT';
        if (fieldName === 'description') return null;
        if (fieldName === 'fields') {
          const fields = SCHEMA_FIELDS[parent.name] ?? [];
          return fields.map((name) => ({ name }));
        }
        if (fieldName === 'enumValues') {
          const values = SCHEMA_ENUMS[parent.name] ?? [];
          return values.map((name) => ({ name }));
        }
        return null;
      }
      default:
        return null;
    }
  }

  private resolveQueryField(fieldName: string, args: Record<string, unknown>, selections: SelectionNode[]): unknown {
    switch (fieldName) {
      case 'viewer':
        return this.resolveNested({ __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID }, selections);
      case 'repository': {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        if (owner !== VIEWER_LOGIN) return null;
        const repo = this.store.getRepo(owner, name);
        if (repo === undefined) return null;
        return this.resolveNested({ __typename: 'Repository', repo }, selections);
      }
      case 'node': {
        const parsed = parseGlobalId(String(args.id ?? ''));
        if (parsed === null) return null;
        const repo = this.store.getRepoById(parsed.repoId);
        if (repo === undefined) return null;
        if (parsed.kind === 'Repository') return this.resolveNested({ __typename: 'Repository', repo }, selections);
        if (parsed.kind === 'Issue' && parsed.n !== null) {
          const issue = this.store.getIssue(repo, parsed.n);
          if (issue === undefined) return null;
          return this.resolveNested({ __typename: 'Issue', repo, issue }, selections);
        }
        if (parsed.kind === 'PullRequest' && parsed.n !== null) {
          const pull = this.store.getPull(repo, parsed.n);
          if (pull === undefined) return null;
          return this.resolveNested({ __typename: 'PullRequest', repo, pull }, selections);
        }
        return null;
      }
      case '__type': {
        const name = String(args.name ?? '');
        if (SCHEMA_FIELDS[name] === undefined && SCHEMA_ENUMS[name] === undefined) return null;
        return this.resolveNested({ __typename: '__Type', name }, selections);
      }
      case '__schema':
        return null;
      default:
        return null;
    }
  }

  private resolveMutationField(fieldName: string, args: Record<string, unknown>, selections: SelectionNode[]): unknown {
    const input = (args.input ?? {}) as Record<string, unknown>;
    switch (fieldName) {
      case 'createIssue': {
        const parsed = parseGlobalId(String(input.repositoryId ?? ''));
        if (parsed === null || parsed.kind !== 'Repository') {
          this.errors.push({ message: 'createIssue: unknown repositoryId' });
          return null;
        }
        const repo = this.store.getRepoById(parsed.repoId);
        if (repo === undefined) {
          this.errors.push({ message: 'createIssue: unknown repositoryId' });
          return null;
        }
        const created = this.store.createIssue(repo, { title: String(input.title ?? ''), body: String(input.body ?? '') });
        if ('error' in created) {
          this.errors.push({ message: `createIssue: ${created.error}` });
          return null;
        }
        return this.resolveNested({ __typename: 'CreateIssuePayload', repo, issue: created }, selections);
      }
      case 'closeIssue': {
        const parsed = parseGlobalId(String(input.issueId ?? ''));
        if (parsed === null || parsed.kind !== 'Issue' || parsed.n === null) {
          this.errors.push({ message: 'closeIssue: unknown issueId' });
          return null;
        }
        const repo = this.store.getRepoById(parsed.repoId);
        const issue = repo === undefined ? undefined : this.store.getIssue(repo, parsed.n);
        if (repo === undefined || issue === undefined) {
          this.errors.push({ message: 'closeIssue: unknown issueId' });
          return null;
        }
        issue.state = 'closed';
        return this.resolveNested({ __typename: 'CloseIssuePayload', repo, issue }, selections);
      }
      case 'createPullRequest': {
        const parsed = parseGlobalId(String(input.repositoryId ?? ''));
        if (parsed === null || parsed.kind !== 'Repository') {
          this.errors.push({ message: 'createPullRequest: unknown repositoryId' });
          return null;
        }
        const repo = this.store.getRepoById(parsed.repoId);
        if (repo === undefined) {
          this.errors.push({ message: 'createPullRequest: unknown repositoryId' });
          return null;
        }
        const created = this.store.createPull(repo, {
          head: String(input.headRefName ?? ''),
          base: String(input.baseRefName ?? ''),
          title: String(input.title ?? ''),
          body: String(input.body ?? ''),
        });
        if ('error' in created) {
          this.errors.push({ message: `createPullRequest: ${created.error}` });
          return null;
        }
        return this.resolveNested({ __typename: 'CreatePullRequestPayload', repo, pull: created }, selections);
      }
      case 'mergePullRequest': {
        const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
        if (parsed === null || parsed.kind !== 'PullRequest' || parsed.n === null) {
          this.errors.push({ message: 'mergePullRequest: unknown pullRequestId' });
          return null;
        }
        const repo = this.store.getRepoById(parsed.repoId);
        const pull = repo === undefined ? undefined : this.store.getPull(repo, parsed.n);
        if (repo === undefined || pull === undefined) {
          this.errors.push({ message: 'mergePullRequest: unknown pullRequestId' });
          return null;
        }
        const merged = this.store.mergePull(repo, pull);
        if ('error' in merged) {
          this.errors.push({ message: `mergePullRequest: ${merged.error}` });
          return null;
        }
        return this.resolveNested({ __typename: 'MergePullRequestPayload', repo, pull }, selections);
      }
      case 'addComment': {
        const parsed = parseGlobalId(String(input.subjectId ?? ''));
        if (parsed === null || parsed.kind !== 'Issue' || parsed.n === null) {
          this.errors.push({ message: 'addComment: unknown subjectId' });
          return null;
        }
        const repo = this.store.getRepoById(parsed.repoId);
        if (repo === undefined) {
          this.errors.push({ message: 'addComment: unknown subjectId' });
          return null;
        }
        const comment = this.store.createComment(repo, parsed.n, String(input.body ?? ''));
        if (comment === null) {
          this.errors.push({ message: 'addComment: unknown subjectId' });
          return null;
        }
        return this.resolveNested({ __typename: 'AddCommentPayload', repo, comment }, selections);
      }
      default:
        return null;
    }
  }

  private issuesConnection(repo: Repo, args: Record<string, unknown>): NodeValue {
    let list = [...repo.issues];
    const states = args.states;
    if (Array.isArray(states) && states.length > 0) {
      const wanted = new Set(states.map((state) => String(state).toLowerCase()));
      list = list.filter((issue) => wanted.has(issue.state));
    }
    const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
    const field = orderBy?.field ?? 'CREATED_AT';
    const direction = orderBy?.direction ?? 'DESC';
    list.sort((a, b) => {
      const cmp = field === 'COMMENTS' ? a.comments.length - b.comments.length : a.seq - b.seq;
      return direction === 'ASC' ? cmp : -cmp;
    });
    const afterSeq = seqOfCursor(typeof args.after === 'string' ? args.after : null);
    if (afterSeq !== null) {
      const index = list.findIndex((issue) => issue.seq === afterSeq);
      if (index >= 0) list = list.slice(index + 1);
    }
    const first = typeof args.first === 'number' ? args.first : list.length;
    const page = list.slice(0, first);
    return {
      __typename: 'IssueConnection',
      repo,
      nodes: page,
      hasNextPage: list.length > page.length,
      endCursor: page.length > 0 ? cursorOf(page[page.length - 1]?.seq ?? 0) : null,
    };
  }

  private pullsConnection(repo: Repo, args: Record<string, unknown>): NodeValue {
    const list = this.store.listPulls(repo, 'open');
    const first = typeof args.first === 'number' ? args.first : list.length;
    const page = list.slice(0, first);
    return {
      __typename: 'PullRequestConnection',
      repo,
      nodes: page,
      hasNextPage: list.length > page.length,
      endCursor: page.length > 0 ? cursorOf(page[page.length - 1]?.seq ?? 0) : null,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// HTTP entry point: one operation or a batch, answered {data, errors?}
// ---------------------------------------------------------------------------------------------

export interface GraphQLBody {
  status: number;
  body: string;
}

export function handleGraphQL(store: Store, rawBody: Buffer): GraphQLBody {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: JSON.stringify({ errors: [{ message: 'request body is not valid JSON' }] }) };
  }
  const operations = Array.isArray(parsed) ? parsed : [parsed];
  const answers: Array<Record<string, unknown>> = [];
  for (const entry of operations) {
    if (typeof entry !== 'object' || entry === null || typeof (entry as Record<string, unknown>).query !== 'string') {
      answers.push({ data: null, errors: [{ message: 'each operation needs a query string' }] });
      continue;
    }
    const record = entry as Record<string, unknown>;
    const query = record.query as string;
    const variables = (record.variables ?? {}) as Record<string, unknown>;
    const operationName = typeof record.operationName === 'string' ? record.operationName : null;
    let document: DocumentNode;
    try {
      document = parseDocument(query);
    } catch (err) {
      answers.push({ data: null, errors: [{ message: `could not parse the document: ${(err as Error).message}` }] });
      continue;
    }
    const operation = operationName === null ? document.operations[0] : document.operations.find((op) => op.name === operationName);
    if (operation === undefined) {
      answers.push({ data: null, errors: [{ message: `no operation named ${operationName ?? ''}` }] });
      continue;
    }
    const executor = new Executor(store, variables, document.fragments);
    const result = executor.run(operation);
    const answer: Record<string, unknown> = { data: result.data };
    if (result.errors.length > 0) answer.errors = result.errors;
    answers.push(answer);
  }
  const body = Array.isArray(parsed) ? JSON.stringify(answers) : JSON.stringify(answers[0] ?? { data: null });
  return { status: 200, body };
}
