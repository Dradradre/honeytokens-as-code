import http from 'node:http';
import { awsCli, type AwsRunner } from './aws.ts';
import { handle, resolveClientIp } from './core/handle.ts';
import type { Alert, AwsTrap, Trap } from './core/types.ts';
import { createDispatcher, notifiersFromEnv } from './notify/index.ts';
import { appendAlert, readRegistry } from './store.ts';
import { watchLoop, type WatchedAwsTrap } from './watch.ts';

export interface ServeOptions {
  home: string;
  host?: string;
  port?: number;
  cooldownMs?: number;
  /**
   * Header that carries the real client address when a reverse proxy or tunnel you control sits in
   * front (x-forwarded-for, cf-connecting-ip, x-real-ip). Unset, the TCP peer is the client.
   */
  trustProxy?: string;
  /** Replaces the default pipeline (alerts.jsonl + cooldown + env-configured notifiers). */
  onAlert?: (alert: Alert) => void | Promise<void>;
  /** How often to look for AWS trap use in CloudTrail. Default 5 minutes; 0 turns it off. */
  awsPollMs?: number;
  /** Regions to search. Default: every region enabled in the account. */
  awsRegions?: string[];
  aws?: AwsRunner;
}

const MAX_BODY = 64 * 1024;

/** node:http adapter around the Web-standard `handle()` in core. */
export function serve(opts: ServeOptions): Promise<http.Server> {
  const onAlert =
    opts.onAlert ??
    createDispatcher({
      notifiers: notifiersFromEnv(),
      log: (alert) => appendAlert(opts.home, alert),
      cooldownMs: opts.cooldownMs,
    });

  const server = http.createServer(async (req, res) => {
    try {
      const request = await toRequest(req);
      const response = await handle(request, {
        traps: () => loadTraps(opts.home),
        onAlert: (alert) => deliver(alert),
        clientIp: resolveClientIp(request.headers, req.socket.remoteAddress ?? '', opts.trustProxy),
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      console.error('[honeytoken] request failed:', err);
      if (!res.headersSent) res.writeHead(400);
      res.end();
    }
  });

  const deliver = (alert: Alert) =>
    void Promise.resolve(onAlert(alert)).catch((err) => console.error('[honeytoken] alert failed:', err));
  const awsPollMs = opts.awsPollMs ?? 5 * 60_000;
  if (awsPollMs > 0) {
    const stop = watchLoop({
      home: opts.home,
      aws: opts.aws ?? awsCli(),
      intervalMs: awsPollMs,
      regions: opts.awsRegions,
      traps: () => loadTraps(opts.home).filter((t): t is AwsTrap => t.kind === 'aws') as WatchedAwsTrap[],
      onAlert: deliver,
    });
    server.on('close', stop);
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 8787, opts.host ?? '127.0.0.1', () => resolve(server));
  });
}

function loadTraps(home: string): Trap[] {
  try {
    return readRegistry(home).traps;
  } catch (err) {
    console.error('[honeytoken] cannot read registry:', err);
    return [];
  }
}

async function toRequest(req: http.IncomingMessage): Promise<Request> {
  const headers = new Headers();
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    try {
      headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
    } catch {
      // a header the Fetch API rejects; Node accepted it, we can skip it
    }
  }
  const method = req.method ?? 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);
  // Host is attacker-controlled, so build the URL on a fixed origin.
  return new Request(new URL(req.url ?? '/', 'http://localhost'), { method, headers, body });
}

/** Keep the first 64 KB and drain the rest so the client sees a normal response. */
function readBody(req: http.IncomingMessage): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      if (size < MAX_BODY) chunks.push(chunk);
      size += chunk.length;
    });
    req.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks).subarray(0, MAX_BODY))));
    req.on('error', () => resolve(new Uint8Array(0)));
  });
}
