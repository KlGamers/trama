import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { CodecError, Doc } from "../src/index.js";
import { decodeSave, encodeSave } from "../src/save.js";
import { decodeChange } from "../src/change.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("compact save format", () => {
  test("rebuilds every change byte for byte, with typing and deleting runs", () => {
    const x = new Doc({ actor: "a".repeat(32) });
    const y = new Doc({ actor: "b".repeat(32) });
    for (const ch of "hola mundo") x.change((r) => { const t = r.text("t"); t.insert(t.length, ch); });
    for (let i = 0; i < 4; i++) x.change((r) => { const t = r.text("t"); t.delete(t.length - 1, 1); });
    y.apply(x.changes());
    y.change((r) => { r.counter("c").increment(3); r.list("l").push(1.5); r.map("m").set("k", null); });
    for (const ch of "!!") y.change((r) => { const t = r.text("t"); t.insert(0, ch); });
    x.apply(y.changes());
    const saved = x.save();
    const back = Doc.load(saved, { actor: "c".repeat(32) });
    expect(back.toJSON()).toEqual(x.toJSON());
    expect(back.changes().map(hex)).toEqual(x.changes().map(hex));
    expect(saved.length).toBeLessThan(x.changes().reduce((n, b) => n + b.length, 0) / 3);
  });

  test("round trips random histories", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.integer({ min: 0, max: 2 }), fc.integer({ min: 0, max: 5 }), fc.string({ minLength: 1, maxLength: 3 })), { minLength: 1, maxLength: 80, size: "max" }), (steps) => {
        const docs = ["1", "2", "3"].map((d) => new Doc({ actor: d.repeat(32) }));
        for (const [who, kind, s] of steps) {
          const d = docs[who]!;
          if (kind === 5) {
            const o = docs[(who + 1) % 3]!;
            o.apply(d.changes(o.version()));
            continue;
          }
          d.change((r) => {
            const t = r.text("t");
            if (kind <= 2 || t.length === 0) t.insert(kind === 0 ? 0 : t.length, s);
            else if (kind === 3) t.delete(t.length - 1, 1);
            else r.counter("n").increment(s.length);
          });
        }
        for (const d of docs) {
          const back = Doc.load(d.save());
          expect(back.toJSON()).toEqual(d.toJSON());
          expect(back.changes().map(hex)).toEqual(d.changes().map(hex));
        }
      }),
      { numRuns: 300 },
    );
  });

  test("rejects corrupt saves", () => {
    const d = new Doc({ actor: "a".repeat(32) });
    d.change((r) => r.text("t").insert(0, "hola"));
    d.change((r) => r.text("t").insert(4, "!"));
    const s = d.save();
    expect(() => Doc.load(s.slice(0, s.length - 1))).toThrow(CodecError);
    expect(() => Doc.load(new Uint8Array([...s, 0]))).toThrow(CodecError);
    expect(() => decodeSave(new Uint8Array([0x44, 9]))).toThrow(CodecError);
    expect(decodeSave(encodeSave(d.changes().map(decodeChange))).length).toBe(2);
  });
});
