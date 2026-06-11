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
	// MaxDepth bounds variable-length expansion. 1 (the default when omitted
	// or <= 0) reproduces the historical 1-hop neighbourhood exactly. Values
	// > 1 traverse up to that many hops of each candidate edge element via a
	// WITH RECURSIVE walk (see sqlpgq.BuildRecursiveExpansion). Multi-hop is
	// only meaningful for self-referential edges; for other edges the depth is
	// silently capped at 1.
	MaxDepth int `json:"max_depth,omitempty"`
}

// expand streams the neighbourhood of a vertex as NDJSON. By default this is
// the 1-hop neighbourhood; with max_depth > 1 it streams up to that many hops
// of each candidate edge via a parameterized WITH RECURSIVE walk.
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

	maxDepth := req.MaxDepth
	if maxDepth < 1 {
		maxDepth = 1
	}
	queries, err := sqlpgq.BuildRecursiveExpansion(md, anchor, req.AnchorPK, req.EdgeLabels, req.Limit, maxDepth)
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
		SQL      string               `json:"sql"`
		Bindings []sqlpgq.BindingView `json:"bindings"`
	}
	subs := make([]metaSub, 0, len(queries))
	for _, q := range queries {
		subs = append(subs, metaSub{
			SQL:      q.Query.SQL,
			Bindings: q.Query.Decoder.BindingViews(),
		})
	}
	_ = enc.Encode(map[string]any{
		"type":    "meta",
		"mode":    "expand",
		"queries": subs,
	})
	flusher.Flush()

	// Shared dedup + safety caps across all sub-queries. The expand path
	// previously applied no row/element/time bound at all (DR-3); a single-hop
	// expansion of a high-degree hub could stream unboundedly. Mirror the guards
	// streamGraph enforces on /query, accumulated across sub-queries.
	es := newExpandStream(enc, flusher, defaultElementCap)
	var streamErr error
	for i, q := range queries {
		if es.capHit() {
			break
		}
		if err := streamExpandOne(r.Context(), sess.Pool, q.Query, q.Params, es); err != nil {
			streamErr = fmt.Errorf("subquery %d: %w", i, err)
			break
		}
	}

	elapsed := time.Since(start).Milliseconds()

	if streamErr != nil {
		_ = enc.Encode(map[string]any{"type": "error", "error": streamErr.Error()})
		flusher.Flush()
		s.logger.Warn("expand failed", "sid", sess.Label, "graph_oid", oid, "err", streamErr)
		return
	}

	// Report UNIQUE elements (post-dedup), matching streamGraph — the old
	// per-subquery sum double-counted vertices shared across sub-queries.
	stats := map[string]any{
		"type":      "stats",
		"rows":      es.scanned,
		"vertices":  len(es.seenV),
		"edges":     len(es.seenE),
		"truncated": es.truncated,
	}
	if es.reason != "" {
		stats["truncated_reason"] = es.reason
	}
	_ = enc.Encode(stats)
	_ = enc.Encode(map[string]any{
		"type":       "summary",
		"elapsed_ms": elapsed,
	})
	flusher.Flush()
}

// expandStream accumulates dedup + safety-cap state across an expansion's
// sub-queries. The /expand path otherwise had no row/element/time bound (DR-3);
// these mirror the guards streamGraph enforces on /query so a high-degree
// expansion can't stream without limit. Dedup by synthetic id also gives the
// element cap a precise "unique elements" meaning and stops shared endpoints
// from being double-counted across sub-queries.
type expandStream struct {
	enc        *json.Encoder
	flusher    http.Flusher
	seenV      map[string]struct{}
	seenE      map[string]struct{}
	scanned    int // raw rows scanned across all sub-queries
	deadline   time.Time
	elementCap int // post-dedup unique-element cap
	truncated  bool
	reason     string // "element_cap" | "scanned_rows" | "wall_clock"
}

func newExpandStream(enc *json.Encoder, flusher http.Flusher, elementCap int) *expandStream {
	if elementCap <= 0 {
		elementCap = defaultElementCap
	}
	return &expandStream{
		enc:        enc,
		flusher:    flusher,
		seenV:      map[string]struct{}{},
		seenE:      map[string]struct{}{},
		deadline:   time.Now().Add(defaultGraphWallClock),
		elementCap: elementCap,
	}
}

// capHit reports whether a safety cap has been reached, recording which one.
func (es *expandStream) capHit() bool {
	switch {
	case es.truncated:
		return true
	case len(es.seenV)+len(es.seenE) >= es.elementCap:
		es.truncated, es.reason = true, "element_cap"
	case es.scanned >= defaultScannedRowCap:
		es.truncated, es.reason = true, "scanned_rows"
	case time.Now().After(es.deadline):
		es.truncated, es.reason = true, "wall_clock"
	default:
		return false
	}
	return true
}

// streamExpandOne runs one sub-query of an expansion, emitting deduplicated
// vertex/edge events into the shared expandStream and honouring its caps.
func streamExpandOne(ctx context.Context, pool poolQuerier, pq *sqlpgq.ProjectedQuery, params []any, es *expandStream) error {
	rows, err := pool.Query(ctx, pq.SQL, params...)
	if err != nil {
		return fmt.Errorf("query: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		if es.capHit() {
			break
		}
		vals, err := rows.Values()
		if err != nil {
			return fmt.Errorf("scan row %d: %w", es.scanned, err)
		}
		// Ids from the raw row (pre-jsonify), properties from the jsonified row —
		// see RowDecoder.DecodeRaw.
		raw := append([]any(nil), vals...)
		jsonifyRow(vals)
		for _, ev := range pq.Decoder.DecodeRaw(raw, vals) {
			// Drop already-seen ids so the element cap counts unique elements.
			switch ev.Kind {
			case sqlpgq.EventVertex:
				if _, dup := es.seenV[ev.ID]; dup {
					continue
				}
				es.seenV[ev.ID] = struct{}{}
			case sqlpgq.EventEdge:
				if _, dup := es.seenE[ev.ID]; dup {
					continue
				}
				es.seenE[ev.ID] = struct{}{}
			}
			if err := es.enc.Encode(ev); err != nil {
				return fmt.Errorf("encode event: %w", err)
			}
			if len(es.seenV)+len(es.seenE) >= es.elementCap {
				es.truncated, es.reason = true, "element_cap"
				break
			}
		}
		es.scanned++
		if es.scanned%flushEvery == 0 {
			es.flusher.Flush()
		}
		if es.truncated {
			break
		}
	}
	if !es.truncated {
		if err := rows.Err(); err != nil {
			return err
		}
	}
	return nil
}
