package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

// cancelQuery looks up the backend PID associated with (sid, qid) and calls
// pg_cancel_backend on it. The actual SQL goes through the session pool —
// pg_cancel_backend signals any backend by PID, not just the caller's, so any
// connection in the pool works.
//
// Returns:
//   - 204 when the cancel signal was delivered (the canonical "success" case).
//   - 404 when no in-flight query is registered for (sid, qid).
//   - 502 when the cancel statement itself fails against the server.
//
// Note: a successful 204 only means SIGINT was queued — the running query will
// stop at the next CHECK_FOR_INTERRUPTS, which is usually fast but not
// instant. The client should still wait for the streaming response to end.
func (s *Server) cancelQuery(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	sid := chi.URLParam(r, "sid")
	qid := chi.URLParam(r, "qid")
	if qid == "" {
		writeErr(w, http.StatusBadRequest, "qid is required")
		return
	}

	pid, ok := s.sessions.LookupPID(sid, qid)
	if !ok {
		writeErr(w, http.StatusNotFound, "no in-flight query for that qid")
		return
	}

	var cancelled bool
	if err := sess.Pool.QueryRow(r.Context(), `SELECT pg_cancel_backend($1)`, pid).Scan(&cancelled); err != nil {
		s.logger.Warn("pg_cancel_backend failed", "sid", sid, "qid", qid, "pid", pid, "err", err)
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	s.logger.Info("query cancel requested", "sid", sid, "qid", qid, "pid", pid, "cancelled", cancelled)
	w.WriteHeader(http.StatusNoContent)
}
