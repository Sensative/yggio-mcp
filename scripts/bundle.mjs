#!/usr/bin/env node
// Bundles the server, its dependencies and the API spec into one file,
// dist/yggio-mcp.mjs, that runs with plain `node` and nothing installed.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(root, 'dist/yggio-mcp.mjs');

await build({
  entryPoints: [path.join(root, 'src/index.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  legalComments: 'none',
  minifySyntax: true,
  // Some dependencies still call require(); give ESM output a working one.
  banner: {js: "#!/usr/bin/env node\nimport {createRequire as __yggioCreateRequire} from 'node:module';\nconst require = __yggioCreateRequire(import.meta.url);"},
  logLevel: 'warning',
});
fs.chmodSync(outfile, 0o755);
console.log(`Built ${path.relative(root, outfile)} (${Math.round(fs.statSync(outfile).size / 1024)} kB)`);
