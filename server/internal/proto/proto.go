package proto

import (
	"encoding/hex"
	"errors"
	"fmt"
	"unicode/utf8"
)

const (
	Hello   byte = 1
	Changes byte = 2
	Welcome byte = 3
	Error   byte = 4
	Version byte = 1
)

const (
	CodeBadRequest   byte = 1
	CodeUnauthorized byte = 2
	CodeForbidden    byte = 3
	CodeConflict     byte = 4
	CodeTooLarge     byte = 5
	CodeInternal     byte = 6
)

var ErrBad = errors.New("malformed message")

type Msg struct {
	Type  byte
	Doc   string
	Token string
	VV    map[string]uint64
	Blobs [][]byte
	Write bool
	Code  byte
	Text  string
}

type writer struct{ b []byte }

func (w *writer) u8(v byte) { w.b = append(w.b, v) }

func (w *writer) uint(v uint64) {
	for v >= 0x80 {
		w.b = append(w.b, byte(v&0x7f)|0x80)
		v >>= 7
	}
	w.b = append(w.b, byte(v))
}

func (w *writer) bytes(b []byte) {
	w.uint(uint64(len(b)))
	w.b = append(w.b, b...)
}

func (w *writer) vv(m map[string]uint64) {
	w.uint(uint64(len(m)))
	for a, s := range m {
		raw, _ := hex.DecodeString(a)
		w.b = append(w.b, raw...)
		w.uint(s)
	}
}

func Encode(m Msg) []byte {
	w := &writer{}
	w.u8(m.Type)
	switch m.Type {
	case Hello:
		w.u8(Version)
		w.bytes([]byte(m.Doc))
		w.bytes([]byte(m.Token))
		w.vv(m.VV)
	case Changes:
		w.uint(uint64(len(m.Blobs)))
		for _, b := range m.Blobs {
			w.bytes(b)
		}
	case Welcome:
		if m.Write {
			w.u8(1)
		} else {
			w.u8(0)
		}
		w.vv(m.VV)
	case Error:
		w.u8(m.Code)
		w.bytes([]byte(m.Text))
	}
	return w.b
}

type reader struct {
	b   []byte
	pos int
}

func (r *reader) u8() (byte, error) {
	if r.pos >= len(r.b) {
		return 0, fmt.Errorf("%w: unexpected end", ErrBad)
	}
	v := r.b[r.pos]
	r.pos++
	return v, nil
}

func (r *reader) uint() (uint64, error) {
	var out uint64
	for shift := 0; shift < 63; shift += 7 {
		b, err := r.u8()
		if err != nil {
			return 0, err
		}
		out |= uint64(b&0x7f) << shift
		if b < 0x80 {
			return out, nil
		}
	}
	return 0, fmt.Errorf("%w: varint too long", ErrBad)
}

func (r *reader) bytes() ([]byte, error) {
	n, err := r.uint()
	if err != nil {
		return nil, err
	}
	if n > uint64(len(r.b)-r.pos) {
		return nil, fmt.Errorf("%w: length past end", ErrBad)
	}
	out := r.b[r.pos : r.pos+int(n)]
	r.pos += int(n)
	return out, nil
}

func (r *reader) text() (string, error) {
	b, err := r.bytes()
	if err != nil {
		return "", err
	}
	if !utf8.Valid(b) {
		return "", fmt.Errorf("%w: invalid utf-8", ErrBad)
	}
	return string(b), nil
}

func (r *reader) vv() (map[string]uint64, error) {
	n, err := r.uint()
	if err != nil {
		return nil, err
	}
	if n > uint64(len(r.b)) {
		return nil, fmt.Errorf("%w: too many entries", ErrBad)
	}
	out := make(map[string]uint64, n)
	for i := uint64(0); i < n; i++ {
		if len(r.b)-r.pos < 16 {
			return nil, fmt.Errorf("%w: short actor", ErrBad)
		}
		a := hex.EncodeToString(r.b[r.pos : r.pos+16])
		r.pos += 16
		s, err := r.uint()
		if err != nil {
			return nil, err
		}
		out[a] = s
	}
	return out, nil
}

func Decode(b []byte) (Msg, error) {
	r := &reader{b: b}
	t, err := r.u8()
	if err != nil {
		return Msg{}, err
	}
	m := Msg{Type: t}
	switch t {
	case Hello:
		v, err := r.u8()
		if err != nil {
			return m, err
		}
		if v != Version {
			return m, fmt.Errorf("%w: protocol version %d", ErrBad, v)
		}
		if m.Doc, err = r.text(); err != nil {
			return m, err
		}
		if m.Token, err = r.text(); err != nil {
			return m, err
		}
		if m.VV, err = r.vv(); err != nil {
			return m, err
		}
	case Changes:
		n, err := r.uint()
		if err != nil {
			return m, err
		}
		if n > uint64(len(b)) {
			return m, fmt.Errorf("%w: too many changes", ErrBad)
		}
		for i := uint64(0); i < n; i++ {
			blob, err := r.bytes()
			if err != nil {
				return m, err
			}
			m.Blobs = append(m.Blobs, blob)
		}
	case Welcome:
		w, err := r.u8()
		if err != nil {
			return m, err
		}
		m.Write = w == 1
		if m.VV, err = r.vv(); err != nil {
			return m, err
		}
	case Error:
		if m.Code, err = r.u8(); err != nil {
			return m, err
		}
		if m.Text, err = r.text(); err != nil {
			return m, err
		}
	default:
		return m, fmt.Errorf("%w: unknown type %d", ErrBad, t)
	}
	if r.pos != len(b) {
		return m, fmt.Errorf("%w: trailing bytes", ErrBad)
	}
	return m, nil
}
