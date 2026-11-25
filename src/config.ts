export interface Config {
  /** Yggio root, e.g. https://app.yggio.net (no trailing /api). */
  baseUrl: string;
  username?: string;
  password?: string;
  /** A ready token, used instead of username/password. Not refreshed. */
  token?: string;
  readOnly: boolean;
  timeoutMs: number;
  maxResponseChars: number;
}

const truthy = (value: string | undefined) => /^(1|true|yes|on)$/i.test(value?.trim() ?? '');

const intOr = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const normalizeBaseUrl = (raw: string) => {
  const url = new URL(raw.trim());
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`YGGIO_URL must be http(s), got ${url.protocol}`);
  }
  // People paste the API root or the swagger URL; keep only the origin + any
  // path prefix in front of /api.
  const pathname = url.pathname.replace(/\/+$/, '').replace(/\/(api|swagger)(\/.*)?$/, '');
  return `${url.origin}${pathname}`;
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const rawUrl = env.YGGIO_URL?.trim();
  if (!rawUrl) {
    throw new Error('YGGIO_URL is not set (for example https://app.yggio.net).');
  }
  const token = env.YGGIO_TOKEN?.trim() || undefined;
  const username = env.YGGIO_USERNAME?.trim() || undefined;
  const password = env.YGGIO_PASSWORD || undefined;
  if (!token && !(username && password)) {
    throw new Error('Set YGGIO_USERNAME and YGGIO_PASSWORD (or YGGIO_TOKEN).');
  }
  return {
    baseUrl: normalizeBaseUrl(rawUrl),
    username,
    password,
    token,
    readOnly: truthy(env.YGGIO_READ_ONLY),
    timeoutMs: intOr(env.YGGIO_TIMEOUT_MS, 30_000),
    maxResponseChars: intOr(env.YGGIO_MAX_RESPONSE_CHARS, 60_000),
  };
};
