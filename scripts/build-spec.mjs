#!/usr/bin/env node
// Flattens Yggio's multi-file OpenAPI spec (storm/externals/swagger/src in the
// Sensative/yggio repo) into one JSON file the MCP server bundles.
//
//   node scripts/build-spec.mjs [path/to/swagger/src]
//
// Path files are inlined. Component files (schemas, parameters, responses,
// requestBodies, widget templates) are kept once each under `components`, and
// every $ref into them is rewritten to "<file>#/<pointer>" (for example
// "schemas.yaml#/Iotnode"). The server expands those refs on demand, so a
// schema used by a hundred endpoints is stored once.

import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import YAML from 'yaml';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const srcDir = path.resolve(
  process.argv[2] ?? path.join(root, '../recreate-qrlio/yggio/storm/externals/swagger/src'),
);
const outFile = path.join(root, 'src/generated/openapi.json');

const cache = new Map();
const load = file => {
  if (!cache.has(file)) {
    cache.set(file, YAML.parse(fs.readFileSync(file, 'utf8')));
  }
  return cache.get(file);
};

const componentsDir = path.join(srcDir, 'components');
const isComponent = file => path.dirname(file) === componentsDir;
const componentKey = file => path.basename(file);

const pointerGet = (doc, pointer) => {
  if (!pointer || pointer === '/') {
    return doc;
  }
  return pointer.split('/').slice(1).reduce((node, part) => {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (node === undefined || node === null || !(key in node)) {
      throw new Error(`Bad pointer ${pointer}`);
    }
    return node[key];
  }, doc);
};

// Walks a node that lives in `file`, rewriting or inlining every $ref.
const walk = (node, file, stack) => {
  if (Array.isArray(node)) {
    return node.map(item => walk(item, file, stack));
  }
  if (node === null || typeof node !== 'object') {
    return node;
  }
  if (typeof node.$ref === 'string') {
    const [refFile, pointer = ''] = node.$ref.split('#');
    const target = refFile ? path.resolve(path.dirname(file), refFile) : file;
    if (isComponent(target)) {
      return {$ref: `${componentKey(target)}#${pointer}`};
    }
    const id = `${target}#${pointer}`;
    if (stack.includes(id)) {
      throw new Error(`Circular $ref outside components: ${id}`);
    }
    return walk(pointerGet(load(target), pointer), target, [...stack, id]);
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v, file, stack)]));
};

const indexFile = path.join(srcDir, 'index.yaml');
const index = load(indexFile);

const components = {};
for (const name of fs.readdirSync(componentsDir).filter(n => n.endsWith('.yaml')).sort()) {
  const file = path.join(componentsDir, name);
  components[name] = walk(load(file), file, []);
}

const paths = walk(index.paths, indexFile, []);

let source = 'unknown';
try {
  const rev = execFileSync('git', ['-C', srcDir, 'log', '-1', '--format=%h %cs', '--', '.'], {encoding: 'utf8'}).trim();
  source = `Sensative/yggio storm/externals/swagger/src @ ${rev}`;
} catch {
  // not a git checkout; keep "unknown"
}

const out = {
  info: {title: index.info?.title, version: index.info?.version, source},
  description: index.info?.description ?? '',
  paths,
  components,
};

fs.mkdirSync(path.dirname(outFile), {recursive: true});
fs.writeFileSync(outFile, `${JSON.stringify(out)}\n`);

const ops = Object.values(paths).reduce(
  (n, item) => n + Object.keys(item).filter(k => ['get', 'post', 'put', 'patch', 'delete'].includes(k)).length,
  0,
);
console.log(`Wrote ${path.relative(root, outFile)}: ${Object.keys(paths).length} paths, ${ops} operations (${source})`);
