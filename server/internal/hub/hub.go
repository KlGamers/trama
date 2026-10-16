package hub

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/KlGamers/trama/server/internal/auth"
	"github.com/KlGamers/trama/server/internal/change"
	"github.com/KlGamers/trama/server/internal/proto"
	"github.com/KlGamers/trama/server/internal/store"
)

var docName = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)

type Hub struct {
	st     *store.Store
	sig    *auth.Signer
	log    *slog.Logger
	MaxMsg int64
	mu     sync.Mutex
	rooms  map[string]*room
	hello  time.Duration
}

type room struct {
	mu    sync.Mutex
	conns map[*peer]struct{}
}

type peer struct {
	out    chan []byte
	cancel context.CancelFunc
}

func New(st *store.Store, sig *auth.Signer, log *slog.Logger) *Hub {
	return &Hub{st: st, sig: sig, log: log, MaxMsg: 8 << 20, rooms: map[string]*room{}, hello: 10 * time.Second}
}

func (h *Hub) room(doc string) *room {
	h.mu.Lock()
	defer h.mu.Unlock()
	r, ok := h.rooms[doc]
	if !ok {
		r = &room{conns: map[*peer]struct{}{}}
		h.rooms[doc] = r
	}
	return r
}

func (h *Hub) leave(doc string, p *peer) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if r, ok := h.rooms[doc]; ok {
		r.mu.Lock()
		delete(r.conns, p)
		empty := len(r.conns) == 0
		r.mu.Unlock()
		if empty {
			delete(h.rooms, doc)
		}
	}
}

func (h *Hub) Peers(doc string) int {
	h.mu.Lock()
	r, ok := h.rooms[doc]
	h.mu.Unlock()
	if !ok {
		return 0
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.conns)
}

func send(ctx context.Context, c *websocket.Conn, m proto.Msg) error {
	wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return c.Write(wctx, websocket.MessageBinary, proto.Encode(m))
}

func fail(ctx context.Context, c *websocket.Conn, code byte, text string) {
	send(ctx, c, proto.Msg{Type: proto.Error, Code: code, Text: text})
	c.Close(websocket.StatusPolicyViolation, text)
}

func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	c.SetReadLimit(h.MaxMsg)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	defer c.CloseNow()

	hctx, hcancel := context.WithTimeout(ctx, h.hello)
	typ, raw, err := c.Read(hctx)
	hcancel()
	if err != nil {
		return
	}
	m, err := proto.Decode(raw)
	if typ != websocket.MessageBinary || err != nil || m.Type != proto.Hello {
		fail(ctx, c, proto.CodeBadRequest, "first message must be hello")
		return
	}
	if !docName.MatchString(m.Doc) {
		fail(ctx, c, proto.CodeBadRequest, "invalid document name")
		return
	}
	claims, err := h.sig.Check(m.Token, m.Doc, time.Now())
	if err != nil {
		fail(ctx, c, proto.CodeUnauthorized, err.Error())
		return
	}

	rm := h.room(m.Doc)
	p := &peer{out: make(chan []byte, 256), cancel: cancel}
	rm.mu.Lock()
	vv, err := h.st.Version(ctx, m.Doc)
	var missing [][]byte
	if err == nil {
		missing, err = h.st.Since(ctx, m.Doc, m.VV)
	}
	if err == nil {
		rm.conns[p] = struct{}{}
	}
	rm.mu.Unlock()
	if err != nil {
		fail(ctx, c, proto.CodeInternal, "storage error")
		return
	}
	defer h.leave(m.Doc, p)
	if send(ctx, c, proto.Msg{Type: proto.Welcome, Write: claims.Write, VV: vv}) != nil {
		return
	}
	if len(missing) > 0 && send(ctx, c, proto.Msg{Type: proto.Changes, Blobs: missing}) != nil {
		return
	}
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case b := <-p.out:
				wctx, wc := context.WithTimeout(ctx, 10*time.Second)
				err := c.Write(wctx, websocket.MessageBinary, b)
				wc()
				if err != nil {
					cancel()
					return
				}
			}
		}
	}()
	h.log.Info("joined", "doc", m.Doc, "write", claims.Write)

	for {
		typ, raw, err := c.Read(ctx)
		if err != nil {
			var ce websocket.CloseError
			if errors.As(err, &ce) || ctx.Err() != nil {
				return
			}
			if websocket.CloseStatus(err) == websocket.StatusMessageTooBig {
				return
			}
			return
		}
		msg, err := proto.Decode(raw)
		if typ != websocket.MessageBinary || err != nil || msg.Type != proto.Changes {
			fail(ctx, c, proto.CodeBadRequest, "expected changes")
			return
		}
		if !claims.Write {
			fail(ctx, c, proto.CodeForbidden, "token is read-only")
			return
		}
		if code, text := h.accept(ctx, m.Doc, rm, p, msg.Blobs); code != 0 {
			fail(ctx, c, code, text)
			return
		}
	}
}

func (h *Hub) accept(ctx context.Context, doc string, rm *room, from *peer, blobs [][]byte) (byte, string) {
	hdrs := make([]*change.Header, len(blobs))
	for i, b := range blobs {
		hd, err := change.Parse(b)
		if err != nil {
			return proto.CodeBadRequest, err.Error()
		}
		hdrs[i] = hd
	}
	rm.mu.Lock()
	defer rm.mu.Unlock()
	var fresh [][]byte
	for i, b := range blobs {
		ok, err := h.st.Add(ctx, doc, hdrs[i], b)
		if errors.Is(err, store.ErrGap) {
			return proto.CodeConflict, err.Error()
		}
		if err != nil {
			h.log.Error("store", "doc", doc, "err", err)
			return proto.CodeInternal, "storage error"
		}
		if ok {
			fresh = append(fresh, append([]byte(nil), b...))
		}
	}
	if vv, err := h.st.Version(ctx, doc); err == nil {
		select {
		case from.out <- proto.Encode(proto.Msg{Type: proto.Welcome, Write: true, VV: vv}):
		default:
			from.cancel()
		}
	}
	if len(fresh) == 0 {
		return 0, ""
	}
	frame := proto.Encode(proto.Msg{Type: proto.Changes, Blobs: fresh})
	for p := range rm.conns {
		if p == from {
			continue
		}
		select {
		case p.out <- frame:
		default:
			p.cancel()
		}
	}
	return 0, ""
}
