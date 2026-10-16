import {
  type Change,
  type Kind,
  type ObjRef,
  type Op,
  type OpId,
  OpType,
  type Val,
  isKeyRef,
  refKey,
  span,
  width,
} from "./change.js";
import { CodecError, Reader, Writer, hex, unhex } from "./codec.js";

const MAGIC = 0x44;
const VERSION = 2;
const FULL = 0;
const TYPE_RUN = 1;
const DEL_RUN = 2;
const F_SEQ = 1;
const F_DEPS = 2;
const F_START = 4;

class Table {
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

function sameDeps(x: Map<string, number>, y: Map<string, number> | undefined): boolean {
  if (!y || x.size !== y.size) return false;
  for (const [a, s] of x) if (y.get(a) !== s) return false;
  return true;
}

function single(ch: Change): Op | null {
  return ch.ops.length === 1 ? ch.ops[0]! : null;
}

function sameRef(x: ObjRef, y: ObjRef): boolean {
  return refKey(x) === refKey(y);
}

function continuesTyping(prev: Change, ch: Change): boolean {
  const p = single(prev);
  const o = single(ch);
  if (!p || !o || p.t !== OpType.Splice || o.t !== OpType.Splice) return false;
  const last = prev.start + span(prev) - 1;
  return (
    ch.actor === prev.actor &&
    ch.seq === prev.seq + 1 &&
    ch.start === last + 1 &&
    sameDeps(ch.deps, prev.deps) &&
    sameRef(o.obj, p.obj) &&
    o.ref !== null &&
    o.ref.a === ch.actor &&
    o.ref.c === last
  );
}

function continuesDeleting(prev: Change, ch: Change): boolean {
  const p = single(prev);
  const o = single(ch);
  if (!p || !o || p.t !== OpType.Rm || o.t !== OpType.Rm || p.n !== 1 || o.n !== 1) return false;
  return (
    ch.actor === prev.actor &&
    ch.seq === prev.seq + 1 &&
    ch.start === prev.start + 1 &&
    sameDeps(ch.deps, prev.deps) &&
    sameRef(o.obj, p.obj) &&
    o.elem.a === p.elem.a &&
    o.elem.c === p.elem.c - 1
  );
}

class OpWriter {
  refs = new Map<string, number>();
  constructor(private readonly w: Writer, private readonly acts: Table) {}

  id(id: OpId | null, base: number): void {
    if (id === null) {
      this.w.u8(0);
      return;
    }
    this.w.u8(1).int(base - id.c).uint(this.acts.add(id.a));
  }

  ref(r: ObjRef, base: number): void {
    if (r === null) {
      this.w.u8(0);
      return;
    }
    const k = refKey(r);
    const known = this.refs.get(k);
    if (known !== undefined) {
      this.w.u8(3).uint(known);
      return;
    }
    if (isKeyRef(r)) {
      this.w.u8(2);
      this.ref(r.parent, base);
      this.w.str(r.key).u8(r.kind);
      this.id(r.epoch, base);
    } else {
      this.w.u8(1);
      this.id(r, base);
    }
    this.refs.set(k, this.refs.size);
  }

  val(v: Val): void {
    if (v === null) this.w.u8(0);
    else if (v === false) this.w.u8(1);
    else if (v === true) this.w.u8(2);
    else if (typeof v === "string") this.w.u8(4).str(v);
    else if (Number.isSafeInteger(v)) this.w.u8(5).int(v);
    else this.w.u8(3).f64(v);
  }

  op(op: Op, base: number): void {
    const w = this.w;
    w.u8(op.t);
    this.ref(op.obj, base);
    switch (op.t) {
      case OpType.Set:
        w.str(op.key);
        this.val(op.val);
        break;
      case OpType.Make:
        w.str(op.key).u8(op.kind);
        this.id(op.epoch, base);
        break;
      case OpType.Del:
        w.str(op.key);
        break;
      case OpType.Ins:
        this.id(op.ref, base);
        this.val(op.val);
        break;
      case OpType.InsMake:
        this.id(op.ref, base);
        w.u8(op.kind);
        break;
      case OpType.Splice:
        this.id(op.ref, base);
        w.str(op.text);
        break;
      case OpType.Rm:
        this.id(op.elem, base);
        w.uint(op.n);
        break;
      case OpType.Inc:
        w.int(op.by);
        break;
    }
  }
}

export function encodeSave(log: Change[]): Uint8Array {
  const acts = new Table();
  for (const ch of log) acts.add(ch.actor);
  const body = new Writer();
  const ow = new OpWriter(body, acts);
  const lastSeq = new Map<string, number>();
  const lastDeps = new Map<string, Map<string, number>>();
  let prev: Change | null = null;
  let prevTime = 0;
  let records = 0;
  let i = 0;
  while (i < log.length) {
    const ch = log[i]!;
    if (prev && (continuesTyping(prev, ch) || continuesDeleting(prev, ch))) {
      const typing = continuesTyping(prev, ch);
      let j = i;
      while (j < log.length && (typing ? continuesTyping(log[j - 1]!, log[j]!) : continuesDeleting(log[j - 1]!, log[j]!))) j++;
      body.u8(typing ? TYPE_RUN : DEL_RUN).uint(j - i);
      for (let k = i; k < j; k++) {
        const c = log[k]!;
        if (typing) body.str((c.ops[0] as Extract<Op, { t: OpType.Splice }>).text);
        body.int(c.time - prevTime);
        prevTime = c.time;
        lastSeq.set(c.actor, c.seq);
      }
      prev = log[j - 1]!;
      records++;
      i = j;
      continue;
    }
    const expStart = prev ? prev.start + span(prev) : 1;
    let flags = 0;
    if (ch.seq !== (lastSeq.get(ch.actor) ?? 0) + 1) flags |= F_SEQ;
    if (!sameDeps(ch.deps, lastDeps.get(ch.actor)) && !(ch.deps.size === 0 && !lastDeps.has(ch.actor))) flags |= F_DEPS;
    if (ch.start !== expStart) flags |= F_START;
    body.u8(FULL).uint(acts.add(ch.actor)).u8(flags);
    if (flags & F_SEQ) body.uint(ch.seq);
    if (flags & F_START) body.uint(ch.start);
    body.int(ch.time - prevTime);
    if (flags & F_DEPS) {
      const deps = [...ch.deps.entries()].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
      body.uint(deps.length);
      for (const [a, s] of deps) body.uint(acts.add(a)).uint(s);
    }
    body.uint(ch.ops.length);
    let base = ch.start;
    for (const op of ch.ops) {
      ow.op(op, base);
      base += width(op);
    }
    lastSeq.set(ch.actor, ch.seq);
    lastDeps.set(ch.actor, ch.deps);
    prevTime = ch.time;
    prev = ch;
    records++;
    i++;
  }
  const w = new Writer().u8(MAGIC).u8(VERSION).uint(acts.list.length);
  for (const a of acts.list) w.raw(unhex(a));
  w.uint(log.length).uint(records).raw(body.done());
  return w.done();
}

export function decodeSave(buf: Uint8Array): Change[] {
  const r = new Reader(buf);
  if (r.u8() !== MAGIC || r.u8() !== VERSION) throw new CodecError("not a trama document");
  const na = r.uint();
  if (na > r.left / 16) throw new CodecError("bad actor table");
  const acts: string[] = [];
  for (let i = 0; i < na; i++) acts.push(hex(r.raw(16)));
  const act = (i: number): string => {
    const a = acts[i];
    if (a === undefined) throw new CodecError(`actor index ${i} out of range`);
    return a;
  };
  const total = r.uint();
  const records = r.uint();
  const refs: ObjRef[] = [];
  const getId = (base: number): OpId | null => {
    const tag = r.u8();
    if (tag === 0) return null;
    if (tag !== 1) throw new CodecError("bad id");
    const c = base - r.int();
    if (c < 1) throw new CodecError("bad id counter");
    return { c, a: act(r.uint()) };
  };
  const needId = (base: number): OpId => {
    const id = getId(base);
    if (!id) throw new CodecError("missing id");
    return id;
  };
  const getRef = (base: number, depth: number): ObjRef => {
    if (depth > 64) throw new CodecError("reference too deep");
    const tag = r.u8();
    if (tag === 0) return null;
    if (tag === 3) {
      const i = r.uint();
      if (i >= refs.length) throw new CodecError("bad reference index");
      return refs[i]!;
    }
    let out: ObjRef;
    if (tag === 1) out = needId(base);
    else if (tag === 2) {
      const parent = getRef(base, depth + 1);
      const key = r.str();
      const kind = r.u8();
      if (kind < 1 || kind > 4) throw new CodecError("bad kind");
      out = { parent, key, kind: kind as Kind, epoch: getId(base) };
    } else throw new CodecError(`bad reference tag ${tag}`);
    refs.push(out);
    return out;
  };
  const getVal = (): Val => {
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
        throw new CodecError(`bad value tag ${tag}`);
    }
  };
  const getOp = (base: number): Op => {
    const t = r.u8();
    const obj = getRef(base, 0);
    switch (t) {
      case OpType.Set:
        return { t, obj, key: r.str(), val: getVal() };
      case OpType.Make: {
        const key = r.str();
        const kind = r.u8();
        if (kind < 1 || kind > 4) throw new CodecError("bad kind");
        return { t, obj, key, kind: kind as Kind, epoch: getId(base) };
      }
      case OpType.Del:
        return { t, obj, key: r.str() };
      case OpType.Ins:
        return { t, obj, ref: getId(base), val: getVal() };
      case OpType.InsMake: {
        const ref = getId(base);
        const kind = r.u8();
        if (kind < 1 || kind > 4) throw new CodecError("bad kind");
        return { t, obj, ref, kind: kind as Kind };
      }
      case OpType.Splice:
        return { t, obj, ref: getId(base), text: r.str() };
      case OpType.Rm:
        return { t, obj, elem: needId(base), n: r.uint() };
      case OpType.Inc:
        return { t, obj, by: r.int() };
      default:
        throw new CodecError(`bad op type ${t}`);
    }
  };
  const out: Change[] = [];
  const lastSeq = new Map<string, number>();
  const lastDeps = new Map<string, Map<string, number>>();
  let prev: Change | null = null;
  let prevTime = 0;
  for (let k = 0; k < records; k++) {
    const kind = r.u8();
    if (kind === FULL) {
      const actor = act(r.uint());
      const flags = r.u8();
      const seq = flags & F_SEQ ? r.uint() : (lastSeq.get(actor) ?? 0) + 1;
      const start = flags & F_START ? r.uint() : prev ? prev.start + span(prev) : 1;
      const time = prevTime + r.int();
      let deps: Map<string, number>;
      if (flags & F_DEPS) {
        deps = new Map();
        const nd = r.uint();
        for (let d = 0; d < nd; d++) deps.set(act(r.uint()), r.uint());
      } else deps = new Map(lastDeps.get(actor) ?? []);
      const no = r.uint();
      if (no > r.left) throw new CodecError("op count larger than input");
      const ops: Op[] = [];
      let base = start;
      for (let o = 0; o < no; o++) {
        const op = getOp(base);
        ops.push(op);
        base += width(op);
      }
      const ch: Change = { actor, seq, start, time, deps, ops };
      out.push(ch);
      lastSeq.set(actor, seq);
      lastDeps.set(actor, deps);
      prevTime = time;
      prev = ch;
    } else if (kind === TYPE_RUN || kind === DEL_RUN) {
      if (!prev) throw new CodecError("run without a previous change");
      const n = r.uint();
      for (let i = 0; i < n; i++) {
        const p: Change = prev;
        const po = p.ops[0]!;
        let op: Op;
        let start: number;
        if (kind === TYPE_RUN) {
          if (po.t !== OpType.Splice) throw new CodecError("bad typing run");
          const last = p.start + span(p) - 1;
          op = { t: OpType.Splice, obj: po.obj, ref: { c: last, a: p.actor }, text: r.str() };
          start = last + 1;
        } else {
          if (po.t !== OpType.Rm) throw new CodecError("bad delete run");
          op = { t: OpType.Rm, obj: po.obj, elem: { c: po.elem.c - 1, a: po.elem.a }, n: 1 };
          start = p.start + 1;
        }
        const time = prevTime + r.int();
        const ch: Change = { actor: p.actor, seq: p.seq + 1, start, time, deps: new Map(p.deps), ops: [op] };
        out.push(ch);
        lastSeq.set(ch.actor, ch.seq);
        prevTime = time;
        prev = ch;
      }
    } else throw new CodecError(`bad record ${kind}`);
  }
  r.end();
  if (out.length !== total) throw new CodecError("change count mismatch");
  return out;
}
