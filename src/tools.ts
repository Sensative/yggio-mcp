import * as z from 'zod';
import type {McpServer} from '@modelcontextprotocol/server';
import type {Config} from './config.js';
import {YggioClient, YggioError, type Query} from './client.js';
import {describeOperation, findOperation, searchOperations, spec, tags} from './spec.js';

type ToolResult = {content: Array<{type: 'text'; text: string}>; isError?: boolean};

export const render = (value: unknown, maxChars: number): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? 'null';
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n\n[Truncated: the response was ${text.length} characters, showing the first ${maxChars}. ` +
    'Narrow the request (filters, limit, a shorter time range, a larger stats `distance`) to see all of it.]';
};

const run = async (maxChars: number, fn: () => Promise<unknown>): Promise<ToolResult> => {
  try {
    return {content: [{type: 'text', text: render(await fn(), maxChars)}]};
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {content: [{type: 'text', text: message}], isError: true};
  }
};

/** Accepts unix ms, unix seconds, an ISO date, or "now" / "now-7d" (s/m/h/d/w). */
export const toMillis = (value: string | number | undefined, name: string, now = Date.now()) => {
  if (value === undefined || value === '') {
    return undefined;
  }
  if (typeof value === 'number' || /^\d+$/.test(value)) {
    const n = Number(value);
    return n < 1e11 ? n * 1000 : n;
  }
  const relative = /^now(?:\s*-\s*(\d+)\s*([smhdw]))?$/i.exec(value.trim());
  if (relative) {
    const units: Record<string, number> = {s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5};
    return now - Number(relative[1] ?? 0) * (units[(relative[2] ?? 's').toLowerCase()] ?? 1e3);
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new YggioError(`${name} must be an ISO date, unix milliseconds, or "now-7d"-style; got "${value}"`);
  }
  return parsed;
};

const SUMMARY_FIELDS = [
  '_id', 'name', 'description', 'deviceModelName', 'devEui', 'serialNumber', 'connector',
  'reportedAt', 'updatedAt', 'synchronizedAt', 'expectedReportInterval', 'lnglat',
];

const getPath = (obj: unknown, dotted: string) =>
  dotted.split('.').reduce<unknown>((node, part) =>
    node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined, obj);

export const summarizeDevice = (device: Record<string, unknown>, extra: string[] = []) => {
  const out: Record<string, unknown> = {};
  for (const key of [...SUMMARY_FIELDS, ...extra]) {
    const value = getPath(device, key);
    if (value === undefined) {
      continue;
    }
    out[key] = key === 'connector' && value && typeof value === 'object'
      ? {_id: getPath(value, '_id'), name: getPath(value, 'name')}
      : value;
  }
  return out;
};

const queryValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]);
const queryRecord = z.record(z.string(), queryValue).optional()
  .describe('Query string parameters as an object, e.g. {"limit": 10, "orderBy": "name"}.');

const httpError = (method: string, path: string, status: number, body: unknown) =>
  new YggioError(`${method} ${path} returned HTTP ${status}: ${render(body ?? '', 2000)}`, status, body);

export const registerTools = (server: McpServer, config: Config, client: YggioClient) => {
  const max = config.maxResponseChars;

  server.registerTool('yggio_whoami', {
    title: 'Who am I in Yggio',
    description: 'Returns the logged-in Yggio user and which Yggio instance this server talks to. Call it first to confirm the connection works.',
    inputSchema: z.object({}),
    annotations: {readOnlyHint: true, openWorldHint: true},
  }, async () => run(max, async () => ({
    yggio: client.baseUrl,
    readOnly: config.readOnly,
    user: await client.call('GET', '/users/me'),
  })));

  server.registerTool('yggio_find_devices', {
    title: 'Find devices',
    description:
      'Lists Yggio devices (called "iotnodes" in the API) the user can see. Filter by exact name, devEui, ' +
      'any other field via `filters`, or an NGSIv2-like query `q` (e.g. "temperature>25"). Returns a compact summary ' +
      'per device by default; pass `fields` to add more (dot paths like "value.temperature"), or `full: true` for whole documents. ' +
      'Paginate with orderBy + cursorDirection + cursorId (the orderBy value of the last device in the previous page).',
    inputSchema: z.object({
      name: z.string().optional().describe('Exact device name (comma-separate several).'),
      devEui: z.string().optional(),
      q: z.string().optional().describe('NGSIv2-like query, e.g. "deviceModelName==sensative-strips-comfort".'),
      filters: z.record(z.string(), z.string()).optional()
        .describe('Any other field=value filters, e.g. {"deviceModelName": "sensative-strips-comfort"}.'),
      limit: z.number().int().min(1).max(2000).optional().describe('Default 50.'),
      orderBy: z.enum(['_id', 'name', 'reportedAt']).optional(),
      cursorDirection: z.enum(['next', 'prev']).optional(),
      cursorId: z.string().optional(),
      fields: z.array(z.string()).optional().describe('Extra fields to include in each summary.'),
      full: z.boolean().optional().describe('Return complete device documents (large).'),
    }),
    annotations: {readOnlyHint: true, openWorldHint: true},
  }, async args => run(max, async () => {
    const limit = args.limit ?? 50;
    const query: Query = {
      ...(args.filters ?? {}),
      name: args.name,
      devEui: args.devEui,
      q: args.q,
      limit,
      orderBy: args.orderBy,
      cursorDirection: args.cursorDirection,
      cursorId: args.cursorId,
    };
    const devices = await client.call<Array<Record<string, unknown>>>('GET', '/iotnodes', {query});
    const list = Array.isArray(devices) ? devices : [];
    return {
      count: list.length,
      ...(list.length === limit ? {note: 'Hit the limit; there may be more. Paginate or narrow the filter.'} : {}),
      devices: args.full ? list : list.map(d => summarizeDevice(d, args.fields)),
    };
  }));

  server.registerTool('yggio_get_device', {
    title: 'Get device',
    description: 'Fetches one device (iotnode) by its _id, with all its current values.',
    inputSchema: z.object({id: z.string().min(1).describe('Device _id.')}),
    annotations: {readOnlyHint: true, openWorldHint: true},
  }, async ({id}) => run(max, () => client.call('GET', `/iotnodes/${encodeURIComponent(id)}`)));

  server.registerTool('yggio_device_measurements', {
    title: 'List measurements of a device',
    description: 'Lists which time-series fields (measurements) a device has stored. Use the names with yggio_device_history.',
    inputSchema: z.object({id: z.string().min(1).describe('Device _id.')}),
    annotations: {readOnlyHint: true, openWorldHint: true},
  }, async ({id}) => run(max, () => client.call('GET', `/iotnodes/${encodeURIComponent(id)}/stats/fields`)));

  server.registerTool('yggio_device_history', {
    title: 'Device time series',
    description:
      'Reads stored history for one measurement of a device. Times accept ISO dates, unix ms, or "now-7d" (s/m/h/d/w). ' +
      'Without `distance` you get raw points; with `distance` (seconds per bucket) you get aggregated points ' +
      '(mean/max/min/stddev, or `valueFunction`). Yggio returns at most 1000 points, so pick `distance` to fit the range.',
    inputSchema: z.object({
      id: z.string().min(1).describe('Device _id.'),
      measurement: z.string().min(1).describe('Field name, from yggio_device_measurements (e.g. "temperature").'),
      start: z.union([z.string(), z.number()]).optional().describe('Default: 30 days before end.'),
      end: z.union([z.string(), z.number()]).optional().describe('Default: now.'),
      distance: z.number().positive().optional().describe('Seconds per aggregated point, e.g. 3600 for hourly.'),
      valueFunction: z.enum(['mean', 'max', 'min', 'first', 'last', 'sum', 'count', 'difference', 'timeWeightedMean']).optional(),
      timezone: z.string().optional().describe('IANA zone for bucket alignment, e.g. "Europe/Stockholm".'),
    }),
    annotations: {readOnlyHint: true, openWorldHint: true},
  }, async args => run(max, async () => {
    const start = toMillis(args.start, 'start');
    const end = toMillis(args.end, 'end');
    const query: Query = {
      measurement: args.measurement,
      start,
      end,
      distance: args.distance,
      valueFunction: args.valueFunction,
      timezone: args.timezone,
    };
    const points = await client.call<unknown[]>('GET', `/iotnodes/${encodeURIComponent(args.id)}/stats`, {query});
    return {
      measurement: args.measurement,
      ...(start === undefined ? {} : {start: new Date(start).toISOString()}),
      ...(end === undefined ? {} : {end: new Date(end).toISOString()}),
      count: Array.isArray(points) ? points.length : undefined,
      points,
    };
  }));

  server.registerTool('yggio_search_api', {
    title: 'Search the Yggio API',
    description:
      'Searches the bundled Yggio REST API reference for endpoints matching keywords such as "device groups", "rules", ' +
      '"organization members", "reports". Returns method, path and summary. Then use yggio_describe_endpoint for ' +
      'parameters and body, and yggio_api_get / yggio_api_write to call it. ' +
      `Tags: ${tags.join(', ')}.`,
    inputSchema: z.object({
      query: z.string().optional().describe('Keywords. Empty lists everything (with tag, everything in that tag).'),
      tag: z.string().optional().describe('Restrict to one tag, e.g. "Iotnodes".'),
      limit: z.number().int().min(1).max(250).optional().describe('Default 25.'),
    }),
    annotations: {readOnlyHint: true, openWorldHint: false},
  }, async args => run(max, async () => searchOperations(args.query, args.tag, args.limit ?? 25)));

  server.registerTool('yggio_describe_endpoint', {
    title: 'Describe a Yggio API endpoint',
    description:
      'Shows the full reference for one endpoint: parameters, request body schema and success response schema. ' +
      'Identify it by operationId, or by path (as in yggio_search_api, e.g. "/iotnodes/{id}/stats") plus method.',
    inputSchema: z.object({
      endpoint: z.string().min(1).describe('operationId (e.g. "getIotnodeStats") or path template.'),
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional().describe('Needed when a path has several methods.'),
      depth: z.number().int().min(1).max(8).optional().describe('How many levels of schema $refs to inline (default 4).'),
    }),
    annotations: {readOnlyHint: true, openWorldHint: false},
  }, async args => run(max, async () => {
    const matches = findOperation(args.method, args.endpoint);
    if (matches.length === 0) {
      throw new YggioError(`No endpoint matches "${args.endpoint}"${args.method ? ` ${args.method}` : ''}. Use yggio_search_api to find it.`);
    }
    if (matches.length > 1) {
      return {
        note: 'Several methods share this path; pass `method` to pick one.',
        methods: matches.map(m => ({method: m.method, operationId: m.operationId, summary: m.summary})),
      };
    }
    return describeOperation(matches[0]!, args.depth ?? 4);
  }));

  server.registerTool('yggio_api_get', {
    title: 'GET from the Yggio API',
    description:
      'Calls any read-only (GET) endpoint of the Yggio REST API as the logged-in user. `path` is relative to /api with ' +
      'ids filled in, e.g. "/device-groups" or "/organizations/64ab.../members". Find endpoints with yggio_search_api.',
    inputSchema: z.object({
      path: z.string().min(1).describe('API path with ids filled in, e.g. "/iotnodes/abc123".'),
      query: queryRecord,
    }),
    annotations: {readOnlyHint: true, openWorldHint: true},
  }, async ({path, query}) => run(max, async () => {
    const res = await client.request('GET', path, {query});
    if (res.status >= 400) {
      throw httpError('GET', path, res.status, res.body);
    }
    return res.body ?? {status: res.status};
  }));

  if (!config.readOnly) {
    server.registerTool('yggio_api_write', {
      title: 'Change data in Yggio',
      description:
        'Calls a POST, PUT, PATCH or DELETE endpoint of the Yggio REST API as the logged-in user. This changes real data ' +
        '(creates, edits or deletes devices, groups, rules, users...) or sends commands to devices. Check the endpoint with ' +
        'yggio_describe_endpoint first, and confirm with the user before deleting anything or changing many items.',
      inputSchema: z.object({
        method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
        path: z.string().min(1).describe('API path with ids filled in, e.g. "/device-groups/abc/members".'),
        query: queryRecord,
        body: z.unknown().optional().describe('JSON request body.'),
      }),
      annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true},
    }, async ({method, path, query, body}) => run(max, async () => {
      const res = await client.request(method, path, {query, body});
      if (res.status >= 400) {
        throw httpError(method, path, res.status, res.body);
      }
      return {status: res.status, body: res.body};
    }));
  }
};
