import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { StoredConfig } from '../config/store.js';

export type TunnelStatus = 'connected' | 'closed';

export interface TunnelOptions {
  /** Local port the HTTP server listens on. */
  port: number;
  authtoken: string;
  /** Reserved or static domain to request; ngrok picks one otherwise. */
  domain?: string;
  onStatus?: (status: TunnelStatus) => void;
}

export interface Tunnel {
  /** Public base URL, for example https://name.ngrok-free.dev (no trailing slash). */
  url: string;
  close(): Promise<void>;
}

/** Anything that can expose a local port on the public internet. Lets tests use a fake. */
export interface TunnelProvider {
  readonly name: string;
  start(options: TunnelOptions): Promise<Tunnel>;
}

export type TunnelErrorKind = 'auth' | 'session_limit' | 'domain' | 'endpoint_in_use' | 'network' | 'unavailable' | 'unknown';

export class TunnelError extends Error {
  readonly kind: TunnelErrorKind;
  readonly hint: string;
  /** ngrok's own error code, such as ERR_NGROK_105. */
  readonly ngrokCode: string | undefined;

  constructor(kind: TunnelErrorKind, message: string, hint: string, ngrokCode?: string) {
    super(message);
    this.name = 'TunnelError';
    this.kind = kind;
    this.hint = hint;
    this.ngrokCode = ngrokCode;
  }
}

export const NGROK_URLS = {
  signup: 'https://dashboard.ngrok.com/signup',
  authtoken: 'https://dashboard.ngrok.com/get-started/your-authtoken',
  domains: 'https://dashboard.ngrok.com/domains',
  agents: 'https://dashboard.ngrok.com/agents',
} as const;

/** Turn whatever the ngrok SDK threw into an error a person can act on. */
export function classifyNgrokError(err: unknown): TunnelError {
  if (err instanceof TunnelError) return err;
  const raw = err instanceof Error ? err.message : String(err);
  const code = (err as { errorCode?: unknown } | null)?.errorCode;
  const ngrokCode = typeof code === 'string' ? code : /ERR_NGROK_\d+/.exec(raw)?.[0];
  // The SDK's messages are several lines of instructions; keep the first sentence.
  const first = raw.replace(/\s*error_code: ERR_NGROK_\d+\s*$/, '').split('\n')[0]?.trim() ?? raw;

  switch (ngrokCode) {
    case 'ERR_NGROK_4018':
      return new TunnelError('auth', 'ngrok needs an authtoken.', `Create a free account at ${NGROK_URLS.signup} and copy the token from ${NGROK_URLS.authtoken}.`, ngrokCode);
    case 'ERR_NGROK_105':
    case 'ERR_NGROK_106':
    case 'ERR_NGROK_107':
      return new TunnelError('auth', 'ngrok rejected the authtoken.', `Copy the current token from ${NGROK_URLS.authtoken} (it is not the API key).`, ngrokCode);
    case 'ERR_NGROK_108':
      return new TunnelError(
        'session_limit',
        'Your ngrok account already has the maximum number of agent sessions running.',
        `Stop other ngrok agents or mcpclaude instances (see ${NGROK_URLS.agents}) and try again.`,
        ngrokCode,
      );
    case 'ERR_NGROK_334':
      return new TunnelError(
        'endpoint_in_use',
        'That ngrok address is already online from another agent.',
        `Another agent on your ngrok account holds this address: a running mcpclaude, "ngrok http" in another terminal, the ngrok desktop app, or another computer using the same authtoken (free accounts have a single address). Stop it (see ${NGROK_URLS.agents}) or use a different --ngrok-domain.`,
        ngrokCode,
      );
    case 'ERR_NGROK_313':
    case 'ERR_NGROK_314':
    case 'ERR_NGROK_319':
    case 'ERR_NGROK_320':
    case 'ERR_NGROK_326':
      return new TunnelError('domain', `ngrok cannot use the requested domain: ${first}`, `Check the domains of your account at ${NGROK_URLS.domains}, or start without --ngrok-domain.`, ngrokCode);
    default:
      break;
  }
  if (/dial|lookup|no such host|timed? ?out|network|connection (refused|reset)|unreachable|tls/i.test(raw)) {
    return new TunnelError('network', `Could not reach ngrok: ${first}`, 'Check the internet connection, VPN or firewall, then try again.', ngrokCode);
  }
  return new TunnelError('unknown', `ngrok failed to start the tunnel: ${first}`, 'Run "mcpclaude doctor" for diagnostics.', ngrokCode);
}

/** The embedded ngrok agent (official SDK). Loaded lazily so a broken install cannot break startup. */
export const ngrokProvider: TunnelProvider = {
  name: 'ngrok',
  async start(options) {
    let sdk: typeof import('@ngrok/ngrok');
    try {
      sdk = await import('@ngrok/ngrok');
    } catch (err) {
      throw new TunnelError(
        'unavailable',
        `The ngrok SDK could not be loaded: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
        'Reinstall mcpclaude on this machine (npm install) so the ngrok binary for this platform is present, or start with --no-tunnel.',
      );
    }
    const { forward, disconnect } = sdk;
    try {
      const listener = await forward({
        addr: `127.0.0.1:${options.port}`,
        authtoken: options.authtoken,
        forwards_to: 'mcpclaude',
        ...(options.domain ? { domain: options.domain } : {}),
        onStatusChange: (status: string) => {
          if (status === 'connected' || status === 'closed') options.onStatus?.(status);
        },
      });
      const url = listener.url();
      if (!url) {
        await listener.close().catch(() => undefined);
        throw new TunnelError('unknown', 'ngrok started a tunnel without a public URL.', 'Try again, or pass --ngrok-domain.');
      }
      return {
        url: url.replace(/\/+$/, ''),
        close: async () => {
          await listener.close().catch(() => undefined);
          await disconnect().catch(() => undefined);
        },
      };
    } catch (err) {
      throw classifyNgrokError(err);
    }
  },
};

/** ngrok authtokens are long URL-safe strings; this only catches obvious paste mistakes. */
export function looksLikeAuthtoken(token: string): boolean {
  return /^[A-Za-z0-9_-]{24,}$/.test(token.trim());
}

/** Extract the authtoken from an ngrok CLI config file (version 2 or 3). */
export function parseNgrokConfig(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const match = /^\s*authtoken:\s*["']?([^\s"'#]+)/.exec(line);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

export function ngrokConfigPaths(home: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const paths: string[] = [];
  if (env['XDG_CONFIG_HOME']) paths.push(path.join(env['XDG_CONFIG_HOME'], 'ngrok', 'ngrok.yml'));
  if (platform === 'darwin') paths.push(path.join(home, 'Library', 'Application Support', 'ngrok', 'ngrok.yml'));
  paths.push(path.join(home, '.config', 'ngrok', 'ngrok.yml'), path.join(home, '.ngrok2', 'ngrok.yml'));
  return paths;
}

export interface FoundAuthtoken {
  token: string;
  source: 'flag' | 'environment' | 'saved' | 'ngrok-config';
  /** Human-readable origin for the UI. */
  description: string;
}

/** Look for an authtoken in every place a user may already have put one. */
export async function findNgrokAuthtoken(sources: {
  flag?: string | undefined;
  env: NodeJS.ProcessEnv;
  config: Readonly<StoredConfig>;
  home: string;
  platform: NodeJS.Platform;
}): Promise<FoundAuthtoken | undefined> {
  if (sources.flag) return { token: sources.flag.trim(), source: 'flag', description: '--ngrok-authtoken' };
  const fromEnv = sources.env['NGROK_AUTHTOKEN']?.trim();
  if (fromEnv) return { token: fromEnv, source: 'environment', description: 'NGROK_AUTHTOKEN' };
  if (sources.config.ngrokAuthtoken) return { token: sources.config.ngrokAuthtoken, source: 'saved', description: 'saved mcpclaude settings' };
  for (const file of ngrokConfigPaths(sources.home, sources.platform, sources.env)) {
    const text = await readFile(file, 'utf8').catch(() => undefined);
    const token = text ? parseNgrokConfig(text) : undefined;
    if (token) return { token, source: 'ngrok-config', description: file };
  }
  return undefined;
}
