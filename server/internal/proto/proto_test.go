package proto

import (
	"errors"
	"reflect"
	"testing"
)

func TestRoundTrip(t *testing.T) {
	vv := map[string]uint64{"0123456789abcdef0123456789abcdef": 7, "ffffffffffffffffffffffffffffffff": 1 << 40}
	for _, m := range []Msg{
		{Type: Hello, Doc: "notas-1", Token: "abc.def", VV: vv},
		{Type: Hello, Doc: "x", VV: map[string]uint64{}},
		{Type: Changes, Blobs: [][]byte{{1, 2, 3}, {}, make([]byte, 300)}},
		{Type: Welcome, Write: true, VV: vv},
		{Type: Welcome, VV: map[string]uint64{}},
		{Type: Error, Code: CodeConflict, Text: "falta un cambio"},
	} {
		got, err := Decode(Encode(m))
		if err != nil {
			t.Fatalf("%+v: %v", m, err)
		}
		if m.Type == Changes && len(got.Blobs) != len(m.Blobs) {
			t.Fatalf("blobs %d", len(got.Blobs))
		}
		got.Blobs, m.Blobs = nil, nil
		if !reflect.DeepEqual(got, m) {
			t.Fatalf("got %+v want %+v", got, m)
		}
	}
}

func TestRejects(t *testing.T) {
	good := Encode(Msg{Type: Hello, Doc: "d", VV: map[string]uint64{"0123456789abcdef0123456789abcdef": 1}})
	cases := [][]byte{nil, {9}, {Hello, 2}, good[:len(good)-1], append(append([]byte{}, good...), 0), {Changes, 0xff, 0xff, 0xff, 0x7f}, {Error, 1, 2, 0xff, 0xfe}}
	for _, b := range cases {
		if _, err := Decode(b); !errors.Is(err, ErrBad) {
			t.Fatalf("%x: %v", b, err)
		}
	}
}

func FuzzDecode(f *testing.F) {
	f.Add(Encode(Msg{Type: Changes, Blobs: [][]byte{{1}}}))
	f.Fuzz(func(t *testing.T, b []byte) { Decode(b) })
}
