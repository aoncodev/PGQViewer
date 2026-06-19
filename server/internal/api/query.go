package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/aoncodev/PGQViewer/server/internal/sqlpgq"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
)

// queryRequest is the JSON payload for POST /sessions/{sid}/query.
//
// Mode "sql" runs the statement verbatim. Mode "graph" runs an auto-projected
// SELECT against GRAPH_TABLE; see sqlpgq.BuildProjection.
type queryRequest struct {
	Mode string `json:"mode"`
	// SQL: required when mode == "sql".
	SQL string `json:"sql,omitempty"`
	// Graph-mode payload: required when mode == "graph".
	GraphOID uint32           `json:"graph_oid,omitempty"`
	Match    string           `json:"match,omitempty"`
	Where    string           `json:"where,omitempty"`
	Limit    int              `json:"limit,omitempty"`
	Bindings []sqlpgq.Binding `json:"bindings,omitempty"`
	// Optional lateral form: when From is non-empty, the projection becomes
	//   SELECT * FROM <From...>, GRAPH_TABLE (...) <LateralAlias>
	// (GRAPH_TABLE is implicitly lateral; PG19 rejects an explicit LATERAL here)
	// From items are raw SQL fragments — caller-supplied, caller-trusted.
	From         []string `json:"from,omitempty"`
	LateralAlias string   `json:"lateral_alias,omitempty"`
	// Columns is a graph-mode-only custom COLUMNS list. When non-empty the
	// projection emits these expressions VERBATIM in place of the synthesized
	// vertex/edge columns, and the result streams through the columns/rows
	// path (like SQL mode) instead of producing graph events. Each entry is a
	// raw SQL fragment — caller-supplied, caller-trusted, exactly like Where
	// and From. Empty preserves auto-projection (vertex/edge events).
	Columns []string `json:"columns,omitempty"`
	// Params is the positional bind list for parameterised SQL ($1, $2, ...).
	// Honoured in both "sql" mode and "graph" mode (the projected GRAPH_TABLE
	// SELECT forwards them to PostgreSQL).
	Params []any `json:"params,omitempty"`
	// Explain / ExplainAnalyze request a query plan instead of results. When
	// either is set the statement is wrapped in EXPLAIN (FORMAT JSON [, ANALYZE])
	// and a single {"type":"explain","plan": <json>} event is emitted in place
	// of the normal columns/rows or vertex/edge stream. ExplainAnalyze implies
	// EXPLAIN and additionally executes the statement (side effects included),
	// so it is only meaningful for read-only queries here.
	Explain        bool `json:"explain,omitempty"`
	ExplainAnalyze bool `json:"explain_analyze,omitempty"`
	// ElementCap is a graph-mode-only post-dedup safety net. We stop
	// emitting vertex/edge events once `unique_vertices + unique_edges`
	// reaches this value, regardless of how many rows the underlying
	// query still has to produce. Complements the row-level LIMIT
	// because dedup ratio is unpredictable: 3000 rows with a hub-dense
	// fan-out can dedup to 100 unique vertices, while 3000 rows over a
	// sparse graph can dedup to 6000 unique elements. A non-positive
	// value falls back to defaultElementCap; the renderer normally
	// omits the field and accepts the default.
	ElementCap int `json:"element_cap,omitempty"`
}

// defaultElementCap protects the renderer from a runaway fan-out even
// when the client doesn't set ElementCap. 10k matches the
// canvas-element budget Cytoscape can render smoothly on a mid-range
// laptop; anything beyond gets stutter regardless of what we stream.
const defaultElementCap = 10_000

// poolQuerier is the slice of *pgxpool.Pool we use here.
type poolQuerier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// newQueryID returns a 128-bit random hex string used to address one in-flight
// query in the session's cancel map. Collisions inside a session would have
// to occur within a single user's parallel runs, which is impractical.
func newQueryID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// query streams the result of a SQL statement as application/x-ndjson.
//
// Event types written, in order:
//
//	{"type":"columns", "columns":[{"name":...,"type":...,"type_oid":...}, ...]}
//	{"type":"row",     "row":[v1, v2, ...]}            (one per result row)
//	{"type":"stats",   "rows":N, "command":"SELECT", "db_rows":N}
//	{"type":"summary", "elapsed_ms":N}
//
// Graph mode (auto-projection) instead emits {"type":"vertex"...} /
// {"type":"edge"...} events. Graph mode with a custom COLUMNS list
// (req.Columns) streams the columns/rows path above, like SQL mode.
//
// EXPLAIN: when req.Explain or req.ExplainAnalyze is set (either mode), the
// statement is wrapped in EXPLAIN (FORMAT JSON [, ANALYZE]) and a single
// event is emitted in place of the data stream:
//
//	{"type":"explain", "plan": <decoded json plan>}
//
// Errors discovered after streaming begins are reported in-band:
//
//	{"type":"error", "error":"<msg>"}
//
// Pre-flight failures (bad body, session not found) return a normal JSON
// error with an HTTP error status code.
func (s *Server) query(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}

	var req queryRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json body")
		return
	}
	if err := validateQueryRequest(req); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, http.StatusInternalServerError, "response writer does not support streaming")
		return
	}

	projected, ok := prepareProjection(w, r, sess.Pool, req)
	if !ok {
		return
	}

	// Acquire a connection up-front so we can pin the query to a single
	// backend PID — required for /queries/{qid}/cancel to call
	// pg_cancel_backend on the right session.
	sid := chi.URLParam(r, "sid")
	qid := newQueryID()

	conn, err := sess.Pool.Acquire(r.Context())
	if err != nil {
		writeErr(w, http.StatusBadGateway, "acquire conn: "+err.Error())
		return
	}
	defer conn.Release()

	var pid int32
	if err := conn.QueryRow(r.Context(), `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
		writeErr(w, http.StatusBadGateway, "pg_backend_pid: "+err.Error())
		return
	}
	s.sessions.RegisterPID(sid, qid, pid)
	defer s.sessions.UnregisterPID(sid, qid)

	w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("X-Query-ID", qid)
	w.WriteHeader(http.StatusOK)

	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	start := time.Now()

	explain := req.Explain || req.ExplainAnalyze

	var streamErr error
	rowCount := 0
	switch req.Mode {
	case "sql":
		// Emit a meta event up-front so the client can correlate qid with the
		// rest of the stream (and stash it for cancellation), even when the
		// body is empty/short.
		_ = enc.Encode(map[string]any{
			"type":        "meta",
			"qid":         qid,
			"backend_pid": pid,
		})
		flusher.Flush()
		if explain {
			streamErr = streamExplain(r.Context(), conn, req.SQL, req.Params, req.ExplainAnalyze, enc, flusher)
		} else {
			streamErr = streamSQL(r.Context(), conn, req.SQL, req.Params, enc, flusher, &rowCount)
		}
	case "graph":
		// Emit a one-line meta event so the client can render binding shapes
		// (which fields are vertices vs edges, label sets, etc.) before any
		// data arrives. For a custom-COLUMNS (tabular) query there is no
		// binding decoder, so the bindings field is omitted.
		elementCap := req.ElementCap
		if elementCap <= 0 {
			elementCap = defaultElementCap
		}
		meta := map[string]any{
			"type":        "meta",
			"qid":         qid,
			"backend_pid": pid,
			"sql":         projected.SQL,
			"element_cap": elementCap,
		}
		if projected.Decoder != nil {
			meta["bindings"] = projected.Decoder.BindingViews()
		}
		if projected.Tabular {
			meta["tabular"] = true
		}
		if len(projected.ColumnMap) > 0 {
			meta["column_map"] = projected.ColumnMap
		}
		if len(projected.Trimmed) > 0 {
			meta["trimmed"] = projected.Trimmed
		}
		if len(projected.Warnings) > 0 {
			meta["warnings"] = projected.Warnings
		}
		_ = enc.Encode(meta)
		flusher.Flush()
		switch {
		case explain:
			streamErr = streamExplain(r.Context(), conn, projected.SQL, projected.Params, req.ExplainAnalyze, enc, flusher)
		case projected.Tabular:
			// Custom COLUMNS: no graph events to decode, stream raw rows.
			streamErr = streamSQL(r.Context(), conn, projected.SQL, projected.Params, enc, flusher, &rowCount)
		default:
			streamErr = streamGraph(r.Context(), conn, projected, enc, flusher, &rowCount, elementCap)
		}
	}

	elapsed := time.Since(start).Milliseconds()

	if streamErr != nil {
		_ = enc.Encode(errorEvent(streamErr))
		flusher.Flush()
		s.logger.Warn("query failed", "sid", sid, "qid", qid, "err", streamErr)
		return
	}

	_ = enc.Encode(map[string]any{
		"type":       "summary",
		"elapsed_ms": elapsed,
	})
	flusher.Flush()
}

// validateQueryRequest checks the mode-specific required fields of a query
// request. A non-nil error is always a client (HTTP 400) error.
func validateQueryRequest(req queryRequest) error {
	switch req.Mode {
	case "sql":
		if req.SQL == "" {
			return errors.New("sql is required")
		}
	case "graph":
		if req.GraphOID == 0 {
			return errors.New("graph_oid is required")
		}
		if req.Match == "" {
			return errors.New("match is required")
		}
		if len(req.Bindings) == 0 {
			return errors.New("bindings is required")
		}
		// Custom COLUMNS entries are caller-trusted raw SQL fragments, but
		// each must be a non-empty string — an empty fragment yields invalid
		// SQL (a bare comma in the COLUMNS list).
		for i, c := range req.Columns {
			if strings.TrimSpace(c) == "" {
				return fmt.Errorf("columns[%d] must not be empty", i)
			}
		}
	default:
		return errors.New("mode must be 'sql' or 'graph'")
	}
	return nil
}

// prepareProjection builds the graph-mode ProjectedQuery. For sql mode there
// is nothing to project, so it returns (nil, true). On failure it writes the
// HTTP error itself and returns ok=false, mirroring requireSession/parseOID.
func prepareProjection(
	w http.ResponseWriter, r *http.Request, db sqlpgq.Queryer, req queryRequest,
) (*sqlpgq.ProjectedQuery, bool) {
	if req.Mode != "graph" {
		return nil, true
	}
	md, err := sqlpgq.GetMetadata(r.Context(), db, req.GraphOID)
	if err != nil {
		if errors.Is(err, sqlpgq.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "graph not found")
		} else {
			writeErr(w, http.StatusBadGateway, err.Error())
		}
		return nil, false
	}
	// Always go through the struct entry point so custom Columns, Params, and
	// the lateral From form are all honoured. With none of those set the
	// result is identical to the original BuildProjection path.
	projected, err := sqlpgq.BuildProjectionWithOpts(sqlpgq.ProjectionOpts{
		Metadata:     md,
		Bindings:     req.Bindings,
		Match:        req.Match,
		Where:        req.Where,
		Limit:        req.Limit,
		LateralFrom:  req.From,
		LateralAlias: req.LateralAlias,
		Columns:      req.Columns,
		Params:       req.Params,
	})
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return nil, false
	}
	return projected, true
}

// flushEvery is how many rows the streaming handlers buffer before forcing
// an http.Flusher flush — a throughput/latency trade-off shared by every
// row loop in this package.
const flushEvery = 64

// streamGraph guards (todo.md #6). These sit alongside the post-dedup element
// cap to bound work the element cap can't see:
//
//   - defaultScannedRowCap bounds raw rows scanned. A hub-dense fan-out can
//     dedup thousands of rows down to a handful of unique elements, so the
//     element cap never trips while the DB keeps streaming. This caps that.
//   - defaultGraphWallClock bounds wall-clock time spent in the row loop, so
//     a pathological plan can't hold the connection (and the client) forever.
//
// Row-level LIMIT (req.Limit) still applies in SQL and is the primary control;
// these are last-resort server-side stops. The stats event carries a
// `truncated_reason` naming which guard fired.
const (
	defaultScannedRowCap  = 200_000
	defaultGraphWallClock = 30 * time.Second
)

// streamGraph runs the projected GRAPH_TABLE query and emits one
// vertex/edge event per binding per row. Deduplication is the client's
// responsibility — but we apply a post-dedup element cap server-side
// (elementCap arg) as a safety net so the client never gets a runaway
// fan-out it has no way to refuse. Once the count of unique vertices +
// unique edges reaches the cap we stop emitting and finish the stream
// with `truncated: true` in the stats event.
func streamGraph(ctx context.Context, pool poolQuerier, pq *sqlpgq.ProjectedQuery, enc *json.Encoder, flusher http.Flusher, out *int, elementCap int) error {
	// Forward the projection's bind parameters ($1, $2, ...). nil for a
	// literal statement, which is the common case.
	rows, err := pool.Query(ctx, pq.SQL, pq.Params...)
	if err != nil {
		return fmt.Errorf("query: %w", err)
	}
	defer rows.Close()

	rowCount := 0
	vertexCount := 0
	edgeCount := 0
	seenV := make(map[string]struct{})
	seenE := make(map[string]struct{})
	truncated := false
	// truncReason names which guard stopped the stream: "element_cap",
	// "scanned_rows", or "wall_clock". Empty when we ran to completion.
	truncReason := ""
	deadline := time.Now().Add(defaultGraphWallClock)

	for rows.Next() {
		if elementCap > 0 && len(seenV)+len(seenE) >= elementCap {
			truncated, truncReason = true, "element_cap"
			break
		}
		if rowCount >= defaultScannedRowCap {
			truncated, truncReason = true, "scanned_rows"
			break
		}
		if time.Now().After(deadline) {
			truncated, truncReason = true, "wall_clock"
			break
		}
		vals, err := rows.Values()
		if err != nil {
			return fmt.Errorf("scan row %d: %w", rowCount, err)
		}
		// Synthesize ids from the raw row (before jsonifyRow rewrites numerics
		// and friends into id-unstable display forms); properties use the
		// jsonified row. See RowDecoder.DecodeRaw.
		raw := append([]any(nil), vals...)
		jsonifyRow(vals)
		for _, ev := range pq.Decoder.DecodeRaw(raw, vals) {
			// Drop already-seen ids quietly. Saves bytes on the wire and
			// gives our cap a precise meaning ("unique elements" not
			// "decode events").
			switch ev.Kind {
			case sqlpgq.EventVertex:
				if _, dup := seenV[ev.ID]; dup {
					continue
				}
				seenV[ev.ID] = struct{}{}
				vertexCount++
			case sqlpgq.EventEdge:
				if _, dup := seenE[ev.ID]; dup {
					continue
				}
				seenE[ev.ID] = struct{}{}
				edgeCount++
			}
			if err := enc.Encode(ev); err != nil {
				return fmt.Errorf("encode event: %w", err)
			}
			if elementCap > 0 && len(seenV)+len(seenE) >= elementCap {
				truncated, truncReason = true, "element_cap"
				break
			}
		}
		rowCount++
		if rowCount%flushEvery == 0 {
			flusher.Flush()
		}
		if truncated {
			break
		}
	}
	if !truncated {
		if err := rows.Err(); err != nil {
			return err
		}
	}
	*out = rowCount
	stats := map[string]any{
		"type":      "stats",
		"rows":      rowCount,
		"vertices":  vertexCount,
		"edges":     edgeCount,
		"truncated": truncated,
	}
	if truncReason != "" {
		stats["truncated_reason"] = truncReason
	}
	return enc.Encode(stats)
}

// streamExplain runs a statement under EXPLAIN (FORMAT JSON [, ANALYZE]) and
// emits a single {"type":"explain","plan": <plan>} NDJSON event. The plan
// comes back as a single json/jsonb column whose value pgx hands us as
// already-decoded Go data (map/slice/scalar via encoding/json), so we forward
// it verbatim. analyze=true adds ANALYZE, which executes the statement — only
// safe for read-only queries, which is all the viewer issues.
//
// The statement runs on the caller's pinned connection (same as streamSQL /
// streamGraph), so /queries/{qid}/cancel can still cancel it.
func streamExplain(ctx context.Context, pool poolQuerier, sql string, params []any, analyze bool, enc *json.Encoder, flusher http.Flusher) error {
	var sb strings.Builder
	sb.WriteString("EXPLAIN (FORMAT JSON")
	if analyze {
		sb.WriteString(", ANALYZE")
	}
	sb.WriteString(") ")
	sb.WriteString(sql)

	rows, err := pool.Query(ctx, sb.String(), params...)
	if err != nil {
		return fmt.Errorf("explain: %w", err)
	}
	defer rows.Close()

	var plan any
	if rows.Next() {
		vals, err := rows.Values()
		if err != nil {
			return fmt.Errorf("scan explain row: %w", err)
		}
		if len(vals) > 0 {
			plan = vals[0]
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}

	if err := enc.Encode(map[string]any{"type": "explain", "plan": plan}); err != nil {
		return fmt.Errorf("encode explain: %w", err)
	}
	flusher.Flush()
	return nil
}

// streamSQL runs one statement and writes columns, rows, and a stats event.
// The caller is responsible for the wall-clock summary. The row count is
// written through `out` so the caller can record query history.
//
// params is the positional bind list ($1, $2, ...); pass nil for a literal
// statement. pgx handles type inference per the wire protocol.
func streamSQL(ctx context.Context, pool poolQuerier, sql string, params []any, enc *json.Encoder, flusher http.Flusher, out *int) error {
	rows, err := pool.Query(ctx, sql, params...)
	if err != nil {
		return fmt.Errorf("query: %w", err)
	}
	defer rows.Close()

	fds := rows.FieldDescriptions()
	cols := make([]columnInfo, len(fds))
	tm := pgtype.NewMap()
	for i, fd := range fds {
		cols[i] = columnInfo{
			Name:    fd.Name,
			TypeOID: fd.DataTypeOID,
			Type:    typeName(tm, fd.DataTypeOID),
		}
	}
	if err := enc.Encode(map[string]any{"type": "columns", "columns": cols}); err != nil {
		return fmt.Errorf("encode columns: %w", err)
	}
	flusher.Flush()

	rowCount := 0
	for rows.Next() {
		vals, err := rows.Values()
		if err != nil {
			return fmt.Errorf("scan row %d: %w", rowCount, err)
		}
		jsonifyRow(vals)
		if err := enc.Encode(map[string]any{"type": "row", "row": vals}); err != nil {
			return fmt.Errorf("encode row %d: %w", rowCount, err)
		}
		rowCount++
		if rowCount%flushEvery == 0 {
			flusher.Flush()
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}

	tag := rows.CommandTag()
	*out = rowCount
	if err := enc.Encode(map[string]any{
		"type":    "stats",
		"rows":    rowCount,
		"command": tag.String(),
		"db_rows": tag.RowsAffected(),
	}); err != nil {
		return err
	}
	flusher.Flush()
	return nil
}

type columnInfo struct {
	Name    string `json:"name"`
	Type    string `json:"type"`
	TypeOID uint32 `json:"type_oid"`
}

func typeName(tm *pgtype.Map, oid uint32) string {
	if t, ok := tm.TypeForOID(oid); ok {
		return t.Name
	}
	return fmt.Sprintf("oid:%d", oid)
}

// errorEvent renders an in-band {"type":"error",...} event for the
// streaming NDJSON response. When the underlying error is a
// *pgconn.PgError, the structured PostgreSQL fields (code, detail, hint,
// position, ...) are surfaced alongside the message so the renderer can
// pattern-map them to friendlier UI hints.
func errorEvent(err error) map[string]any {
	ev := map[string]any{"type": "error", "error": err.Error()}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		ev["error"] = pgErr.Message
		if pgErr.Code != "" {
			ev["code"] = pgErr.Code
		}
		if pgErr.Detail != "" {
			ev["detail"] = pgErr.Detail
		}
		if pgErr.Hint != "" {
			ev["hint"] = pgErr.Hint
		}
		if pgErr.Position != 0 {
			ev["position"] = pgErr.Position
		}
		if pgErr.InternalPosition != 0 {
			ev["internal_position"] = pgErr.InternalPosition
		}
		if pgErr.Where != "" {
			ev["where"] = pgErr.Where
		}
		if pgErr.SchemaName != "" {
			ev["schema"] = pgErr.SchemaName
		}
		if pgErr.TableName != "" {
			ev["table"] = pgErr.TableName
		}
		if pgErr.ColumnName != "" {
			ev["column"] = pgErr.ColumnName
		}
		if pgErr.ConstraintName != "" {
			ev["constraint"] = pgErr.ConstraintName
		}
		if pgErr.Severity != "" {
			ev["severity"] = pgErr.Severity
		}
	}
	return ev
}

// jsonify patches values that pgx returns but encoding/json doesn't handle
// cleanly. Two failure modes we care about:
//
//   - precision loss: int64 > 2^53 and pgtype.Numeric serialize as JSON
//     numbers and the renderer decodes them as JavaScript Numbers, dropping
//     digits. We stringify so the renderer can choose how to display them.
//
//   - opaque structs: pgtype.Interval, pgtype.Timestamp(tz)/Date, and
//     pgtype.UUID marshal to JSON as their Go-struct shapes, which the UI
//     can't render. We stringify to the canonical PG text form.
//
// We intentionally don't touch values that already JSON-encode cleanly
// (regular int/int32/float, strings, bool, time.Time, nil) — the renderer
// already handles those correctly.
// jsSafeIntMax is 2^53. Integers beyond ±this lose precision when parsed
// as a JavaScript Number, so jsonify stringifies anything outside the range.
const jsSafeIntMax = 1 << 53

func jsonify(v any) any {
	switch x := v.(type) {
	case nil:
		return nil
	case []byte:
		return "\\x" + hex.EncodeToString(x)
	case [16]byte:
		return sqlpgq.FormatUUIDBytes(x)
	case int64:
		// JS Number safely represents integers up to 2^53. Stringify
		// anything that could lose precision; small int64 values still
		// stringify, which is harmless and consistent.
		if x > jsSafeIntMax || x < -jsSafeIntMax {
			return strconv.FormatInt(x, 10)
		}
		return x
	case uint64:
		if x > jsSafeIntMax {
			return strconv.FormatUint(x, 10)
		}
		return x
	case pgtype.Numeric:
		if !x.Valid {
			return nil
		}
		s, err := x.Value()
		if err != nil || s == nil {
			return nil
		}
		if str, ok := s.(string); ok {
			return str
		}
		return s
	case pgtype.UUID:
		if !x.Valid {
			return nil
		}
		return sqlpgq.FormatUUIDBytes(x.Bytes)
	case pgtype.Interval:
		if !x.Valid {
			return nil
		}
		// Canonical text form: "<months> mons <days> days <us> us".
		// We emit the standard ISO 8601 form via a manual conversion to
		// keep things human-readable.
		return formatInterval(x)
	}
	return v
}

// jsonifyRow rewrites every value of a result row in place into its
// JSON-friendly form. See jsonify for the per-value rules.
func jsonifyRow(vals []any) {
	for i, v := range vals {
		vals[i] = jsonify(v)
	}
}

// formatInterval renders a pgtype.Interval as a Postgres-compatible text
// string. Layout matches `IntervalStyle = postgres`, which is the default
// the user is most likely to see in psql.
func formatInterval(iv pgtype.Interval) string {
	years := iv.Months / 12
	months := iv.Months % 12
	var sb strings.Builder
	wrote := false
	emit := func(n int, unit string) {
		if n == 0 {
			return
		}
		if wrote {
			sb.WriteByte(' ')
		}
		fmt.Fprintf(&sb, "%d %s", n, unit)
		wrote = true
	}
	emit(int(years), "years")
	emit(int(months), "mons")
	emit(int(iv.Days), "days")
	if iv.Microseconds != 0 {
		secs := iv.Microseconds / 1_000_000
		us := iv.Microseconds % 1_000_000
		if wrote {
			sb.WriteByte(' ')
		}
		hh := secs / 3600
		mm := (secs % 3600) / 60
		ss := secs % 60
		if us != 0 {
			fmt.Fprintf(&sb, "%02d:%02d:%02d.%06d", hh, mm, ss, us)
		} else {
			fmt.Fprintf(&sb, "%02d:%02d:%02d", hh, mm, ss)
		}
		wrote = true
	}
	if !wrote {
		return "00:00:00"
	}
	return sb.String()
}
