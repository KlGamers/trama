package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

var (
	ErrToken   = errors.New("invalid token")
	ErrExpired = errors.New("token expired")
	ErrDoc     = errors.New("token is for another document")
)

type Claims struct {
	Doc   string `json:"doc"`
	Exp   int64  `json:"exp"`
	Write bool   `json:"write"`
}

type Signer struct{ key []byte }

func New(secret string) *Signer {
	if secret == "" {
		return nil
	}
	return &Signer{key: []byte(secret)}
}

var b64 = base64.RawURLEncoding

func (s *Signer) mac(p string) string {
	m := hmac.New(sha256.New, s.key)
	m.Write([]byte(p))
	return b64.EncodeToString(m.Sum(nil))
}

func (s *Signer) Mint(c Claims) string {
	raw, _ := json.Marshal(c)
	p := b64.EncodeToString(raw)
	return p + "." + s.mac(p)
}

func (s *Signer) Check(tok, doc string, now time.Time) (Claims, error) {
	if s == nil {
		return Claims{Doc: doc, Write: true}, nil
	}
	p, sig, ok := strings.Cut(tok, ".")
	if !ok || !hmac.Equal([]byte(sig), []byte(s.mac(p))) {
		return Claims{}, ErrToken
	}
	raw, err := b64.DecodeString(p)
	if err != nil {
		return Claims{}, ErrToken
	}
	var c Claims
	if err := json.Unmarshal(raw, &c); err != nil {
		return Claims{}, ErrToken
	}
	if c.Exp != 0 && now.Unix() >= c.Exp {
		return Claims{}, ErrExpired
	}
	if c.Doc != doc && c.Doc != "*" {
		return Claims{}, ErrDoc
	}
	return c, nil
}
