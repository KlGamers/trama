import 'change.dart';

class Elem<T> {
  Elem(this.id, this.val, this.blk);
  final OpId id;
  final T val;
  bool dead = false;
  Block<T> blk;
}

class Block<T> {
  final List<Elem<T>> items = [];
  int live = 0;
}

const _max = 512;

class Seq<T> {
  final List<Block<T>> _blocks = [Block<T>()];
  final Map<String, Elem<T>> _byId = {};
  int size = 0;

  Elem<T>? get(OpId id) => _byId[id.key];

  Elem<T>? _first() {
    for (final b in _blocks) {
      if (b.items.isNotEmpty) return b.items.first;
    }
    return null;
  }

  Elem<T>? _next(Elem<T> e) {
    final b = e.blk;
    final i = b.items.indexOf(e);
    if (i + 1 < b.items.length) return b.items[i + 1];
    for (var k = _blocks.indexOf(b) + 1; k < _blocks.length; k++) {
      final nb = _blocks[k];
      if (nb.items.isNotEmpty) return nb.items.first;
    }
    return null;
  }

  void _place(Elem<T>? prev, Elem<T> e) {
    final Block<T> b;
    final int at;
    if (prev == null) {
      b = _blocks.first;
      at = 0;
    } else {
      b = prev.blk;
      at = b.items.indexOf(prev) + 1;
    }
    b.items.insert(at, e);
    e.blk = b;
    if (!e.dead) {
      b.live++;
      size++;
    }
    _byId[e.id.key] = e;
    if (b.items.length > _max) _split(b);
  }

  void _split(Block<T> b) {
    final half = b.items.length >> 1;
    final nb = Block<T>();
    nb.items.addAll(b.items.sublist(half));
    b.items.removeRange(half, b.items.length);
    for (final e in nb.items) {
      e.blk = nb;
      if (!e.dead) nb.live++;
    }
    b.live -= nb.live;
    _blocks.insert(_blocks.indexOf(b) + 1, nb);
  }

  Elem<T> integrate(Elem<T>? ref, OpId id, T val) {
    final e = Elem<T>(id, val, _blocks.first);
    var prev = ref;
    var p = ref != null ? _next(ref) : _first();
    while (p != null && p.id.compareTo(id) > 0) {
      prev = p;
      p = _next(p);
    }
    _place(prev, e);
    return e;
  }

  bool kill(Elem<T> e) {
    if (e.dead) return false;
    e.dead = true;
    e.blk.live--;
    size--;
    return true;
  }

  Elem<T> at(int index) {
    if (index < 0 || index >= size) throw RangeError('index $index out of range');
    var left = index;
    for (final b in _blocks) {
      if (left >= b.live) {
        left -= b.live;
        continue;
      }
      for (final e in b.items) {
        if (e.dead) continue;
        if (left == 0) return e;
        left--;
      }
    }
    throw RangeError('index $index out of range');
  }

  Iterable<Elem<T>> live() sync* {
    for (final b in _blocks) {
      for (final e in b.items) {
        if (!e.dead) yield e;
      }
    }
  }

  List<Elem<T>> slice(int from, int n) {
    final out = <Elem<T>>[];
    if (n <= 0) return out;
    var skip = from;
    for (final b in _blocks) {
      if (skip >= b.live) {
        skip -= b.live;
        continue;
      }
      for (final e in b.items) {
        if (e.dead) continue;
        if (skip > 0) {
          skip--;
          continue;
        }
        out.add(e);
        if (out.length == n) return out;
      }
    }
    return out;
  }
}
