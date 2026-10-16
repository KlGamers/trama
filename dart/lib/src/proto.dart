import 'dart:typed_data';

import 'codec.dart';

const msgHello = 1;
const msgChanges = 2;
const msgWelcome = 3;
const msgError = 4;

class Msg {
  Msg.hello(this.doc, this.token, this.vv)
      : type = msgHello,
        blobs = const [],
        write = false,
        code = 0,
        text = '';
  Msg.changes(this.blobs)
      : type = msgChanges,
        doc = '',
        token = '',
        vv = const {},
        write = false,
        code = 0,
        text = '';
  Msg.welcome(this.write, this.vv)
      : type = msgWelcome,
        doc = '',
        token = '',
        blobs = const [],
        code = 0,
        text = '';
  Msg.error(this.code, this.text)
      : type = msgError,
        doc = '',
        token = '',
        vv = const {},
        blobs = const [],
        write = false;

  final int type;
  final String doc;
  final String token;
  final Map<String, int> vv;
  final List<Uint8List> blobs;
  final bool write;
  final int code;
  final String text;
}

void _putVV(Writer w, Map<String, int> vv) {
  w.uint(vv.length);
  vv.forEach((a, s) {
    w.raw(unhex(a));
    w.uint(s);
  });
}

Map<String, int> _getVV(Reader r) {
  final n = r.uint();
  if (n > r.left) throw CodecError('bad version vector');
  return {for (var i = 0; i < n; i++) hex(r.raw(16)): r.uint()};
}

Uint8List encodeMsg(Msg m) {
  final w = Writer()..u8(m.type);
  switch (m.type) {
    case msgHello:
      w
        ..u8(1)
        ..str(m.doc)
        ..str(m.token);
      _putVV(w, m.vv);
    case msgChanges:
      w.uint(m.blobs.length);
      for (final b in m.blobs) {
        w.bytes(b);
      }
    case msgWelcome:
      w.u8(m.write ? 1 : 0);
      _putVV(w, m.vv);
    case msgError:
      w
        ..u8(m.code)
        ..str(m.text);
  }
  return w.done();
}

Msg decodeMsg(Uint8List buf) {
  final r = Reader(buf);
  final t = r.u8();
  final Msg m;
  switch (t) {
    case msgHello:
      if (r.u8() != 1) throw CodecError('unsupported protocol version');
      m = Msg.hello(r.str(), r.str(), _getVV(r));
    case msgChanges:
      final n = r.uint();
      if (n > r.left) throw CodecError('bad change count');
      m = Msg.changes([for (var i = 0; i < n; i++) Uint8List.fromList(r.bytes())]);
    case msgWelcome:
      m = Msg.welcome(r.u8() == 1, _getVV(r));
    case msgError:
      m = Msg.error(r.u8(), r.str());
    default:
      throw CodecError('unknown message type $t');
  }
  r.end();
  return m;
}
