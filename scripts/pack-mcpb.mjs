#!/usr/bin/env node
// Packs dist/yggio-mcp.mjs into an MCP Bundle (.mcpb) that Claude Desktop
// installs with a double click and a settings form (URL, optional user/password).
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const stage = path.join(root, 'dist/mcpb');
const out = path.join(root, `dist/yggio-mcp-${pkg.version}.mcpb`);

fs.rmSync(stage, {recursive: true, force: true});
fs.mkdirSync(path.join(stage, 'server'), {recursive: true});
fs.copyFileSync(path.join(root, 'dist/yggio-mcp.mjs'), path.join(stage, 'server/yggio-mcp.mjs'));

const manifest = {
  manifest_version: '0.3',
  name: 'yggio',
  display_name: 'Yggio',
  version: pkg.version,
  description: 'Read and manage devices, time series, groups, rules and more on the Yggio IoT platform.',
  long_description:
    'Talks to the Yggio REST API as your own Yggio user. Has tools for devices and their history, ' +
    'plus a searchable copy of the full Yggio API reference so Claude can call any endpoint. ' +
    'Turn on read-only to keep Claude from changing anything.',
  author: {name: 'Sensative'},
  server: {
    type: 'node',
    entry_point: 'server/yggio-mcp.mjs',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/server/yggio-mcp.mjs'],
      env: {
        YGGIO_URL: '${user_config.yggio_url}',
        YGGIO_USERNAME: '${user_config.username}',
        YGGIO_PASSWORD: '${user_config.password}',
        YGGIO_READ_ONLY: '${user_config.read_only}',
      },
    },
  },
  tools: [
    {name: 'yggio_whoami', description: 'Shows the logged-in Yggio user.'},
    {name: 'yggio_find_devices', description: 'Lists and filters devices.'},
    {name: 'yggio_get_device', description: 'Fetches one device with its current values.'},
    {name: 'yggio_device_measurements', description: 'Lists the stored measurements of a device.'},
    {name: 'yggio_device_history', description: 'Reads the time series of one measurement.'},
    {name: 'yggio_search_api', description: 'Searches the Yggio API reference.'},
    {name: 'yggio_describe_endpoint', description: 'Shows parameters and schemas for one endpoint.'},
    {name: 'yggio_api_get', description: 'Calls any GET endpoint.'},
    {name: 'yggio_api_write', description: 'Calls POST/PUT/PATCH/DELETE endpoints (not in read-only mode).'},
  ],
  user_config: {
    yggio_url: {
      type: 'string',
      title: 'Yggio address',
      description: 'The address you open Yggio at in the browser, e.g. https://yggio.example.com',
      required: true,
    },
    username: {
      type: 'string',
      title: 'Username',
      description: 'Your Yggio username. Leave username and password empty to log in in the browser (Keycloak, works with 2FA).',
      required: false,
      // Without a default an empty field is passed on as the literal "${user_config.username}".
      default: '',
    },
    password: {type: 'string', title: 'Password', description: 'Your Yggio password.', sensitive: true, required: false, default: ''},
    read_only: {
      type: 'boolean',
      title: 'Read-only',
      description: 'Leave out the tool that can change data in Yggio.',
      default: false,
      required: false,
    },
  },
  compatibility: {platforms: ['darwin', 'win32', 'linux'], runtimes: {node: '>=20.0.0'}},
  license: 'MIT',
};

fs.writeFileSync(path.join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const mcpb = path.join(root, 'node_modules/.bin/mcpb');
execFileSync(mcpb, ['validate', path.join(stage, 'manifest.json')], {stdio: 'inherit'});
fs.rmSync(out, {force: true});
execFileSync(mcpb, ['pack', stage, out], {stdio: 'inherit'});
console.log(`Packed ${path.relative(root, out)}`);
