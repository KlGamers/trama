import { type OpId, cmpId } from "./change.js";

export interface Elem<T> {
  id: OpId;
  val: T;
  dead: boolean;
  blk: Block<T>;
}

interface Block<T> {
  items: Elem<T>[];
  live: number;
}

const MAX = 512;

export function idKey(id: OpId): string {
  return `${id.c}@${id.a}`;
}

export class Actors {
  private idx = new Map<string, number>();
  of(a: string): number {
    let i = this.idx.get(a);
    if (i === undefined) {
      i = this.idx.size;
      this.idx.set(a, i);
    }
    return i;
  }
}

export class Seq<T> {
  private blocks: Block<T>[] = [{ items: [], live: 0 }];
  private byId = new Map<number, Elem<T>>();
  size = 0;

  constructor(private readonly acts: Actors) {}

  private num(id: OpId): number {
    return id.c * 65536 + this.acts.of(id.a);
  }

  get(id: OpId): Elem<T> | undefined {
    return this.byId.get(this.num(id));
  }

  private first(): Elem<T> | null {
    for (const b of this.blocks) if (b.items.length) return b.items[0]!;
    return null;
  }

  private next(e: Elem<T>): Elem<T> | null {
    const b = e.blk;
    const i = b.items.indexOf(e);
    if (i + 1 < b.items.length) return b.items[i + 1]!;
    for (let k = this.blocks.indexOf(b) + 1; k < this.blocks.length; k++) {
      const nb = this.blocks[k]!;
      if (nb.items.length) return nb.items[0]!;
    }
    return null;
  }

  private place(prev: Elem<T> | null, e: Elem<T>): void {
    let b: Block<T>;
    let at: number;
    if (prev === null) {
      b = this.blocks[0]!;
      at = 0;
    } else {
      b = prev.blk;
      at = b.items.indexOf(prev) + 1;
    }
    b.items.splice(at, 0, e);
    e.blk = b;
    if (!e.dead) {
      b.live++;
      this.size++;
    }
    this.byId.set(this.num(e.id), e);
    if (b.items.length > MAX) this.split(b);
  }

  private split(b: Block<T>): void {
    const half = b.items.length >> 1;
    const tail = b.items.splice(half);
    const nb: Block<T> = { items: tail, live: 0 };
    for (const e of tail) {
      e.blk = nb;
      if (!e.dead) nb.live++;
    }
    b.live -= nb.live;
    this.blocks.splice(this.blocks.indexOf(b) + 1, 0, nb);
  }

  integrate(ref: Elem<T> | null, id: OpId, val: T): Elem<T> {
    const e: Elem<T> = { id, val, dead: false, blk: this.blocks[0]! };
    let prev = ref;
    let p = ref ? this.next(ref) : this.first();
    while (p !== null && cmpId(p.id, id) > 0) {
      prev = p;
      p = this.next(p);
    }
    this.place(prev, e);
    return e;
  }

  kill(e: Elem<T>): boolean {
    if (e.dead) return false;
    e.dead = true;
    e.blk.live--;
    this.size--;
    return true;
  }

  at(index: number): Elem<T> {
    if (index < 0 || index >= this.size) throw new RangeError(`index ${index} out of range`);
    let left = index;
    for (const b of this.blocks) {
      if (left >= b.live) {
        left -= b.live;
        continue;
      }
      for (const e of b.items) {
        if (e.dead) continue;
        if (left === 0) return e;
        left--;
      }
    }
    throw new RangeError(`index ${index} out of range`);
  }

  *live(): IterableIterator<Elem<T>> {
    for (const b of this.blocks) for (const e of b.items) if (!e.dead) yield e;
  }

  *all(): IterableIterator<Elem<T>> {
    for (const b of this.blocks) for (const e of b.items) yield e;
  }

  slice(from: number, n: number): Elem<T>[] {
    const out: Elem<T>[] = [];
    if (n <= 0) return out;
    let skip = from;
    for (const b of this.blocks) {
      if (skip >= b.live) {
        skip -= b.live;
        continue;
      }
      for (const e of b.items) {
        if (e.dead) continue;
        if (skip > 0) {
          skip--;
          continue;
        }
        out.push(e);
        if (out.length === n) return out;
      }
    }
    return out;
  }
}
