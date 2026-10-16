import 'dart:math';
import 'dart:typed_data';

import 'change.dart';
import 'codec.dart';
import 'save.dart';
import 'seq.dart';

const _root = 'root';

class _Ref {
  const _Ref(this.obj);
  final String obj;
}

class _Entry {
  _Entry(this.id, this.val, this.del);
  final OpId id;
  final Object? val;
  final bool del;
}

sealed class _Obj {
  _Obj(this.ref);
  final Object? ref;
}

class _MapObj extends _Obj {
  _MapObj(super.ref);
  final Map<String, _Entry> entries = {};
  final Map<String, OpId> dels = {};
}

class _SeqObj extends _Obj {
  _SeqObj(super.ref, this.text);
  final bool text;
  final Seq<Object?> seq = Seq<Object?>();
}

class _CounterObj extends _Obj {
  _CounterObj(super.ref);
  int n = 0;
}

final _actorRe = RegExp(r'^[0-9a-f]{32}$');

String _newActor() {
  final rnd = Random.secure();
  return hex(List<int>.generate(16, (_) => rnd.nextInt(256)));
}

class _Logged {
  _Logged(this.actor, this.seq, this.blob);
  final String actor;
  final int seq;
  final Uint8List blob;
}

typedef Listener = void Function(List<Change> changes, bool local);

class Doc {
  Doc({String? actor}) : actor = actor ?? _newActor() {
    if (!_actorRe.hasMatch(this.actor)) throw ArgumentError('actor must be 32 lowercase hex characters');
  }

  final String actor;
  final Map<String, _Obj> _objs = {_root: _MapObj(null)};
  final Map<String, int> _vv = {};
  int _maxOp = 0;
  final List<_Logged> _log = [];
  final Map<String, (Change, Uint8List)> _queue = {};
  List<Op>? _pending;
  int _nextOp = 0;
  final Set<Listener> _subs = {};

  MapRef get root => MapRef._(this, null);

  Map<String, int> version() => Map.of(_vv);

  int get missing => _queue.length;

  void Function() subscribe(Listener fn) {
    _subs.add(fn);
    return () => _subs.remove(fn);
  }

  Uint8List? change(void Function(MapRef root) fn) {
    if (_pending != null) throw StateError('nested change');
    final start = _maxOp + 1;
    _pending = [];
    _nextOp = start;
    try {
      fn(root);
    } catch (_) {
      _pending = null;
      rethrow;
    }
    final ops = _pending!;
    _pending = null;
    if (ops.isEmpty) return null;
    final deps = Map.of(_vv)..remove(actor);
    final ch = Change(actor, (_vv[actor] ?? 0) + 1, start, DateTime.now().millisecondsSinceEpoch, deps, ops);
    final blob = encodeChange(ch);
    _commit(ch, blob, false);
    _emit([ch], true);
    return blob;
  }

  OpId _record(Op op) {
    final p = _pending;
    if (p == null) throw StateError('mutations must happen inside doc.change()');
    final id = OpId(_nextOp, actor);
    if (!_merge(p, op, id)) p.add(op);
    _exec(op, id);
    _nextOp += width(op);
    _maxOp = _nextOp - 1;
    return id;
  }

  bool _merge(List<Op> ops, Op op, OpId id) {
    if (ops.isEmpty) return false;
    final last = ops.last;
    if (op is SpliceOp && last is SpliceOp) {
      final ref = op.ref;
      if (refKey(last.obj) != refKey(op.obj) || ref == null || ref.a != actor || ref.c != id.c - 1) return false;
      ops[ops.length - 1] = SpliceOp(last.obj, last.ref, last.text + op.text);
      return true;
    }
    if (op is RmOp && last is RmOp) {
      if (refKey(last.obj) != refKey(op.obj) || op.elem.a != last.elem.a || op.n != 1 || op.elem.c != last.elem.c - 1) return false;
      ops[ops.length - 1] = RmOp(last.obj, op.elem, last.n + 1);
      return true;
    }
    return false;
  }

  void _commit(Change ch, Uint8List blob, bool apply) {
    if (apply) {
      var c = ch.start;
      for (final op in ch.ops) {
        _exec(op, OpId(c, ch.actor));
        c += width(op);
      }
    }
    _vv[ch.actor] = ch.seq;
    _maxOp = max(_maxOp, ch.start + ch.span - 1);
    _log.add(_Logged(ch.actor, ch.seq, blob));
  }

  List<Change> apply(Iterable<Uint8List> blobs) => _ingest([for (final b in blobs) (decodeChange(b), b)]);

  List<Change> _ingest(Iterable<(Change, Uint8List)> pairs) {
    if (_pending != null) throw StateError('cannot apply changes inside doc.change()');
    for (final (ch, blob) in pairs) {
      if ((_vv[ch.actor] ?? 0) >= ch.seq) continue;
      _queue['${ch.actor}:${ch.seq}'] = (ch, blob);
    }
    final done = <Change>[];
    var moved = true;
    while (moved) {
      moved = false;
      for (final k in _queue.keys.toList()) {
        final (ch, blob) = _queue[k]!;
        if (!_ready(ch)) continue;
        _queue.remove(k);
        _commit(ch, blob, true);
        done.add(ch);
        moved = true;
      }
    }
    if (done.isNotEmpty) _emit(done, false);
    return done;
  }

  bool _ready(Change ch) {
    if ((_vv[ch.actor] ?? 0) != ch.seq - 1) return false;
    for (final d in ch.deps.entries) {
      if ((_vv[d.key] ?? 0) < d.value) return false;
    }
    return true;
  }

  List<Uint8List> changes([Map<String, int> since = const {}]) => [
        for (final e in _log)
          if (e.seq > (since[e.actor] ?? 0)) e.blob
      ];

  Uint8List save() => encodeSave([for (final e in _log) decodeChange(e.blob)]);

  static Doc load(Uint8List buf, {String? actor}) {
    final doc = Doc(actor: actor);
    doc._ingest([for (final ch in decodeSave(buf)) (ch, encodeChange(ch))]);
    if (doc.missing > 0) throw CodecError('document is missing changes');
    return doc;
  }

  void _emit(List<Change> chs, bool local) {
    for (final fn in _subs.toList()) {
      fn(chs, local);
    }
  }

  _Obj _blank(Kind kind, Object? ref) => switch (kind) {
        Kind.map => _MapObj(ref),
        Kind.counter => _CounterObj(ref),
        Kind.list => _SeqObj(ref, false),
        Kind.text => _SeqObj(ref, true),
      };

  void _exec(Op op, OpId id) {
    final Object? objRef = switch (op) {
      SetOp() => op.obj,
      MakeOp() => op.obj,
      DelOp() => op.obj,
      InsOp() => op.obj,
      InsMakeOp() => op.obj,
      SpliceOp() => op.obj,
      RmOp() => op.obj,
      IncOp() => op.obj,
    };
    final target = _objs[refKey(objRef)];
    if (target == null) return;
    switch (op) {
      case SetOp() || MakeOp() || DelOp():
        if (target is! _MapObj) return;
        final key = switch (op) { SetOp() => op.key, MakeOp() => op.key, DelOp() => op.key, _ => '' };
        Object? val;
        if (op is MakeOp) {
          final child = KeyRef(op.obj, op.key, op.kind, op.epoch);
          final ck = refKey(child);
          _objs.putIfAbsent(ck, () => _blank(op.kind, child));
          val = _Ref(ck);
        }
        if (op is DelOp) {
          final last = target.dels[key];
          if (last == null || id.compareTo(last) > 0) target.dels[key] = id;
        }
        if (op is SetOp) val = op.val;
        final cur = target.entries[key];
        if (cur != null && cur.id.compareTo(id) >= 0) return;
        target.entries[key] = _Entry(id, val, op is DelOp);
      case InsOp() || InsMakeOp() || SpliceOp():
        if (target is! _SeqObj) return;
        final refId = switch (op) { InsOp() => op.ref, InsMakeOp() => op.ref, SpliceOp() => op.ref, _ => null };
        Elem<Object?>? ref;
        if (refId != null) {
          ref = target.seq.get(refId);
          if (ref == null) return;
        }
        if (op is SpliceOp) {
          var c = id.c;
          for (final r in op.text.runes) {
            ref = target.seq.integrate(ref, OpId(c, id.a), String.fromCharCode(r));
            c++;
          }
          return;
        }
        Object? val;
        if (op is InsOp) val = op.val;
        if (op is InsMakeOp) {
          _objs[id.key] = _blank(op.kind, id);
          val = _Ref(id.key);
        }
        target.seq.integrate(ref, id, val);
      case RmOp():
        if (target is! _SeqObj) return;
        for (var k = 0; k < op.n; k++) {
          final e = target.seq.get(OpId(op.elem.c + k, op.elem.a));
          if (e != null) target.seq.kill(e);
        }
      case IncOp():
        if (target is! _CounterObj) return;
        target.n += op.by;
    }
  }

  Object? json([String key = _root]) {
    final o = _objs[key];
    switch (o) {
      case null:
        return null;
      case _MapObj():
        final out = <String, Object?>{};
        for (final k in o.entries.keys.toList()..sort()) {
          final e = o.entries[k]!;
          if (e.del) continue;
          final v = e.val;
          out[k] = v is _Ref ? json(v.obj) : v;
        }
        return out;
      case _SeqObj(text: true):
        final sb = StringBuffer();
        for (final e in o.seq.live()) {
          sb.write(e.val as String);
        }
        return sb.toString();
      case _SeqObj():
        return [for (final e in o.seq.live()) e.val is _Ref ? json((e.val as _Ref).obj) : e.val];
      case _CounterObj():
        return o.n;
    }
  }

  Object? toJson() => json();
}

Object? _wrap(Doc doc, Object? v) {
  if (v is! _Ref) return v;
  final o = doc._objs[v.obj]!;
  return switch (o) {
    _MapObj() => MapRef._(doc, o.ref),
    _SeqObj(text: true) => TextRef._(doc, o.ref),
    _SeqObj() => ListRef._(doc, o.ref),
    _CounterObj() => CounterRef._(doc, o.ref),
  };
}

class MapRef {
  MapRef._(this._doc, this.ref) : key = refKey(ref);
  final Doc _doc;
  final Object? ref;
  final String key;

  _MapObj get _o => _doc._objs[key] as _MapObj;

  List<String> keys() => [
        for (final e in _o.entries.entries)
          if (!e.value.del) e.key
      ]..sort();

  bool has(String k) {
    final e = _o.entries[k];
    return e != null && !e.del;
  }

  Object? get(String k) {
    final e = _o.entries[k];
    if (e == null || e.del) return null;
    return _wrap(_doc, e.val);
  }

  void set(String k, Object? v) {
    checkVal(v);
    _doc._record(SetOp(ref, k, v));
  }

  void delete(String k) {
    if (has(k)) _doc._record(DelOp(ref, k));
  }

  Object? _ensure(String k, Kind kind) {
    final e = _o.entries[k];
    if (e != null && !e.del && e.val is _Ref) {
      final o = _doc._objs[(e.val as _Ref).obj]!;
      final ok = switch (kind) {
        Kind.map => o is _MapObj,
        Kind.counter => o is _CounterObj,
        Kind.list => o is _SeqObj && !o.text,
        Kind.text => o is _SeqObj && o.text,
      };
      if (ok) return o.ref;
    }
    final epoch = _o.dels[k];
    _doc._record(MakeOp(ref, k, kind, epoch));
    return KeyRef(ref, k, kind, epoch);
  }

  MapRef map(String k) => MapRef._(_doc, _ensure(k, Kind.map));
  ListRef list(String k) => ListRef._(_doc, _ensure(k, Kind.list));
  TextRef text(String k) => TextRef._(_doc, _ensure(k, Kind.text));
  CounterRef counter(String k) => CounterRef._(_doc, _ensure(k, Kind.counter));

  Object? toJson() => _doc.json(key);
}

abstract class _SeqRef {
  _SeqRef(this._doc, this.ref) : key = refKey(ref);
  final Doc _doc;
  final Object? ref;
  final String key;

  Seq<Object?> get _seq => (_doc._objs[key] as _SeqObj).seq;

  int get length => _seq.size;

  OpId? _at(int index) {
    if (index < 0 || index > _seq.size) throw RangeError('index $index out of range');
    return index == 0 ? null : _seq.at(index - 1).id;
  }

  void delete(int index, [int n = 1]) {
    if (n <= 0) return;
    if (index < 0 || index + n > _seq.size) throw RangeError('delete range out of bounds');
    final els = _seq.slice(index, n);
    var i = 0;
    while (i < els.length) {
      final first = els[i];
      var run = 1;
      while (i + run < els.length && els[i + run].id.a == first.id.a && els[i + run].id.c == first.id.c + run) {
        run++;
      }
      _doc._record(RmOp(ref!, first.id, run));
      i += run;
    }
  }

  Object? toJson() => _doc.json(key);
}

class ListRef extends _SeqRef {
  ListRef._(super.doc, super.ref);

  Object? get(int index) => _wrap(_doc, _seq.at(index).val);

  void insert(int index, Object? v) {
    checkVal(v);
    _doc._record(InsOp(ref!, _at(index), v));
  }

  void push(Object? v) => insert(length, v);

  OpId _make(int index, Kind kind) => _doc._record(InsMakeOp(ref!, _at(index), kind));

  MapRef insertMap(int index) => MapRef._(_doc, _make(index, Kind.map));
  ListRef insertList(int index) => ListRef._(_doc, _make(index, Kind.list));
  TextRef insertText(int index) => TextRef._(_doc, _make(index, Kind.text));

  List<Object?> toList() => [for (final e in _seq.live()) _wrap(_doc, e.val)];
}

class TextRef extends _SeqRef {
  TextRef._(super.doc, super.ref);

  void insert(int index, String s) {
    if (s.isEmpty) return;
    _doc._record(SpliceOp(ref!, _at(index), s));
  }

  @override
  String toString() => _doc.json(key) as String;
}

class CounterRef {
  CounterRef._(this._doc, this.ref) : key = refKey(ref);
  final Doc _doc;
  final Object? ref;
  final String key;

  int get value => (_doc._objs[key] as _CounterObj).n;

  void increment([int by = 1]) {
    if (by.abs() > maxSafe) throw ArgumentError('increment out of range');
    _doc._record(IncOp(ref!, by));
  }

  Object? toJson() => value;
}
