import 'dart:convert';
import 'dart:io';

import 'package:trama/trama.dart';

Future<void> main(List<String> args) async {
  final url = Uri.parse(args[0]);
  final name = args[1];
  final out = File(args[2]);
  final mode = args.length > 3 ? args[3] : 'edit';
  final doc = Doc();
  if (mode == 'edit') {
    doc.change((r) {
      r.text('t').insert(0, 'Dart: ');
      r.list('l').push('b');
      r.counter('c').increment(5);
      r.set('desde_dart', true);
      r.map('meta').set('autor', 'dart 🎯');
    });
  }
  final client = SyncClient(doc, url: url, docName: name);
  client.start();
  await client.whenSynced().timeout(const Duration(seconds: 15));
  await Future<void>.delayed(const Duration(milliseconds: 300));
  out.writeAsStringSync(jsonEncode(doc.toJson()));
  await client.stop();
  exit(0);
}
