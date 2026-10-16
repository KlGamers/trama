package change

import (
	"encoding/hex"
	"errors"
	"fmt"
	"unicode/utf8"
)

const (
	magic      = 0x54
	version    = 2
	maxDepth   = 64
	actorBytes = 16
	maxSafe    = 1<<53 - 1
)

var ErrBad = errors.New("malformed change")

type Header struct {
	Actor string
	Seq   uint64
	Start uint64
	Time  uint64
	Deps  map[string]uint64
	Ops   int
	Span  uint64
}

type reader struct {
	buf []byte
	pos int
}

func (r *reader) fail(msg string) error { return fmt.Errorf("%w: %s at byte %d", ErrBad, msg, r.pos) }

func (r *reader) u8() (byte, error) {
	if r.pos >= len(r.buf) {
		return 0, r.fail("unexpected end")
	}
	b := r.buf[r.pos]
	r.pos++
	return b, nil
}

func (r *reader) uint() (uint64, error) {
	var out, mul uint64 = 0, 1
	for i := 0; i < 8; i++ {
		b, err := r.u8()
		if err != nil {
			return 0, err
		}
		out += uint64(b&0x7f) * mul
		if b < 0x80 {
			if out > maxSafe {
				return 0, r.fail("varint too large")
			}
			return out, nil
		}
		mul *= 0x80
	}
	return 0, r.fail("varint too long")
}

func (r *reader) raw(n uint64) ([]byte, error) {
	if n > uint64(len(r.buf)-r.pos) {
		return nil, r.fail("unexpected end")
	}
	b := r.buf[r.pos : r.pos+int(n)]
	r.pos += int(n)
	return b, nil
}

func (r *reader) str() (string, error) {
	n, err := r.uint()
	if err != nil {
		return "", err
	}
	b, err := r.raw(n)
	if err != nil {
		return "", err
	}
	if !utf8.Valid(b) {
		return "", r.fail("invalid utf-8")
	}
	return string(b), nil
}

func Parse(buf []byte) (*Header, error) {
	r := &reader{buf: buf}
	m, err := r.u8()
	if err != nil {
		return nil, err
	}
	if m != magic {
		return nil, r.fail("not a trama change")
	}
	v, err := r.u8()
	if err != nil {
		return nil, err
	}
	if v != version {
		return nil, r.fail(fmt.Sprintf("unsupported version %d", v))
	}
	na, err := r.uint()
	if err != nil {
		return nil, err
	}
	if na == 0 || na > 65535 {
		return nil, r.fail("bad actor table")
	}
	acts := make([]string, na)
	for i := range acts {
		b, err := r.raw(actorBytes)
		if err != nil {
			return nil, err
		}
		acts[i] = hex.EncodeToString(b)
	}
	h := &Header{Actor: acts[0], Deps: map[string]uint64{}}
	if h.Seq, err = r.uint(); err != nil {
		return nil, err
	}
	if h.Start, err = r.uint(); err != nil {
		return nil, err
	}
	if h.Time, err = r.uint(); err != nil {
		return nil, err
	}
	if h.Seq < 1 || h.Start < 1 {
		return nil, r.fail("bad header")
	}
	act := func() (string, error) {
		i, err := r.uint()
		if err != nil {
			return "", err
		}
		if i >= uint64(len(acts)) {
			return "", r.fail("actor index out of range")
		}
		return acts[i], nil
	}
	nd, err := r.uint()
	if err != nil {
		return nil, err
	}
	for i := uint64(0); i < nd; i++ {
		a, err := act()
		if err != nil {
			return nil, err
		}
		s, err := r.uint()
		if err != nil {
			return nil, err
		}
		if _, dup := h.Deps[a]; dup || a == h.Actor || s < 1 {
			return nil, r.fail("bad dependency")
		}
		h.Deps[a] = s
	}
	id := func(required bool) error {
		c, err := r.uint()
		if err != nil {
			return err
		}
		if c == 0 {
			if required {
				return r.fail("missing object id")
			}
			return nil
		}
		_, err = act()
		return err
	}
	var ref func(depth int, required bool) error
	ref = func(depth int, required bool) error {
		if depth > maxDepth {
			return r.fail("object reference too deep")
		}
		tag, err := r.u8()
		if err != nil {
			return err
		}
		switch tag {
		case 0:
			if required {
				return r.fail("sequence and counter ops need an object")
			}
			return nil
		case 1:
			return id(true)
		case 2:
			if err := ref(depth+1, false); err != nil {
				return err
			}
			if _, err := r.str(); err != nil {
				return err
			}
			k, err := r.u8()
			if err != nil {
				return err
			}
			if k < 1 || k > 4 {
				return r.fail("unknown object kind")
			}
			return id(false)
		default:
			return r.fail(fmt.Sprintf("unknown reference tag %d", tag))
		}
	}
	val := func() error {
		tag, err := r.u8()
		if err != nil {
			return err
		}
		switch tag {
		case 0, 1, 2:
			return nil
		case 3:
			_, err = r.raw(8)
		case 4:
			_, err = r.str()
		case 5:
			_, err = r.uint()
		default:
			return r.fail(fmt.Sprintf("unknown value tag %d", tag))
		}
		return err
	}
	kind := func() error {
		k, err := r.u8()
		if err != nil {
			return err
		}
		if k < 1 || k > 4 {
			return r.fail("unknown object kind")
		}
		return nil
	}
	no, err := r.uint()
	if err != nil {
		return nil, err
	}
	if no > uint64(len(r.buf)-r.pos) {
		return nil, r.fail("op count larger than input")
	}
	h.Ops = int(no)
	for i := uint64(0); i < no; i++ {
		t, err := r.u8()
		if err != nil {
			return nil, err
		}
		w := uint64(1)
		switch t {
		case 1:
			err = firstErr(ref(0, false), strErr(r), val())
		case 2:
			err = firstErr(ref(0, false), strErr(r), kind(), id(false))
		case 3:
			err = firstErr(ref(0, false), strErr(r))
		case 4:
			err = firstErr(ref(0, true), id(false), val())
		case 5:
			err = firstErr(ref(0, true), id(false), kind())
		case 6:
			if err = firstErr(ref(0, true), id(false)); err == nil {
				var s string
				if s, err = r.str(); err == nil {
					if s == "" {
						err = r.fail("empty splice")
					}
					w = uint64(utf8.RuneCountInString(s))
				}
			}
		case 7:
			if err = firstErr(ref(0, true), id(true)); err == nil {
				var n uint64
				if n, err = r.uint(); err == nil && n < 1 {
					err = r.fail("empty removal")
				}
				w = n
			}
		case 8:
			err = firstErr(ref(0, true), uintErr(r))
		default:
			err = r.fail(fmt.Sprintf("unknown op type %d", t))
		}
		if err != nil {
			return nil, err
		}
		h.Span += w
	}
	if r.pos != len(r.buf) {
		return nil, r.fail("trailing bytes")
	}
	return h, nil
}

func strErr(r *reader) error {
	_, err := r.str()
	return err
}

func uintErr(r *reader) error {
	_, err := r.uint()
	return err
}

func firstErr(errs ...error) error {
	for _, e := range errs {
		if e != nil {
			return e
		}
	}
	return nil
}
