import 'dart:typed_data';

import 'package:test/test.dart';
import 'package:trama/trama.dart';

final a = 'a' * 32;
final b = 'b' * 32;
final c = 'c' * 32;

void sync(List<Doc> docs) {
  for (final x in docs) {
    for (final y in docs) {
      if (!identical(x, y)) y.apply(x.changes(y.version()));
    }
  }
}

void main() {
  group('maps', () {
    test('set, get, delete and nested objects', () {
      final d = Doc(actor: a);
      d.change((r) {
        r.set('title', 'Hola');
        r.set('n', 3);
        r.set('pi', 3.25);
        r.set('ok', true);
        r.set('none', null);
        r.map('meta').set('lang', 'es');
        r.delete('none');
      });
      expect(d.toJson(), {'meta': {'lang': 'es'}, 'n': 3, 'ok': true, 'pi': 3.25, 'title': 'Hola'});
      expect(d.root.keys(), ['meta', 'n', 'ok', 'pi', 'title']);
    });

    test('concurrent writes: highest op id wins', () {
      final x = Doc(actor: a), y = Doc(actor: b);
      x.change((r) => r.set('k', 'x'));
      y.change((r) => r.set('k', 'y'));
      sync([x, y]);
      expect(x.toJson(), {'k': 'y'});
      expect(y.toJson(), {'k': 'y'});
    });

    test('rejects unsupported values and mutations outside change', () {
      final d = Doc(actor: a);
      expect(() => d.change((r) => r.set('x', double.nan)), throwsArgumentError);
      expect(() => d.root.set('x', 1), throwsStateError);
    });
  });

  group('lists and text', () {
    test('list operations', () {
      final d = Doc(actor: a);
      d.change((r) {
        final l = r.list('items');
        l.push('b');
        l.insert(0, 'a');
        l.push('c');
        l.insertMap(3).set('done', false);
        l.delete(1);
      });
      expect(d.toJson(), {
        'items': ['a', 'c', {'done': false}]
      });
    });

    test('text with emoji counts code points', () {
      final d = Doc(actor: a);
      d.change((r) => r.text('t').insert(0, 'hola 👋 mundo'));
      expect((d.root.get('t') as TextRef).length, 12);
      d.change((r) => r.text('t').delete(5, 2));
      expect(d.toJson(), {'t': 'hola mundo'});
    });

    test('concurrent typing at the same spot', () {
      final x = Doc(actor: a), y = Doc(actor: b);
      x.change((r) => r.text('t').insert(0, 'ac'));
      sync([x, y]);
      x.change((r) => r.text('t').insert(1, 'XX'));
      y.change((r) => r.text('t').insert(1, 'yy'));
      sync([x, y]);
      expect(x.toJson(), y.toJson());
      expect((x.toJson() as Map)['t'], matches(RegExp(r'^a(XXyy|yyXX)c$')));
    });

    test('delete races with typing', () {
      final x = Doc(actor: a), y = Doc(actor: b);
      x.change((r) => r.text('t').insert(0, 'hola mundo'));
      sync([x, y]);
      x.change((r) => r.text('t').delete(0, 5));
      y.change((r) => r.text('t').insert(5, 'gran '));
      sync([x, y]);
      expect(x.toJson(), {'t': 'gran mundo'});
      expect(y.toJson(), {'t': 'gran mundo'});
    });

    test('long documents split into blocks', () {
      final d = Doc(actor: a);
      final words = <String>[];
      d.change((r) {
        final t = r.text('t');
        for (var i = 0; i < 3000; i++) {
          final w = 'w$i ';
          if (i % 7 == 0) {
            t.insert(0, w);
            words.insert(0, w);
          } else {
            t.insert(t.length, w);
            words.add(w);
          }
        }
      });
      expect(d.toJson(), {'t': words.join()});
      expect(Doc.load(d.save()).toJson(), d.toJson());
    });
  });

  test('counters add concurrent increments', () {
    final docs = [Doc(actor: a), Doc(actor: b), Doc(actor: c)];
    docs[0].change((r) => r.counter('likes').increment(0));
    sync(docs);
    for (var i = 0; i < docs.length; i++) {
      docs[i].change((r) => r.counter('likes').increment(i + 1));
    }
    docs[1].change((r) => r.counter('likes').increment(-1));
    sync(docs);
    for (final d in docs) {
      expect(d.toJson(), {'likes': 5});
    }
  });

  group('history', () {
    test('out of order changes wait for dependencies', () {
      final x = Doc(actor: a);
      final c1 = x.change((r) => r.text('t').insert(0, 'uno '))!;
      final c2 = x.change((r) => r.text('t').insert(4, 'dos '))!;
      final c3 = x.change((r) => r.set('fin', true))!;
      final y = Doc(actor: b);
      y.apply([c3, c2]);
      expect(y.toJson(), <String, Object?>{});
      expect(y.missing, 2);
      y.apply([c1, c1, c2]);
      expect(y.missing, 0);
      expect(y.toJson(), x.toJson());
    });

    test('save, load and subscribers', () {
      final x = Doc(actor: a);
      final seen = <String>[];
      x.subscribe((chs, local) => seen.add('${local ? 'local' : 'remote'}:${chs.length}'));
      x.change((r) => r.list('l').push(1));
      final y = Doc.load(x.save(), actor: b);
      expect(y.toJson(), x.toJson());
      expect(y.version(), x.version());
      expect(seen, ['local:1']);
      expect(() => Doc.load(Uint8List.fromList([1, 2, 3])), throwsA(isA<CodecError>()));
    });
  });

  test('binary round trip and malformed input', () {
    final x = Doc(actor: a), y = Doc(actor: b);
    y.change((r) => r.list('l').push('from b'));
    x.apply(y.changes());
    final blob = x.change((r) {
      r.set('s', 'é');
      r.set('i', -42);
      r.set('f', 1.5);
      r.set('whole', 3.0);
      r.map('m');
      r.delete('s');
      final l = r.list('l');
      l.insert(0, true);
      l.insertText(1).insert(0, 'ñ👍');
      l.delete(0);
      r.counter('c').increment(-3);
    })!;
    final ch = decodeChange(blob);
    expect(ch.deps[b], 1);
    expect(encodeChange(ch), blob);
    expect(() => decodeChange(Uint8List.sublistView(blob, 0, blob.length - 1)), throwsA(isA<CodecError>()));
    expect(() => Doc(actor: 'nope'), throwsArgumentError);
  });
}
