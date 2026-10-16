import 'dart:typed_data';

import 'codec.dart';

const actorBytes = 16;
const _magic = 0x54;
const _version = 1;

enum Kind { map, list, text, counter }

int kindCode(Kind k) => k.index + 1;

Kind _kind(int c) {
  if (c < 1 || c > 4) throw CodecError('unknown object kind $c');
  return Kind.values[c - 1];
}

class OpId implements Comparable<OpId> {
  const OpId(this.c, this.a);
  final int c;
  final String a;

  String get key => '$c@$a';

  @override
  int compareTo(OpId other) => c != other.c ? c.compareTo(other.c) : a.compareTo(other.a);

  @override
  bool operator ==(Object other) => other is OpId && other.c == c && other.a == a;

  @override
  int get hashCode => Object.hash(c, a);

  @override
  String toString() => key;
}

sealed class Op {
  const Op();
}

class SetOp extends Op {
  const SetOp(this.obj, this.key, this.val);
  final OpId? obj;
  final String key;
  final Object? val;
}

class MakeOp extends Op {
  const MakeOp(this.obj, this.key, this.kind);
  final OpId? obj;
  final String key;
  final Kind kind;
}

class DelOp extends Op {
  const DelOp(this.obj, this.key);
  final OpId? obj;
  final String key;
}

class InsOp extends Op {
  const InsOp(this.obj, this.ref, this.val);
  final OpId obj;
  final OpId? ref;
  final Object? val;
}

class InsMakeOp extends Op {
  const InsMakeOp(this.obj, this.ref, this.kind);
  final OpId obj;
  final OpId? ref;
  final Kind kind;
}

class SpliceOp extends Op {
  const SpliceOp(this.obj, this.ref, this.text);
  final OpId obj;
  final OpId? ref;
  final String text;
}

class RmOp extends Op {
  const RmOp(this.obj, this.elem, this.n);
  final OpId obj;
  final OpId elem;
  final int n;
}

class IncOp extends Op {
  const IncOp(this.obj, this.by);
  final OpId obj;
  final int by;
}

int width(Op op) => op is SpliceOp ? op.text.runes.length : 1;

class Change {
  Change(this.actor, this.seq, this.start, this.time, this.deps, this.ops);
  final String actor;
  final int seq;
  final int start;
  final int time;
  final Map<String, int> deps;
  final List<Op> ops;

  int get span => ops.fold(0, (n, op) => n + width(op));
}

class _Actors {
  final List<String> list = [];
  final Map<String, int> _idx = {};

  int add(String a) => _idx.putIfAbsent(a, () {
        list.add(a);
        return list.length - 1;
      });
}

void _putId(Writer w, _Actors acts, OpId? id) {
  if (id == null) {
    w.uint(0);
    return;
  }
  w.uint(id.c);
  w.uint(acts.add(id.a));
}

bool isSafeInt(num v) => v.isFinite && v == v.truncate() && v.abs() <= maxSafe;

void checkVal(Object? v) {
  if (v == null || v is bool || v is String) return;
  if (v is num && v.isFinite) return;
  throw ArgumentError('unsupported value: $v');
}

void _putVal(Writer w, Object? v) {
  if (v == null) {
    w.u8(0);
  } else if (v == false) {
    w.u8(1);
  } else if (v == true) {
    w.u8(2);
  } else if (v is String) {
    w.u8(4);
    w.str(v);
  } else if (v is num && isSafeInt(v)) {
    w.u8(5);
    w.int_(v.toInt());
  } else if (v is num) {
    w.u8(3);
    w.f64(v.toDouble());
  } else {
    throw ArgumentError('unsupported value: $v');
  }
}

Object? _getVal(Reader r) {
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
      throw CodecError('unknown value tag $tag');
  }
}

Uint8List encodeChange(Change ch) {
  final acts = _Actors()..add(ch.actor);
  final body = Writer();
  final deps = ch.deps.entries.toList()..sort((x, y) => x.key.compareTo(y.key));
  body.uint(deps.length);
  for (final d in deps) {
    body.uint(acts.add(d.key));
    body.uint(d.value);
  }
  body.uint(ch.ops.length);
  for (final op in ch.ops) {
    switch (op) {
      case SetOp():
        body.u8(1);
        _putId(body, acts, op.obj);
        body.str(op.key);
        _putVal(body, op.val);
      case MakeOp():
        body.u8(2);
        _putId(body, acts, op.obj);
        body.str(op.key);
        body.u8(kindCode(op.kind));
      case DelOp():
        body.u8(3);
        _putId(body, acts, op.obj);
        body.str(op.key);
      case InsOp():
        body.u8(4);
        _putId(body, acts, op.obj);
        _putId(body, acts, op.ref);
        _putVal(body, op.val);
      case InsMakeOp():
        body.u8(5);
        _putId(body, acts, op.obj);
        _putId(body, acts, op.ref);
        body.u8(kindCode(op.kind));
      case SpliceOp():
        body.u8(6);
        _putId(body, acts, op.obj);
        _putId(body, acts, op.ref);
        body.str(op.text);
      case RmOp():
        body.u8(7);
        _putId(body, acts, op.obj);
        _putId(body, acts, op.elem);
        body.uint(op.n);
      case IncOp():
        body.u8(8);
        _putId(body, acts, op.obj);
        body.int_(op.by);
    }
  }
  final w = Writer()
    ..u8(_magic)
    ..u8(_version)
    ..uint(acts.list.length);
  for (final a in acts.list) {
    w.raw(unhex(a));
  }
  w
    ..uint(ch.seq)
    ..uint(ch.start)
    ..uint(ch.time)
    ..raw(body.done());
  return w.done();
}

Change decodeChange(Uint8List buf) {
  final r = Reader(buf);
  if (r.u8() != _magic) throw CodecError('not a trama change');
  final ver = r.u8();
  if (ver != _version) throw CodecError('unsupported change version $ver');
  final na = r.uint();
  if (na == 0 || na > 65535) throw CodecError('bad actor table');
  final acts = [for (var i = 0; i < na; i++) hex(r.raw(actorBytes))];
  String act(int i) {
    if (i >= acts.length) throw CodecError('actor index $i out of range');
    return acts[i];
  }

  OpId? getId() {
    final c = r.uint();
    if (c == 0) return null;
    return OpId(c, act(r.uint()));
  }

  OpId needId() {
    final id = getId();
    if (id == null) throw CodecError('missing object id');
    return id;
  }

  final seq = r.uint();
  final start = r.uint();
  final time = r.uint();
  if (seq < 1 || start < 1) throw CodecError('bad change header');
  final deps = <String, int>{};
  final nd = r.uint();
  for (var i = 0; i < nd; i++) {
    final a = act(r.uint());
    final s = r.uint();
    if (a == acts[0] || deps.containsKey(a) || s < 1) throw CodecError('bad dependency');
    deps[a] = s;
  }
  final no = r.uint();
  if (no > r.left) throw CodecError('op count larger than input');
  final ops = <Op>[];
  for (var i = 0; i < no; i++) {
    final t = r.u8();
    switch (t) {
      case 1:
        ops.add(SetOp(getId(), r.str(), _getVal(r)));
      case 2:
        ops.add(MakeOp(getId(), r.str(), _kind(r.u8())));
      case 3:
        ops.add(DelOp(getId(), r.str()));
      case 4:
        ops.add(InsOp(needId(), getId(), _getVal(r)));
      case 5:
        ops.add(InsMakeOp(needId(), getId(), _kind(r.u8())));
      case 6:
        final obj = needId();
        final ref = getId();
        final text = r.str();
        if (text.isEmpty) throw CodecError('empty splice');
        ops.add(SpliceOp(obj, ref, text));
      case 7:
        final obj = needId();
        final elem = needId();
        final n = r.uint();
        if (n < 1) throw CodecError('empty removal');
        ops.add(RmOp(obj, elem, n));
      case 8:
        ops.add(IncOp(needId(), r.int_()));
      default:
        throw CodecError('unknown op type $t');
    }
  }
  r.end();
  return Change(acts[0], seq, start, time, deps, ops);
}
