package auth

import (
	"errors"
	"testing"
	"time"
)

func TestTokens(t *testing.T) {
	s := New("secreto")
	now := time.Unix(1_800_000_000, 0)
	tok := s.Mint(Claims{Doc: "notas", Exp: now.Add(time.Hour).Unix(), Write: true})
	c, err := s.Check(tok, "notas", now)
	if err != nil || !c.Write {
		t.Fatalf("%+v %v", c, err)
	}
	if _, err := s.Check(tok, "otra", now); !errors.Is(err, ErrDoc) {
		t.Fatal(err)
	}
	if _, err := s.Check(tok, "notas", now.Add(2*time.Hour)); !errors.Is(err, ErrExpired) {
		t.Fatal(err)
	}
	if _, err := New("otro").Check(tok, "notas", now); !errors.Is(err, ErrToken) {
		t.Fatal(err)
	}
	for _, bad := range []string{"", "nodot", tok + "x", "!!!." + tok[len(tok)-10:]} {
		if _, err := s.Check(bad, "notas", now); !errors.Is(err, ErrToken) {
			t.Fatalf("%q: %v", bad, err)
		}
	}
	any := s.Mint(Claims{Doc: "*"})
	if c, err := s.Check(any, "lo-que-sea", now); err != nil || c.Write {
		t.Fatalf("%+v %v", c, err)
	}
	var open *Signer = New("")
	if c, err := open.Check("", "x", now); err != nil || !c.Write {
		t.Fatalf("open mode: %+v %v", c, err)
	}
}
