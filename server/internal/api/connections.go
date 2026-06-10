package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/aoncodev/PGQViewer/server/internal/pg"
	"github.com/aoncodev/PGQViewer/server/internal/store"
	"github.com/go-chi/chi/v5"
)

// connectionView is the JSON shape we return — never includes the password.
type connectionView struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	Host      string `json:"host"`
	Port      int    `json:"port"`
	Database  string `json:"database"`
	User      string `json:"user"`
	SSLMode   string `json:"sslmode"`
	CreatedAt int64  `json:"created_at"`
	UpdatedAt int64  `json:"updated_at"`
}

func toView(c store.Connection) connectionView {
	return connectionView{
		ID:        c.ID,
		Name:      c.Name,
		Host:      c.Host,
		Port:      c.Port,
		Database:  c.Database,
		User:      c.User,
		SSLMode:   c.SSLMode,
		CreatedAt: c.CreatedAt.Unix(),
		UpdatedAt: c.UpdatedAt.Unix(),
	}
}

func (s *Server) createConnection(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		writeErr(w, http.StatusServiceUnavailable, "app store not initialized")
		return
	}
	var in store.NewConnection
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json body")
		return
	}
	c, err := s.store.CreateConnection(r.Context(), in)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	s.logger.Info("connection saved", "id", c.ID, "name", c.Name)
	writeJSON(w, http.StatusCreated, map[string]any{"connection": toView(c)})
}

func (s *Server) listConnections(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		writeJSON(w, http.StatusOK, map[string]any{"connections": []connectionView{}})
		return
	}
	all, err := s.store.ListConnections(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	out := make([]connectionView, len(all))
	for i, c := range all {
		out[i] = toView(c)
	}
	writeJSON(w, http.StatusOK, map[string]any{"connections": out})
}

func (s *Server) deleteConnection(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		writeErr(w, http.StatusServiceUnavailable, "app store not initialized")
		return
	}
	id, ok := parseInt64ID(w, r)
	if !ok {
		return
	}
	switch err := s.store.DeleteConnection(r.Context(), id); {
	case err == nil:
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, store.ErrNotFound):
		writeErr(w, http.StatusNotFound, "connection not found")
	default:
		writeErr(w, http.StatusInternalServerError, err.Error())
	}
}

// openConnection opens a session against a saved profile (id).
func (s *Server) openConnection(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		writeErr(w, http.StatusServiceUnavailable, "app store not initialized")
		return
	}
	id, ok := parseInt64ID(w, r)
	if !ok {
		return
	}
	c, err := s.store.GetConnection(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "connection not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	pool, err := pg.Open(r.Context(), pg.ConnectInput{
		Host:     c.Host,
		Port:     c.Port,
		Database: c.Database,
		User:     c.User,
		Password: c.Password,
		SSLMode:  c.SSLMode,
	})
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	sid := s.sessions.Add(pool, c.Host+":"+strconv.Itoa(c.Port)+"/"+c.Database)
	s.sessions.Tag(sid, c.ID)
	s.logger.Info("session opened from saved connection", "sid", sid, "connection_id", c.ID)
	writeJSON(w, http.StatusCreated, map[string]any{
		"session_id":    sid,
		"label":         c.Host + ":" + strconv.Itoa(c.Port) + "/" + c.Database,
		"connection_id": c.ID,
	})
}

func parseInt64ID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	raw := chi.URLParam(r, "id")
	v, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid id")
		return 0, false
	}
	return v, true
}
