package main

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestServeAndHealth(t *testing.T) {
	ctx, stop := context.WithCancel(context.Background())
	ready := make(chan string, 1)
	done := make(chan error, 1)
	go func() {
		done <- serve(ctx, "127.0.0.1:0", filepath.Join(t.TempDir(), "s.db"), "", slog.New(slog.NewTextHandler(io.Discard, nil)), ready)
	}()
	var addr string
	select {
	case addr = <-ready:
	case err := <-done:
		t.Fatal(err)
	case <-time.After(5 * time.Second):
		t.Fatal("did not start")
	}
	res, err := http.Get("http://" + addr + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if !strings.HasPrefix(string(body), "ok docs=0 changes=0") {
		t.Fatalf("%q", body)
	}
	stop()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if err := serve(context.Background(), "127.0.0.1:0", "/nonexistent/x.db", "", slog.New(slog.NewTextHandler(io.Discard, nil)), nil); err == nil {
		t.Fatal("want error for bad db path")
	}
}

func TestTokenCommand(t *testing.T) {
	var out, errb bytes.Buffer
	if code := Main([]string{"token", "-doc", "x"}, &out, &errb); code != 2 {
		t.Fatalf("missing secret should fail, got %d", code)
	}
	t.Setenv("TRAMA_SECRET", "s")
	out.Reset()
	if code := Main([]string{"token", "-doc", "notas", "-read-only"}, &out, &errb); code != 0 || strings.Count(out.String(), ".") != 1 {
		t.Fatalf("%d %q", code, out.String())
	}
	if code := Main([]string{"-nope"}, &out, &errb); code != 2 {
		t.Fatal("bad flag")
	}
}
