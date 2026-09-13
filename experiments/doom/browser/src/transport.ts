import { JsonRpcError, type Transport, type TransportRequestOptions } from '@groundhogchain/client';

type Pending = {
  resolve(value: unknown): void;
  reject(reason: Error): void;
};

/** One browser-to-node socket; submissions are never automatically retried. */
export class WebSocketTransport implements Transport {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;
  private socket: WebSocket;
  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', event => {
      try {
        const parsed = JSON.parse(String(event.data));
        const replies = Array.isArray(parsed) ? parsed : [parsed];
        const ids = new Set<number>();
        // Validate the whole batch before resolving any caller.
        for (const reply of replies) {
          if (!reply || reply.jsonrpc !== '2.0' || !Number.isSafeInteger(reply.id)
              || ids.has(reply.id) || !this.pending.has(reply.id)
              || (('result' in reply) === ('error' in reply))) {
            throw new Error('Invalid JSON-RPC response IDs or envelope');
          }
          if ('error' in reply && (!reply.error || typeof reply.error.code !== 'number'
              || typeof reply.error.message !== 'string')) throw new Error('Invalid JSON-RPC error');
          ids.add(reply.id);
        }
        for (const reply of replies) {
          const task = this.pending.get(reply.id)!;
          this.pending.delete(reply.id);
          if ('error' in reply) {
            task.reject(new JsonRpcError(reply.error.code, reply.error.message, reply.error.data));
          } else task.resolve(reply.result);
        }
      } catch (error) {
        this.fail(new Error('Invalid RPC socket response', {cause: error}));
      }
    });
    socket.addEventListener('close', () => this.fail(new Error('RPC socket closed; reload to reconnect')));
    socket.addEventListener('error', () => this.fail(new Error('RPC socket failed; reload to reconnect')));
  }

  static async connect(rpcUrl: string): Promise<WebSocketTransport> {
    const url = new URL(rpcUrl);
    if (url.protocol === 'http:') url.protocol = 'ws:';
    if (url.protocol === 'https:') url.protocol = 'wss:';
    if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('RPC URL must use HTTP(S) or WS(S)');
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('RPC socket connection timed out')); }, 10_000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, {once: true});
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Cannot connect to the node RPC socket')); }, {once: true});
    });
    return new WebSocketTransport(socket);
  }

  async request<T = unknown>(method: string, params: unknown[] = [], options: TransportRequestOptions = {}): Promise<T> {
    if (options.signal?.aborted) throw new Error('RPC request aborted');
    return (await this.batch([{method, params}], options.signal))[0] as T;
  }

  async batch(calls: {method: string; params: unknown[]}[], signal?: AbortSignal): Promise<unknown[]> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) throw new Error('RPC socket is closed');
    if (!calls.length) return [];
    if (signal?.aborted) throw new Error('RPC request aborted');
    const messages = calls.map(call => ({jsonrpc: '2.0', id: this.nextId++, ...call}));
    const tasks = messages.map(message => new Promise<unknown>((resolve, reject) => {
      this.pending.set(message.id, {resolve, reject});
    }));
    const abort = () => this.fail(new Error('RPC request aborted; submission outcome may be unknown'));
    const timeout = setTimeout(() => this.fail(new Error('RPC request timed out; submission outcome may be unknown')), 60_000);
    signal?.addEventListener('abort', abort, {once: true});
    try {
      try {
        this.socket.send(JSON.stringify(messages.length === 1 ? messages[0] : messages));
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
      return await Promise.all(tasks);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }

  close(): void { this.fail(new Error('RPC socket closed')); }
  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const task of this.pending.values()) task.reject(error);
    this.pending.clear();
    this.socket.close();
  }
}
