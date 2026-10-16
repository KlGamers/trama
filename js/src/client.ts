import type { Doc, VV } from "./doc.js";
import { type Msg, MsgType, decodeMsg, encodeMsg } from "./proto.js";

export type Status = "idle" | "connecting" | "syncing" | "synced" | "offline";

export interface ClientOptions {
  url: string;
  doc: string;
  token?: string;
  WebSocket?: typeof WebSocket;
  minDelay?: number;
  maxDelay?: number;
}

export class SyncError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

const FATAL = new Set([1, 2, 3]);

export class SyncClient {
  private ws: WebSocket | null = null;
  private stopped = true;
  private delay: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private server: VV = new Map();
  private sent: VV = new Map();
  private write = false;
  private unsub: (() => void) | null = null;
  private waiters: (() => void)[] = [];
  private listeners = new Set<(s: Status, err?: SyncError) => void>();
  status: Status = "idle";
  lastError: SyncError | null = null;

  constructor(readonly doc: Doc, private readonly opts: ClientOptions) {
    this.delay = opts.minDelay ?? 250;
  }

  onStatus(fn: (s: Status, err?: SyncError) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(s: Status, err?: SyncError): void {
    this.status = s;
    if (err) this.lastError = err;
    for (const fn of this.listeners) fn(s, err);
    if (s === "synced") this.flushWaiters();
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.unsub = this.doc.subscribe((_, local) => {
      if (local) this.push();
    });
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.unsub?.();
    this.unsub = null;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
    this.set("idle");
  }

  whenSynced(): Promise<void> {
    if (this.covered()) return Promise.resolve();
    return new Promise((res) => this.waiters.push(res));
  }

  private covered(): boolean {
    if (this.status !== "synced") return false;
    for (const [a, s] of this.doc.version()) if ((this.server.get(a) ?? 0) < s) return false;
    return this.doc.missing === 0;
  }

  private flushWaiters(): void {
    if (!this.covered()) return;
    const ws = this.waiters;
    this.waiters = [];
    for (const fn of ws) fn();
  }

  private connect(): void {
    if (this.stopped) return;
    this.set("connecting");
    const WS = this.opts.WebSocket ?? globalThis.WebSocket;
    const ws = new WS(this.opts.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.set("syncing");
      ws.send(encodeMsg({ t: MsgType.Hello, doc: this.opts.doc, token: this.opts.token ?? "", vv: this.doc.version() }));
    };
    ws.onmessage = (ev) => {
      let m: Msg;
      try {
        m = decodeMsg(new Uint8Array(ev.data as ArrayBuffer));
      } catch {
        ws.close();
        return;
      }
      this.handle(m);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped) return;
      this.set("offline");
      this.timer = setTimeout(() => this.connect(), this.delay);
      this.delay = Math.min(this.delay * 2, this.opts.maxDelay ?? 10_000);
    };
    ws.onerror = () => {};
  }

  private handle(m: Msg): void {
    switch (m.t) {
      case MsgType.Welcome: {
        const first = this.status !== "synced";
        this.server = m.vv;
        if (first) this.sent = new Map(m.vv);
        this.write = m.write;
        this.delay = this.opts.minDelay ?? 250;
        if (first) this.push();
        this.set("synced");
        break;
      }
      case MsgType.Changes:
        this.doc.apply(m.blobs);
        for (const [a, s] of this.doc.version()) if ((this.server.get(a) ?? 0) < s && a !== this.doc.actor) this.server.set(a, s);
        this.flushWaiters();
        break;
      case MsgType.Error: {
        const err = new SyncError(m.code, m.text);
        if (FATAL.has(m.code)) {
          this.stopped = true;
          this.unsub?.();
          this.set("idle", err);
        } else {
          this.lastError = err;
        }
        break;
      }
      case MsgType.Hello:
        break;
    }
  }

  private push(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1 || !this.write) return;
    const blobs = this.doc.changes(this.sent);
    if (!blobs.length) return;
    ws.send(encodeMsg({ t: MsgType.Changes, blobs }));
    for (const [a, s] of this.doc.version()) if ((this.sent.get(a) ?? 0) < s) this.sent.set(a, s);
  }
}
