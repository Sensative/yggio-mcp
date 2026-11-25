// End to end: the built dist/yggio-mcp.mjs, spawned over stdio by the MCP SDK
// v2 client, against a fake Yggio REST API on localhost.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';

const bundle = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/yggio-mcp.mjs');

const jwt = (exp) => ['e30', Buffer.from(JSON.stringify({exp})).toString('base64url'), 'sig'].join('.');

const state = {logins: 0, validToken: undefined, requests: []};
const devices = [
  {_id: 'a'.repeat(24), name: 'strips-1', deviceModelName: 'sensative-strips-comfort', reportedAt: '2026-11-24T10:00:00Z',
    secret: 'x', value: {temperature: 21.5}, connector: {_id: 'c1', name: 'Netmore', huge: 'y'.repeat(100)}},
  {_id: 'b'.repeat(24), name: 'strips-2', deviceModelName: 'sensative-strips-comfort'},
];

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const body = raw ? JSON.parse(raw) : undefined;
    state.requests.push({method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, auth: req.headers.authorization});
    const send = (status, payload) => {
      res.writeHead(status, {'content-type': 'application/json'});
      res.end(payload === undefined ? '' : JSON.stringify(payload));
    };
    if (url.pathname === '/api/auth/local' && req.method === 'POST') {
      if (body?.username !== 'demo-user' || body?.password !== 'hemligt') {
        return send(401, {message: 'bad credentials'});
      }
      state.logins += 1;
      state.validToken = jwt(Math.floor(Date.now() / 1000) + 3600 + state.logins);
      return send(200, {token: state.validToken});
    }
    if (req.headers.authorization !== `Bearer ${state.validToken}`) {
      return send(401, {message: 'unauthorized'});
    }
    if (url.pathname === '/api/users/me') {
      return send(200, {_id: 'u1', username: 'demo-user'});
    }
    if (url.pathname === '/api/iotnodes' && req.method === 'GET') {
      return send(200, devices.slice(0, Number(url.searchParams.get('limit') ?? 50)));
    }
    if (url.pathname === `/api/iotnodes/${devices[0]._id}/stats`) {
      return send(200, [{time: '2026-11-24T10:00:00Z', value: 21.5}]);
    }
    if (url.pathname === '/api/iotnodes/command' && req.method === 'PUT') {
      return send(200, {ok: true});
    }
    if (url.pathname === '/api/device-groups') {
      return send(200, [{_id: 'g1', name: 'Floor 3'}]);
    }
    return send(404, {message: 'not found'});
  });
});

let baseUrl;
before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const connect = async ({pin, env = {}} = {}) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bundle],
    env: {PATH: process.env.PATH, YGGIO_URL: `${baseUrl}/api`, YGGIO_USERNAME: 'demo-user', YGGIO_PASSWORD: 'hemligt', ...env},
    stderr: 'pipe',
  });
  const client = new Client({name: 'e2e', version: '0'}, pin ? {versionNegotiation: {mode: {pin}}} : {});
  await client.connect(transport);
  return client;
};

const call = async (client, name, args = {}) => {
  const result = await client.callTool({name, arguments: args});
  const text = result.content.map(c => c.text).join('');
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return {isError: Boolean(result.isError), text, json};
};

for (const pin of [undefined, '2026-07-28']) {
  test(`protocol ${pin ?? '2025 (legacy handshake)'}: tools, login and calls`, async () => {
    const client = await connect({pin});
    try {
      const {tools} = await client.listTools();
      const names = tools.map(t => t.name).sort();
      assert.deepEqual(names, [
        'yggio_api_get', 'yggio_api_write', 'yggio_describe_endpoint', 'yggio_device_history',
        'yggio_device_measurements', 'yggio_find_devices', 'yggio_get_device', 'yggio_search_api', 'yggio_whoami',
      ]);
      assert.equal(tools.find(t => t.name === 'yggio_api_write').annotations.destructiveHint, true);
      assert.equal(tools.find(t => t.name === 'yggio_api_get').annotations.readOnlyHint, true);

      const who = await call(client, 'yggio_whoami');
      assert.equal(who.isError, false, who.text);
      assert.equal(who.json.user.username, 'demo-user');
      assert.equal(who.json.yggio, baseUrl, 'a trailing /api in YGGIO_URL is dropped');

      const found = await call(client, 'yggio_find_devices', {limit: 2, fields: ['value.temperature']});
      assert.equal(found.json.count, 2);
      assert.match(found.json.note, /limit/);
      assert.deepEqual(found.json.devices[0], {
        _id: devices[0]._id, name: 'strips-1', deviceModelName: 'sensative-strips-comfort',
        connector: {_id: 'c1', name: 'Netmore'}, reportedAt: '2026-11-24T10:00:00Z', 'value.temperature': 21.5,
      });
    } finally {
      await client.close();
    }
  });
}

test('history converts relative times to unix ms', async () => {
  const client = await connect();
  try {
    const before = Date.now();
    const res = await call(client, 'yggio_device_history', {id: devices[0]._id, measurement: 'temperature', start: 'now-7d', distance: 3600});
    assert.equal(res.isError, false, res.text);
    assert.equal(res.json.count, 1);
    const sent = state.requests.findLast(r => r.path.endsWith('/stats')).query;
    assert.equal(sent.measurement, 'temperature');
    assert.equal(sent.distance, '3600');
    assert.ok(Math.abs(Number(sent.start) - (before - 7 * 864e5)) < 60_000, `start=${sent.start}`);
    assert.equal(sent.end, undefined);
  } finally {
    await client.close();
  }
});

test('an expired token is replaced by logging in again', async () => {
  const client = await connect();
  try {
    await call(client, 'yggio_whoami');
    const loginsBefore = state.logins;
    state.validToken = 'rotated-on-the-server';
    const res = await call(client, 'yggio_api_get', {path: '/device-groups'});
    assert.equal(res.isError, false, res.text);
    assert.equal(res.json[0].name, 'Floor 3');
    assert.equal(state.logins, loginsBefore + 1);
  } finally {
    await client.close();
  }
});

test('generic tools: search, describe, write, and path guard', async () => {
  const client = await connect();
  try {
    const search = await call(client, 'yggio_search_api', {query: 'device history stats'});
    assert.ok(search.json.results.some(r => r.path === '/iotnodes/{id}/stats'), search.text);

    const described = await call(client, 'yggio_describe_endpoint', {endpoint: 'getIotnodeStats'});
    assert.equal(described.json.path, '/iotnodes/{id}/stats');
    assert.ok(described.json.parameters.some(p => p.name === 'measurement' && p.required));
    assert.ok(described.json.parameters.some(p => p.in === 'path'), 'parameter $refs are expanded');

    const ambiguous = await call(client, 'yggio_describe_endpoint', {endpoint: '/iotnodes/{id}'});
    assert.ok(ambiguous.json.methods.length > 1);

    const write = await call(client, 'yggio_api_write', {method: 'PUT', path: '/iotnodes/command', body: {command: 'x', iotnodeId: 'a'}});
    assert.equal(write.isError, false, write.text);
    assert.deepEqual(state.requests.at(-1).body, {command: 'x', iotnodeId: 'a'});

    for (const bad of ['/../auth/local', '/iotnodes/%2e%2e/x', '//evil.example/x', '/iotnodes?limit=1']) {
      const res = await call(client, 'yggio_api_get', {path: bad});
      assert.equal(res.isError, true, `${bad} should be refused`);
    }

    const missing = await call(client, 'yggio_api_get', {path: '/nope'});
    assert.equal(missing.isError, true);
    assert.match(missing.text, /HTTP 404/);
  } finally {
    await client.close();
  }
});

test('YGGIO_READ_ONLY leaves out the write tool', async () => {
  const client = await connect({env: {YGGIO_READ_ONLY: 'true'}});
  try {
    const {tools} = await client.listTools();
    assert.equal(tools.some(t => t.name === 'yggio_api_write'), false);
  } finally {
    await client.close();
  }
});

test('wrong password gives a clear error, not a crash', async () => {
  const client = await connect({env: {YGGIO_PASSWORD: 'fel'}});
  try {
    const res = await call(client, 'yggio_whoami');
    assert.equal(res.isError, true);
    assert.match(res.text, /Login to .* as demo-user failed \(HTTP 401\)/);
  } finally {
    await client.close();
  }
});
