package testdata

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"sort"

	"github.com/KlGamers/trama/server/internal/change"
)

type Scenario struct {
	Seed   int             `json:"seed"`
	Blobs  []string        `json:"blobs"`
	Expect json.RawMessage `json:"expect"`
}

func Load(file string) ([]Scenario, error) {
	_, self, _, _ := runtime.Caller(0)
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(self), "../../../conformance", file))
	if err != nil {
		return nil, err
	}
	var v struct {
		Scenarios []Scenario `json:"scenarios"`
	}
	return v.Scenarios, json.Unmarshal(raw, &v)
}

func Causal(s Scenario) ([][]byte, []*change.Header) {
	type item struct {
		b []byte
		h *change.Header
	}
	var items []item
	for _, x := range s.Blobs {
		b, _ := hex.DecodeString(x)
		h, err := change.Parse(b)
		if err != nil {
			panic(err)
		}
		items = append(items, item{b, h})
	}
	sort.Slice(items, func(i, j int) bool { return items[i].h.Start < items[j].h.Start })
	bs := make([][]byte, len(items))
	hs := make([]*change.Header, len(items))
	for i, it := range items {
		bs[i], hs[i] = it.b, it.h
	}
	return bs, hs
}
