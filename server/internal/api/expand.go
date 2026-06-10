package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/aoncodev/PGQViewer/server/internal/sqlpgq"
)

// ExpandRoute is the canonical URL pattern that wires (*Server).expand onto
// the chi router. Match the existing PathfindRoute style so router setup
// code can read the path from one place.
//
//	r.Post(api.ExpandRoute, s.Expand)
//
// matches POST /api/v1/sessions/{sid}/graphs/{oid}/expand.
const ExpandRoute = "/{sid}/graphs/{oid}/expand"

// expandRequest is the JSON payload for POST
// /sessions/{sid}/graphs/{oid}/expand.
//
// AnchorElementOID identifies the *vertex* element the user double-clicked
// (e.g. the OID of the "people" vertex). AnchorPK carries the synthesized PK
// values for that vertex as positional strings — the same ones embedded in
// the Cytoscape node id `<elemOID>:<pk1,pk2>`. EdgeLabels optionally
// restricts the expansion to a subset of incident edge types; empty means
// every edge that touches the anchor.
type expandRequest struct {
	AnchorElementOID uint32   `json:"anchor_element_oid"`
	AnchorPK         []string `json:"anchor_pk"`
	EdgeLabels       []string `json:"edge_labels,omitempty"`
	Limit            int      `json:"limit,omitempty"`
}

// expand streams the 1-hop neighbourhood of a vertex as NDJSON.
//
// Event types are identical to the /query handler so the renderer can reuse
// the same dispatch path:
//
//	{"type":"meta",    "queries":[{sql, bindings}, ...]}
//	{"type":"vertex",  ...}     // per binding per row, dedup is client-side
//	{"type":"edge",    ...}
//	{"type":"stats",   "rows":N, "vertices":V, "edges":E}
//	{"type":"summary", "elapsed_ms":N}
//	{"type":"error",   "error":"..."}
//
// PG19 forbids multi-path MATCH inside one GRAPH_TABLE, so the implementation
// builds one query per (edge element × direction). We stream them
// sequentially and accumulate stats; the meta event lists every sub-SQL up
// front so the UI can show them in EXPLAIN-style detail later (M7).
//
// Exported (capital "E") to mirror the Pathfind handler — the router setup
// in api.go references it directly.
func (s *Server) Expand(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	oid, ok := parseOID(w, r)
	if !ok {
		return
	}

	var req expandRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json body")
		return
	}
	if req.AnchorElementOID == 0 {
		writeErr(w, http.StatusBadRequest, "anchor_element_oid is required")
		return
	}
	if len(req.AnchorPK) == 0 {
		writeErr(w, http.StatusBadRequest, "anchor_pk is required")
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, http.StatusInternalServerError, "response writer does not support streaming")
		return
	}

	md, err := sqlpgq.GetMetadata(r.Context(), sess.Pool, oid)
	if err != nil {
		if errors.Is(err, sqlpgq.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "graph not found")
			return
		}
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}

	// Locate the anchor vertex element in this graph's metadata.
	var anchor *sqlpgq.Element
	for i := range md.Vertices {
		if md.Vertices[i].OID == req.AnchorElementOID {
			anchor = &md.Vertices[i]
			break
		}
	}
	if anchor == nil {
		writeErr(w, http.StatusBadRequest,
			fmt.Sprintf("anchor element oid %d is not a vertex of graph %s.%s",
				req.AnchorElementOID, md.Graph.Schema, md.Graph.Name))
		return
	}
	if len(anchor.PK) != len(req.AnchorPK) {
		writeErr(w, http.StatusBadRequest,
			fmt.Sprintf("anchor_pk length %d does not match element PK arity %d",
				len(req.AnchorPK), len(anchor.PK)))
		return
	}

	queries, err := sqlpgq.BuildExpansion(md, anchor, req.AnchorPK, req.EdgeLabels, req.Limit)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	start := time.Now()

	// One meta event up front, listing every sub-query. Each carries its own
	// binding view since binding-set layouts may differ across queries
	// (different neighbour element). The client can ignore this if it just
	// wants to merge vertex / edge events into the canvas.
	type metaSub struct {
		SQL      string                  `json:"sql"`
		Bindings []sqlpgq.BindingView    `json:"bindings"`
	}
	subs := make([]metaSub, 0, len(queries))
	for _, q := range queries {
		subs = append(subs, metaSub{
			SQL:      q.SQL,
			Bindings: q.Decoder.BindingViews(),
		})
	}
	_ = enc.Encode(map[string]any{
		"type":    "meta",
		"mode":    "expand",
		"queries": subs,
	})
	flusher.Flush()

	totalRows := 0
	totalVertices := 0
	totalEdges := 0
	var streamErr error
	for i, q := range queries {
		subRows := 0
		subVertices := 0
		subEdges := 0
		if err := streamExpandOne(r.Context(), sess.Pool, q, enc, flusher, &subRows, &subVertices, &subEdges); err != nil {
			streamErr = fmt.Errorf("subquery %d: %w", i, err)
			break
		}
		totalRows += subRows
		totalVertices += subVertices
		totalEdges += subEdges
	}

	elapsed := time.Since(start).Milliseconds()

	if streamErr != nil {
		_ = enc.Encode(map[string]any{"type": "error", "error": streamErr.Error()})
		flusher.Flush()
		s.logger.Warn("expand failed", "sid", sess.Label, "graph_oid", oid, "err", streamErr)
		return
	}

	_ = enc.Encode(map[string]any{
		"type":     "stats",
		"rows":     totalRows,
		"vertices": totalVertices,
		"edges":    totalEdges,
	})
	_ = enc.Encode(map[string]any{
		"type":       "summary",
		"elapsed_ms": elapsed,
	})
	flusher.Flush()
}

// streamExpandOne runs one sub-query of an expansion. It mirrors streamGraph
// but writes its row/vertex/edge counters into the caller's accumulator
// pointers so the overall handler can emit a single stats event covering
// every sub-query.
func streamExpandOne(
	ctx context.Context,
	pool poolQuerier,
	pq *sqlpgq.ProjectedQuery,
	enc *json.Encoder,
	flusher http.Flusher,
	rowsOut, vertOut, edgeOut *int,
) error {
	rows, err := pool.Query(ctx, pq.SQL)
	if err != nil {
		return fmt.Errorf("query: %w", err)
	}
	defer rows.Close()

	rowCount := 0
	vertexCount := 0
	edgeCount := 0

	for rows.Next() {
		vals, err := rows.Values()
		if err != nil {
			return fmt.Errorf("scan row %d: %w", rowCount, err)
		}
		jsonifyRow(vals)
		for _, ev := range pq.Decoder.Decode(vals) {
			if err := enc.Encode(ev); err != nil {
				return fmt.Errorf("encode event: %w", err)
			}
			switch ev.Kind {
			case sqlpgq.EventVertex:
				vertexCount++
			case sqlpgq.EventEdge:
				edgeCount++
			}
		}
		rowCount++
		if rowCount%flushEvery == 0 {
			flusher.Flush()
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	*rowsOut = rowCount
	*vertOut = vertexCount
	*edgeOut = edgeCount
	return nil
}
