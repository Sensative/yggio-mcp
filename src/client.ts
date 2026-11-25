import type {Config} from './config.js';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type Query = Record<string, string | number | boolean | Array<string | number> | undefined>;

export class YggioError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'YggioError';
  }
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

/** Seconds left on a JWT, or undefined when it cannot be read. */
const jwtSecondsLeft = (token: string, now = Date.now()) => {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp - now / 1000 : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Checks a caller-supplied API path and returns it relative to /api. Only
 * paths inside the Yggio API are allowed, so a tool call cannot be pointed at
 * another host or outside /api.
 */
export const apiPath = (raw: string) => {
  let p = raw.trim();
  if (!p.startsWith('/')) {
    p = `/${p}`;
  }
  p = p.replace(/^\/api(?=\/|$)/, '') || '/';
  if (/[?#]/.test(p)) {
    throw new YggioError('Put query parameters in `query`, not in the path.');
  }
  if (p.includes('//') || p.split('/').some(seg => seg === '..' || seg === '.') || /%2e|%2f|\\/i.test(p)) {
    throw new YggioError(`Path not allowed: ${raw}`);
  }
  return p;
};

const appendQuery = (url: URL, query: Query | undefined) => {
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      value.forEach(v => url.searchParams.append(key, String(v)));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
};

export class YggioClient {
  private token: string | undefined;
  private loggingIn: Promise<string> | undefined;

  constructor(
    private readonly config: Config,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.token = config.token;
  }

  get baseUrl() {
    return this.config.baseUrl;
  }

  private canLogin() {
    return Boolean(this.config.username && this.config.password);
  }

  private async login(): Promise<string> {
    if (!this.canLogin()) {
      throw new YggioError('The Yggio token was rejected or has expired, and no YGGIO_USERNAME/YGGIO_PASSWORD is set to log in again.');
    }
    const res = await this.raw('POST', '/auth/local', undefined, {
      username: this.config.username,
      password: this.config.password,
    }, undefined);
    const token = (res.body as {token?: unknown} | undefined)?.token;
    if (res.status >= 400 || typeof token !== 'string') {
      throw new YggioError(
        `Login to ${this.config.baseUrl} as ${this.config.username} failed (HTTP ${res.status}). Check YGGIO_URL, YGGIO_USERNAME and YGGIO_PASSWORD.`,
        res.status,
        res.body,
      );
    }
    this.token = token;
    return token;
  }

  private async currentToken(forceLogin = false): Promise<string> {
    const left = this.token ? jwtSecondsLeft(this.token) : undefined;
    const stale = !this.token || forceLogin || (left !== undefined && left < 60 && this.canLogin());
    if (!stale) {
      return this.token as string;
    }
    // One login at a time, shared by concurrent calls.
    this.loggingIn ??= this.login().finally(() => {
      this.loggingIn = undefined;
    });
    return this.loggingIn;
  }

  private async raw(method: Method, path: string, query: Query | undefined, body: unknown, token: string | undefined): Promise<ApiResponse> {
    const url = new URL(`${this.config.baseUrl}/api${path}`);
    appendQuery(url, query);
    const headers: Record<string, string> = {accept: 'application/json'};
    if (token) {
      headers.authorization = `Bearer ${token}`;
    }
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new YggioError(`${method} ${url.pathname} could not reach Yggio: ${reason}`);
    }
    const text = await res.text();
    let parsed: unknown = text;
    if (text && (res.headers.get('content-type') ?? '').includes('json')) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return {status: res.status, body: text ? parsed : undefined};
  }

  /** Calls the API, logging in first and once more if the token was rejected. */
  async request(method: Method, path: string, options: {query?: Query; body?: unknown} = {}): Promise<ApiResponse> {
    const p = apiPath(path);
    let res = await this.raw(method, p, options.query, options.body, await this.currentToken());
    if (res.status === 401 && this.canLogin()) {
      res = await this.raw(method, p, options.query, options.body, await this.currentToken(true));
    }
    return res;
  }

  /** Like request, but throws on HTTP errors. */
  async call<T = unknown>(method: Method, path: string, options: {query?: Query; body?: unknown} = {}): Promise<T> {
    const res = await this.request(method, path, options);
    if (res.status >= 400) {
      const detail = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
      throw new YggioError(`${method} /api${apiPath(path)} returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 2000)}` : ''}`, res.status, res.body);
    }
    return res.body as T;
  }
}
