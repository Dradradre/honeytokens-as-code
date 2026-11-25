import http from 'node:http';
import { handle } from './core/handle.ts';
import type { Alert, Trap } from './core/types.ts';
import { createDispatcher, notifiersFromEnv } from './notify/index.ts';
import { appendAlert, readRegistry } from './store.ts';

export interface ServeOptions {
  home: string;
  host?: string;
  port?: number;
  cooldownMs?: number;
  /** Replaces the default pipeline (alerts.jsonl + cooldown + env-configured notifiers). */
  onAlert?: (alert: Alert) => void | Promise<void>;
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
      const response = await handle(await toRequest(req), {
        traps: () => loadTraps(opts.home),
        onAlert: (alert) => void Promise.resolve(onAlert(alert)).catch((err) => console.error('[honeytoken] alert failed:', err)),
        clientIp: req.socket.remoteAddress ?? '',
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      console.error('[honeytoken] request failed:', err);
      if (!res.headersSent) res.writeHead(400);
      res.end();
    }
  });

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
