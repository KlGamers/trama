package change

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"testing"
)

func vectors(t *testing.T) [][]byte {
	t.Helper()
	var out [][]byte
	for _, f := range []string{"../../../conformance/typescript.json", "../../../conformance/dart.json"} {
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		var v struct {
			Scenarios []struct {
				Blobs []string `json:"blobs"`
			} `json:"scenarios"`
		}
		if err := json.Unmarshal(raw, &v); err != nil {
			t.Fatal(err)
		}
		for _, s := range v.Scenarios {
			for _, h := range s.Blobs {
				b, err := hex.DecodeString(h)
				if err != nil {
					t.Fatal(err)
				}
				out = append(out, b)
			}
		}
	}
	return out
}

func TestParsesEveryConformanceChange(t *testing.T) {
	blobs := vectors(t)
	if len(blobs) < 1000 {
		t.Fatalf("only %d vectors", len(blobs))
	}
	seen := map[string]bool{}
	for _, b := range blobs {
		h, err := Parse(b)
		if err != nil {
			t.Fatalf("%v (%x)", err, b)
		}
		if len(h.Actor) != 32 || h.Seq < 1 || h.Ops < 1 || h.Span < uint64(h.Ops) {
			t.Fatalf("header %+v", h)
		}
		seen[h.Actor] = true
	}
	if len(seen) < 4 {
		t.Fatalf("actors %d", len(seen))
	}
}

func TestRejectsCorruption(t *testing.T) {
	blobs := vectors(t)
	for i, b := range blobs[:400] {
		if _, err := Parse(b[:len(b)-1]); err == nil || !errors.Is(err, ErrBad) {
			t.Fatalf("truncated change %d accepted", i)
		}
		if _, err := Parse(append(append([]byte{}, b...), 0)); err == nil {
			t.Fatalf("trailing byte accepted in %d", i)
		}
		for k := 0; k < len(b); k++ {
			c := append([]byte{}, b...)
			c[k] ^= 0xff
			Parse(c)
		}
	}
	for _, b := range [][]byte{nil, {0x54}, {0x00, 1}, {0x54, 2}, {0x54, 1, 0}} {
		if _, err := Parse(b); err == nil {
			t.Fatalf("accepted %x", b)
		}
	}
}

func FuzzParse(f *testing.F) {
	f.Add([]byte{0x54, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0})
	f.Fuzz(func(t *testing.T, b []byte) {
		h, err := Parse(b)
		if err == nil && (h.Seq < 1 || len(h.Actor) != 32) {
			t.Fatalf("accepted invalid header %+v", h)
		}
	})
}
