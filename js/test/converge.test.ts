import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { Doc } from "../src/index.js";

type Step =
  | { k: "set"; who: number; key: string; v: number | string | null }
  | { k: "del"; who: number; key: string }
  | { k: "type"; who: number; at: number; s: string }
  | { k: "cut"; who: number; at: number; n: number }
  | { k: "push"; who: number; at: number; v: number }
  | { k: "drop"; who: number; at: number }
  | { k: "inc"; who: number; by: number }
  | { k: "nest"; who: number; key: string }
  | { k: "sync"; from: number; to: number; dup: boolean; rev: boolean };

const key = fc.constantFrom("a", "b", "c");
const who = (n: number) => fc.integer({ min: 0, max: n - 1 });

function steps(n: number): fc.Arbitrary<Step[]> {
  const step: fc.Arbitrary<Step> = fc.oneof(
    fc.record({ k: fc.constant("set" as const), who: who(n), key, v: fc.oneof(fc.integer(), fc.string(), fc.constant(null)) }),
    fc.record({ k: fc.constant("del" as const), who: who(n), key }),
    fc.record({ k: fc.constant("type" as const), who: who(n), at: fc.nat(), s: fc.string({ minLength: 1, maxLength: 6, unit: "grapheme" }) }),
    fc.record({ k: fc.constant("cut" as const), who: who(n), at: fc.nat(), n: fc.integer({ min: 1, max: 4 }) }),
    fc.record({ k: fc.constant("push" as const), who: who(n), at: fc.nat(), v: fc.integer() }),
    fc.record({ k: fc.constant("drop" as const), who: who(n), at: fc.nat() }),
    fc.record({ k: fc.constant("inc" as const), who: who(n), by: fc.integer({ min: -5, max: 5 }) }),
    fc.record({ k: fc.constant("nest" as const), who: who(n), key }),
    fc.record({ k: fc.constant("sync" as const), from: who(n), to: who(n), dup: fc.boolean(), rev: fc.boolean() }),
  );
  return fc.array(step, { minLength: 20, maxLength: 80, size: "max" });
}

function run(n: number, plan: Step[]): Doc[] {
  const docs = Array.from({ length: n }, (_, i) => new Doc({ actor: String(i + 1).repeat(32).slice(0, 32) }));
  for (const s of plan) {
    if (s.k === "sync") {
      if (s.from === s.to) continue;
      let blobs = docs[s.from]!.changes(docs[s.to]!.version());
      if (s.rev) blobs = blobs.reverse();
      if (s.dup) blobs = [...blobs, ...blobs];
      docs[s.to]!.apply(blobs);
      continue;
    }
    const d = docs[s.who]!;
    d.change((r) => {
      switch (s.k) {
        case "set":
          r.set(s.key, s.v);
          break;
        case "del":
          r.delete(s.key);
          break;
        case "type": {
          const t = r.text("t");
          t.insert(s.at % (t.length + 1), s.s);
          break;
        }
        case "cut": {
          const t = r.text("t");
          if (t.length === 0) break;
          const at = s.at % t.length;
          t.delete(at, Math.min(s.n, t.length - at));
          break;
        }
        case "push": {
          const l = r.list("l");
          l.insert(s.at % (l.length + 1), s.v);
          break;
        }
        case "drop": {
          const l = r.list("l");
          if (l.length) l.delete(s.at % l.length);
          break;
        }
        case "inc":
          r.counter("n").increment(s.by);
          break;
        case "nest":
          r.map("m").set(s.key, d.actor.slice(0, 2));
          break;
      }
    });
  }
  return docs;
}

describe("convergence", () => {
  test("replicas converge after exchanging everything, in any order", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 4 }).chain((n) => fc.tuple(fc.constant(n), steps(n), fc.array(fc.double(), { maxLength: 200 }))),
        ([n, plan, keys]) => {
        const docs = run(n, plan);
        const all = docs.flatMap((d) => d.changes());
        const shuffled = all.map((b, i) => [keys[i % Math.max(keys.length, 1)] ?? i, i, b] as const).sort((x, y) => x[0] - y[0] || x[1] - y[1]).map((t) => t[2]);
        const late = new Doc({ actor: "f".repeat(32) });
        late.apply(shuffled);
        for (let round = 0; round < 2; round++) {
          for (const x of docs) for (const y of docs) if (x !== y) y.apply(x.changes(y.version()));
        }
        const want = JSON.stringify(docs[0]!.toJSON());
        for (const d of docs) {
          expect(d.missing).toBe(0);
          expect(JSON.stringify(d.toJSON())).toBe(want);
          expect(JSON.stringify(Doc.load(d.save()).toJSON())).toBe(want);
        }
        expect(late.missing).toBe(0);
        expect(JSON.stringify(late.toJSON())).toBe(want);
        },
      ),
      { numRuns: 500 },
    );
  });
});
