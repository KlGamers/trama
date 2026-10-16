import 'dart:convert';
import 'dart:typed_data';

class CodecError implements Exception {
  CodecError(this.message);
  final String message;
  @override
  String toString() => 'CodecError: $message';
}

const maxSafe = 9007199254740991;

class Writer {
  final BytesBuilder _b = BytesBuilder(copy: false);

  void u8(int v) => _b.addByte(v & 0xff);

  void uint(int v) {
    if (v < 0 || v > maxSafe) throw RangeError('not a uint: $v');
    while (v >= 0x80) {
      _b.addByte((v % 0x80) | 0x80);
      v = v ~/ 0x80;
    }
    _b.addByte(v);
  }

  void int_(int v) {
    if (v.abs() > maxSafe) throw RangeError('not an int: $v');
    uint(v >= 0 ? v * 2 : -v * 2 - 1);
  }

  void f64(double v) {
    final bd = ByteData(8)..setFloat64(0, v, Endian.little);
    _b.add(bd.buffer.asUint8List());
  }

  void raw(List<int> b) => _b.add(b);

  void bytes(List<int> b) {
    uint(b.length);
    raw(b);
  }

  void str(String s) => bytes(utf8.encode(s));

  Uint8List done() => _b.toBytes();
}

class Reader {
  Reader(this._buf);
  final Uint8List _buf;
  int pos = 0;

  int get left => _buf.length - pos;

  int u8() {
    if (pos >= _buf.length) throw CodecError('unexpected end of input');
    return _buf[pos++];
  }

  int uint() {
    var out = 0;
    var mul = 1;
    for (var i = 0; i < 8; i++) {
      final b = u8();
      out += (b & 0x7f) * mul;
      if (b < 0x80) {
        if (out > maxSafe) throw CodecError('varint too large');
        return out;
      }
      mul *= 0x80;
    }
    throw CodecError('varint too long');
  }

  int int_() {
    final v = uint();
    return v.isEven ? v ~/ 2 : -((v + 1) ~/ 2);
  }

  double f64() {
    if (left < 8) throw CodecError('unexpected end of input');
    final v = ByteData.sublistView(_buf, pos, pos + 8).getFloat64(0, Endian.little);
    pos += 8;
    return v;
  }

  Uint8List raw(int n) {
    if (n > left) throw CodecError('unexpected end of input');
    final out = Uint8List.sublistView(_buf, pos, pos + n);
    pos += n;
    return out;
  }

  Uint8List bytes() => raw(uint());

  String str() {
    try {
      return utf8.decode(bytes());
    } on FormatException {
      throw CodecError('invalid utf-8');
    }
  }

  void end() {
    if (left != 0) throw CodecError('trailing bytes');
  }
}

String hex(List<int> b) => b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

final _hexRe = RegExp(r'^(?:[0-9a-f]{2})*$');

Uint8List unhex(String s) {
  if (!_hexRe.hasMatch(s)) throw CodecError('bad hex: $s');
  final out = Uint8List(s.length ~/ 2);
  for (var i = 0; i < out.length; i++) {
    out[i] = int.parse(s.substring(i * 2, i * 2 + 2), radix: 16);
  }
  return out;
}
