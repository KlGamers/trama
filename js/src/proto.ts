import { CodecError, Reader, Writer, hex, unhex } from "./codec.js";
import type { VV } from "./doc.js";

export const enum MsgType {
  Hello = 1,
  Changes = 2,
  Welcome = 3,
  Error = 4,
}

export type Msg =
  | { t: MsgType.Hello; doc: string; token: string; vv: VV }
  | { t: MsgType.Changes; blobs: Uint8Array[] }
  | { t: MsgType.Welcome; write: boolean; vv: VV }
  | { t: MsgType.Error; code: number; text: string };

function putVV(w: Writer, vv: VV): void {
  w.uint(vv.size);
  for (const [a, s] of vv) w.raw(unhex(a)).uint(s);
}

function getVV(r: Reader): VV {
  const n = r.uint();
  if (n > r.left) throw new CodecError("bad version vector");
  const vv: VV = new Map();
  for (let i = 0; i < n; i++) vv.set(hex(r.raw(16)), r.uint());
  return vv;
}

export function encodeMsg(m: Msg): Uint8Array {
  const w = new Writer().u8(m.t);
  switch (m.t) {
    case MsgType.Hello:
      w.u8(1).str(m.doc).str(m.token);
      putVV(w, m.vv);
      break;
    case MsgType.Changes:
      w.uint(m.blobs.length);
      for (const b of m.blobs) w.bytes(b);
      break;
    case MsgType.Welcome:
      w.u8(m.write ? 1 : 0);
      putVV(w, m.vv);
      break;
    case MsgType.Error:
      w.u8(m.code).str(m.text);
      break;
  }
  return w.done();
}

export function decodeMsg(buf: Uint8Array): Msg {
  const r = new Reader(buf);
  const t = r.u8();
  let m: Msg;
  switch (t) {
    case MsgType.Hello: {
      if (r.u8() !== 1) throw new CodecError("unsupported protocol version");
      m = { t, doc: r.str(), token: r.str(), vv: getVV(r) };
      break;
    }
    case MsgType.Changes: {
      const n = r.uint();
      if (n > r.left) throw new CodecError("bad change count");
      const blobs: Uint8Array[] = [];
      for (let i = 0; i < n; i++) blobs.push(r.bytes().slice());
      m = { t, blobs };
      break;
    }
    case MsgType.Welcome:
      m = { t, write: r.u8() === 1, vv: getVV(r) };
      break;
    case MsgType.Error:
      m = { t, code: r.u8(), text: r.str() };
      break;
    default:
      throw new CodecError(`unknown message type ${t}`);
  }
  r.end();
  return m;
}
