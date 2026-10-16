package store

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/KlGamers/trama/server/internal/testdata"
)

func TestAddSinceVersion(t *testing.T) {
	sc, err := testdata.Load("typescript.json")
	if err != nil {
		t.Fatal(err)
	}
	bs, hs := testdata.Causal(sc[0])
	st, err := Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	ctx := context.Background()
	for i := range bs {
		ok, err := st.Add(ctx, "doc", hs[i], bs[i])
		if err != nil || !ok {
			t.Fatalf("%d: %v %v", i, ok, err)
		}
	}
	if ok, err := st.Add(ctx, "doc", hs[0], bs[0]); ok || err != nil {
		t.Fatalf("duplicate: %v %v", ok, err)
	}
	vv, err := st.Version(ctx, "doc")
	if err != nil {
		t.Fatal(err)
	}
	total := 0
	for _, s := range vv {
		total += int(s)
	}
	if total != len(bs) {
		t.Fatalf("version sums to %d, want %d", total, len(bs))
	}
	all, _ := st.Since(ctx, "doc", nil)
	if len(all) != len(bs) {
		t.Fatalf("since nil: %d", len(all))
	}
	none, _ := st.Since(ctx, "doc", vv)
	if len(none) != 0 {
		t.Fatalf("since full version: %d", len(none))
	}
	other, _ := st.Since(ctx, "other", nil)
	if len(other) != 0 {
		t.Fatal("documents leak into each other")
	}
	docs, chs, err := st.Stats(ctx)
	if err != nil || docs != 1 || chs != int64(len(bs)) {
		t.Fatalf("stats %d %d %v", docs, chs, err)
	}
}

func TestGap(t *testing.T) {
	sc, _ := testdata.Load("dart.json")
	bs, hs := testdata.Causal(sc[1])
	st, _ := Open(filepath.Join(t.TempDir(), "t.db"))
	defer st.Close()
	ctx := context.Background()
	for i := range bs {
		if hs[i].Seq == 2 {
			_, err := st.Add(ctx, "doc", hs[i], bs[i])
			if !errors.Is(err, ErrGap) {
				t.Fatalf("want gap, got %v", err)
			}
			return
		}
	}
	t.Fatal("no seq 2 change in scenario")
}

func TestOpenFails(t *testing.T) {
	if _, err := Open("/nonexistent/dir/x.db"); err == nil {
		t.Fatal("want error")
	}
}
