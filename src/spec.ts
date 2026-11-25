import specJson from './generated/openapi.json' with {type: 'json'};

type Json = unknown;
type JsonObject = Record<string, Json>;

interface Spec {
  info: {title?: string; version?: string; source?: string};
  description: string;
  paths: Record<string, Record<string, JsonObject>>;
  components: Record<string, JsonObject>;
}

export const spec = specJson as unknown as Spec;

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

export interface Operation {
  method: string;
  path: string;
  operationId?: string;
  tags: string[];
  summary: string;
  deprecated: boolean;
  /** Lower-cased text the search runs over. */
  haystack: string;
}

const firstLine = (text: unknown) => {
  if (typeof text !== 'string') {
    return '';
  }
  const line = text.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#')) ?? '';
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
};

const pointerGet = (doc: Json, pointer: string): Json =>
  pointer.split('/').slice(1).reduce<Json>((node, part) => {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    return node && typeof node === 'object' ? (node as JsonObject)[key] : undefined;
  }, doc);

const resolveRef = (ref: string): Json => {
  const [file, pointer = ''] = ref.split('#');
  return pointerGet(spec.components[file ?? ''], pointer);
};

const refName = (ref: string) => ref.split('/').pop() ?? ref;

/**
 * Inlines component $refs up to `depth` levels. Deeper refs, and refs that
 * would recurse into themselves, are left as {"$ref": "Name"} so the output
 * stays bounded.
 */
export const expand = (node: Json, depth = 4, seen: string[] = []): Json => {
  if (Array.isArray(node)) {
    return node.map(item => expand(item, depth, seen));
  }
  if (node === null || typeof node !== 'object') {
    return node;
  }
  const obj = node as JsonObject;
  if (typeof obj.$ref === 'string') {
    const ref = obj.$ref;
    if (depth <= 0 || seen.includes(ref)) {
      return {$ref: refName(ref)};
    }
    const target = resolveRef(ref);
    return target === undefined ? {$ref: refName(ref), unresolved: true} : expand(target, depth - 1, [...seen, ref]);
  }
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, expand(v, depth, seen)]));
};

export const operations: Operation[] = Object.entries(spec.paths).flatMap(([path, item]) =>
  METHODS.filter(m => item[m]).map(m => {
    const op = item[m] as JsonObject;
    const tags = Array.isArray(op.tags) ? (op.tags as string[]) : [];
    const summary = firstLine(op.summary) || firstLine(op.description);
    const params = Array.isArray(op.parameters)
      ? (op.parameters as JsonObject[]).map(p => (typeof p.$ref === 'string' ? refName(p.$ref) : String(p.name ?? ''))).join(' ')
      : '';
    return {
      method: m.toUpperCase(),
      path,
      operationId: typeof op.operationId === 'string' ? op.operationId : undefined,
      tags,
      summary,
      deprecated: op.deprecated === true,
      haystack: [m, path, op.operationId, tags.join(' '), op.summary, op.description, params]
        .filter(Boolean)
        .join(' ')
        .toLowerCase(),
    };
  }),
);

export const tags = [...new Set(operations.flatMap(o => o.tags))].sort();

const tokenize = (q: string) =>
  q.toLowerCase().split(/[^a-z0-9{}_-]+/).filter(Boolean).flatMap(t => {
    // "devices" should find "iotnodes"; Yggio calls devices iotnodes.
    const synonyms: Record<string, string[]> = {
      device: ['iotnode'], devices: ['iotnode'], sensor: ['iotnode'], sensors: ['iotnode'],
      timeseries: ['stats'], history: ['stats'], measurements: ['stats'], data: ['stats'],
      org: ['organization'], orgs: ['organization'], group: ['group'], groups: ['group'],
      rule: ['rule'], rules: ['rule'], alarm: ['rule', 'log'], alarms: ['rule', 'log'],
    };
    const stem = t.endsWith('s') && t.length > 3 ? t.slice(0, -1) : t;
    return [...new Set([stem, ...(synonyms[t] ?? [])])];
  });

export const searchOperations = (query: string | undefined, tag: string | undefined, limit: number) => {
  let pool = operations;
  if (tag) {
    const t = tag.toLowerCase();
    pool = pool.filter(o => o.tags.some(x => x.toLowerCase() === t));
  }
  const terms = tokenize(query ?? '');
  const scored = pool
    .map(o => {
      const score = terms.reduce((s, t) => {
        if (!o.haystack.includes(t)) {
          return s;
        }
        return s + 1 + (o.path.toLowerCase().includes(t) ? 2 : 0) + (o.operationId?.toLowerCase().includes(t) ? 1 : 0);
      }, 0);
      return {o, score};
    })
    .filter(x => terms.length === 0 || x.score > 0)
    .sort((a, b) => b.score - a.score || a.o.path.localeCompare(b.o.path));
  return {
    total: scored.length,
    results: scored.slice(0, limit).map(({o}) => ({
      method: o.method,
      path: o.path,
      operationId: o.operationId,
      tags: o.tags,
      summary: o.summary,
      ...(o.deprecated ? {deprecated: true} : {}),
    })),
  };
};

export const findOperation = (method: string | undefined, pathOrId: string) => {
  const key = pathOrId.trim();
  const byId = operations.filter(o => o.operationId?.toLowerCase() === key.toLowerCase());
  if (byId.length) {
    return byId;
  }
  const p = key.replace(/^\/api(?=\/)/, '');
  return operations.filter(o => o.path === p && (!method || o.method === method.toUpperCase()));
};

export const describeOperation = (op: Operation, depth: number) => {
  const raw = spec.paths[op.path]?.[op.method.toLowerCase()] as JsonObject;
  const pathLevelParams = (spec.paths[op.path]?.parameters as Json[] | undefined) ?? [];
  const expanded = expand({...raw, parameters: [...pathLevelParams, ...((raw.parameters as Json[]) ?? [])]}, depth) as JsonObject;
  const responses = expanded.responses as Record<string, JsonObject> | undefined;
  return {
    method: op.method,
    path: op.path,
    callWith: op.method === 'GET' ? 'yggio_api_get' : 'yggio_api_write',
    operationId: op.operationId,
    tags: op.tags,
    description: expanded.description ?? expanded.summary,
    parameters: expanded.parameters,
    requestBody: expanded.requestBody,
    // Success responses in full, errors by status + description only.
    responses: responses && Object.fromEntries(
      Object.entries(responses).map(([status, r]) =>
        status.startsWith('2') ? [status, r] : [status, (r as JsonObject)?.description ?? '']),
    ),
  };
};
