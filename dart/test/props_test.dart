import 'dart:convert';
import 'dart:math';

import 'package:test/test.dart';
import 'package:trama/trama.dart';

String _str(Random rnd, int max) {
  const pool = ['a', 'b', 'ñ', 'é', '👋', '数', ' ', 'z'];
  return List.generate(1 + rnd.nextInt(max), (_) => pool[rnd.nextInt(pool.length)]).join();
}

void main() {
  test('sequential edits match a plain model on two replicas', () {
    for (var seed = 0; seed < 300; seed++) {
      final rnd = Random(seed);
      final d = Doc(actor: 'a' * 32), mirror = Doc(actor: 'b' * 32);
      mirror.apply([
        d.change((r) {
          r.text('t');
          r.list('l');
          r.counter('n');
        })!
      ]);
      final map = <String, Object?>{};
      var text = <String>[];
      final list = <int>[];
      var n = 0;
      for (var b = 0; b < 30; b++) {
        final blob = d.change((r) {
          for (var k = 0; k <= rnd.nextInt(4); k++) {
            switch (rnd.nextInt(7)) {
              case 0:
                final key = 'k${rnd.nextInt(4)}';
                final v = [null, true, rnd.nextInt(100), 'v${rnd.nextInt(9)}', 2.5][rnd.nextInt(5)];
                r.set(key, v);
                map[key] = v;
              case 1:
                final key = 'k${rnd.nextInt(4)}';
                r.delete(key);
                map.remove(key);
              case 2:
                final at = rnd.nextInt(text.length + 1);
                final s = _str(rnd, 6);
                r.text('t').insert(at, s);
                text = [...text.sublist(0, at), ...s.runes.map(String.fromCharCode), ...text.sublist(at)];
              case 3:
                if (text.isEmpty) break;
                final at = rnd.nextInt(text.length);
                final cnt = min(1 + rnd.nextInt(5), text.length - at);
                r.text('t').delete(at, cnt);
                text.removeRange(at, at + cnt);
              case 4:
                final at = rnd.nextInt(list.length + 1);
                final v = rnd.nextInt(1000);
                r.list('l').insert(at, v);
                list.insert(at, v);
              case 5:
                if (list.isEmpty) break;
                final at = rnd.nextInt(list.length);
                final cnt = min(1 + rnd.nextInt(3), list.length - at);
                r.list('l').delete(at, cnt);
                list.removeRange(at, at + cnt);
              case 6:
                final by = rnd.nextInt(19) - 9;
                r.counter('n').increment(by);
                n += by;
            }
          }
        });
        if (blob != null) mirror.apply([blob]);
      }
      final want = {...map, 'l': list, 'n': n, 't': text.join()};
      final sorted = {for (final k in want.keys.toList()..sort()) k: want[k]};
      expect(d.toJson(), sorted, reason: 'seed $seed');
      expect(mirror.toJson(), sorted, reason: 'seed $seed');
    }
  });

  test('replicas converge regardless of delivery order and duplicates', () {
    for (var seed = 0; seed < 300; seed++) {
      final rnd = Random(seed);
      final n = 2 + rnd.nextInt(3);
      final docs = [for (var i = 0; i < n; i++) Doc(actor: '${i + 1}' * 32)];
      for (var s = 0; s < 60; s++) {
        final who = docs[rnd.nextInt(n)];
        if (rnd.nextInt(5) == 0) {
          final to = docs[rnd.nextInt(n)];
          if (identical(to, who)) continue;
          var blobs = who.changes(to.version());
          if (rnd.nextBool()) blobs = blobs.reversed.toList();
          if (rnd.nextBool()) blobs = [...blobs, ...blobs];
          to.apply(blobs);
          continue;
        }
        who.change((r) {
          switch (rnd.nextInt(6)) {
            case 0:
              r.set('k${rnd.nextInt(3)}', rnd.nextInt(50));
            case 1:
              r.delete('k${rnd.nextInt(3)}');
            case 2:
              final t = r.text('t');
              t.insert(rnd.nextInt(t.length + 1), _str(rnd, 5));
            case 3:
              final t = r.text('t');
              if (t.length > 0) {
                final at = rnd.nextInt(t.length);
                t.delete(at, min(1 + rnd.nextInt(3), t.length - at));
              }
            case 4:
              final l = r.list('l');
              l.insert(rnd.nextInt(l.length + 1), rnd.nextInt(9));
            case 5:
              r.counter('c').increment(rnd.nextInt(7) - 3);
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
      final all = [for (final d in docs) ...d.changes()]..shuffle(rnd);
      final late = Doc(actor: 'f' * 32)..apply(all);
      final want = jsonEncode(docs.first.toJson());
      for (final d in [...docs, late]) {
        expect(d.missing, 0, reason: 'seed $seed');
        expect(jsonEncode(d.toJson()), want, reason: 'seed $seed');
      }
    }
  });
}
