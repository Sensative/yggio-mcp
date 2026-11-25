// Browser login through Yggio's Keycloak, for accounts with 2FA (OTP) or SSO
// where POST /auth/local (password grant) cannot work. Same flow as the Yggio
// web UI: GET /auth/info -> Keycloak login page -> redirect with ?code ->
// GET /auth/code exchanges it for a Yggio token. Only the redirect lands on a
// one-shot server on 127.0.0.1, so that URI must be registered on the
// yggio-services client in Keycloak.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';

type Get = (path: string, query: Record<string, string>) => Promise<{status: number; body: unknown}>;

const cacheFile = () => path.join(os.homedir(), '.yggio-mcp', 'tokens.json');

const readCache = (): Record<string, string> => {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
  } catch {
    return {};
  }
};

/** Tokens are shared between Claude sessions so each one does not open a browser. */
export const readCachedToken = (baseUrl: string): string | undefined => readCache()[baseUrl];

export const saveCachedToken = (baseUrl: string, token: string) => {
  fs.mkdirSync(path.dirname(cacheFile()), {recursive: true, mode: 0o700});
  fs.writeFileSync(cacheFile(), JSON.stringify({...readCache(), [baseUrl]: token}, null, 2), {mode: 0o600});
};

const openBrowser = (url: string) => {
  if (process.env.BROWSER === 'none') {
    return;
  }
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : ['xdg-open', [url]];
  spawn(cmd, args, {stdio: 'ignore', detached: true}).on('error', () => {}).unref();
};

export const browserLogin = async (port: number, get: Get, timeoutMs = 180_000): Promise<string> => {
  const info = await get('/auth/info', {});
  const {authorizationEndpoint, clientId, scope} = (info.body ?? {}) as Record<string, string | undefined>;
  if (info.status >= 400 || !authorizationEndpoint || !clientId) {
    throw new Error(`GET /api/auth/info returned HTTP ${info.status}, so the Keycloak login page could not be found.`);
  }
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const state = crypto.randomBytes(16).toString('hex');
  const authUrl = new URL(authorizationEndpoint);
  authUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scope ?? 'openid email',
    state,
  }).toString();

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const params = new URL(req.url ?? '/', redirectUri).searchParams;
      // Anything without our state (favicon, a stray tab) is not the callback.
      if (params.get('state') !== state) {
        res.writeHead(404, {connection: 'close'}).end();
        return;
      }
      const got = params.get('code');
      const problem = params.get('error_description') ?? params.get('error') ?? 'no code in the callback';
      res.writeHead(got ? 200 : 400, {'content-type': 'text/plain; charset=utf-8', connection: 'close'})
        .end(got ? 'Inloggad i Yggio. Du kan stänga fliken.' : `Inloggningen misslyckades: ${problem}`);
      finish(got ? undefined : new Error(`Keycloak login failed: ${problem}`), got ?? '');
    });
    const timer = setTimeout(() => finish(new Error(
      `No Yggio login within ${timeoutMs / 1000} s. Open ${authUrl.href} to log in. ` +
      `If Keycloak says the redirect URI is invalid, an admin must add ${redirectUri.replace(/callback$/, '*')} ` +
      `to the Valid Redirect URIs of the ${clientId} client.`)), timeoutMs);
    const finish = (err: Error | undefined, value = '') => {
      clearTimeout(timer);
      server.close();
      if (err) {
        reject(err);
      } else {
        resolve(value);
      }
    };
    server.on('error', err => finish(new Error(
      `Could not listen on 127.0.0.1:${port} for the login callback (${err.message}). Set YGGIO_OAUTH_PORT to a free port registered in Keycloak.`)));
    server.listen(port, '127.0.0.1', () => {
      process.stderr.write(`yggio-mcp: log in to Yggio in your browser: ${authUrl.href}\n`);
      openBrowser(authUrl.href);
    });
  });

  const res = await get('/auth/code', {code, client_id: clientId, redirect_uri: redirectUri});
  const token = (res.body as {token?: unknown} | undefined)?.token;
  if (res.status >= 400 || typeof token !== 'string') {
    throw new Error(`Exchanging the Keycloak code at /api/auth/code failed (HTTP ${res.status}).`);
  }
  return token;
};
