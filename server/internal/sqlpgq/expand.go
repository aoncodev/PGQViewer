package sqlpgq

import (
	"errors"
	"fmt"
	"sort"
	"strings"
)

// BuildExpansion produces one ProjectedQuery per candidate edge element that
// touches the anchor vertex. Each result is a GRAPH_TABLE query of the shape
//
//	MATCH (a IS <anchor_label> WHERE a.<pk1> = '...' AND ...) -[k IS <edge_label>]-> (b)
//
// (or the reversed `<-` form when the anchor is the destination end). The
// caller streams the union of all subqueries — each one independently
// projects the anchor `a`, the edge `k`, and the adjacent vertex `b` so the
// renderer can dedup them into the existing canvas via the synthetic
// `<elemOID>:<pk>` IDs.
//
// PG19 forbids multi-path MATCH inside one GRAPH_TABLE, so each (edge,
// direction) candidate gets its own query.
//
// Parameters:
//   - md         : metadata for the graph the anchor belongs to.
//   - anchor     : the vertex Element that the user double-clicked.
//   - anchorPK   : positional PK values (one per anchor.PK column) as strings.
//                  These are inlined as SQL literals into a `WHERE a.col = '...'`
//                  predicate inside the MATCH. Strings only — for non-string
//                  PK types Postgres performs an implicit cast on the literal.
//   - edgeLabels : optional whitelist of edge labels to follow. Empty means
//                  every edge element that touches the anchor.
//   - limit      : per-subquery LIMIT; 0 disables.
//
// We deliberately don't run a UNION ALL on the server side because each
// candidate edge has its own column layout (different property sets on `b`),
// and BuildProjection picks columns per binding.
func BuildExpansion(md *GraphMetadata, anchor *Element, anchorPK []string, edgeLabels []string, limit int) ([]*ProjectedQuery, error) {
	if md == nil {
		return nil, errors.New("metadata is required")
	}
	if anchor == nil {
		return nil, errors.New("anchor is required")
	}
	if anchor.Kind != "v" {
		return nil, fmt.Errorf("anchor %q is not a vertex element", anchor.Alias)
	}
	if len(anchor.PK) != len(anchorPK) {
		return nil, fmt.Errorf("anchor PK length mismatch: element has %d columns, got %d values", len(anchor.PK), len(anchorPK))
	}
	if len(anchor.PK) == 0 {
		return nil, fmt.Errorf("anchor %q has no primary key", anchor.Alias)
	}

	// Resolve element pointers and build label sets we can check candidate
	// edges against.
	byOID := map[uint32]*Element{}
	for i := range md.Vertices {
		byOID[md.Vertices[i].OID] = &md.Vertices[i]
	}
	for i := range md.Edges {
		byOID[md.Edges[i].OID] = &md.Edges[i]
	}

	// Confirm the anchor really lives in this graph.
	if a, ok := byOID[anchor.OID]; !ok || a.Kind != "v" {
		return nil, fmt.Errorf("anchor element oid %d is not a vertex in this graph", anchor.OID)
	}

	wantLabel := map[string]struct{}{}
	for _, l := range edgeLabels {
		wantLabel[l] = struct{}{}
	}
	edgeLabelMatches := func(e *Element) bool {
		if len(wantLabel) == 0 {
			return true
		}
		for _, l := range e.Labels {
			if _, ok := wantLabel[l]; ok {
				return true
			}
		}
		return false
	}

	// Pick a label for the anchor's `(a IS <label>)` constraint. PG19 only
	// supports disjunction (`|`), so when an element carries multiple labels
	// we OR them together; using the alias works too but the label form is
	// what the user actually typed in the schema.
	anchorLabelExpr, err := labelExpr(anchor.Labels)
	if err != nil {
		return nil, fmt.Errorf("anchor: %w", err)
	}

	// Stable iteration order (so two calls with the same inputs produce
	// queries in the same order — easier to test, easier to debug).
	edgesSorted := make([]*Element, 0, len(md.Edges))
	for i := range md.Edges {
		edgesSorted = append(edgesSorted, &md.Edges[i])
	}
	sort.Slice(edgesSorted, func(i, j int) bool { return edgesSorted[i].Alias < edgesSorted[j].Alias })

	var out []*ProjectedQuery

	for _, e := range edgesSorted {
		if !edgeLabelMatches(e) {
			continue
		}

		edgeLabelExpr, err := labelExpr(e.Labels)
		if err != nil {
			return nil, fmt.Errorf("edge %q: %w", e.Alias, err)
		}

		// "Outgoing": anchor is the SOURCE end → -[k]-> (b).
		if e.Source != nil && e.Source.VertexOID == anchor.OID {
			otherOID := vertexOIDOrZero(e.Destination)
			other, ok := byOID[otherOID]
			if !ok {
				return nil, fmt.Errorf("edge %q: destination vertex oid %d not in this graph", e.Alias, otherOID)
			}
			pq, err := buildOneExpansion(md, anchor, anchorPK, anchorLabelExpr, e, edgeLabelExpr, other, "->", limit)
			if err != nil {
				return nil, fmt.Errorf("expand %q (outgoing): %w", e.Alias, err)
			}
			out = append(out, pq)
		}

		// "Incoming": anchor is the DESTINATION end → <-[k]- (b).
		// Self-edges emit both directions on purpose — they're distinct rows
		// from the PG19 rewriter's perspective and the client dedups by ID
		// anyway.
		if e.Destination != nil && e.Destination.VertexOID == anchor.OID {
			otherOID := vertexOIDOrZero(e.Source)
			other, ok := byOID[otherOID]
			if !ok {
				return nil, fmt.Errorf("edge %q: source vertex oid %d not in this graph", e.Alias, otherOID)
			}
			pq, err := buildOneExpansion(md, anchor, anchorPK, anchorLabelExpr, e, edgeLabelExpr, other, "<-", limit)
			if err != nil {
				return nil, fmt.Errorf("expand %q (incoming): %w", e.Alias, err)
			}
			out = append(out, pq)
		}
	}

	return out, nil
}

// buildOneExpansion assembles a single GRAPH_TABLE query for one
// (anchor, edge, direction) combination and delegates COLUMNS-list
// construction to BuildProjection.
func buildOneExpansion(
	md *GraphMetadata,
	anchor *Element,
	anchorPK []string,
	anchorLabelExpr string,
	edge *Element,
	edgeLabelExpr string,
	other *Element,
	direction string, // "->" or "<-"
	limit int,
) (*ProjectedQuery, error) {
	var match strings.Builder

	// Anchor side, inline WHERE on PK values.
	match.WriteString("(a IS ")
	match.WriteString(anchorLabelExpr)
	match.WriteString(" WHERE ")
	for i, col := range anchor.PK {
		if i > 0 {
			match.WriteString(" AND ")
		}
		fmt.Fprintf(&match, "a.%s = %s", pgQuoteIdent(col), pgQuoteLit(anchorPK[i]))
	}
	match.WriteString(")")

	// Edge token + direction. Cytoscape's id scheme is endpoint-agnostic — we
	// only care that the projection records the correct source / destination
	// so the renderer wires the edge between the existing anchor and the new
	// neighbour.
	if direction == "->" {
		match.WriteString(" -[k IS ")
		match.WriteString(edgeLabelExpr)
		match.WriteString("]-> ")
	} else {
		match.WriteString(" <-[k IS ")
		match.WriteString(edgeLabelExpr)
		match.WriteString("]- ")
	}

	// Neighbour vertex — no IS constraint, so we get whatever the edge
	// connects to. The element_oid is known from the edge endpoint, so the
	// projected ID will still dedup correctly on the client.
	match.WriteString("(b)")

	bindings := []Binding{
		{Alias: "a", ElementOID: anchor.OID},
		{Alias: "k", ElementOID: edge.OID},
		{Alias: "b", ElementOID: other.OID},
	}

	return BuildProjection(md, bindings, match.String(), "", limit)
}

// labelExpr turns a list of labels into the PG19 label expression used after
// `IS`. PG19 only supports disjunction (`|`); we fold all of an element's
// labels into one alternation so `(a IS L1 | L2)` works for multi-labelled
// elements. Returns an error if the element has no labels (which shouldn't
// happen for graphs created via DDL but we defend anyway).
func labelExpr(labels []string) (string, error) {
	if len(labels) == 0 {
		return "", errors.New("element has no labels")
	}
	parts := make([]string, len(labels))
	for i, l := range labels {
		parts[i] = pgQuoteIdent(l)
	}
	return strings.Join(parts, " | "), nil
}

// vertexOIDOrZero is a nil-safe accessor for an edge end. Edge metadata is
// almost always populated for both ends, but defending against nil here keeps
// the expansion builder panic-free on malformed graphs.
func vertexOIDOrZero(e *EdgeEnd) uint32 {
	if e == nil {
		return 0
	}
	return e.VertexOID
}
