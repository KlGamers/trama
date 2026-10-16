import 'dart:async';
import 'dart:typed_data';

import 'package:web_socket_channel/web_socket_channel.dart';

import 'doc.dart';
import 'proto.dart';

enum Status { idle, connecting, syncing, synced, offline }

class SyncError implements Exception {
  SyncError(this.code, this.message);
  final int code;
  final String message;
  @override
  String toString() => 'SyncError($code): $message';
}

typedef Connector = WebSocketChannel Function(Uri uri);

class SyncClient {
  SyncClient(this.doc, {required this.url, required this.docName, this.token = '', Connector? connect, this.minDelay = const Duration(milliseconds: 250), this.maxDelay = const Duration(seconds: 10)})
      : _connect = connect ?? WebSocketChannel.connect,
        _delay = minDelay;

  final Doc doc;
  final Uri url;
  final String docName;
  final String token;
  final Duration minDelay;
  final Duration maxDelay;
  final Connector _connect;

  Duration _delay;
  WebSocketChannel? _ch;
  StreamSubscription<dynamic>? _sub;
  void Function()? _unsub;
  Timer? _timer;
  bool _stopped = true;
  bool _write = false;
  Map<String, int> _server = {};
  Map<String, int> _sent = {};
  final List<Completer<void>> _waiters = [];
  final StreamController<Status> _status = StreamController.broadcast();

  Status status = Status.idle;
  SyncError? lastError;

  Stream<Status> get statuses => _status.stream;

  void _set(Status s) {
    status = s;
    _status.add(s);
    if (s == Status.synced) _flush();
  }

  void start() {
    if (!_stopped) return;
    _stopped = false;
    _unsub = doc.subscribe((_, local) {
      if (local) _push();
    });
    _open();
  }

  Future<void> stop() async {
    _stopped = true;
    _unsub?.call();
    _unsub = null;
    _timer?.cancel();
    await _sub?.cancel();
    await _ch?.sink.close();
    _ch = null;
    _set(Status.idle);
  }

  Future<void> whenSynced() {
    if (_covered()) return Future.value();
    final c = Completer<void>();
    _waiters.add(c);
    return c.future;
  }

  bool _covered() {
    if (status != Status.synced || doc.missing > 0) return false;
    for (final e in doc.version().entries) {
      if ((_server[e.key] ?? 0) < e.value) return false;
    }
    return true;
  }

  void _flush() {
    if (!_covered()) return;
    final ws = List.of(_waiters);
    _waiters.clear();
    for (final c in ws) {
      c.complete();
    }
  }

  void _open() {
    if (_stopped) return;
    _set(Status.connecting);
    final ch = _connect(url);
    _ch = ch;
    ch.ready.then((_) {
      if (!identical(_ch, ch)) return;
      _set(Status.syncing);
      ch.sink.add(encodeMsg(Msg.hello(docName, token, doc.version())));
    }, onError: (_) {});
    _sub = ch.stream.listen(
      (data) {
        final bytes = data is Uint8List ? data : Uint8List.fromList((data as List).cast<int>());
        final Msg m;
        try {
          m = decodeMsg(bytes);
        } catch (_) {
          ch.sink.close();
          return;
        }
        _handle(m);
      },
      onDone: () => _closed(ch),
      onError: (_) => _closed(ch),
      cancelOnError: true,
    );
  }

  void _closed(WebSocketChannel ch) {
    if (!identical(_ch, ch)) return;
    _ch = null;
    if (_stopped) return;
    _set(Status.offline);
    _timer = Timer(_delay, _open);
    final next = _delay * 2;
    _delay = next > maxDelay ? maxDelay : next;
  }

  void _handle(Msg m) {
    switch (m.type) {
      case msgWelcome:
        final first = status != Status.synced;
        _server = Map.of(m.vv);
        if (first) _sent = Map.of(m.vv);
        _write = m.write;
        _delay = minDelay;
        if (first) _push();
        _set(Status.synced);
      case msgChanges:
        doc.apply(m.blobs);
        for (final e in doc.version().entries) {
          if (e.key != doc.actor && (_server[e.key] ?? 0) < e.value) _server[e.key] = e.value;
        }
        _flush();
      case msgError:
        final err = SyncError(m.code, m.text);
        lastError = err;
        if (m.code >= 1 && m.code <= 3) {
          _stopped = true;
          _unsub?.call();
          _set(Status.idle);
          for (final c in _waiters) {
            c.completeError(err);
          }
          _waiters.clear();
        }
    }
  }

  void _push() {
    final ch = _ch;
    if (ch == null || !_write || status == Status.connecting) return;
    final blobs = doc.changes(_sent);
    if (blobs.isEmpty) return;
    ch.sink.add(encodeMsg(Msg.changes(blobs)));
    for (final e in doc.version().entries) {
      if ((_sent[e.key] ?? 0) < e.value) _sent[e.key] = e.value;
    }
  }
}
