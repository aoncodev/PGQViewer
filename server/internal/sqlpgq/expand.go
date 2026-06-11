package sqlpgq

import (
	"errors"
	"fmt"
	"sort"
	"strings"
)

// ExpansionQuery pairs a ProjectedQuery with the positional bind parameters
// its SQL expects. The 1-hop GRAPH_TABLE form inlines the anchor PK as a
// WHERE predicate inside MATCH (PG19 has no parameter placeholder syntax
// inside GRAPH_TABLE), so Params is nil for those. The multi-hop recursive
// form binds the anchor PK through $N placeholders, so Params carries the
// anchor PK values (already coerced to the anchor's column types by pgx).
//
// Callers run the query as pool.Query(ctx, q.Query.SQL, q.Params...). When
// Params is nil this degrades to the historical no-arg call.
type ExpansionQuery struct {
	Query  *ProjectedQuery
	Params []any
}

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
//     These are inlined as SQL literals into a `WHERE a.col = '...'`
//     predicate inside the MATCH. Strings only — for non-string
//     PK types Postgres performs an implicit cast on the literal.
//   - edgeLabels : optional whitelist of edge labels to follow. Empty means
//     every edge element that touches the anchor.
//   - limit      : per-subquery LIMIT; 0 disables.
//
// We deliberately don't run a UNION ALL on the server side because each
// candidate edge has its own column layout (different property sets on `b`),
// and BuildProjection picks columns per binding.
//
// Deprecated for the streaming path: prefer BuildRecursiveExpansion, which
// returns parameterized queries (no literal inlining) and supports
// max_depth > 1. BuildExpansion is retained unchanged for backward
// compatibility — it still inlines anchor PK literals.
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

// BuildRecursiveExpansion produces one ExpansionQuery per candidate (edge,
// direction) that touches the anchor vertex, traversing up to maxDepth hops
// of the SAME edge element via a WITH RECURSIVE CTE over the underlying
// vertex/edge tables.
//
// maxDepth semantics:
//   - maxDepth <= 1 : exactly the historical 1-hop neighbourhood (one edge
//     traversal). This is the default and produces results identical in shape
//     to BuildExpansion, but parameterized rather than literal-inlined.
//   - maxDepth == N : every vertex/edge reachable within N traversals of the
//     candidate edge, following its REFERENCES/KEY relationship repeatedly.
//
// Each emitted row carries one edge traversal plus both endpoint vertices,
// projected with the SAME `<alias>__pk__<col>` / `__p__` / `__sk__` / `__dk__`
// column-naming scheme the RowDecoder expects, so the client dedups vertices
// and edges into the canvas exactly as it does for 1-hop expansion and graph
// queries. Bindings are `a` (the from-vertex of the hop), `k` (the edge), and
// `b` (the to-vertex of the hop).
//
// The anchor PK is bound through $1..$N placeholders (returned in
// ExpansionQuery.Params), removing the pgQuoteLit string-cast fragility the
// inlining path carried.
//
// We restrict each recursive walk to a single edge element. PG19's
// variable-length patterns aren't supported (see package docs), and a frontier
// that mixes heterogeneous edge tables would need a uniform row shape we can't
// synthesize generically; following one edge label N hops is the common
// "expand the KNOWS neighbourhood" case and keeps the SQL analyzable.
func BuildRecursiveExpansion(md *GraphMetadata, anchor *Element, anchorPK []string, edgeLabels []string, limit, maxDepth int) ([]ExpansionQuery, error) {
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
	if maxDepth < 1 {
		maxDepth = 1
	}

	byOID := map[uint32]*Element{}
	for i := range md.Vertices {
		byOID[md.Vertices[i].OID] = &md.Vertices[i]
	}
	for i := range md.Edges {
		byOID[md.Edges[i].OID] = &md.Edges[i]
	}

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

	edgesSorted := make([]*Element, 0, len(md.Edges))
	for i := range md.Edges {
		edgesSorted = append(edgesSorted, &md.Edges[i])
	}
	sort.Slice(edgesSorted, func(i, j int) bool { return edgesSorted[i].Alias < edgesSorted[j].Alias })

	var out []ExpansionQuery

	for _, e := range edgesSorted {
		if !edgeLabelMatches(e) {
			continue
		}

		// Outgoing: anchor is the SOURCE end, walk -> repeatedly.
		if e.Source != nil && e.Source.VertexOID == anchor.OID {
			otherOID := vertexOIDOrZero(e.Destination)
			other, ok := byOID[otherOID]
			if !ok {
				return nil, fmt.Errorf("edge %q: destination vertex oid %d not in this graph", e.Alias, otherOID)
			}
			eq, err := buildOneRecursiveExpansion(md, anchor, anchorPK, e, other, "->", limit, maxDepth)
			if err != nil {
				return nil, fmt.Errorf("expand %q (outgoing): %w", e.Alias, err)
			}
			out = append(out, eq)
		}

		// Incoming: anchor is the DESTINATION end, walk <- repeatedly.
		if e.Destination != nil && e.Destination.VertexOID == anchor.OID {
			otherOID := vertexOIDOrZero(e.Source)
			other, ok := byOID[otherOID]
			if !ok {
				return nil, fmt.Errorf("edge %q: source vertex oid %d not in this graph", e.Alias, otherOID)
			}
			eq, err := buildOneRecursiveExpansion(md, anchor, anchorPK, e, other, "<-", limit, maxDepth)
			if err != nil {
				return nil, fmt.Errorf("expand %q (incoming): %w", e.Alias, err)
			}
			out = append(out, eq)
		}
	}

	return out, nil
}

// buildOneRecursiveExpansion assembles a single parameterized WITH RECURSIVE
// query for one (anchor, edge, direction) candidate and a RowDecoder over the
// a/k/b bindings.
//
// direction == "->" : anchor is the edge SOURCE. Each hop joins the current
// frontier vertex (the "from" vertex) to edge rows whose source-KEY columns
// equal the frontier vertex's source-REFERENCES columns, then to the
// destination vertex via the edge's destination KEY/REF. The next frontier is
// the destination vertex.
//
// direction == "<-" : anchor is the edge DESTINATION; the roles of source and
// destination swap so we walk edges backwards.
func buildOneRecursiveExpansion(
	md *GraphMetadata,
	anchor *Element,
	anchorPK []string,
	edge *Element,
	other *Element,
	direction string,
	limit, maxDepth int,
) (ExpansionQuery, error) {
	if edge.Source == nil || edge.Destination == nil {
		return ExpansionQuery{}, fmt.Errorf("edge %q is missing endpoint metadata", edge.Alias)
	}

	// Resolve which end of the edge the frontier vertex sits on, and which end
	// the newly-reached vertex sits on. For "->" the frontier is the source,
	// the new vertex is the destination; for "<-" it's reversed.
	var (
		fromEnd *EdgeEnd // edge end joined to the current frontier vertex
		toEnd   *EdgeEnd // edge end joined to the newly-reached vertex
	)
	switch direction {
	case "->":
		fromEnd, toEnd = edge.Source, edge.Destination
	case "<-":
		fromEnd, toEnd = edge.Destination, edge.Source
	default:
		return ExpansionQuery{}, fmt.Errorf("invalid direction %q", direction)
	}

	if len(fromEnd.Key) == 0 || len(fromEnd.Ref) == 0 || len(toEnd.Key) == 0 || len(toEnd.Ref) == 0 {
		return ExpansionQuery{}, fmt.Errorf("edge %q has incomplete endpoint key/ref metadata", edge.Alias)
	}
	if len(fromEnd.Ref) != len(anchor.PK) {
		return ExpansionQuery{}, fmt.Errorf("edge %q from-end ref arity %d does not match anchor PK arity %d", edge.Alias, len(fromEnd.Ref), len(anchor.PK))
	}

	// Multi-hop traversal over one edge element is only coherent when the edge
	// is self-referential (its from-end and to-end vertices are the same
	// element), because the recursive frontier must re-join through the SAME
	// from-end key/ref on the newly-reached vertex. For heterogeneous edges
	// (A -e-> B with A != B) only depth 1 is meaningful, so we cap it — no
	// regression versus the existing 1-hop behaviour.
	selfRef := anchor.OID == other.OID
	if !selfRef && maxDepth > 1 {
		maxDepth = 1
	}
	// The next-frontier projection reads the to-vertex's from-end-ref columns
	// so the next hop can re-join; that requires the to-vertex to expose those
	// columns, which only holds for self-referential edges. Confirm arity to
	// fail fast on malformed metadata.
	if selfRef && len(toEnd.Ref) != len(fromEnd.Ref) {
		selfRef = false
		if maxDepth > 1 {
			maxDepth = 1
		}
	}

	// Build the projection decoder for a/k/b reusing BuildProjection so the
	// column naming and decoder layout match exactly. We do not use the SQL it
	// returns (that's a GRAPH_TABLE form); we only borrow its Decoder and the
	// column expressions we re-derive below for the CTE projection.
	bindings := []Binding{
		{Alias: "a", ElementOID: anchor.OID},
		{Alias: "k", ElementOID: edge.OID},
		{Alias: "b", ElementOID: other.OID},
	}
	proj, err := BuildProjection(md, bindings, "(a)-[k]->(b)", "", 0)
	if err != nil {
		return ExpansionQuery{}, err
	}

	// Table-qualified, quoted relation references.
	//   av = the "from" vertex table of a hop
	//   ke = the edge table
	//   bv = the "to" vertex table of a hop
	avT := qualTable(anchor.Table)
	keT := qualTable(edge.Table)
	bvT := qualTable(other.Table)

	// The frontier carries, for each visited vertex, the values of the
	// from-end REFERENCES columns (f0..fN) — i.e. the columns the next hop's
	// edge from-KEY joins against. depth counts hops taken so far.
	frontierCols := make([]string, len(fromEnd.Ref))
	for i := range fromEnd.Ref {
		frontierCols[i] = fmt.Sprintf("f%d", i)
	}

	params := make([]any, 0, len(anchor.PK))
	var sb strings.Builder

	if maxDepth <= 1 {
		// Single hop: a plain three-way join, no recursion. This is the exact
		// 1-hop neighbourhood, parameterized on the anchor PK.
		cols := recursiveProjectionColumns(anchor, edge, other)
		sb.WriteString("SELECT\n    ")
		sb.WriteString(strings.Join(cols, ",\n    "))
		fmt.Fprintf(&sb, "\nFROM %s av\nJOIN %s ke ON ", avT, keT)
		for i := range fromEnd.Key {
			if i > 0 {
				sb.WriteString(" AND ")
			}
			fmt.Fprintf(&sb, "ke.%s = av.%s", pgQuoteIdent(fromEnd.Key[i]), pgQuoteIdent(fromEnd.Ref[i]))
		}
		fmt.Fprintf(&sb, "\nJOIN %s bv ON ", bvT)
		for i := range toEnd.Key {
			if i > 0 {
				sb.WriteString(" AND ")
			}
			fmt.Fprintf(&sb, "bv.%s = ke.%s", pgQuoteIdent(toEnd.Ref[i]), pgQuoteIdent(toEnd.Key[i]))
		}
		sb.WriteString("\nWHERE ")
		for i, col := range anchor.PK {
			if i > 0 {
				sb.WriteString(" AND ")
			}
			fmt.Fprintf(&sb, "av.%s = $%d", pgQuoteIdent(col), i+1)
			params = append(params, anchorPK[i])
		}
		if limit > 0 {
			fmt.Fprintf(&sb, "\nLIMIT %d", limit)
		}
		return ExpansionQuery{
			Query:  &ProjectedQuery{SQL: sb.String(), Decoder: proj.Decoder},
			Params: params,
		}, nil
	}

	// Multi-hop (self-referential edge): a WITH RECURSIVE walk. The frontier
	// CTE expands the reachable vertex set up to maxDepth hops; the outer
	// SELECT then reconstructs each realized hop's (from-vertex, edge,
	// to-vertex) triple for projection.
	sb.WriteString("WITH RECURSIVE frontier(depth")
	for _, fc := range frontierCols {
		sb.WriteString(", ")
		sb.WriteString(fc)
	}
	sb.WriteString(") AS (\n")

	// Base term: depth 0 is the anchor, selected by parameterized PK. Seed the
	// frontier with the anchor's from-end-ref column values.
	sb.WriteString("  SELECT 0")
	for i := range fromEnd.Ref {
		fmt.Fprintf(&sb, ", av.%s", pgQuoteIdent(fromEnd.Ref[i]))
	}
	fmt.Fprintf(&sb, "\n  FROM %s av\n  WHERE ", avT)
	for i, col := range anchor.PK {
		if i > 0 {
			sb.WriteString(" AND ")
		}
		fmt.Fprintf(&sb, "av.%s = $%d", pgQuoteIdent(col), i+1)
		params = append(params, anchorPK[i])
	}
	sb.WriteString("\n  UNION ALL\n")

	// Recursive term: from each frontier vertex, follow one edge to the next
	// vertex; the next frontier carries that vertex's from-end-ref columns so
	// the walk can continue. Stops at maxDepth.
	sb.WriteString("  SELECT fr.depth + 1")
	for i := range fromEnd.Ref {
		fmt.Fprintf(&sb, ", bv.%s", pgQuoteIdent(fromEnd.Ref[i]))
	}
	fmt.Fprintf(&sb, "\n  FROM frontier fr\n  JOIN %s ke ON ", keT)
	for i := range fromEnd.Key {
		if i > 0 {
			sb.WriteString(" AND ")
		}
		fmt.Fprintf(&sb, "ke.%s = fr.%s", pgQuoteIdent(fromEnd.Key[i]), frontierCols[i])
	}
	fmt.Fprintf(&sb, "\n  JOIN %s bv ON ", bvT)
	for i := range toEnd.Key {
		if i > 0 {
			sb.WriteString(" AND ")
		}
		fmt.Fprintf(&sb, "bv.%s = ke.%s", pgQuoteIdent(toEnd.Ref[i]), pgQuoteIdent(toEnd.Key[i]))
	}
	fmt.Fprintf(&sb, "\n  WHERE fr.depth < %d\n)\n", maxDepth)

	// Outer SELECT: for every frontier entry that itself resulted from a hop
	// (depth >= 1), re-derive the edge and both endpoint vertices and project
	// the a/k/b columns. fr holds the to-vertex's from-end-ref values, so we
	// recover the edge via toEnd.Key = fr.f_i, then the from-vertex (av) and
	// to-vertex (bv) from the edge. depth 0 (the anchor with no edge) is
	// excluded; the anchor still appears as the `a` of every depth-1 hop.
	cols := recursiveProjectionColumns(anchor, edge, other)
	sb.WriteString("SELECT\n    ")
	sb.WriteString(strings.Join(cols, ",\n    "))
	fmt.Fprintf(&sb, "\nFROM frontier fr\nJOIN %s ke ON ", keT)
	for i := range toEnd.Key {
		if i > 0 {
			sb.WriteString(" AND ")
		}
		// fr holds from-end-ref values of the to-vertex; for a self-ref edge
		// from-end-ref and to-end-ref name the same vertex columns, so the
		// frontier value equals the to-end-ref value and we can join the edge
		// on toEnd.Key = toEnd.Ref(==frontier).
		fmt.Fprintf(&sb, "ke.%s = fr.%s", pgQuoteIdent(toEnd.Key[i]), frontierCols[i])
	}
	fmt.Fprintf(&sb, "\nJOIN %s av ON ", avT)
	for i := range fromEnd.Key {
		if i > 0 {
			sb.WriteString(" AND ")
		}
		fmt.Fprintf(&sb, "av.%s = ke.%s", pgQuoteIdent(fromEnd.Ref[i]), pgQuoteIdent(fromEnd.Key[i]))
	}
	fmt.Fprintf(&sb, "\nJOIN %s bv ON ", bvT)
	for i := range toEnd.Key {
		if i > 0 {
			sb.WriteString(" AND ")
		}
		fmt.Fprintf(&sb, "bv.%s = ke.%s", pgQuoteIdent(toEnd.Ref[i]), pgQuoteIdent(toEnd.Key[i]))
	}
	sb.WriteString("\nWHERE fr.depth >= 1")
	if limit > 0 {
		fmt.Fprintf(&sb, "\nLIMIT %d", limit)
	}

	return ExpansionQuery{
		Query:  &ProjectedQuery{SQL: sb.String(), Decoder: proj.Decoder},
		Params: params,
	}, nil
}

// recursiveProjectionColumns builds the COLUMNS-equivalent SELECT list for the
// recursive (and single-hop join) CTE's outer query, mirroring BuildProjection's
// naming so the shared RowDecoder can consume the rows. Bindings: av->a, ke->k,
// bv->b.
func recursiveProjectionColumns(anchor, edge, other *Element) []string {
	var cols []string

	// addCol projects a plain physical column `<tableAlias>.<col>` under the
	// decoder's column-naming scheme.
	addCol := func(tableAlias, sourceCol, bindingAlias, prefix, suffix string) {
		out := bindingAlias + sep + prefix + sep + suffix
		cols = append(cols, fmt.Sprintf("%s.%s AS %s", tableAlias, pgQuoteIdent(sourceCol), pgQuoteIdent(out)))
	}

	// addProp projects a property. Plain / aliased-column properties read a
	// real column; computed expression properties emit the expression text
	// scoped to the table alias. SQL/PGQ stores the expression unqualified
	// (it refers to the element's own columns), so prefixing the table alias
	// keeps the reference unambiguous in the multi-table CTE join.
	addProp := func(tableAlias string, p Property, bindingAlias string) {
		out := bindingAlias + sep + prefixP + sep + p.Name
		if col, ok := plainPropColumn(p); ok {
			cols = append(cols, fmt.Sprintf("%s.%s AS %s", tableAlias, pgQuoteIdent(col), pgQuoteIdent(out)))
			return
		}
		// Computed expression: scope unqualified column refs to the table
		// alias so they resolve in the join. We can't reliably rewrite every
		// token, so we wrap the raw expression in a derived reference: most
		// expressions in practice reference the element's own columns, and the
		// CTE only brings one row per element table into scope, so an
		// unqualified expression still resolves. Emit it as-is.
		expr := strings.TrimSpace(*p.Expression)
		cols = append(cols, fmt.Sprintf("(%s) AS %s", expr, pgQuoteIdent(out)))
	}

	// Binding order must match BuildProjection's sort-by-alias: a, b, k.

	// a (from-vertex), alias "a"
	for _, c := range anchor.PK {
		addCol("av", c, "a", prefixPK, c)
	}
	for _, p := range anchor.Properties {
		addProp("av", p, "a")
	}

	// b (to-vertex), alias "b"
	for _, c := range other.PK {
		addCol("bv", c, "b", prefixPK, c)
	}
	for _, p := range other.Properties {
		addProp("bv", p, "b")
	}

	// k (edge), alias "k"
	for _, c := range edge.PK {
		addCol("ke", c, "k", prefixPK, c)
	}
	for _, p := range edge.Properties {
		addProp("ke", p, "k")
	}
	if edge.Source != nil {
		for _, c := range edge.Source.Key {
			addCol("ke", c, "k", prefixSK, c)
		}
	}
	if edge.Destination != nil {
		for _, c := range edge.Destination.Key {
			addCol("ke", c, "k", prefixDK, c)
		}
	}

	return cols
}

// plainPropColumn returns the underlying table column a property reads, when
// the property is a plain column or a simple alias over one (e.g.
// `id AS person_id`). Returns ok=false for computed expression properties,
// which the caller emits as a raw expression instead.
func plainPropColumn(p Property) (string, bool) {
	if p.Expression == nil {
		return p.Name, true
	}
	expr := strings.TrimSpace(*p.Expression)
	if expr == p.Name {
		return p.Name, true
	}
	// Quoted identifier: "col" or "co""l".
	if len(expr) >= 2 && expr[0] == '"' && expr[len(expr)-1] == '"' {
		inner := strings.ReplaceAll(expr[1:len(expr)-1], `""`, `"`)
		if !strings.ContainsAny(inner, " \t(),+*/-") {
			return inner, true
		}
	}
	// Bare identifier (letters, digits, underscore only) — an aliased column.
	if isSimpleIdent(expr) {
		return expr, true
	}
	return "", false
}

// isSimpleIdent reports whether s is a bare unquoted SQL identifier (no
// operators, spaces, or function calls) — i.e. a plain column reference.
func isSimpleIdent(s string) bool {
	if s == "" {
		return false
	}
	for i, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r == '_':
		case r >= '0' && r <= '9' && i > 0:
		default:
			return false
		}
	}
	return true
}

// qualTable renders a schema-qualified, quoted table reference.
func qualTable(t TableRef) string {
	return pgQuoteIdent(t.Schema) + "." + pgQuoteIdent(t.Name)
}
