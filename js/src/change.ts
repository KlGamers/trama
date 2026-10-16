import { CodecError, Reader, Writer, hex, unhex } from "./codec.js";

export const ACTOR_BYTES = 16;

export type Val = null | boolean | number | string;

export const enum Kind {
  Map = 1,
  List = 2,
  Text = 3,
  Counter = 4,
}

export const enum OpType {
  Set = 1,
  Make = 2,
  Del = 3,
  Ins = 4,
  InsMake = 5,
  Splice = 6,
  Rm = 7,
  Inc = 8,
}

export interface OpId {
  c: number;
  a: string;
}

export interface KeyRef {
  parent: ObjRef;
  key: string;
  kind: Kind;
  epoch: OpId | null;
}

export type ObjRef = null | OpId | KeyRef;

export function isKeyRef(r: ObjRef): r is KeyRef {
  return r !== null && "parent" in r;
}

export function refKey(r: ObjRef): string {
  if (r === null) return "root";
  if (isKeyRef(r)) return `${refKey(r.parent)}\u0001${r.key}\u0001${r.kind}\u0001${r.epoch ? `${r.epoch.c}@${r.epoch.a}` : ""}`;
  return `${r.c}@${r.a}`;
}

export type Op =
  | { t: OpType.Set; obj: ObjRef; key: string; val: Val }
  | { t: OpType.Make; obj: ObjRef; key: string; kind: Kind; epoch: OpId | null }
  | { t: OpType.Del; obj: ObjRef; key: string }
  | { t: OpType.Ins; obj: ObjRef; ref: OpId | null; val: Val }
  | { t: OpType.InsMake; obj: ObjRef; ref: OpId | null; kind: Kind }
  | { t: OpType.Splice; obj: ObjRef; ref: OpId | null; text: string }
  | { t: OpType.Rm; obj: ObjRef; elem: OpId; n: number }
  | { t: OpType.Inc; obj: ObjRef; by: number };

export interface Change {
  actor: string;
  seq: number;
  start: number;
  time: number;
  deps: Map<string, number>;
  ops: Op[];
}

export function width(op: Op): number {
  if (op.t === OpType.Splice) return [...op.text].length;
  if (op.t === OpType.Rm) return op.n;
  return 1;
}

export function span(ch: Change): number {
  let n = 0;
  for (const op of ch.ops) n += width(op);
  return n;
}

const MAGIC = 0x54;
const VERSION = 2;
const MAX_DEPTH = 64;

class Actors {
  list: string[] = [];
  private idx = new Map<string, number>();

  add(a: string): number {
    let i = this.idx.get(a);
    if (i === undefined) {
      i = this.list.length;
      this.list.push(a);
      this.idx.set(a, i);
    }
    return i;
  }
}

function putId(w: Writer, acts: Actors, id: OpId | null): void {
  if (id === null) {
    w.uint(0);
    return;
  }
  w.uint(id.c);
  w.uint(acts.add(id.a));
}

function putRef(w: Writer, acts: Actors, r: ObjRef): void {
  if (r === null) {
    w.u8(0);
  } else if (isKeyRef(r)) {
    w.u8(2);
    putRef(w, acts, r.parent);
    w.str(r.key).u8(r.kind);
    putId(w, acts, r.epoch);
  } else {
    w.u8(1);
    putId(w, acts, r);
  }
}

function putVal(w: Writer, v: Val): void {
  if (v === null) w.u8(0);
  else if (v === false) w.u8(1);
  else if (v === true) w.u8(2);
  else if (typeof v === "string") w.u8(4).str(v);
  else if (Number.isSafeInteger(v)) w.u8(5).int(v);
  else w.u8(3).f64(v);
}

function getVal(r: Reader): Val {
  const tag = r.u8();
  switch (tag) {
    case 0:
      return null;
    case 1:
      return false;
    case 2:
      return true;
    case 3:
      return r.f64();
    case 4:
      return r.str();
    case 5:
      return r.int();
    default:
      throw new CodecError(`unknown value tag ${tag}`);
  }
}

function getKind(r: Reader): Kind {
  const k = r.u8();
  if (k < Kind.Map || k > Kind.Counter) throw new CodecError(`unknown object kind ${k}`);
  return k as Kind;
}

export function encodeChange(ch: Change): Uint8Array {
  const acts = new Actors();
  acts.add(ch.actor);
  const body = new Writer();
  const deps = [...ch.deps.entries()].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  body.uint(deps.length);
  for (const [a, s] of deps) body.uint(acts.add(a)).uint(s);
  body.uint(ch.ops.length);
  for (const op of ch.ops) {
    body.u8(op.t);
    switch (op.t) {
      case OpType.Set:
        putRef(body, acts, op.obj);
        body.str(op.key);
        putVal(body, op.val);
        break;
      case OpType.Make:
        putRef(body, acts, op.obj);
        body.str(op.key).u8(op.kind);
        putId(body, acts, op.epoch);
        break;
      case OpType.Del:
        putRef(body, acts, op.obj);
        body.str(op.key);
        break;
      case OpType.Ins:
        putRef(body, acts, op.obj);
        putId(body, acts, op.ref);
        putVal(body, op.val);
        break;
      case OpType.InsMake:
        putRef(body, acts, op.obj);
        putId(body, acts, op.ref);
        body.u8(op.kind);
        break;
      case OpType.Splice:
        putRef(body, acts, op.obj);
        putId(body, acts, op.ref);
        body.str(op.text);
        break;
      case OpType.Rm:
        putRef(body, acts, op.obj);
        putId(body, acts, op.elem);
        body.uint(op.n);
        break;
      case OpType.Inc:
        putRef(body, acts, op.obj);
        body.int(op.by);
        break;
    }
  }
  const w = new Writer().u8(MAGIC).u8(VERSION);
  w.uint(acts.list.length);
  for (const a of acts.list) w.raw(unhex(a));
  w.uint(ch.seq).uint(ch.start).uint(ch.time);
  w.raw(body.done());
  return w.done();
}

export function decodeChange(buf: Uint8Array): Change {
  const r = new Reader(buf);
  if (r.u8() !== MAGIC) throw new CodecError("not a trama change");
  const ver = r.u8();
  if (ver !== VERSION) throw new CodecError(`unsupported change version ${ver}`);
  const na = r.uint();
  if (na === 0 || na > 65535) throw new CodecError("bad actor table");
  const acts: string[] = [];
  for (let i = 0; i < na; i++) acts.push(hex(r.raw(ACTOR_BYTES)));
  const act = (i: number): string => {
    const a = acts[i];
    if (a === undefined) throw new CodecError(`actor index ${i} out of range`);
    return a;
  };
  const getId = (): OpId | null => {
    const c = r.uint();
    if (c === 0) return null;
    return { c, a: act(r.uint()) };
  };
  const needId = (): OpId => {
    const id = getId();
    if (id === null) throw new CodecError("missing element id");
    return id;
  };
  const getRef = (depth: number): ObjRef => {
    if (depth > MAX_DEPTH) throw new CodecError("object reference too deep");
    const tag = r.u8();
    if (tag === 0) return null;
    if (tag === 1) return needId();
    if (tag !== 2) throw new CodecError(`unknown reference tag ${tag}`);
    const parent = getRef(depth + 1);
    const key = r.str();
    const kind = getKind(r);
    return { parent, key, kind, epoch: getId() };
  };
  const needRef = (): ObjRef => {
    const ref = getRef(0);
    if (ref === null) throw new CodecError("sequence and counter ops need an object");
    return ref;
  };
  const seq = r.uint();
  const start = r.uint();
  const time = r.uint();
  if (seq < 1 || start < 1) throw new CodecError("bad change header");
  const deps = new Map<string, number>();
  const nd = r.uint();
  for (let i = 0; i < nd; i++) {
    const a = act(r.uint());
    const s = r.uint();
    if (a === acts[0] || deps.has(a) || s < 1) throw new CodecError("bad dependency");
    deps.set(a, s);
  }
  const no = r.uint();
  if (no > r.left) throw new CodecError("op count larger than input");
  const ops: Op[] = [];
  for (let i = 0; i < no; i++) {
    const t = r.u8();
    switch (t) {
      case OpType.Set:
        ops.push({ t, obj: getRef(0), key: r.str(), val: getVal(r) });
        break;
      case OpType.Make:
        ops.push({ t, obj: getRef(0), key: r.str(), kind: getKind(r), epoch: getId() });
        break;
      case OpType.Del:
        ops.push({ t, obj: getRef(0), key: r.str() });
        break;
      case OpType.Ins:
        ops.push({ t, obj: needRef(), ref: getId(), val: getVal(r) });
        break;
      case OpType.InsMake:
        ops.push({ t, obj: needRef(), ref: getId(), kind: getKind(r) });
        break;
      case OpType.Splice: {
        const obj = needRef();
        const ref = getId();
        const text = r.str();
        if (text.length === 0) throw new CodecError("empty splice");
        ops.push({ t, obj, ref, text });
        break;
      }
      case OpType.Rm: {
        const obj = needRef();
        const elem = needId();
        const n = r.uint();
        if (n < 1) throw new CodecError("empty removal");
        ops.push({ t, obj, elem, n });
        break;
      }
      case OpType.Inc:
        ops.push({ t, obj: needRef(), by: r.int() });
        break;
      default:
        throw new CodecError(`unknown op type ${t}`);
    }
  }
  r.end();
  return { actor: acts[0]!, seq, start, time, deps, ops };
}

export function cmpId(x: OpId, y: OpId): number {
  if (x.c !== y.c) return x.c - y.c;
  return x.a < y.a ? -1 : x.a > y.a ? 1 : 0;
}
