import 'dart:typed_data';

import 'change.dart';
import 'codec.dart';

const _magic = 0x44;
const _version = 2;
const _full = 0;
const _typeRun = 1;
const _delRun = 2;
const _fSeq = 1;
const _fDeps = 2;
const _fStart = 4;

class _Table {
  final List<String> list = [];
  final Map<String, int> _idx = {};
  int add(String a) => _idx.putIfAbsent(a, () {
        list.add(a);
        return list.length - 1;
      });
}

bool _sameDeps(Map<String, int> x, Map<String, int>? y) {
  if (y == null || x.length != y.length) return false;
  for (final e in x.entries) {
    if (y[e.key] != e.value) return false;
  }
  return true;
}

Op? _single(Change ch) => ch.ops.length == 1 ? ch.ops.first : null;

bool _continuesTyping(Change prev, Change ch) {
  final p = _single(prev), o = _single(ch);
  if (p is! SpliceOp || o is! SpliceOp) return false;
  final last = prev.start + prev.span - 1;
  final ref = o.ref;
  return ch.actor == prev.actor &&
      ch.seq == prev.seq + 1 &&
      ch.start == last + 1 &&
      _sameDeps(ch.deps, prev.deps) &&
      refKey(o.obj) == refKey(p.obj) &&
      ref != null &&
      ref.a == ch.actor &&
      ref.c == last;
}

bool _continuesDeleting(Change prev, Change ch) {
  final p = _single(prev), o = _single(ch);
  if (p is! RmOp || o is! RmOp || p.n != 1 || o.n != 1) return false;
  return ch.actor == prev.actor &&
      ch.seq == prev.seq + 1 &&
      ch.start == prev.start + 1 &&
      _sameDeps(ch.deps, prev.deps) &&
      refKey(o.obj) == refKey(p.obj) &&
      o.elem.a == p.elem.a &&
      o.elem.c == p.elem.c - 1;
}

class _OpWriter {
  _OpWriter(this.w, this.acts);
  final Writer w;
  final _Table acts;
  final Map<String, int> refs = {};

  void id(OpId? id, int base) {
    if (id == null) {
      w.u8(0);
      return;
    }
    w
      ..u8(1)
      ..int_(base - id.c)
      ..uint(acts.add(id.a));
  }

  void ref(Object? r, int base) {
    if (r == null) {
      w.u8(0);
      return;
    }
    final k = refKey(r);
    final known = refs[k];
    if (known != null) {
      w
        ..u8(3)
        ..uint(known);
      return;
    }
    if (r is KeyRef) {
      w.u8(2);
      ref(r.parent, base);
      w
        ..str(r.key)
        ..u8(kindCode(r.kind));
      id(r.epoch, base);
    } else {
      w.u8(1);
      id(r as OpId, base);
    }
    refs[k] = refs.length;
  }

  void val(Object? v) {
    if (v == null) {
      w.u8(0);
    } else if (v == false) {
      w.u8(1);
    } else if (v == true) {
      w.u8(2);
    } else if (v is String) {
      w
        ..u8(4)
        ..str(v);
    } else if (v is num && isSafeInt(v)) {
      w
        ..u8(5)
        ..int_(v.toInt());
    } else {
      w
        ..u8(3)
        ..f64((v as num).toDouble());
    }
  }

  void op(Op op, int base) {
    switch (op) {
      case SetOp():
        w.u8(1);
        ref(op.obj, base);
        w.str(op.key);
        val(op.val);
      case MakeOp():
        w.u8(2);
        ref(op.obj, base);
        w
          ..str(op.key)
          ..u8(kindCode(op.kind));
        id(op.epoch, base);
      case DelOp():
        w.u8(3);
        ref(op.obj, base);
        w.str(op.key);
      case InsOp():
        w.u8(4);
        ref(op.obj, base);
        id(op.ref, base);
        val(op.val);
      case InsMakeOp():
        w.u8(5);
        ref(op.obj, base);
        id(op.ref, base);
        w.u8(kindCode(op.kind));
      case SpliceOp():
        w.u8(6);
        ref(op.obj, base);
        id(op.ref, base);
        w.str(op.text);
      case RmOp():
        w.u8(7);
        ref(op.obj, base);
        id(op.elem, base);
        w.uint(op.n);
      case IncOp():
        w.u8(8);
        ref(op.obj, base);
        w.int_(op.by);
    }
  }
}

Uint8List encodeSave(List<Change> log) {
  final acts = _Table();
  for (final ch in log) {
    acts.add(ch.actor);
  }
  final body = Writer();
  final ow = _OpWriter(body, acts);
  final lastSeq = <String, int>{};
  final lastDeps = <String, Map<String, int>>{};
  Change? prev;
  var prevTime = 0;
  var records = 0;
  var i = 0;
  while (i < log.length) {
    final ch = log[i];
    if (prev != null && (_continuesTyping(prev, ch) || _continuesDeleting(prev, ch))) {
      final typing = _continuesTyping(prev, ch);
      var j = i;
      while (j < log.length && (typing ? _continuesTyping(log[j - 1], log[j]) : _continuesDeleting(log[j - 1], log[j]))) {
        j++;
      }
      body
        ..u8(typing ? _typeRun : _delRun)
        ..uint(j - i);
      for (var k = i; k < j; k++) {
        final c = log[k];
        if (typing) body.str((c.ops.first as SpliceOp).text);
        body.int_(c.time - prevTime);
        prevTime = c.time;
        lastSeq[c.actor] = c.seq;
      }
      prev = log[j - 1];
      records++;
      i = j;
      continue;
    }
    final expStart = prev != null ? prev.start + prev.span : 1;
    var flags = 0;
    if (ch.seq != (lastSeq[ch.actor] ?? 0) + 1) flags |= _fSeq;
    if (!_sameDeps(ch.deps, lastDeps[ch.actor]) && !(ch.deps.isEmpty && !lastDeps.containsKey(ch.actor))) flags |= _fDeps;
    if (ch.start != expStart) flags |= _fStart;
    body
      ..u8(_full)
      ..uint(acts.add(ch.actor))
      ..u8(flags);
    if (flags & _fSeq != 0) body.uint(ch.seq);
    if (flags & _fStart != 0) body.uint(ch.start);
    body.int_(ch.time - prevTime);
    if (flags & _fDeps != 0) {
      final deps = ch.deps.entries.toList()..sort((x, y) => x.key.compareTo(y.key));
      body.uint(deps.length);
      for (final d in deps) {
        body
          ..uint(acts.add(d.key))
          ..uint(d.value);
      }
    }
    body.uint(ch.ops.length);
    var base = ch.start;
    for (final op in ch.ops) {
      ow.op(op, base);
      base += width(op);
    }
    lastSeq[ch.actor] = ch.seq;
    lastDeps[ch.actor] = ch.deps;
    prevTime = ch.time;
    prev = ch;
    records++;
    i++;
  }
  final w = Writer()
    ..u8(_magic)
    ..u8(_version)
    ..uint(acts.list.length);
  for (final a in acts.list) {
    w.raw(unhex(a));
  }
  w
    ..uint(log.length)
    ..uint(records)
    ..raw(body.done());
  return w.done();
}

List<Change> decodeSave(Uint8List buf) {
  final r = Reader(buf);
  if (r.u8() != _magic || r.u8() != _version) throw CodecError('not a trama document');
  final na = r.uint();
  if (na > r.left ~/ 16) throw CodecError('bad actor table');
  final acts = [for (var i = 0; i < na; i++) hex(r.raw(16))];
  String act(int i) {
    if (i >= acts.length) throw CodecError('actor index $i out of range');
    return acts[i];
  }

  final total = r.uint();
  final records = r.uint();
  final refs = <Object?>[];
  OpId? getId(int base) {
    final tag = r.u8();
    if (tag == 0) return null;
    if (tag != 1) throw CodecError('bad id');
    final c = base - r.int_();
    if (c < 1) throw CodecError('bad id counter');
    return OpId(c, act(r.uint()));
  }

  OpId needId(int base) => getId(base) ?? (throw CodecError('missing id'));

  Kind kind() {
    final k = r.u8();
    if (k < 1 || k > 4) throw CodecError('bad kind');
    return Kind.values[k - 1];
  }

  Object? getRef(int base, int depth) {
    if (depth > 64) throw CodecError('reference too deep');
    final tag = r.u8();
    if (tag == 0) return null;
    if (tag == 3) {
      final i = r.uint();
      if (i >= refs.length) throw CodecError('bad reference index');
      return refs[i];
    }
    final Object out;
    if (tag == 1) {
      out = needId(base);
    } else if (tag == 2) {
      final parent = getRef(base, depth + 1);
      final key = r.str();
      final k = kind();
      out = KeyRef(parent, key, k, getId(base));
    } else {
      throw CodecError('bad reference tag $tag');
    }
    refs.add(out);
    return out;
  }

  Object? getVal() {
    final tag = r.u8();
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
        return r.int_();
      default:
        throw CodecError('bad value tag $tag');
    }
  }

  Op getOp(int base) {
    final t = r.u8();
    final obj = getRef(base, 0);
    Object need() => obj ?? (throw CodecError('missing object'));
    switch (t) {
      case 1:
        return SetOp(obj, r.str(), getVal());
      case 2:
        final key = r.str();
        final k = kind();
        return MakeOp(obj, key, k, getId(base));
      case 3:
        return DelOp(obj, r.str());
      case 4:
        return InsOp(need(), getId(base), getVal());
      case 5:
        final ref = getId(base);
        return InsMakeOp(need(), ref, kind());
      case 6:
        return SpliceOp(need(), getId(base), r.str());
      case 7:
        return RmOp(need(), needId(base), r.uint());
      case 8:
        return IncOp(need(), r.int_());
      default:
        throw CodecError('bad op type $t');
    }
  }

  final out = <Change>[];
  final lastSeq = <String, int>{};
  final lastDeps = <String, Map<String, int>>{};
  Change? prev;
  var prevTime = 0;
  for (var k = 0; k < records; k++) {
    final kindByte = r.u8();
    if (kindByte == _full) {
      final actor = act(r.uint());
      final flags = r.u8();
      final seq = flags & _fSeq != 0 ? r.uint() : (lastSeq[actor] ?? 0) + 1;
      final start = flags & _fStart != 0 ? r.uint() : (prev != null ? prev.start + prev.span : 1);
      final time = prevTime + r.int_();
      final Map<String, int> deps;
      if (flags & _fDeps != 0) {
        deps = {};
        final nd = r.uint();
        for (var d = 0; d < nd; d++) {
          deps[act(r.uint())] = r.uint();
        }
      } else {
        deps = Map.of(lastDeps[actor] ?? const {});
      }
      final no = r.uint();
      if (no > r.left) throw CodecError('op count larger than input');
      final ops = <Op>[];
      var base = start;
      for (var o = 0; o < no; o++) {
        final op = getOp(base);
        ops.add(op);
        base += width(op);
      }
      final ch = Change(actor, seq, start, time, deps, ops);
      out.add(ch);
      lastSeq[actor] = seq;
      lastDeps[actor] = deps;
      prevTime = time;
      prev = ch;
    } else if (kindByte == _typeRun || kindByte == _delRun) {
      if (prev == null) throw CodecError('run without a previous change');
      final n = r.uint();
      for (var i = 0; i < n; i++) {
        final p = prev!;
        final po = p.ops.first;
        final Op op;
        final int start;
        if (kindByte == _typeRun) {
          if (po is! SpliceOp) throw CodecError('bad typing run');
          final last = p.start + p.span - 1;
          op = SpliceOp(po.obj, OpId(last, p.actor), r.str());
          start = last + 1;
        } else {
          if (po is! RmOp) throw CodecError('bad delete run');
          op = RmOp(po.obj, OpId(po.elem.c - 1, po.elem.a), 1);
          start = p.start + 1;
        }
        final time = prevTime + r.int_();
        final ch = Change(p.actor, p.seq + 1, start, time, Map.of(p.deps), [op]);
        out.add(ch);
        lastSeq[ch.actor] = ch.seq;
        prevTime = time;
        prev = ch;
      }
    } else {
      throw CodecError('bad record $kindByte');
    }
  }
  r.end();
  if (out.length != total) throw CodecError('change count mismatch');
  return out;
}
