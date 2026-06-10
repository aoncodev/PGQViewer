// Package pg wraps pgx connection pools.
package pg

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// ConnectInput describes a PostgreSQL connection request.
//
// Either DSN or the discrete fields may be supplied; DSN wins if both are set.
type ConnectInput struct {
	DSN      string `json:"dsn,omitempty"`
	Host     string `json:"host,omitempty"`
	Port     int    `json:"port,omitempty"`
	Database string `json:"database,omitempty"`
	User     string `json:"user,omitempty"`
	Password string `json:"password,omitempty"`
	SSLMode  string `json:"sslmode,omitempty"` // disable|prefer|require|verify-ca|verify-full
}

// BuildConfig produces a pgxpool config from connection input.
func BuildConfig(in ConnectInput) (*pgxpool.Config, error) {
	dsn := in.DSN
	if dsn == "" {
		port := in.Port
		if port == 0 {
			port = 5432
		}
		sslmode := in.SSLMode
		if sslmode == "" {
			sslmode = "prefer"
		}
		dsn = fmt.Sprintf("postgres://%s:%s@%s:%d/%s?sslmode=%s",
			urlQuote(in.User), urlQuote(in.Password),
			in.Host, port, urlQuote(in.Database), sslmode,
		)
	}

	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse dsn: %w", err)
	}
	cfg.MaxConns = 8
	cfg.MinConns = 0
	cfg.MaxConnIdleTime = 5 * time.Minute
	cfg.MaxConnLifetime = 1 * time.Hour
	return cfg, nil
}

// Open creates a pool and verifies it with a ping.
func Open(ctx context.Context, in ConnectInput) (*pgxpool.Pool, error) {
	cfg, err := BuildConfig(in)
	if err != nil {
		return nil, err
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("open pool: %w", err)
	}
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return pool, nil
}

// urlQuote percent-encodes the userinfo/path components of a DSN. Minimal
// implementation; we only worry about characters that can appear in real
// PG credentials.
func urlQuote(s string) string {
	const hex = "0123456789ABCDEF"
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case 'A' <= c && c <= 'Z',
			'a' <= c && c <= 'z',
			'0' <= c && c <= '9',
			c == '-', c == '_', c == '.', c == '~':
			out = append(out, c)
		default:
			out = append(out, '%', hex[c>>4], hex[c&0xF])
		}
	}
	return string(out)
}
