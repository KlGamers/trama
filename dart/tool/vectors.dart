import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:trama/trama.dart';

const pool = ['a', 'b', 'ñ', 'é', '👋', '数', ' ', '\u{1F1F2}\u{1F1FD}', 'z', '\n'];

Object? val(Random r) => [null, true, false, r.nextInt(2000) - 1000, (r.nextDouble() - 0.5) * 1e6, 'v${r.nextInt(9)}', '', 3.0, -0.25][r.nextInt(9)];

Map<String, Object?> scenario(int seed) {
  final r = Random(seed);
  final n = 2 + r.nextInt(3);
  final docs = [for (var i = 0; i < n; i++) Doc(actor: (i + 1).toRadixString(16) * 32)];
  for (var s = 0; s < 80; s++) {
    final d = docs[r.nextInt(n)];
    if (r.nextInt(5) == 0) {
      final to = docs[r.nextInt(n)];
      if (!identical(to, d)) to.apply(d.changes(to.version()));
      continue;
    }
    d.change((root) {
      switch (r.nextInt(9)) {
        case 0:
          root.set('k${r.nextInt(3)}', val(r));
        case 1:
          root.delete('k${r.nextInt(3)}');
        case 2:
          final t = root.text('t');
          final s2 = List.generate(1 + r.nextInt(6), (_) => pool[r.nextInt(pool.length)]).join();
          t.insert(r.nextInt(t.length + 1), s2);
        case 3:
          final t = root.text('t');
          if (t.length > 0) {
            final at = r.nextInt(t.length);
            t.delete(at, min(1 + r.nextInt(4), t.length - at));
          }
        case 4:
          final l = root.list('l');
          l.insert(r.nextInt(l.length + 1), val(r));
        case 5:
          final l = root.list('l');
          if (l.length > 0) l.delete(r.nextInt(l.length));
        case 6:
          root.counter('c').increment(r.nextInt(21) - 10);
        case 7:
          root.map('m').map('deep').set('x${r.nextInt(2)}', val(r));
        case 8:
          final l = root.list('objs');
          l.insertMap(r.nextInt(l.length + 1)).set('id', r.nextInt(100));
      }
    });
  }
  for (var round = 0; round < 2; round++) {
    for (final x in docs) {
      for (final y in docs) {
        if (!identical(x, y)) y.apply(x.changes(y.version()));
      }
    }
  }
  final blobs = [for (final b in docs.first.changes()) b.map((x) => x.toRadixString(16).padLeft(2, '0')).join()]..shuffle(r);
  return {'seed': seed, 'blobs': blobs, 'expect': docs.first.toJson()};
}

void main() {
  final out = {'generator': 'dart', 'scenarios': [for (var i = 1; i <= 60; i++) scenario(i)]};
  File('../conformance/dart.json').writeAsStringSync(const JsonEncoder.withIndent(' ').convert(out));
  final n = (out['scenarios'] as List).fold<int>(0, (a, s) => a + ((s as Map)['blobs'] as List).length);
  stdout.writeln('wrote 60 scenarios, $n changes');
}
