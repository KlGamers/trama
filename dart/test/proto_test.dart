import 'dart:typed_data';

import 'package:test/test.dart';
import 'package:trama/trama.dart';

void main() {
  test('protocol round trip', () {
    final vv = {'0123456789abcdef0123456789abcdef': 7};
    final h = decodeMsg(encodeMsg(Msg.hello('notas', 'a.b', vv)));
    expect([h.doc, h.token, h.vv], ['notas', 'a.b', vv]);
    final c = decodeMsg(encodeMsg(Msg.changes([
      Uint8List.fromList([1, 2]),
      Uint8List(0)
    ])));
    expect(c.blobs.map((b) => b.length), [2, 0]);
    final w = decodeMsg(encodeMsg(Msg.welcome(true, vv)));
    expect([w.write, w.vv], [true, vv]);
    final e = decodeMsg(encodeMsg(Msg.error(4, 'falta')));
    expect([e.code, e.text], [4, 'falta']);
    for (final b in [
      <int>[],
      [9],
      [1, 2],
      [2, 5]
    ]) {
      expect(() => decodeMsg(Uint8List.fromList(b)), throwsA(isA<CodecError>()));
    }
  });
}
