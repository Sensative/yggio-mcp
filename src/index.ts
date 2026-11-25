import {serveStdio} from '@modelcontextprotocol/server/stdio';
import {loadConfig} from './config.js';
import {YggioClient, createServerFactory, VERSION} from './server.js';
import {operations, spec} from './spec.js';

const HELP = `yggio-mcp ${VERSION} - MCP server for the Yggio REST API (stdio)

Environment:
  YGGIO_URL                 The address you open Yggio at in a browser (required)
  YGGIO_USERNAME            Yggio username                             (required unless YGGIO_TOKEN)
  YGGIO_PASSWORD            Yggio password                             (required unless YGGIO_TOKEN)
  YGGIO_TOKEN               Use this token instead of logging in (not refreshed)
  YGGIO_READ_ONLY=true      Leave out the write tool
  YGGIO_TIMEOUT_MS          Per-request timeout (default 30000)
  YGGIO_MAX_RESPONSE_CHARS  Truncate tool output after this many characters (default 60000)

Usage:
  yggio-mcp            Serve MCP over stdio (what Claude runs)
  yggio-mcp --check    Log in, print who you are, and exit
  yggio-mcp --version
`;

const main = async () => {
  const arg = process.argv[2];
  if (arg === '--help' || arg === '-h') {
    process.stdout.write(HELP);
    return;
  }
  if (arg === '--version') {
    process.stdout.write(`${VERSION} (API spec: ${spec.info.source}, ${operations.length} operations)\n`);
    return;
  }

  const config = loadConfig();

  if (arg === '--check') {
    const me = await new YggioClient(config).call<Record<string, unknown>>('GET', '/users/me');
    process.stdout.write(`OK: logged in to ${config.baseUrl} as ${String(me.username ?? me.email ?? me._id)}` +
      `${config.readOnly ? ' (read-only)' : ''}\n`);
    return;
  }
  if (arg) {
    throw new Error(`Unknown argument ${arg}. Try --help.`);
  }

  // stdout is the MCP channel: everything else goes to stderr.
  serveStdio(createServerFactory(config), {
    onerror: err => process.stderr.write(`yggio-mcp: ${err.message}\n`),
  });
  process.stderr.write(`yggio-mcp ${VERSION}: serving ${config.baseUrl}${config.readOnly ? ' (read-only)' : ''}\n`);
};

main().catch(err => {
  process.stderr.write(`yggio-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
