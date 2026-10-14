const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

export class Writer {
  private buf = new Uint8Array(256);
  private len = 0;

  private room(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const nxt = new Uint8Array(cap);
    nxt.set(this.buf.subarray(0, this.len));
    this.buf = nxt;
  }

  u8(v: number): this {
    this.room(1);
    this.buf[this.len++] = v & 0xff;
    return this;
  }

  uint(v: number): this {
    if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`not a uint: ${v}`);
    this.room(10);
    while (v >= 0x80) {
      this.buf[this.len++] = (v % 0x80) | 0x80;
      v = Math.floor(v / 0x80);
    }
    this.buf[this.len++] = v;
    return this;
  }

  int(v: number): this {
    if (!Number.isSafeInteger(v)) throw new RangeError(`not an int: ${v}`);
    return this.uint(v >= 0 ? v * 2 : -v * 2 - 1);
  }

  f64(v: number): this {
    this.room(8);
    new DataView(this.buf.buffer, this.buf.byteOffset + this.len, 8).setFloat64(0, v, true);
    this.len += 8;
    return this;
  }

  bytes(b: Uint8Array): this {
    this.uint(b.length);
    this.raw(b);
    return this;
  }

  raw(b: Uint8Array): this {
    this.room(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
    return this;
  }

  str(s: string): this {
    return this.bytes(enc.encode(s));
  }

  done(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

export class CodecError extends Error {}

export class Reader {
  pos = 0;
  constructor(private readonly buf: Uint8Array) {}

  get left(): number {
    return this.buf.length - this.pos;
  }

  u8(): number {
    if (this.pos >= this.buf.length) throw new CodecError("unexpected end of input");
    return this.buf[this.pos++]!;
  }

  uint(): number {
    let out = 0;
    let mul = 1;
    for (let i = 0; i < 8; i++) {
      const b = this.u8();
      out += (b & 0x7f) * mul;
      if (b < 0x80) {
        if (!Number.isSafeInteger(out)) throw new CodecError("varint too large");
        return out;
      }
      mul *= 0x80;
    }
    throw new CodecError("varint too long");
  }

  int(): number {
    const v = this.uint();
    return v % 2 === 0 ? v / 2 : -(v + 1) / 2;
  }

  f64(): number {
    if (this.left < 8) throw new CodecError("unexpected end of input");
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8).getFloat64(0, true);
    this.pos += 8;
    return v;
  }

  raw(n: number): Uint8Array {
    if (n > this.left) throw new CodecError("unexpected end of input");
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  bytes(): Uint8Array {
    return this.raw(this.uint());
  }

  str(): string {
    try {
      return dec.decode(this.bytes());
    } catch (e) {
      if (e instanceof CodecError) throw e;
      throw new CodecError("invalid utf-8");
    }
  }

  end(): void {
    if (this.left !== 0) throw new CodecError("trailing bytes");
  }
}

export function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function unhex(s: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(s)) throw new CodecError(`bad hex: ${s}`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
