import http from 'node:http';
import { containsTrap, readLock } from './lock.ts';
import { notifyConfigFromEnv, sendAlert, type Alert } from './notify.ts';
import type { Trap } from './trap.ts';

export interface ServerOptions {
  lockPath: string;
  host?: string;
  port?: number;
  /** Defaults to console + Slack/Discord forwarding configured through env vars. */
  onAlert?: (alert: Alert) => void | Promise<void>;
}

const MAX_BODY = 64 * 1024;

/**
 * Every request is checked against every trap in the lock: the trap id may show up in the
 * path, and the token in a header, the query string, Basic auth or the body. The lock is
 * re-read per request so traps created while the server runs are picked up immediately.
 */
export function startServer(opts: ServerOptions): Promise<http.Server> {
  const onAlert = opts.onAlert ?? ((alert: Alert) => sendAlert(alert, notifyConfigFromEnv()));

  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const url = req.url ?? '/';
    const haystack = [url, body, ...headerValues(req), decodeBasicAuth(req.headers.authorization)].join('\n');

    const hits = loadTraps(opts.lockPath).filter((trap) => containsTrap(haystack, trap));

    // Answer like an API rejecting a bad key, so the caller learns nothing.
    res.writeHead(hits.length ? 401 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: hits.length ? 'unauthorized' : 'not_found' }));

    for (const trap of hits) {
      const alert: Alert = {
        trapId: trap.id,
        label: trap.label,
        matched: [
          ...(haystack.includes(trap.id) ? (['url'] as const) : []),
          ...(haystack.includes(trap.token) ? (['token'] as const) : []),
        ],
        plantedIn: trap.placements.map((p) => `${p.file}:${p.line}`),
        method: req.method ?? '?',
        path: url,
        remoteAddress: req.socket.remoteAddress ?? '',
        forwardedFor: firstHeader(req.headers['x-forwarded-for']),
        userAgent: firstHeader(req.headers['user-agent']),
        at: new Date().toISOString(),
      };
      Promise.resolve(onAlert(alert)).catch((err) => console.error('[honeytoken] alert handler failed:', err));
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 8787, opts.host ?? '127.0.0.1', () => resolve(server));
  });
}

function loadTraps(lockPath: string): Trap[] {
  try {
    return readLock(lockPath).traps;
  } catch (err) {
    console.error(`[honeytoken] cannot read ${lockPath}:`, err);
    return [];
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      if (size < MAX_BODY) chunks.push(chunk);
      size += chunk.length;
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8', 0, MAX_BODY)));
    req.on('error', () => resolve(''));
  });
}

function headerValues(req: http.IncomingMessage): string[] {
  return Object.values(req.headers).flatMap((v) => v ?? []);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function decodeBasicAuth(header: string | undefined): string {
  const match = header?.match(/^Basic\s+(\S+)/i);
  return match?.[1] ? Buffer.from(match[1], 'base64').toString('utf8') : '';
}
