// Package api wires HTTP handlers for pgqviewer-server.
package api

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/aoncodev/PGQViewer/server/internal/pg"
	"github.com/aoncodev/PGQViewer/server/internal/session"
	"github.com/aoncodev/PGQViewer/server/internal/sqlpgq"
	"github.com/aoncodev/PGQViewer/server/internal/store"
	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"
)

type Server struct {
	logger   *slog.Logger
	sessions *session.Manager
	store    *store.Store // optional; nil disables /connections and /history
}

func New(logger *slog.Logger, sm *session.Manager, st *store.Store) *Server {
	return &Server{logger: logger, sessions: sm, store: st}
}

// Router builds the HTTP routes.
func (s *Server) Router() http.Handler {
	r := chi.NewRouter()
	r.Use(chimw.RequestID)
	r.Use(chimw.Recoverer)
	// No global timeout: /query streams arbitrarily long results and we rely
	// on the request context for client-disconnect cancellation. Per-endpoint
	// timeouts are added where appropriate.

	r.Get("/api/v1/healthz", s.healthz)

	r.Route("/api/v1/sessions", func(r chi.Router) {
		r.Post("/", s.openSession)
		r.Get("/", s.listSessions)
		r.Delete("/{sid}", s.closeSession)
		r.Get("/{sid}/ping", s.pingSession)

		r.Get("/{sid}/graphs", s.listGraphs)
		r.Get("/{sid}/graphs/{oid}", s.getGraphMetadata)
		r.Get("/{sid}/graphs/{oid}/counts", s.getGraphCounts)
		r.Post(ExpandRoute, s.Expand)

		r.Post("/{sid}/query", s.query)
		r.Post("/{sid}/queries/{qid}/cancel", s.cancelQuery)
	})

	r.Route("/api/v1/connections", func(r chi.Router) {
		r.Get("/", s.listConnections)
		r.Post("/", s.createConnection)
		r.Delete("/{id}", s.deleteConnection)
		r.Post("/{id}/open", s.openConnection)
	})

	return r
}

// --- handlers --------------------------------------------------------------

func (s *Server) healthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":   true,
		"time": time.Now().UTC(),
	})
}

func (s *Server) openSession(w http.ResponseWriter, r *http.Request) {
	var in pg.ConnectInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json body")
		return
	}
	pool, err := pg.Open(r.Context(), in)
	if err != nil {
		s.logger.Warn("session open failed", "err", err)
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	label := labelFor(in)
	id := s.sessions.Add(pool, label)
	s.logger.Info("session opened", "sid", id, "label", label)
	writeJSON(w, http.StatusCreated, map[string]any{
		"session_id": id,
		"label":      label,
	})
}

func (s *Server) listSessions(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"sessions": s.sessions.List()})
}

func (s *Server) closeSession(w http.ResponseWriter, r *http.Request) {
	sid := chi.URLParam(r, "sid")
	switch err := s.sessions.Close(r.Context(), sid); {
	case err == nil:
		s.logger.Info("session closed", "sid", sid)
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, session.ErrNotFound):
		writeErr(w, http.StatusNotFound, "session not found")
	default:
		writeErr(w, http.StatusInternalServerError, err.Error())
	}
}

func (s *Server) pingSession(w http.ResponseWriter, r *http.Request) {
	sid := chi.URLParam(r, "sid")
	sess, err := s.sessions.Get(sid)
	if err != nil {
		writeErr(w, http.StatusNotFound, "session not found")
		return
	}
	if err := sess.Pool.Ping(r.Context()); err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) listGraphs(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	graphs, err := sqlpgq.ListGraphs(r.Context(), sess.Pool)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"graphs": graphs})
}

func (s *Server) getGraphMetadata(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	oid, ok := parseOID(w, r)
	if !ok {
		return
	}
	md, err := sqlpgq.GetMetadata(r.Context(), sess.Pool, oid)
	switch {
	case errors.Is(err, sqlpgq.ErrNotFound):
		writeErr(w, http.StatusNotFound, "graph not found")
	case err != nil:
		writeErr(w, http.StatusBadGateway, err.Error())
	default:
		writeJSON(w, http.StatusOK, md)
	}
}

func (s *Server) getGraphCounts(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	oid, ok := parseOID(w, r)
	if !ok {
		return
	}
	counts, err := sqlpgq.GetCounts(r.Context(), sess.Pool, oid)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"counts": counts})
}

// requireSession resolves the URL :sid or writes 404 and returns ok=false.
func (s *Server) requireSession(w http.ResponseWriter, r *http.Request) (*session.Session, bool) {
	sid := chi.URLParam(r, "sid")
	sess, err := s.sessions.Get(sid)
	if err != nil {
		writeErr(w, http.StatusNotFound, "session not found")
		return nil, false
	}
	return sess, true
}

// parseOID parses the URL :oid as a uint32 or writes 400 and returns ok=false.
func parseOID(w http.ResponseWriter, r *http.Request) (uint32, bool) {
	raw := chi.URLParam(r, "oid")
	v, err := strconv.ParseUint(raw, 10, 32)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid oid")
		return 0, false
	}
	return uint32(v), true
}

// --- helpers ---------------------------------------------------------------

func labelFor(in pg.ConnectInput) string {
	if in.DSN != "" {
		return "dsn"
	}
	host := in.Host
	if host == "" {
		host = "localhost"
	}
	port := in.Port
	if port == 0 {
		port = 5432
	}
	db := in.Database
	if db == "" {
		db = "postgres"
	}
	return host + ":" + strconv.Itoa(port) + "/" + db
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]any{"error": msg})
}
