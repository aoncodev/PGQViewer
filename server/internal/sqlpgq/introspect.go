// Package sqlpgq is the catalog introspection layer for PostgreSQL 19
// SQL/PGQ property graphs.
//
// It owns the queries against pg_class (relkind='g') and the pg_propgraph_*
// family. It produces typed metadata that powers:
//   - the schema sidebar and meta-chart in the UI,
//   - the COLUMNS auto-projection used by graph-mode queries (M5), and
//   - CodeMirror autocomplete (label/property suggestions).
//
// The package has no HTTP dependencies. It accepts any pgx Queryer so it
// can run against a pool, a connection, or a read-only transaction.
package sqlpgq

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
)

// rowQuerier issues a query that returns rows. Most introspection helpers
// need nothing more; see Queryer for the QueryRow-capable superset.
type rowQuerier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// Queryer is the subset of pgx interfaces GetMetadata needs — it also reads
// the single-row graph header via QueryRow. Satisfied by *pgxpool.Pool,
// *pgx.Conn, and pgx.Tx.
type Queryer interface {
	rowQuerier
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

//go:embed sql/list_graphs.sql
var qListGraphs string

//go:embed sql/graph_header.sql
var qGraphHeader string

//go:embed sql/elements.sql
var qElements string

//go:embed sql/element_labels.sql
var qElementLabels string

//go:embed sql/element_properties.sql
var qElementProperties string

//go:embed sql/element_key_uniqueness.sql
var qElementKeyUniqueness string

// ErrNotFound is returned when a graph oid does not exist or is not a
// property graph.
var ErrNotFound = errors.New("graph not found")

// ListGraphs returns every property graph visible to the current role.
func ListGraphs(ctx context.Context, db rowQuerier) ([]Graph, error) {
	rows, err := db.Query(ctx, qListGraphs)
	if err != nil {
		return nil, fmt.Errorf("list graphs: %w", err)
	}
	defer rows.Close()

	var out []Graph
	for rows.Next() {
		var g Graph
		if err := rows.Scan(&g.OID, &g.Schema, &g.Name, &g.Owner); err != nil {
			return nil, fmt.Errorf("scan graph: %w", err)
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// GetMetadata returns the complete descriptor for a property graph.
//
// Four catalog queries run sequentially against the same Queryer; pass a
// transaction if you need a consistent snapshot under concurrent DDL.
func GetMetadata(ctx context.Context, db Queryer, oid uint32) (*GraphMetadata, error) {
	header, err := scanHeader(ctx, db, oid)
	if err != nil {
		return nil, err
	}

	elements, byOID, err := scanElements(ctx, db, oid)
	if err != nil {
		return nil, err
	}

	if err := attachLabels(ctx, db, oid, byOID); err != nil {
		return nil, err
	}
	if err := attachProperties(ctx, db, oid, byOID); err != nil {
		return nil, err
	}
	if err := attachKeyUniqueness(ctx, db, oid, byOID); err != nil {
		return nil, err
	}

	// Resolve edge endpoints to their vertex alias now that we have the map,
	// and verify that the edge's REFERENCES columns match the referenced
	// vertex element's KEY columns. PG19 does NOT require this (see
	// propgraphcmds.c:371-511 — no PK/KEY check on explicit REFERENCES) so
	// the viewer must detect the mismatch and refuse the projection.
	for i := range elements {
		e := &elements[i]
		if e.Source != nil {
			if v, ok := byOID[e.Source.VertexOID]; ok {
				e.Source.Vertex = v.Alias
				if !sameKeyColumns(e.Source.Ref, v.PK) {
					e.Diagnostics = append(e.Diagnostics, refMismatchDiagnostic(
						"source", e.Alias, v.Alias, e.Source.Ref, v.PK,
					))
				}
			}
		}
		if e.Destination != nil {
			if v, ok := byOID[e.Destination.VertexOID]; ok {
				e.Destination.Vertex = v.Alias
				if !sameKeyColumns(e.Destination.Ref, v.PK) {
					e.Diagnostics = append(e.Diagnostics, refMismatchDiagnostic(
						"destination", e.Alias, v.Alias, e.Destination.Ref, v.PK,
					))
				}
			}
		}
	}

	md := &GraphMetadata{
		Graph:      header.Graph,
		Definition: strings.TrimSpace(header.Definition),
	}
	for _, e := range elements {
		switch e.Kind {
		case "v":
			md.Vertices = append(md.Vertices, e)
		case "e":
			md.Edges = append(md.Edges, e)
		}
	}
	return md, nil
}

// sameKeyColumns reports whether two column lists are equal as ordered
// sequences. We require identical order because the projection emits
// COLUMNS in a positional layout; reordering would require a more involved
// rewrite.
func sameKeyColumns(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// refMismatchDiagnostic builds the user-facing error for an edge whose
// REFERENCES columns don't equal the referenced vertex's KEY columns.
//
// We construct a clear, action-oriented message because the user almost
// always wants to recreate their graph to fix this (the alternative
// projection-time rewrite is on the roadmap but not v1).
func refMismatchDiagnostic(side, edgeAlias, vertexAlias string, ref, pk []string) Diagnostic {
	return Diagnostic{
		Code:     "ref-not-vertex-key",
		Severity: "error",
		Field:    side,
		Message: fmt.Sprintf(
			"edge %q's %s REFERENCES columns (%s) do not match vertex %q's KEY columns (%s); the viewer cannot synthesize matching endpoint ids. Recreate the graph with REFERENCES %s (%s) or change vertex %q's KEY clause.",
			edgeAlias, side, formatColList(ref),
			vertexAlias, formatColList(pk),
			vertexAlias, formatColList(pk),
			vertexAlias,
		),
	}
}

func formatColList(cols []string) string {
	if len(cols) == 0 {
		return "<empty>"
	}
	return strings.Join(cols, ", ")
}

// attachKeyUniqueness flags elements whose KEY columns are not covered by a
// non-partial unique index. See element_key_uniqueness.sql for the criteria.
func attachKeyUniqueness(ctx context.Context, db rowQuerier, graphOID uint32, byOID map[uint32]*Element) error {
	rows, err := db.Query(ctx, qElementKeyUniqueness, graphOID)
	if err != nil {
		return fmt.Errorf("element key uniqueness: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var (
			elOID  uint32
			unique bool
		)
		if err := rows.Scan(&elOID, &unique); err != nil {
			return fmt.Errorf("scan key uniqueness: %w", err)
		}
		if unique {
			continue
		}
		e, ok := byOID[elOID]
		if !ok {
			continue
		}
		e.Diagnostics = append(e.Diagnostics, Diagnostic{
			Code:     "non-unique-key",
			Severity: "warning",
			Message: fmt.Sprintf(
				"element %q's KEY (%s) is not covered by a unique index on %s.%s; rows with duplicate key values will be merged into one node/edge on the canvas.",
				e.Alias, formatColList(e.PK),
				e.Table.Schema, e.Table.Name,
			),
		})
	}
	return rows.Err()
}

// GetCounts returns the planner's row estimate (`pg_class.reltuples`)
// per element backing table, plus the element's labels. Labels are
// attached so the caller can aggregate per-label counts client-side.
//
// We deliberately use the estimate instead of exact `count(*)` because:
//
//  1. Property graphs are views over potentially huge production
//     tables. `count(*)` on a 100M-row table is multi-second; the
//     sidebar shows a number for every element on graph open.
//
//  2. psql's `\d+` shows the same number, so users have a calibrated
//     intuition for its accuracy.
//
//  3. When ANALYZE has never run, reltuples is -1 — we surface that
//     verbatim so the renderer can render an honest "—" instead of
//     pretending we know.
//
// One static query joins pg_propgraph_element to pg_class; no dynamic
// SQL, no per-element round-trips.
func GetCounts(ctx context.Context, db rowQuerier, oid uint32) ([]LabelCount, error) {
	const q = `
		SELECT e.oid, e.pgealias, e.pgekind::text, c.reltuples::bigint
		FROM pg_catalog.pg_propgraph_element e
		JOIN pg_catalog.pg_class c ON c.oid = e.pgerelid
		WHERE e.pgepgid = $1
		ORDER BY e.pgealias`
	rows, err := db.Query(ctx, q, oid)
	if err != nil {
		return nil, fmt.Errorf("counts: %w", err)
	}
	var out []LabelCount
	for rows.Next() {
		var lc LabelCount
		if err := rows.Scan(&lc.ElementOID, &lc.Alias, &lc.Kind, &lc.Count); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan count: %w", err)
		}
		out = append(out, lc)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Second tiny query to attach labels. We collect into a map first
	// rather than holding pointers into `out` — appending to `out`
	// during the first loop may have reallocated the backing array, so
	// any &out[i] taken mid-scan is unsafe by the time we merge.
	if len(out) == 0 {
		return out, nil
	}
	labelRows, err := db.Query(ctx, qElementLabels, oid)
	if err != nil {
		return nil, fmt.Errorf("element labels: %w", err)
	}
	defer labelRows.Close()
	labelsByOID := make(map[uint32][]string)
	for labelRows.Next() {
		var elOID uint32
		var label string
		if err := labelRows.Scan(&elOID, &label); err != nil {
			return nil, fmt.Errorf("scan label: %w", err)
		}
		labelsByOID[elOID] = append(labelsByOID[elOID], label)
	}
	if err := labelRows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		out[i].Labels = labelsByOID[out[i].ElementOID]
	}
	return out, nil
}

// --- internals -------------------------------------------------------------

type headerRow struct {
	Graph      Graph
	Definition string
}

func scanHeader(ctx context.Context, db Queryer, oid uint32) (*headerRow, error) {
	var h headerRow
	err := db.QueryRow(ctx, qGraphHeader, oid).Scan(
		&h.Graph.OID, &h.Graph.Schema, &h.Graph.Name, &h.Graph.Owner, &h.Definition,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("graph header: %w", err)
	}
	return &h, nil
}

func scanElements(ctx context.Context, db rowQuerier, graphOID uint32) ([]Element, map[uint32]*Element, error) {
	rows, err := db.Query(ctx, qElements, graphOID)
	if err != nil {
		return nil, nil, fmt.Errorf("elements: %w", err)
	}
	defer rows.Close()

	var elements []Element
	byOID := make(map[uint32]*Element)

	for rows.Next() {
		var (
			e            Element
			srcVertexOID *uint32
			dstVertexOID *uint32
			pkCols       []string
			srcKeyCols   []string
			srcRefCols   []string
			dstKeyCols   []string
			dstRefCols   []string
		)
		if err := rows.Scan(
			&e.OID, &e.Alias, &e.Kind,
			&e.Table.OID, &e.Table.Schema, &e.Table.Name,
			&srcVertexOID, &dstVertexOID,
			&pkCols, &srcKeyCols, &srcRefCols, &dstKeyCols, &dstRefCols,
		); err != nil {
			return nil, nil, fmt.Errorf("scan element: %w", err)
		}
		e.PK = pkCols
		if e.Kind == "e" {
			if srcVertexOID != nil {
				e.Source = &EdgeEnd{
					VertexOID: *srcVertexOID,
					Key:       srcKeyCols,
					Ref:       srcRefCols,
				}
			}
			if dstVertexOID != nil {
				e.Destination = &EdgeEnd{
					VertexOID: *dstVertexOID,
					Key:       dstKeyCols,
					Ref:       dstRefCols,
				}
			}
		}
		elements = append(elements, e)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}

	// Build the by-OID map only after the slice is fully populated, so the
	// pointers remain valid across appends.
	for i := range elements {
		byOID[elements[i].OID] = &elements[i]
	}
	return elements, byOID, nil
}

func attachLabels(ctx context.Context, db rowQuerier, graphOID uint32, byOID map[uint32]*Element) error {
	rows, err := db.Query(ctx, qElementLabels, graphOID)
	if err != nil {
		return fmt.Errorf("element labels: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var elOID uint32
		var label string
		if err := rows.Scan(&elOID, &label); err != nil {
			return fmt.Errorf("scan label: %w", err)
		}
		if e, ok := byOID[elOID]; ok {
			e.Labels = append(e.Labels, label)
		}
	}
	return rows.Err()
}

func attachProperties(ctx context.Context, db rowQuerier, graphOID uint32, byOID map[uint32]*Element) error {
	rows, err := db.Query(ctx, qElementProperties, graphOID)
	if err != nil {
		return fmt.Errorf("element properties: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var (
			elOID uint32
			p     Property
			expr  *string
		)
		if err := rows.Scan(&elOID, &p.Name, &p.Type, &expr); err != nil {
			return fmt.Errorf("scan property: %w", err)
		}
		p.Expression = expr
		if e, ok := byOID[elOID]; ok {
			e.Properties = append(e.Properties, p)
		}
	}
	return rows.Err()
}

// pgQuoteIdent wraps an identifier in double-quotes, escaping internal quotes.
func pgQuoteIdent(s string) string {
	return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
}

// pgQuoteLit wraps a literal in single-quotes, escaping internal quotes.
func pgQuoteLit(s string) string {
	return `'` + strings.ReplaceAll(s, `'`, `''`) + `'`
}
