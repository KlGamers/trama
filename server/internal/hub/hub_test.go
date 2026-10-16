package hub

import (
	"context"
	"io"
	"log/slog"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/KlGamers/trama/server/internal/auth"
	"github.com/KlGamers/trama/server/internal/proto"
	"github.com/KlGamers/trama/server/internal/store"
	"github.com/KlGamers/trama/server/internal/testdata"
)

type env struct {
	url string
	hub *Hub
	sig *auth.Signer
}

func setup(t *testing.T, secret string) *env {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	sig := auth.New(secret)
	h := New(st, sig, slog.New(slog.NewTextHandler(io.Discard, nil)))
	h.hello = 500 * time.Millisecond
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return &env{url: "ws" + strings.TrimPrefix(srv.URL, "http"), hub: h, sig: sig}
}

type client struct {
	t *testing.T
	c *websocket.Conn
}

func (e *env) dial(t *testing.T) *client {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, e.url, nil)
	if err != nil {
		t.Fatal(err)
	}
	c.SetReadLimit(64 << 20)
	t.Cleanup(func() { c.CloseNow() })
	return &client{t: t, c: c}
}

func (c *client) send(m proto.Msg) {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.c.Write(ctx, websocket.MessageBinary, proto.Encode(m)); err != nil {
		c.t.Fatal(err)
	}
}

func (c *client) recv() proto.Msg {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, raw, err := c.c.Read(ctx)
	if err != nil {
		c.t.Fatal(err)
	}
	m, err := proto.Decode(raw)
	if err != nil {
		c.t.Fatal(err)
	}
	return m
}

func (c *client) hello(doc, tok string, vv map[string]uint64) proto.Msg {
	c.send(proto.Msg{Type: proto.Hello, Doc: doc, Token: tok, VV: vv})
	return c.recv()
}

func scenario(t *testing.T) [][]byte {
	sc, err := testdata.Load("typescript.json")
	if err != nil {
		t.Fatal(err)
	}
	bs, _ := testdata.Causal(sc[2])
	return bs
}

func TestRelayAndHistory(t *testing.T) {
	e := setup(t, "")
	bs := scenario(t)
	a, b := e.dial(t), e.dial(t)
	if w := a.hello("doc", "", nil); w.Type != proto.Welcome || !w.Write || len(w.VV) != 0 {
		t.Fatalf("welcome %+v", w)
	}
	b.hello("doc", "", nil)
	half := len(bs) / 2
	a.send(proto.Msg{Type: proto.Changes, Blobs: bs[:half]})
	if ack := a.recv(); ack.Type != proto.Welcome || len(ack.VV) == 0 {
		t.Fatalf("ack %+v", ack)
	}
	got := b.recv()
	if got.Type != proto.Changes || len(got.Blobs) != half {
		t.Fatalf("relay %d of %d", len(got.Blobs), half)
	}
	a.send(proto.Msg{Type: proto.Changes, Blobs: bs})
	total := uint64(0)
	for _, s := range a.recv().VV {
		total += s
	}
	if total != uint64(len(bs)) {
		t.Fatalf("ack covers %d of %d", total, len(bs))
	}
	if got := b.recv(); len(got.Blobs) != len(bs)-half {
		t.Fatalf("only new changes should be relayed, got %d", len(got.Blobs))
	}
	late := e.dial(t)
	w := late.hello("doc", "", nil)
	hist := late.recv()
	if len(hist.Blobs) != len(bs) || len(w.VV) == 0 {
		t.Fatalf("late joiner got %d", len(hist.Blobs))
	}
	again := e.dial(t)
	again.hello("doc", "", w.VV)
	again.send(proto.Msg{Type: proto.Changes, Blobs: bs[:1]})
	time.Sleep(50 * time.Millisecond)
	if n := e.hub.Peers("doc"); n != 4 {
		t.Fatalf("peers %d", n)
	}
}

func TestAuthAndErrors(t *testing.T) {
	e := setup(t, "secreto")
	bs := scenario(t)
	exp := time.Now().Add(time.Hour).Unix()
	rw := e.sig.Mint(auth.Claims{Doc: "doc", Exp: exp, Write: true})
	ro := e.sig.Mint(auth.Claims{Doc: "doc", Exp: exp})

	if m := e.dial(t).hello("doc", "nope", nil); m.Type != proto.Error || m.Code != proto.CodeUnauthorized {
		t.Fatalf("%+v", m)
	}
	if m := e.dial(t).hello("otro", rw, nil); m.Code != proto.CodeUnauthorized {
		t.Fatalf("%+v", m)
	}
	if m := e.dial(t).hello("bad name!", rw, nil); m.Code != proto.CodeBadRequest {
		t.Fatalf("%+v", m)
	}
	r := e.dial(t)
	if w := r.hello("doc", ro, nil); w.Write {
		t.Fatal("read-only token reported writable")
	}
	r.send(proto.Msg{Type: proto.Changes, Blobs: bs[:1]})
	if m := r.recv(); m.Code != proto.CodeForbidden {
		t.Fatalf("%+v", m)
	}
	g := e.dial(t)
	g.hello("doc", rw, nil)
	g.send(proto.Msg{Type: proto.Changes, Blobs: [][]byte{{0x54, 1, 0}}})
	if m := g.recv(); m.Code != proto.CodeBadRequest {
		t.Fatalf("%+v", m)
	}
	gap := e.dial(t)
	gap.hello("doc", rw, nil)
	var second [][]byte
	for i, b := range bs {
		if i > 0 {
			second = append(second, b)
		}
	}
	gap.send(proto.Msg{Type: proto.Changes, Blobs: second})
	if m := gap.recv(); m.Code != proto.CodeConflict {
		t.Fatalf("%+v", m)
	}
	silent := e.dial(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, _, err := silent.c.Read(ctx); err == nil {
		t.Fatal("server should close a connection that never says hello")
	}
	text := e.dial(t)
	text.c.Write(context.Background(), websocket.MessageText, []byte("hola"))
	if m := text.recv(); m.Code != proto.CodeBadRequest {
		t.Fatalf("%+v", m)
	}
}
