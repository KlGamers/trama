import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:test/test.dart';
import 'package:trama/trama.dart';

Uint8List unhex(String h) => Uint8List.fromList([for (var i = 0; i < h.length; i += 2) int.parse(h.substring(i, i + 2), radix: 16)]);

String hexOf(List<int> b) => b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

void main() {
  final data = jsonDecode(File('../conformance/typescript.json').readAsStringSync()) as Map<String, Object?>;
  group('changes produced by the TypeScript implementation', () {
    for (final s in (data['scenarios'] as List).cast<Map<String, Object?>>()) {
      test('scenario ${s['seed']}', () {
        final blobs = [for (final h in (s['blobs'] as List).cast<String>()) unhex(h)];
        for (final b in blobs) {
          expect(hexOf(encodeChange(decodeChange(b))), hexOf(b));
        }
        final d = Doc(actor: 'e' * 32)..apply(blobs);
        expect(d.missing, 0);
        expect(d.toJson(), s['expect']);
      });
    }
  });
}
