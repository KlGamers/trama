package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	_ "modernc.org/sqlite"

	"github.com/KlGamers/trama/server/internal/change"
)

var ErrGap = errors.New("change arrived before an earlier change from the same actor")

const schema = `
CREATE TABLE IF NOT EXISTS changes (
	id INTEGER PRIMARY KEY,
	doc TEXT NOT NULL,
	actor TEXT NOT NULL,
	seq INTEGER NOT NULL,
	data BLOB NOT NULL,
	UNIQUE (doc, actor, seq)
);
CREATE INDEX IF NOT EXISTS changes_doc ON changes(doc, id);
`

type Store struct{ db *sql.DB }

func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) Add(ctx context.Context, doc string, h *change.Header, blob []byte) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	var max sql.NullInt64
	if err := tx.QueryRowContext(ctx, `SELECT MAX(seq) FROM changes WHERE doc=? AND actor=?`, doc, h.Actor).Scan(&max); err != nil {
		return false, err
	}
	cur := uint64(0)
	if max.Valid {
		cur = uint64(max.Int64)
	}
	if h.Seq <= cur {
		return false, nil
	}
	if h.Seq != cur+1 {
		return false, fmt.Errorf("%w: %s seq %d, have %d", ErrGap, h.Actor[:8], h.Seq, cur)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO changes(doc, actor, seq, data) VALUES(?,?,?,?)`, doc, h.Actor, h.Seq, blob); err != nil {
		return false, err
	}
	return true, tx.Commit()
}

func (s *Store) Since(ctx context.Context, doc string, vv map[string]uint64) ([][]byte, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT actor, seq, data FROM changes WHERE doc=? ORDER BY id`, doc)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out [][]byte
	for rows.Next() {
		var actor string
		var seq uint64
		var data []byte
		if err := rows.Scan(&actor, &seq, &data); err != nil {
			return nil, err
		}
		if seq > vv[actor] {
			out = append(out, data)
		}
	}
	return out, rows.Err()
}

func (s *Store) Version(ctx context.Context, doc string) (map[string]uint64, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT actor, MAX(seq) FROM changes WHERE doc=? GROUP BY actor`, doc)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]uint64{}
	for rows.Next() {
		var a string
		var s uint64
		if err := rows.Scan(&a, &s); err != nil {
			return nil, err
		}
		out[a] = s
	}
	return out, rows.Err()
}

func (s *Store) Stats(ctx context.Context) (docs, changes int64, err error) {
	err = s.db.QueryRowContext(ctx, `SELECT COUNT(DISTINCT doc), COUNT(*) FROM changes`).Scan(&docs, &changes)
	return
}
