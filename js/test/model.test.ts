import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { Doc } from "../src/index.js";

type Act =
  | { k: "set"; key: string; v: number | string | boolean | null }
  | { k: "del"; key: string }
  | { k: "type"; at: number; s: string }
  | { k: "cut"; at: number; n: number }
  | { k: "ins"; at: number; v: number }
  | { k: "rm"; at: number; n: number }
  | { k: "inc"; by: number };

const key = fc.constantFrom("a", "b", "c", "d");
const act: fc.Arbitrary<Act> = fc.oneof(
  fc.record({ k: fc.constant("set" as const), key, v: fc.oneof(fc.integer(), fc.string(), fc.boolean(), fc.constant(null)) }),
  fc.record({ k: fc.constant("del" as const), key }),
  fc.record({ k: fc.constant("type" as const), at: fc.nat(), s: fc.string({ minLength: 1, maxLength: 8, unit: "grapheme" }) }),
  fc.record({ k: fc.constant("cut" as const), at: fc.nat(), n: fc.integer({ min: 1, max: 6 }) }),
  fc.record({ k: fc.constant("ins" as const), at: fc.nat(), v: fc.integer() }),
  fc.record({ k: fc.constant("rm" as const), at: fc.nat(), n: fc.integer({ min: 1, max: 4 }) }),
  fc.record({ k: fc.constant("inc" as const), by: fc.integer({ min: -9, max: 9 }) }),
);

describe("matches a plain model", () => {
  test("sequential edits on one replica, mirrored on another", () => {
    fc.assert(
      fc.property(fc.array(fc.array(act, { minLength: 1, maxLength: 5 }), { minLength: 5, maxLength: 60, size: "max" }), (batches) => {
        const d = new Doc({ actor: "a".repeat(32) });
        const mirror = new Doc({ actor: "b".repeat(32) });
        const map: Record<string, unknown> = {};
        let text: string[] = [];
        const list: number[] = [];
        let n = 0;
        mirror.apply([
          d.change((r) => {
            r.text("t");
            r.list("l");
            r.counter("n");
          })!,
        ]);
        for (const batch of batches) {
          const blob = d.change((r) => {
            for (const a of batch) {
              switch (a.k) {
                case "set":
                  r.set(a.key, a.v);
                  map[a.key] = a.v;
                  break;
                case "del":
                  r.delete(a.key);
                  delete map[a.key];
                  break;
                case "type": {
                  const at = a.at % (text.length + 1);
                  r.text("t").insert(at, a.s);
                  text = [...text.slice(0, at), ...a.s, ...text.slice(at)];
                  break;
                }
                case "cut": {
                  if (!text.length) break;
                  const at = a.at % text.length;
                  const cnt = Math.min(a.n, text.length - at);
                  r.text("t").delete(at, cnt);
                  text.splice(at, cnt);
                  break;
                }
                case "ins": {
                  const at = a.at % (list.length + 1);
                  r.list("l").insert(at, a.v);
                  list.splice(at, 0, a.v);
                  break;
                }
                case "rm": {
                  if (!list.length) break;
                  const at = a.at % list.length;
                  const cnt = Math.min(a.n, list.length - at);
                  r.list("l").delete(at, cnt);
                  list.splice(at, cnt);
                  break;
                }
                case "inc":
                  r.counter("n").increment(a.by);
                  n += a.by;
                  break;
              }
            }
          });
          if (blob) mirror.apply([blob]);
        }
        const want = { ...Object.fromEntries(Object.keys(map).sort().map((k) => [k, map[k]])), l: list, n, t: text.join("") };
        const sorted = Object.fromEntries(Object.keys(want).sort().map((k) => [k, (want as Record<string, unknown>)[k]]));
        expect(d.toJSON()).toEqual(sorted);
        expect(mirror.toJSON()).toEqual(sorted);
      }),
      { numRuns: 400 },
    );
  });
});
