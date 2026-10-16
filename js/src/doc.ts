import {
  type Change,
  Kind,
  type ObjRef,
  type Op,
  type OpId,
  OpType,
  type Val,
  cmpId,
  decodeChange,
  encodeChange,
  refKey,
  span,
  width,
} from "./change.js";
import { CodecError, hex } from "./codec.js";
import { decodeSave, encodeSave } from "./save.js";
import { Actors, type Elem, Seq, idKey } from "./seq.js";
import { Log } from "./log.js";

type Slot = Val | { obj: string };

interface Entry {
  id: OpId;
  val: Slot;
  del: boolean;
}

type Obj = { ref: ObjRef } & (
  | { kind: Kind.Map; entries: Map<string, Entry>; dels: Map<string, OpId> }
  | { kind: Kind.List | Kind.Text; seq: Seq<Slot> }
  | { kind: Kind.Counter; n: number }
);

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export type VV = Map<string, number>;

const ROOT = "root";

function isObj(v: Slot): v is { obj: string } {
  return typeof v === "object" && v !== null;
}

function newActor(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return hex(b);
}

function checkVal(v: unknown): asserts v is Val {
  if (v === null || typeof v === "boolean" || typeof v === "string") return;
  if (typeof v === "number" && Number.isFinite(v)) return;
  throw new TypeError(`unsupported value: ${String(v)}`);
}

export class Doc {
  readonly actor: string;
  private objs = new Map<string, Obj>([[ROOT, { ref: null, kind: Kind.Map, entries: new Map(), dels: new Map() }]]);
  private vv: VV = new Map();
  private maxOp = 0;
  private log = new Log();
  private acts = new Actors();
  private queue = new Map<string, { ch: Change; blob: Uint8Array }>();
  private pending: Op[] | null = null;
  private nextOp = 0;
  private subs = new Set<(chs: Change[], local: boolean) => void>();

  constructor(opts: { actor?: string } = {}) {
    const a = opts.actor ?? newActor();
    if (!/^[0-9a-f]{32}$/.test(a)) throw new TypeError("actor must be 32 lowercase hex characters");
    this.actor = a;
  }

  get root(): MapRef {
    return new MapRef(this, null);
  }

  version(): VV {
    return new Map(this.vv);
  }

  subscribe(fn: (chs: Change[], local: boolean) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  change(fn: (root: MapRef) => void): Uint8Array | null {
    if (this.pending) throw new Error("nested change");
    const start = this.maxOp + 1;
    this.pending = [];
    this.nextOp = start;
    try {
      fn(this.root);
    } catch (e) {
      this.pending = null;
      throw e;
    }
    const ops = this.pending;
    this.pending = null;
    if (ops.length === 0) return null;
    const deps = new Map(this.vv);
    deps.delete(this.actor);
    const ch: Change = { actor: this.actor, seq: (this.vv.get(this.actor) ?? 0) + 1, start, time: Date.now(), deps, ops };
    const blob = encodeChange(ch);
    this.commit(ch, blob, false);
    this.emit([ch], true);
    return blob;
  }

  record(op: Op): OpId {
    if (!this.pending) throw new Error("mutations must happen inside doc.change()");
    const id = { c: this.nextOp, a: this.actor };
    if (!this.merge(op, id)) this.pending.push(op);
    this.exec(op, id);
    this.nextOp += width(op);
    this.maxOp = this.nextOp - 1;
    return id;
  }

  private merge(op: Op, id: OpId): boolean {
    const ops = this.pending!;
    const last = ops[ops.length - 1];
    if (!last || last.t !== op.t) return false;
    if (op.t === OpType.Splice && last.t === OpType.Splice) {
      if (refKey(last.obj) !== refKey(op.obj) || !op.ref || op.ref.a !== this.actor || op.ref.c !== id.c - 1) return false;
      ops[ops.length - 1] = { ...last, text: last.text + op.text };
      return true;
    }
    if (op.t === OpType.Rm && last.t === OpType.Rm) {
      if (refKey(last.obj) !== refKey(op.obj) || op.elem.a !== last.elem.a || op.n !== 1 || op.elem.c !== last.elem.c - 1) return false;
      ops[ops.length - 1] = { ...last, elem: op.elem, n: last.n + 1 };
      return true;
    }
    return false;
  }

  private commit(ch: Change, blob: Uint8Array, apply: boolean): void {
    if (apply) {
      let c = ch.start;
      for (const op of ch.ops) {
        this.exec(op, { c, a: ch.actor });
        c += width(op);
      }
    }
    this.vv.set(ch.actor, ch.seq);
    this.maxOp = Math.max(this.maxOp, ch.start + span(ch) - 1);
    this.log.push(ch.actor, ch.seq, blob);
  }

  apply(blobs: Iterable<Uint8Array>): Change[] {
    const pairs: { ch: Change; blob: Uint8Array }[] = [];
    for (const blob of blobs) pairs.push({ ch: decodeChange(blob), blob });
    return this.ingest(pairs);
  }

  private ingest(pairs: Iterable<{ ch: Change; blob: Uint8Array }>): Change[] {
    if (this.pending) throw new Error("cannot apply changes inside doc.change()");
    for (const { ch, blob } of pairs) {
      if ((this.vv.get(ch.actor) ?? 0) >= ch.seq) continue;
      this.queue.set(`${ch.actor}:${ch.seq}`, { ch, blob });
    }
    const done: Change[] = [];
    let moved = true;
    while (moved) {
      moved = false;
      for (const [k, { ch, blob }] of this.queue) {
        if (!this.ready(ch)) continue;
        this.queue.delete(k);
        this.commit(ch, blob, true);
        done.push(ch);
        moved = true;
      }
    }
    if (done.length) this.emit(done, false);
    return done;
  }

  get missing(): number {
    return this.queue.size;
  }

  private ready(ch: Change): boolean {
    if ((this.vv.get(ch.actor) ?? 0) !== ch.seq - 1) return false;
    for (const [a, s] of ch.deps) if ((this.vv.get(a) ?? 0) < s) return false;
    return true;
  }

  changes(since: VV = new Map()): Uint8Array[] {
    return this.log.since(since);
  }

  save(): Uint8Array {
    return encodeSave(this.log.all().map((b) => decodeChange(b)));
  }

  static load(buf: Uint8Array, opts: { actor?: string } = {}): Doc {
    const doc = new Doc(opts);
    doc.ingest(decodeSave(buf).map((ch) => ({ ch, blob: encodeChange(ch) })));
    if (doc.missing) throw new CodecError("document is missing changes");
    return doc;
  }

  private emit(chs: Change[], local: boolean): void {
    for (const fn of this.subs) fn(chs, local);
  }

  obj(key: string): Obj | undefined {
    return this.objs.get(key);
  }

  private exec(op: Op, id: OpId): void {
    const target = this.objs.get(refKey(op.obj));
    if (!target) return;
    switch (op.t) {
      case OpType.Set:
      case OpType.Make:
      case OpType.Del: {
        if (target.kind !== Kind.Map) return;
        let val: Slot = null;
        if (op.t === OpType.Make) {
          const child: ObjRef = { parent: op.obj, key: op.key, kind: op.kind, epoch: op.epoch };
          const ck = refKey(child);
          if (!this.objs.has(ck)) this.objs.set(ck, this.blank(op.kind, child));
          val = { obj: ck };
        }
        if (op.t === OpType.Del) {
          const last = target.dels.get(op.key);
          if (!last || cmpId(id, last) > 0) target.dels.set(op.key, id);
        }
        if (op.t === OpType.Set) val = op.val;
        const cur = target.entries.get(op.key);
        if (cur && cmpId(cur.id, id) >= 0) return;
        target.entries.set(op.key, { id, val, del: op.t === OpType.Del });
        return;
      }
      case OpType.Ins:
      case OpType.InsMake:
      case OpType.Splice: {
        if (target.kind !== Kind.List && target.kind !== Kind.Text) return;
        let ref: Elem<Slot> | null = null;
        if (op.ref !== null) {
          const found = target.seq.get(op.ref);
          if (!found) return;
          ref = found;
        }
        if (op.t === OpType.Splice) {
          let c = id.c;
          for (const ch of op.text) {
            ref = target.seq.integrate(ref, { c, a: id.a }, ch);
            c++;
          }
          return;
        }
        let val: Slot = op.t === OpType.Ins ? op.val : { obj: idKey(id) };
        if (op.t === OpType.InsMake) this.objs.set(idKey(id), this.blank(op.kind, id));
        target.seq.integrate(ref, id, val);
        return;
      }
      case OpType.Rm: {
        if (target.kind !== Kind.List && target.kind !== Kind.Text) return;
        for (let k = 0; k < op.n; k++) {
          const e = target.seq.get({ c: op.elem.c + k, a: op.elem.a });
          if (e) target.seq.kill(e);
        }
        return;
      }
      case OpType.Inc: {
        if (target.kind !== Kind.Counter) return;
        target.n += op.by;
        return;
      }
    }
  }

  private blank(kind: Kind, ref: ObjRef): Obj {
    if (kind === Kind.Map) return { ref, kind, entries: new Map(), dels: new Map() };
    if (kind === Kind.Counter) return { ref, kind, n: 0 };
    return { ref, kind, seq: new Seq<Slot>(this.acts) };
  }

  json(key: string = ROOT): Json {
    const o = this.objs.get(key);
    if (!o) return null;
    switch (o.kind) {
      case Kind.Map: {
        const out: { [k: string]: Json } = {};
        for (const k of [...o.entries.keys()].sort()) {
          const e = o.entries.get(k)!;
          if (e.del) continue;
          out[k] = isObj(e.val) ? this.json(e.val.obj) : e.val;
        }
        return out;
      }
      case Kind.List: {
        const out: Json[] = [];
        for (const e of o.seq.live()) out.push(isObj(e.val) ? this.json(e.val.obj) : e.val);
        return out;
      }
      case Kind.Text: {
        let s = "";
        for (const e of o.seq.live()) s += e.val as string;
        return s;
      }
      case Kind.Counter:
        return o.n;
    }
  }

  toJSON(): Json {
    return this.json();
  }
}

export type Value = Val | MapRef | ListRef | TextRef | CounterRef;

function wrap(doc: Doc, v: Slot): Value {
  if (!isObj(v)) return v;
  const o = doc.obj(v.obj)!;
  switch (o.kind) {
    case Kind.Map:
      return new MapRef(doc, o.ref);
    case Kind.List:
      return new ListRef(doc, o.ref);
    case Kind.Text:
      return new TextRef(doc, o.ref);
    case Kind.Counter:
      return new CounterRef(doc, o.ref);
  }
}

abstract class Ref {
  readonly key: string;
  constructor(protected readonly doc: Doc, readonly ref: ObjRef) {
    this.key = refKey(ref);
  }

  toJSON(): Json {
    return this.doc.json(this.key);
  }
}

export class MapRef extends Ref {
  private get o(): Extract<Obj, { kind: Kind.Map }> {
    return this.doc.obj(this.key) as Extract<Obj, { kind: Kind.Map }>;
  }

  keys(): string[] {
    return [...this.o.entries].filter(([, e]) => !e.del).map(([k]) => k).sort();
  }

  has(k: string): boolean {
    const e = this.o.entries.get(k);
    return !!e && !e.del;
  }

  get(k: string): Value | undefined {
    const e = this.o.entries.get(k);
    if (!e || e.del) return undefined;
    return wrap(this.doc, e.val);
  }

  set(k: string, v: Val): void {
    checkVal(v);
    this.doc.record({ t: OpType.Set, obj: this.ref, key: k, val: v });
  }

  delete(k: string): void {
    if (this.has(k)) this.doc.record({ t: OpType.Del, obj: this.ref, key: k });
  }

  private ensure(k: string, kind: Kind): ObjRef {
    const e = this.o.entries.get(k);
    if (e && !e.del && isObj(e.val)) {
      const o = this.doc.obj(e.val.obj)!;
      if (o.kind === kind) return o.ref;
    }
    const epoch = this.o.dels.get(k) ?? null;
    this.doc.record({ t: OpType.Make, obj: this.ref, key: k, kind, epoch });
    return { parent: this.ref, key: k, kind, epoch };
  }

  map(k: string): MapRef {
    return new MapRef(this.doc, this.ensure(k, Kind.Map));
  }

  list(k: string): ListRef {
    return new ListRef(this.doc, this.ensure(k, Kind.List));
  }

  text(k: string): TextRef {
    return new TextRef(this.doc, this.ensure(k, Kind.Text));
  }

  counter(k: string): CounterRef {
    return new CounterRef(this.doc, this.ensure(k, Kind.Counter));
  }
}

abstract class SeqRef extends Ref {
  protected get seq(): Seq<Slot> {
    return (this.doc.obj(this.key) as Extract<Obj, { kind: Kind.List | Kind.Text }>).seq;
  }

  get length(): number {
    return this.seq.size;
  }

  protected at(index: number): OpId | null {
    if (index < 0 || index > this.seq.size) throw new RangeError(`index ${index} out of range`);
    return index === 0 ? null : this.seq.at(index - 1).id;
  }

  delete(index: number, n = 1): void {
    if (n <= 0) return;
    if (index < 0 || index + n > this.seq.size) throw new RangeError("delete range out of bounds");
    const els = this.seq.slice(index, n);
    let i = 0;
    while (i < els.length) {
      const first = els[i]!;
      let run = 1;
      while (
        i + run < els.length &&
        els[i + run]!.id.a === first.id.a &&
        els[i + run]!.id.c === first.id.c + run
      ) run++;
      this.doc.record({ t: OpType.Rm, obj: this.ref, elem: first.id, n: run });
      i += run;
    }
  }
}

export class ListRef extends SeqRef {
  get(index: number): Value {
    return wrap(this.doc, this.seq.at(index).val);
  }

  insert(index: number, v: Val): void {
    checkVal(v);
    this.doc.record({ t: OpType.Ins, obj: this.ref, ref: this.at(index), val: v });
  }

  push(v: Val): void {
    this.insert(this.length, v);
  }

  private make(index: number, kind: Kind): OpId {
    return this.doc.record({ t: OpType.InsMake, obj: this.ref, ref: this.at(index), kind });
  }

  insertMap(index: number): MapRef {
    return new MapRef(this.doc, this.make(index, Kind.Map));
  }

  insertList(index: number): ListRef {
    return new ListRef(this.doc, this.make(index, Kind.List));
  }

  insertText(index: number): TextRef {
    return new TextRef(this.doc, this.make(index, Kind.Text));
  }

  toArray(): Value[] {
    return [...this.seq.live()].map((e) => wrap(this.doc, e.val));
  }
}

export class TextRef extends SeqRef {
  insert(index: number, s: string): void {
    if (s.length === 0) return;
    this.doc.record({ t: OpType.Splice, obj: this.ref, ref: this.at(index), text: s });
  }

  toString(): string {
    return this.doc.json(this.key) as string;
  }
}

export class CounterRef extends Ref {
  get value(): number {
    return (this.doc.obj(this.key) as Extract<Obj, { kind: Kind.Counter }>).n;
  }

  increment(by = 1): void {
    if (!Number.isSafeInteger(by)) throw new TypeError("counter increments must be integers");
    this.doc.record({ t: OpType.Inc, obj: this.ref, by });
  }

  override toJSON(): Json {
    return this.value;
  }
}
