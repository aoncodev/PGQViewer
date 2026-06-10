// Package session manages live PostgreSQL connection pools keyed by an
// opaque session id. Sessions are ephemeral and process-local; the desktop
// app holds them for the lifetime of the user's open workspace.
package session

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrNotFound = errors.New("session not found")

type Session struct {
	ID        string
	Pool      *pgxpool.Pool
	CreatedAt time.Time
	// Label is a non-sensitive descriptor for logs/UI (e.g. "host:port/db").
	Label string
	// ConnectionID, when non-zero, is the saved-profile id this session was
	// opened from. Used to scope query history.
	ConnectionID int64
	// InFlight maps a per-request query id (qid) to the backend PostgreSQL
	// PID currently executing it. Populated by the query handler so the
	// /queries/{qid}/cancel endpoint can call pg_cancel_backend on the right
	// connection. Mutate only through the Manager methods, which take the
	// Manager's mutex.
	InFlight map[string]int32
}

type Manager struct {
	mu       sync.RWMutex
	sessions map[string]*Session
}

func NewManager() *Manager {
	return &Manager{sessions: make(map[string]*Session)}
}

// Add registers a pool and returns the generated session id.
func (m *Manager) Add(pool *pgxpool.Pool, label string) string {
	id := newID()
	s := &Session{
		ID:        id,
		Pool:      pool,
		Label:     label,
		CreatedAt: time.Now(),
		InFlight:  make(map[string]int32),
	}
	m.mu.Lock()
	m.sessions[id] = s
	m.mu.Unlock()
	return id
}

// Get returns the session by id or ErrNotFound.
func (m *Manager) Get(id string) (*Session, error) {
	m.mu.RLock()
	s, ok := m.sessions[id]
	m.mu.RUnlock()
	if !ok {
		return nil, ErrNotFound
	}
	return s, nil
}

// Tag associates a saved-connection id with an existing session. No-op if
// the session has already been closed.
func (m *Manager) Tag(id string, connectionID int64) {
	m.mu.Lock()
	if s, ok := m.sessions[id]; ok {
		s.ConnectionID = connectionID
	}
	m.mu.Unlock()
}

// RegisterPID records that query qid is currently running on backend pid in
// session sid. No-op if the session is closed.
func (m *Manager) RegisterPID(sid, qid string, pid int32) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[sid]
	if !ok {
		return
	}
	if s.InFlight == nil {
		s.InFlight = make(map[string]int32)
	}
	s.InFlight[qid] = pid
}

// UnregisterPID clears the qid entry for sid. Idempotent and safe to defer.
func (m *Manager) UnregisterPID(sid, qid string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s, ok := m.sessions[sid]; ok && s.InFlight != nil {
		delete(s.InFlight, qid)
	}
}

// LookupPID returns the backend PID currently running qid in sid, or false
// if either the session or qid is unknown.
func (m *Manager) LookupPID(sid, qid string) (int32, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s, ok := m.sessions[sid]
	if !ok || s.InFlight == nil {
		return 0, false
	}
	pid, ok := s.InFlight[qid]
	return pid, ok
}

// Close removes the session, asks PG to terminate any in-flight queries
// belonging to it, then closes the pool. Idempotent.
//
// Why cancel first: pgxpool.Close blocks until every checked-out
// connection is released, which means a Disconnect issued while a long
// query (pg_sleep, slow MATCH, …) is in flight would otherwise wait for
// that query to finish naturally. Sending pg_cancel_backend ahead of the
// close turns the wait from "however long the query takes" into roughly
// the round-trip cost of the cancel signal.
//
// The context bounds only the cancel attempt, not the pool close itself.
// If pg_cancel_backend can't get a free connection within the bounded
// window, we fall through to Pool.Close() — that's no worse than today.
func (m *Manager) Close(ctx context.Context, id string) error {
	m.mu.Lock()
	s, ok := m.sessions[id]
	if ok {
		delete(m.sessions, id)
	}
	m.mu.Unlock()
	if !ok {
		return ErrNotFound
	}
	cancelInFlight(ctx, s)
	s.Pool.Close()
	return nil
}

// cancelInFlight snapshots the session's in-flight backend PIDs and asks
// the server to cancel each. Errors are intentionally swallowed — every
// failure mode (PID already gone, pool busy, network blip) is benign in
// the close path; the subsequent Pool.Close() will surface anything fatal.
//
// Safe to call after the session has been removed from the manager: at
// that point no other code path will mutate s.InFlight (RegisterPID /
// UnregisterPID re-check the manager map and become no-ops).
func cancelInFlight(ctx context.Context, s *Session) {
	if len(s.InFlight) == 0 {
		return
	}
	pids := make([]int32, 0, len(s.InFlight))
	for _, pid := range s.InFlight {
		pids = append(pids, pid)
	}
	s.InFlight = nil
	// 2s gives PG plenty of time to ack the cancel even on a slow link;
	// if the pool happens to be 100% busy the cancels just expire and we
	// fall through to Pool.Close(), which is the pre-fix behaviour.
	cctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	for _, pid := range pids {
		var b bool
		_ = s.Pool.QueryRow(cctx, `SELECT pg_cancel_backend($1)`, pid).Scan(&b)
	}
}

// CloseAll shuts down every open pool. Called on server shutdown. Like
// Close, it asks PG to cancel in-flight queries first so a graceful
// shutdown isn't held up by a long-running statement.
func (m *Manager) CloseAll(ctx context.Context) {
	m.mu.Lock()
	sessions := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		sessions = append(sessions, s)
	}
	m.sessions = make(map[string]*Session)
	m.mu.Unlock()
	done := make(chan struct{})
	go func() {
		for _, s := range sessions {
			cancelInFlight(ctx, s)
			s.Pool.Close()
		}
		close(done)
	}()
	select {
	case <-done:
	case <-ctx.Done():
	}
}

// List returns metadata for every open session (no pool reference).
func (m *Manager) List() []SessionInfo {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]SessionInfo, 0, len(m.sessions))
	for _, s := range m.sessions {
		out = append(out, SessionInfo{ID: s.ID, Label: s.Label, CreatedAt: s.CreatedAt})
	}
	return out
}

type SessionInfo struct {
	ID        string    `json:"id"`
	Label     string    `json:"label"`
	CreatedAt time.Time `json:"created_at"`
}

func newID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}
