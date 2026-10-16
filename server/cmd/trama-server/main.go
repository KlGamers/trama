package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/KlGamers/trama/server/internal/auth"
	"github.com/KlGamers/trama/server/internal/hub"
	"github.com/KlGamers/trama/server/internal/store"
)

func main() {
	os.Exit(Main(os.Args[1:], os.Stdout, os.Stderr))
}

func Main(args []string, out, errw io.Writer) int {
	if len(args) > 0 && args[0] == "token" {
		return token(args[1:], out, errw)
	}
	fs := flag.NewFlagSet("trama-server", flag.ContinueOnError)
	fs.SetOutput(errw)
	addr := fs.String("addr", ":7070", "listen address")
	db := fs.String("db", "trama.db", "SQLite file")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	log := slog.New(slog.NewTextHandler(errw, nil))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := serve(ctx, *addr, *db, os.Getenv("TRAMA_SECRET"), log, nil); err != nil {
		log.Error("fatal", "err", err)
		return 1
	}
	return 0
}

func serve(ctx context.Context, addr, db, secret string, log *slog.Logger, ready chan<- string) error {
	st, err := store.Open(db)
	if err != nil {
		return err
	}
	defer st.Close()
	if secret == "" {
		log.Warn("TRAMA_SECRET is empty: any client can read and write any document")
	}
	h := hub.New(st, auth.New(secret), log)
	mux := http.NewServeMux()
	mux.Handle("GET /sync", h)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		docs, chs, err := st.Stats(r.Context())
		if err != nil {
			http.Error(w, "storage error", http.StatusInternalServerError)
			return
		}
		fmt.Fprintf(w, "ok docs=%d changes=%d\n", docs, chs)
	})
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	errc := make(chan error, 1)
	go func() {
		log.Info("listening", "addr", ln.Addr().String())
		if ready != nil {
			ready <- ln.Addr().String()
		}
		if err := srv.Serve(ln); !errors.Is(err, http.ErrServerClosed) {
			errc <- err
		}
	}()
	select {
	case err = <-errc:
	case <-ctx.Done():
	}
	sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	srv.Shutdown(sctx)
	return err
}

func token(args []string, out, errw io.Writer) int {
	fs := flag.NewFlagSet("token", flag.ContinueOnError)
	fs.SetOutput(errw)
	doc := fs.String("doc", "", "document name, or * for every document")
	ttl := fs.Duration("ttl", 24*time.Hour, "time to live, 0 for no expiry")
	ro := fs.Bool("read-only", false, "deny writes")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	secret := os.Getenv("TRAMA_SECRET")
	if secret == "" || *doc == "" {
		fmt.Fprintln(errw, "set TRAMA_SECRET and -doc")
		return 2
	}
	var exp int64
	if *ttl > 0 {
		exp = time.Now().Add(*ttl).Unix()
	}
	fmt.Fprintln(out, auth.New(secret).Mint(auth.Claims{Doc: *doc, Exp: exp, Write: !*ro}))
	return 0
}
