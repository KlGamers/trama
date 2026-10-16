import type { VV } from "./doc.js";

export class Log {
  private buf = new Uint8Array(1 << 16);
  private used = 0;
  private offs = new Float64Array(1024);
  private seqs = new Float64Array(1024);
  private who = new Uint16Array(1024);
  private names: string[] = [];
  private nameIdx = new Map<string, number>();
  length = 0;

  push(actor: string, seq: number, blob: Uint8Array): void {
    if (this.used + blob.length > this.buf.length) {
      let cap = this.buf.length * 2;
      while (cap < this.used + blob.length) cap *= 2;
      const nb = new Uint8Array(cap);
      nb.set(this.buf.subarray(0, this.used));
      this.buf = nb;
    }
    if (this.length + 1 >= this.offs.length) {
      const grow = <A extends Float64Array | Uint16Array>(a: A, make: (n: number) => A): A => {
        const n = make(a.length * 2);
        n.set(a);
        return n;
      };
      this.offs = grow(this.offs, (n) => new Float64Array(n));
      this.seqs = grow(this.seqs, (n) => new Float64Array(n));
      this.who = grow(this.who, (n) => new Uint16Array(n));
    }
    let ai = this.nameIdx.get(actor);
    if (ai === undefined) {
      ai = this.names.length;
      this.names.push(actor);
      this.nameIdx.set(actor, ai);
    }
    this.buf.set(blob, this.used);
    this.offs[this.length] = this.used;
    this.seqs[this.length] = seq;
    this.who[this.length] = ai;
    this.used += blob.length;
    this.length++;
    this.offs[this.length] = this.used;
  }

  private at(i: number): Uint8Array {
    return this.buf.slice(this.offs[i]!, this.offs[i + 1]!);
  }

  all(): Uint8Array[] {
    const out: Uint8Array[] = [];
    for (let i = 0; i < this.length; i++) out.push(this.at(i));
    return out;
  }

  since(vv: VV): Uint8Array[] {
    const floor = this.names.map((n) => vv.get(n) ?? 0);
    const out: Uint8Array[] = [];
    for (let i = 0; i < this.length; i++) if (this.seqs[i]! > floor[this.who[i]!]!) out.push(this.at(i));
    return out;
  }
}
