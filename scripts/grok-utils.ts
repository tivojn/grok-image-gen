/**
 * Chrome CDP utilities for Grok image & video generation.
 * Based on patterns from baoyu-post-to-x/scripts/x-utils.ts
 * Reuses x-browser-profile — grok.com "Sign in with X" shares cookies.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

export type PlatformCandidates = {
  darwin?: string[];
  win32?: string[];
  default: string[];
};

const CHROME_CANDIDATES: PlatformCandidates = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  default: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ],
};

function getCandidatesForPlatform(candidates: PlatformCandidates): string[] {
  if (process.platform === 'darwin' && candidates.darwin?.length) return candidates.darwin;
  if (process.platform === 'win32' && candidates.win32?.length) return candidates.win32;
  return candidates.default;
}

export function findChromeExecutable(): string | undefined {
  const override = (process.env.GROK_CHROME_PATH || process.env.X_BROWSER_CHROME_PATH)?.trim();
  if (override && fs.existsSync(override)) return override;

  for (const candidate of getCandidatesForPlatform(CHROME_CANDIDATES)) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function getDefaultProfileDir(): string {
  const override = process.env.GROK_PROFILE_DIR?.trim();
  if (override) return override;
  // Reuse the same profile as baoyu-post-to-x so x.com login is shared
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'x-browser-profile');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Unable to allocate a free TCP port.')));
        return;
      }
      const port = address.port;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

export async function waitForChromeDebugPort(port: number, timeoutMs: number): Promise<string> {
  const start = Date.now();
  let lastError: unknown = null;

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { redirect: 'follow' });
      if (!res.ok) throw new Error(`${res.status}`);
      const version = (await res.json()) as { webSocketDebuggerUrl?: string };
      if (version.webSocketDebuggerUrl) return version.webSocketDebuggerUrl;
      lastError = new Error('Missing webSocketDebuggerUrl');
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }

  throw new Error(`Chrome debug port not ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
};

export class CdpConnection {
  private ws: WebSocket;
  private nextId = 0;
  private pending = new Map<number, PendingRequest>();
  private eventHandlers = new Map<string, Set<(params: unknown) => void>>();
  private defaultTimeoutMs: number;

  private constructor(ws: WebSocket, options?: { defaultTimeoutMs?: number }) {
    this.ws = ws;
    this.defaultTimeoutMs = options?.defaultTimeoutMs ?? 15_000;

    this.ws.addEventListener('message', (event) => {
      try {
        const data = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
        const msg = JSON.parse(data) as {
          id?: number;
          method?: string;
          params?: unknown;
          result?: unknown;
          error?: { message?: string };
        };

        if (msg.method) {
          const handlers = this.eventHandlers.get(msg.method);
          if (handlers) handlers.forEach((h) => h(msg.params));
        }

        if (msg.id) {
          const pending = this.pending.get(msg.id);
          if (pending) {
            this.pending.delete(msg.id);
            if (pending.timer) clearTimeout(pending.timer);
            if (msg.error?.message) pending.reject(new Error(msg.error.message));
            else pending.resolve(msg.result);
          }
        }
      } catch {}
    });

    this.ws.addEventListener('close', () => {
      for (const [id, pending] of this.pending.entries()) {
        this.pending.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(new Error('CDP connection closed.'));
      }
    });
  }

  static async connect(url: string, timeoutMs: number, options?: { defaultTimeoutMs?: number }): Promise<CdpConnection> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connection timeout.')), timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('CDP connection failed.'));
      });
    });
    return new CdpConnection(ws, options);
  }

  on(method: string, handler: (params: unknown) => void): void {
    if (!this.eventHandlers.has(method)) this.eventHandlers.set(method, new Set());
    this.eventHandlers.get(method)!.add(handler);
  }

  async send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: { sessionId?: string; timeoutMs?: number },
  ): Promise<T> {
    const id = ++this.nextId;
    const message: Record<string, unknown> = { id, method };
    if (params) message.params = params;
    if (options?.sessionId) message.sessionId = options.sessionId;

    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;

    const result = await new Promise<unknown>((resolve, reject) => {
      const timer =
        timeoutMs > 0 ? setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, timeoutMs) : null;
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(message));
    });

    return result as T;
  }

  close(): void {
    try {
      this.ws.close();
    } catch {}
  }
}

/** Try to find the debug port from a running Chrome using this profile */
export async function getExistingDebugPort(profileDir: string): Promise<number | null> {
  // Method 1: Check DevToolsActivePort file
  const dtpPath = path.join(profileDir, 'DevToolsActivePort');
  try {
    const content = await fs.promises.readFile(dtpPath, 'utf8');
    const port = parseInt(content.split('\n')[0]!, 10);
    if (port > 0) {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return port;
    }
  } catch {}

  // Method 2: Parse running Chrome processes for --remote-debugging-port with matching --user-data-dir
  try {
    const { execSync } = await import('node:child_process');
    const ps = execSync('ps aux', { encoding: 'utf8', timeout: 5000 });
    // Normalize profile path for comparison
    const normProfile = profileDir.replace(/\/+$/, '');
    for (const line of ps.split('\n')) {
      if (!line.includes('--remote-debugging-port=')) continue;
      if (!line.includes(normProfile)) continue;
      const portMatch = line.match(/--remote-debugging-port=(\d+)/);
      if (portMatch) {
        const port = parseInt(portMatch[1]!, 10);
        if (port > 0) {
          try {
            const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
            if (res.ok) return port;
          } catch {}
        }
      }
    }
  } catch {}

  return null;
}

export async function downloadImage(url: string, outputPath: string, cookies?: string): Promise<void> {
  const headers: Record<string, string> = {};
  if (cookies) headers['Cookie'] = cookies;

  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);

  const buffer = await res.arrayBuffer();
  await fs.promises.writeFile(outputPath, Buffer.from(buffer));
}
