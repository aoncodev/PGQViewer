// Package store is the app-local persistence layer: saved connections,
// query history, layout positions, editor sessions.
//
// Backed by SQLite via the pure-Go modernc.org/sqlite driver so we can
// cross-compile the server binary to mac/linux/windows without CGO.
//
// Credential storage note: in v0 the password field holds the raw secret.
// When we wire Electron (M12) the renderer will keep secrets in OS keychain
// via safeStorage and only ship an opaque handle to the server. The schema
// here already supports that direction — `password` will become nullable
// alongside a new `keyring_handle` column when we land that change.
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"time"

	_ "modernc.org/sqlite"
)

// Store is a thin wrapper over *sql.DB that exposes the operations the API
// layer needs. It owns nothing else — open it once at startup, pass to
// handlers, close on shutdown.
type Store struct {
	db   *sql.DB
	path string
}

// Open opens (or creates) the SQLite app database at the platform-appropriate
// location. Use ":memory:" as path for tests.
func Open(path string) (*Store, error) {
	dsn := path
	if path != ":memory:" {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return nil, fmt.Errorf("mkdir data dir: %w", err)
		}
		// _txlock=immediate avoids "database is locked" under concurrent
		// writes; busy_timeout lets readers wait through writes.
		dsn = fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(ON)&_txlock=immediate", path)
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	db.SetMaxOpenConns(1) // SQLite is single-writer; serialize all access.
	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ping sqlite: %w", err)
	}
	s := &Store{db: db, path: path}
	if err := s.migrate(context.Background()); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

// Close flushes and closes the underlying database.
func (s *Store) Close() error { return s.db.Close() }

// Path returns the on-disk path of the open database (":memory:" for in-mem).
func (s *Store) Path() string { return s.path }

// migrate applies any pending schema changes. CREATE statements are
// idempotent; column additions are guarded by addColumnIfMissing so older
// app DBs can be upgraded in place without a migration ladder.
func (s *Store) migrate(ctx context.Context) error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS connections (
			id          INTEGER PRIMARY KEY AUTOINCREMENT,
			name        TEXT NOT NULL UNIQUE,
			host        TEXT NOT NULL,
			port        INTEGER NOT NULL DEFAULT 5432,
			database    TEXT NOT NULL,
			username    TEXT NOT NULL,
			password    TEXT NOT NULL DEFAULT '',
			sslmode     TEXT NOT NULL DEFAULT 'prefer',
			created_at  INTEGER NOT NULL,
			updated_at  INTEGER NOT NULL
		)`,
	}
	for _, stmt := range stmts {
		if _, err := s.db.ExecContext(ctx, stmt); err != nil {
			return fmt.Errorf("migrate: %w (stmt: %s)", err, firstLine(stmt))
		}
	}
	return nil
}

func firstLine(s string) string {
	for i, r := range s {
		if r == '\n' {
			return s[:i]
		}
	}
	return s
}

// --- Connections -----------------------------------------------------------

// Connection is a saved PG profile. Password is included in DB rows but
// callers should strip it before returning over the API.
type Connection struct {
	ID        int64     `json:"id"`
	Name      string    `json:"name"`
	Host      string    `json:"host"`
	Port      int       `json:"port"`
	Database  string    `json:"database"`
	User      string    `json:"user"`
	Password  string    `json:"-"` // never serialized
	SSLMode   string    `json:"sslmode"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// NewConnection is the upsert payload.
type NewConnection struct {
	Name     string `json:"name"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Database string `json:"database"`
	User     string `json:"user"`
	Password string `json:"password"`
	SSLMode  string `json:"sslmode"`
}

// ErrNotFound is returned by GetConnection / DeleteConnection when no row
// matches.
var ErrNotFound = errors.New("not found")

// CreateConnection inserts a new profile and returns the assigned id.
func (s *Store) CreateConnection(ctx context.Context, c NewConnection) (Connection, error) {
	if c.Name == "" || c.Host == "" || c.Database == "" || c.User == "" {
		return Connection{}, errors.New("name, host, database, and user are required")
	}
	port := c.Port
	if port == 0 {
		port = 5432
	}
	sslmode := c.SSLMode
	if sslmode == "" {
		sslmode = "prefer"
	}
	now := time.Now().UTC().Unix()
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO connections (name, host, port, database, username, password, sslmode, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		c.Name, c.Host, port, c.Database, c.User, c.Password, sslmode, now, now,
	)
	if err != nil {
		return Connection{}, fmt.Errorf("insert connection: %w", err)
	}
	id, _ := res.LastInsertId()
	return s.GetConnection(ctx, id)
}

// ListConnections returns every saved profile, ordered by name.
func (s *Store) ListConnections(ctx context.Context) ([]Connection, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, name, host, port, database, username, password, sslmode, created_at, updated_at
		 FROM connections ORDER BY name`)
	if err != nil {
		return nil, fmt.Errorf("list connections: %w", err)
	}
	defer rows.Close()
	var out []Connection
	for rows.Next() {
		c, err := scanConnection(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// GetConnection returns a saved profile by id.
func (s *Store) GetConnection(ctx context.Context, id int64) (Connection, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT id, name, host, port, database, username, password, sslmode, created_at, updated_at
		 FROM connections WHERE id = ?`, id)
	c, err := scanConnection(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Connection{}, ErrNotFound
	}
	return c, err
}

// DeleteConnection removes a profile.
func (s *Store) DeleteConnection(ctx context.Context, id int64) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM connections WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete connection: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// --- helpers ---------------------------------------------------------------

type rowScanner interface {
	Scan(dest ...any) error
}

func scanConnection(s rowScanner) (Connection, error) {
	var (
		c       Connection
		created int64
		updated int64
	)
	err := s.Scan(&c.ID, &c.Name, &c.Host, &c.Port, &c.Database, &c.User, &c.Password, &c.SSLMode, &created, &updated)
	if err != nil {
		return Connection{}, err
	}
	c.CreatedAt = time.Unix(created, 0).UTC()
	c.UpdatedAt = time.Unix(updated, 0).UTC()
	return c, nil
}

// DefaultDBPath returns the per-platform path to the app's SQLite file.
//
//	macOS:   ~/Library/Application Support/PGQViewer/app.db
//	Linux:   $XDG_DATA_HOME/PGQViewer/app.db (default ~/.local/share/PGQViewer/)
//	Windows: %APPDATA%\PGQViewer\app.db
func DefaultDBPath() (string, error) {
	switch runtime.GOOS {
	case "darwin":
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, "Library", "Application Support", "PGQViewer", "app.db"), nil
	case "windows":
		appdata := os.Getenv("APPDATA")
		if appdata == "" {
			cfg, err := os.UserConfigDir()
			if err != nil {
				return "", err
			}
			appdata = cfg
		}
		return filepath.Join(appdata, "PGQViewer", "app.db"), nil
	default:
		base := os.Getenv("XDG_DATA_HOME")
		if base == "" {
			home, err := os.UserHomeDir()
			if err != nil {
				return "", err
			}
			base = filepath.Join(home, ".local", "share")
		}
		return filepath.Join(base, "PGQViewer", "app.db"), nil
	}
}
