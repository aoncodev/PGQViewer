package sqlpgq

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

// Binding pairs a user-chosen MATCH variable (e.g. "a") with the property
// graph element it should be bound to (e.g. element_oid of "people").
//
// The client is expected to supply a binding for every alias used in the
// MATCH clause. We do not parse SQL/PGQ in Go.
//
// DisplayProperties is an optional allow-list narrowing which properties
// get projected for this binding. Empty (default) projects everything,
// which preserves the property panel's "show me everything about this
// vertex" UX. The KEY / edge-endpoint columns are projected regardless of this
// list when they're exposed as properties (the synthetic id and endpoint
// linking need them); when a graph hides them, identity degrades to the
// available columns instead (see the degraded path in BuildProjectionWithOpts).
// A non-empty list lets a renderer (or a power-user hitting the HTTP API
// directly) trim wide graphs down to a sane payload size — see todo.md
// item #6.
type Binding struct {
	Alias             string   `json:"alias"`
	ElementOID        uint32   `json:"element_oid"`
	DisplayProperties []string `json:"display_properties,omitempty"`
	// Label is the label the MATCH pattern bound this alias to (`(a IS person)`
	// → "person"), as parsed client-side. When set, the auto-projection scopes
	// the projected properties to those declared on that label — SQL/PGQ rejects
	// `a.<prop>` for a property not on the bound label. Empty (an unlabeled
	// pattern `(a)`, or any non-GRAPH_TABLE caller) keeps the full property union,
	// which PG also accepts.
	Label string `json:"label,omitempty"`
	// SourceAlias / DestinationAlias name the vertex aliases this edge connects in the
	// MATCH pattern (`(a)-[e]->(b)` → SourceAlias "a", DestinationAlias "b"), as parsed
	// client-side. Set only on edge bindings whose endpoints are both bound
	// vertices in the same pattern.
	//
	// They drive *within-row* endpoint linking: each result row of a GRAPH_TABLE
	// match co-locates the edge with both its endpoint vertices, so the edge can
	// borrow those vertices' synthesized ids directly instead of re-deriving them
	// from its own FK columns. This is what lets the viewer render graphs whose
	// KEY / endpoint columns are NOT exposed as properties (PG's MATCH already
	// resolved the topology; the FK values are never needed). When unset — an
	// anonymous endpoint, an edges-only query, or the /expand path — linking
	// falls back to the value-based scheme (FK value == referenced PK value).
	//
	// For a graph that DOES expose its keys the two schemes produce byte-identical
	// ids (FK value == PK value), so setting these never changes a valid graph's
	// output; it only adds a fallback for the keyless case.
	SourceAlias      string `json:"source_alias,omitempty"`
	DestinationAlias string `json:"destination_alias,omitempty"`
}

// ProjectedQuery is the result of BuildProjection.
//
//	SQL     — full statement ready to send to PostgreSQL
//	Decoder — knows how to turn a result row into per-binding events
//	          (nil when Tabular is true — the caller emits raw columns/rows)
//	Tabular — true when the query projects a caller-supplied COLUMNS list
//	          verbatim instead of the synthesized vertex/edge projection. In
//	          that mode there is nothing to decode into graph events; the
//	          stream goes through the columns/rows path like SQL mode.
//	Params  — positional bind parameters for the SQL ($1, $2, ...). nil for a
//	          literal statement. Threaded through to pool.Query.
//	ColumnMap — synthetic-alias -> (binding, property) lookup for the
//	          auto-projection, so error messages / meta can translate
//	          `alias__p__prop` aliases back to human terms (see todo.md #7).
//	          nil/empty for tabular queries.
//	Trimmed — bindings whose property set was auto-trimmed because the
//	          element is wide and DisplayProperties was empty (todo.md #5).
//
// Fields are additive: expand.go depends on SQL and Decoder, which keep their
// meaning. New consumers branch on Tabular.
type ProjectedQuery struct {
	SQL       string
	Decoder   *RowDecoder
	Tabular   bool
	Params    []any
	ColumnMap []ColumnMapping
	Trimmed   []TrimInfo
	// Warnings carries non-fatal degradation notices produced while building the
	// projection — today, the "this element's KEY isn't exposed as a property, so
	// identity is approximated from its other columns" case (see validateBinding
	// / the degraded-identity path in BuildProjectionWithOpts). The caller
	// surfaces them in the meta event so the user understands why dedup might
	// merge distinct nodes/edges. Empty in the happy path.
	Warnings []string
}

// ColumnMapping translates one synthetic COLUMNS alias (e.g. "a__p__name")
// back to the binding alias and property name it carries. Exposed in the meta
// event so the client can render human-friendly names and so error messages
// can de-mangle the synthetic aliases. Role is one of "pk", "p", "sk", "dk".
type ColumnMapping struct {
	Column   string `json:"column"`
	Alias    string `json:"alias"`
	Property string `json:"property"`
	Role     string `json:"role"`
}

// TrimInfo records that a binding's property projection was narrowed by the
// wide-element heuristic. Surfaced in the meta event so the client can offer a
// "show all properties" affordance (it can re-issue the query with an explicit
// DisplayProperties allow-list to override the trim).
type TrimInfo struct {
	Alias      string   `json:"alias"`
	ElementOID uint32   `json:"element_oid"`
	Total      int      `json:"total"`     // declared property count
	Projected  []string `json:"projected"` // properties actually projected
}

// wideElementPropertyThreshold is the property count above which an element
// with no explicit DisplayProperties gets auto-trimmed to PK + a heuristic
// display set. Below it we keep the "show everything" default. 24 is a
// pragmatic line: most hand-modelled tables sit well under it, while
// generated / denormalized tables that blow past it are exactly the ones that
// bloat the per-vertex payload. Opt-out: pass an explicit DisplayProperties.
const wideElementPropertyThreshold = 24

// EventKind discriminates the row decoder's output.
type EventKind string

const (
	EventVertex EventKind = "vertex"
	EventEdge   EventKind = "edge"
)

// Event is one vertex or edge instance projected out of a query result row.
// The same physical vertex/edge can be emitted many times across rows; the
// caller (or the client) deduplicates by ID.
type Event struct {
	Kind        EventKind      `json:"type"`
	Binding     string         `json:"binding"`
	ID          string         `json:"id"`
	Labels      []string       `json:"labels"`
	Properties  map[string]any `json:"properties"`
	Source      string         `json:"source,omitempty"`      // edges only
	Destination string         `json:"destination,omitempty"` // edges only
}

// Column name prefixes used in the projected COLUMNS list. The decoder
// splits on the double-underscore separator.
//
//	"<alias>__pk__<col>"  primary-key columns of the element
//	"<alias>__p__<prop>"  property columns (per the element's labels)
//	"<alias>__sk__<col>"  source key (edges only)  — value = source vertex PK
//	"<alias>__dk__<col>"  destination key (edges only)
const (
	prefixPK = "pk"
	prefixP  = "p"
	prefixSK = "sk"
	prefixDK = "dk"
	sep      = "__"
)

// ProjectionOpts is the struct-form input to BuildProjectionWithOpts. The
// thin BuildProjection wrapper keeps the original positional signature
// unchanged for callers that don't need lateral form.
//
// LateralFrom: when non-empty, the outer SELECT becomes
//
//	SELECT * FROM <from1>, <from2>, ..., GRAPH_TABLE(...) <alias>
//
// (no LATERAL keyword: PG19 rejects it before GRAPH_TABLE, which is implicitly
// lateral, so a plain comma join both parses and correlates.)
//
// instead of `SELECT * FROM GRAPH_TABLE(...)`. From items are raw SQL
// fragments — the caller is responsible for quoting / safety. LateralAlias
// names the GRAPH_TABLE in the FROM list; if empty we default to "gt".
type ProjectionOpts struct {
	Metadata     *GraphMetadata
	Bindings     []Binding
	Match        string
	Where        string
	Limit        int
	LateralFrom  []string
	LateralAlias string
	// Columns, when non-empty, is a caller-supplied COLUMNS list emitted
	// VERBATIM in place of the synthesized vertex/edge projection. Each entry
	// is a raw SQL fragment (`a.name AS who`, `b.born + 1`) — caller-trusted
	// exactly like Where / LateralFrom. The resulting ProjectedQuery is
	// flagged Tabular with a nil Decoder; the caller streams it through the
	// columns/rows path rather than decoding graph events. Empty preserves
	// today's auto-projection behaviour exactly.
	Columns []string
	// Params is the positional bind list ($1, $2, ...) threaded onto the SQL.
	// nil for a literal statement.
	Params []any
}

// BuildProjection synthesizes a GRAPH_TABLE query that projects every PK
// column, every property, and (for edges) the source/destination key
// columns of each binding. The returned RowDecoder maps query result rows
// back to per-binding vertex/edge events.
//
// Limitations of v0:
//   - The caller must supply a Binding for every alias that appears in
//     `match`; we do not parse SQL/PGQ.
//   - `where` is appended after the MATCH inside GRAPH_TABLE (so it has
//     access to bound aliases). It must be valid SQL/PGQ.
//   - `limit` if > 0 is applied to the outer SELECT.
func BuildProjection(md *GraphMetadata, bindings []Binding, match, where string, limit int) (*ProjectedQuery, error) {
	return BuildProjectionWithOpts(ProjectionOpts{
		Metadata: md,
		Bindings: bindings,
		Match:    match,
		Where:    where,
		Limit:    limit,
	})
}

// BuildProjectionWithOpts is the struct-form entry point. It supports the
// lateral form via ProjectionOpts.LateralFrom; otherwise behavior is
// identical to BuildProjection.
func BuildProjectionWithOpts(opts ProjectionOpts) (*ProjectedQuery, error) {
	md := opts.Metadata
	bindings := opts.Bindings

	if md == nil {
		return nil, errors.New("metadata is required")
	}
	if strings.TrimSpace(opts.Match) == "" {
		return nil, errors.New("match is required")
	}
	if len(bindings) == 0 {
		return nil, errors.New("at least one binding is required")
	}

	// Custom COLUMNS path: the caller drives the projection. We emit their
	// list verbatim and stream the result through the columns/rows path —
	// there are no synthesized vertex/edge events to decode. Bindings are
	// not required to match the alias layout here (the COLUMNS exprs are
	// raw SQL), but Match is still required and the caller still supplies
	// bindings for autocomplete / aliasing context.
	if customCols := nonEmptyTrimmed(opts.Columns); len(customCols) > 0 {
		sql, err := assembleSQL(md, customCols, opts)
		if err != nil {
			return nil, err
		}
		return &ProjectedQuery{SQL: sql, Tabular: true, Params: opts.Params}, nil
	}

	byOID := map[uint32]*Element{}
	for i := range md.Vertices {
		byOID[md.Vertices[i].OID] = &md.Vertices[i]
	}
	for i := range md.Edges {
		byOID[md.Edges[i].OID] = &md.Edges[i]
	}

	// Project columns in a stable order so the decoder can match positions.
	// Sort bindings by alias so client/server agree on the layout.
	sorted := append([]Binding(nil), bindings...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Alias < sorted[j].Alias })

	var cols []string
	var colMap []ColumnMapping
	var trimmed []TrimInfo
	var warnings []string
	// boundVertices lets an edge tell whether its pattern endpoints are bound
	// vertex aliases in THIS query — the precondition for within-row linking.
	boundVertices := map[string]bool{}
	for _, b := range sorted {
		if el, ok := byOID[b.ElementOID]; ok && el.Kind == "v" {
			boundVertices[b.Alias] = true
		}
	}
	dec := &RowDecoder{
		Bindings: make([]decoderBinding, 0, len(sorted)),
	}

	// addCol appends a projected column and records its synthetic-alias ->
	// (binding, property, role) mapping so the meta event / error messages
	// can de-mangle the alias later (todo.md #7).
	addCol := func(alias, propName, outName, role string) int {
		cols = append(cols, projectColumn(alias, propName, outName))
		colMap = append(colMap, ColumnMapping{
			Column:   outName,
			Alias:    alias,
			Property: propName,
			Role:     role,
		})
		return len(cols) - 1
	}

	for _, b := range sorted {
		el, ok := byOID[b.ElementOID]
		if !ok {
			return nil, fmt.Errorf("binding %q: element oid %d not in this graph", b.Alias, b.ElementOID)
		}
		if err := validateAlias(b.Alias); err != nil {
			return nil, fmt.Errorf("binding %q: %w", b.Alias, err)
		}
		if err := validateBinding(b, el); err != nil {
			return nil, err
		}

		db := decoderBinding{
			Alias:      b.Alias,
			ElementOID: el.OID,
			Kind:       el.Kind,
			Labels:     append([]string(nil), el.Labels...),
		}

		// KEY columns. The decoder synthesizes element identity from these, so
		// the ideal is to project them (they're always exposed as properties
		// under PG's default `PROPERTIES ALL COLUMNS`) and use them as idCols.
		// When a graph explicitly omits a KEY column from PROPERTIES, SQL/PGQ
		// won't let us name it inside COLUMNS — so we DON'T project it (that would
		// emit invalid SQL) and instead fall back to a property-derived identity
		// below. PG itself can still run such a graph; we match that rather than
		// refusing it.
		keysExposed := len(missingKeyProperties(el, el.PK)) == 0
		if keysExposed {
			for _, c := range el.PK {
				out := b.Alias + sep + prefixPK + sep + c
				propName, _ := propertyForColumn(el, c)
				db.idCols = append(db.idCols, addCol(b.Alias, propName, out, prefixPK))
			}
		}

		// Properties. Apply the optional DisplayProperties allow-list:
		// empty means "all" (today's default — preserves the property
		// panel UX); non-empty narrows to the named set. Names that
		// don't match a declared property error out, since the user
		// either made a typo or the graph schema changed under them.
		//
		// Wide-element opt-out (todo.md #5): when DisplayProperties is
		// empty AND the element declares more than the threshold, we
		// auto-trim to a heuristic display set (first text-ish / name
		// column) instead of projecting everything. PK and edge keys are
		// still always projected (handled outside this loop), and the
		// trim is recorded so the client can request the full set.
		//
		// The trim is skipped for a DEGRADED element (KEY not exposed): there,
		// identity is synthesized from the projected property columns (below), so
		// trimming them to one heuristic column would collapse identity onto a
		// typically-non-unique value and silently merge distinct nodes/edges. A
		// wide+keyless element is rare; projecting its full property set keeps
		// dedup as accurate as the data allows.
		// F3: scope to the matched label. PG19 binds an element variable to the
		// label named in the pattern, and `a.<prop>` is valid only for a property
		// of that label. The client sends the parsed label; an empty Label
		// (unlabeled `(a)`) keeps the full union, which PG also accepts.
		scopedProps := el.Properties
		if b.Label != "" {
			scopedProps = propertiesForLabel(el.Properties, b.Label)
		}

		effectiveDisplay := b.DisplayProperties
		var didTrim bool
		if len(effectiveDisplay) == 0 && keysExposed && len(scopedProps) > wideElementPropertyThreshold {
			effectiveDisplay = heuristicDisplayProperties(scopedProps)
			didTrim = true
		}
		propFilter, err := makePropertyFilter(effectiveDisplay, scopedProps, el.Alias)
		if err != nil {
			return nil, fmt.Errorf("binding %q: %w", b.Alias, err)
		}
		var projectedProps []string
		for _, p := range scopedProps {
			if !propFilter(p.Name) {
				continue
			}
			out := b.Alias + sep + prefixP + sep + p.Name
			idx := addCol(b.Alias, p.Name, out, prefixP)
			db.propCols = append(db.propCols, propRef{idx: idx, name: p.Name})
			projectedProps = append(projectedProps, p.Name)
		}
		if didTrim {
			trimmed = append(trimmed, TrimInfo{
				Alias:      b.Alias,
				ElementOID: el.OID,
				Total:      len(scopedProps),
				Projected:  projectedProps,
			})
		}

		// When the KEY columns weren't exposed, idCols is still empty (the block
		// above only fills it for keysExposed). Fall back to the projected
		// property columns so the element still renders — dedup then merges rows
		// with identical visible properties, which we warn about.
		if !keysExposed {
			for _, p := range db.propCols {
				db.idCols = append(db.idCols, p.idx)
			}
			warnings = append(warnings, degradedIdentityWarning(b.Alias, el))
		}

		// Edge source / destination key columns. When the FK columns are exposed
		// as properties we project them for value-based linking (FK value ==
		// referenced PK value) — the scheme that also lets /expand stitch edges to
		// vertices it fetched in an earlier query. When they're NOT exposed we
		// rely on within-row linking instead: SourceAlias / DestinationAlias point at the
		// endpoint vertex bindings, and the decoder borrows their ids straight from
		// the same result row (PG's MATCH already resolved the topology).
		if el.Kind == "e" {
			if el.Source != nil {
				if len(missingKeyProperties(el, el.Source.Key)) == 0 {
					for _, c := range el.Source.Key {
						out := b.Alias + sep + prefixSK + sep + c
						propName, _ := propertyForColumn(el, c)
						db.srcKeyCols = append(db.srcKeyCols, addCol(b.Alias, propName, out, prefixSK))
					}
					db.srcVertexOID = el.Source.VertexOID
				}
				if boundVertices[b.SourceAlias] {
					db.srcAlias = b.SourceAlias
				}
				if db.srcVertexOID == 0 && db.srcAlias == "" {
					warnings = append(warnings, unresolvableEndpointWarning(b.Alias, "source"))
				}
			}
			if el.Destination != nil {
				if len(missingKeyProperties(el, el.Destination.Key)) == 0 {
					for _, c := range el.Destination.Key {
						out := b.Alias + sep + prefixDK + sep + c
						propName, _ := propertyForColumn(el, c)
						db.dstKeyCols = append(db.dstKeyCols, addCol(b.Alias, propName, out, prefixDK))
					}
					db.dstVertexOID = el.Destination.VertexOID
				}
				if boundVertices[b.DestinationAlias] {
					db.dstAlias = b.DestinationAlias
				}
				if db.dstVertexOID == 0 && db.dstAlias == "" {
					warnings = append(warnings, unresolvableEndpointWarning(b.Alias, "destination"))
				}
			}
		}

		dec.Bindings = append(dec.Bindings, db)
	}

	if len(cols) == 0 {
		return nil, errors.New("no columns produced (all bindings empty?)")
	}

	sql, err := assembleSQL(md, cols, opts)
	if err != nil {
		return nil, err
	}
	return &ProjectedQuery{
		SQL:       sql,
		Decoder:   dec,
		Params:    opts.Params,
		ColumnMap: colMap,
		Trimmed:   trimmed,
		Warnings:  warnings,
	}, nil
}

// validateBinding rejects a binding the projection genuinely cannot honour: an
// element carrying an error-severity diagnostic, or a vertex with no way at all
// to form an identity.
//
// Warning-severity diagnostics (e.g. non-unique KEY) flow through unblocked —
// they're surfaced via the metadata so the UI can render an advisory banner.
//
// A KEY column that isn't exposed as a property is NOT rejected here: SQL/PGQ
// won't let us name it in COLUMNS, but PG can still run the graph, so the
// projection degrades to a property-derived identity (see the degraded path in
// BuildProjectionWithOpts) rather than refusing. The one irrecoverable case is a
// vertex whose KEY is unexposed AND that declares no properties either — there
// is then literally no column to identify it by, so it can't be placed on the
// canvas. PG can't surface those columns to a query either; this stays an error.
func validateBinding(b Binding, el *Element) error {
	for _, d := range el.Diagnostics {
		if d.Severity == "error" {
			return fmt.Errorf("binding %q (%s): %s", b.Alias, el.Alias, d.Message)
		}
	}
	if el.Kind == "v" && len(missingKeyProperties(el, el.PK)) > 0 && len(el.Properties) == 0 {
		return fmt.Errorf(
			"binding %q (%s): the KEY columns %v are not exposed as properties and the element declares no other property, so the viewer has nothing to identify this vertex by — list at least one column in PROPERTIES (...) (or drop the clause to expose all columns)",
			b.Alias, el.Alias, el.PK,
		)
	}
	return nil
}

// degradedIdentityWarning is emitted when an element's KEY columns are not
// exposed as properties, so identity is approximated from whatever columns ARE
// exposed (or, for a property-less edge, from its resolved endpoints). The
// canvas still renders; the caveat is that two rows the viewer can't tell apart
// collapse into one node/edge.
func degradedIdentityWarning(alias string, el *Element) string {
	return fmt.Sprintf(
		"%s %q: KEY column(s) %s are not exposed as properties; identity is approximated from the columns that are, so rows with identical visible values merge into one element. Add %s to PROPERTIES (...) (or drop the clause to expose all columns) for exact dedup.",
		elementKindNoun(el.Kind), alias, formatColList(el.PK), formatColList(el.PK),
	)
}

// unresolvableEndpointWarning is emitted for an edge endpoint that can be linked
// neither by value (its FK columns aren't exposed) nor within-row (the pattern
// doesn't bind that endpoint vertex), so the edge may render detached.
func unresolvableEndpointWarning(alias, side string) string {
	return fmt.Sprintf(
		"edge %q: its %s endpoint can't be resolved — the FK columns aren't exposed as properties and the pattern doesn't bind that endpoint vertex, so the edge may render without its %s. Bind the %s vertex in the MATCH, or expose the FK columns in PROPERTIES (...).",
		alias, side, side, side,
	)
}

func elementKindNoun(kind string) string {
	if kind == "e" {
		return "edge"
	}
	return "vertex"
}

// graphTableBlock renders the GRAPH_TABLE (...) expression shared by the
// plain and lateral SELECT forms. `where` must already be trimmed.
func graphTableBlock(md *GraphMetadata, match, where string, cols []string) string {
	var sb strings.Builder
	fmt.Fprintf(&sb, "GRAPH_TABLE (%s.%s\n  MATCH %s",
		pgQuoteIdent(md.Graph.Schema), pgQuoteIdent(md.Graph.Name), match)
	if where != "" {
		fmt.Fprintf(&sb, "\n  WHERE %s", where)
	}
	sb.WriteString("\n  COLUMNS (\n    ")
	sb.WriteString(strings.Join(cols, ",\n    "))
	sb.WriteString("\n  )\n)")
	return sb.String()
}

// assembleSQL builds the final statement from the projected COLUMNS list.
// When opts.LateralFrom is non-empty the GRAPH_TABLE is joined as a plain comma
// FROM item (it is implicitly lateral) after those FROM items; otherwise it is
// the sole FROM item.
func assembleSQL(md *GraphMetadata, cols []string, opts ProjectionOpts) (string, error) {
	// Filter out empty/whitespace-only From items so callers can pass nil
	// or an unfiltered slice without changing the default code path.
	var fromItems []string
	for _, f := range opts.LateralFrom {
		if s := strings.TrimSpace(f); s != "" {
			fromItems = append(fromItems, s)
		}
	}

	block := graphTableBlock(md, opts.Match, strings.TrimSpace(opts.Where), cols)

	var sb strings.Builder
	if len(fromItems) > 0 {
		alias := strings.TrimSpace(opts.LateralAlias)
		if alias == "" {
			alias = "gt"
		}
		if err := validateAlias(alias); err != nil {
			return "", fmt.Errorf("lateral alias %q: %w", alias, err)
		}
		sb.WriteString("SELECT * FROM ")
		sb.WriteString(strings.Join(fromItems, ", "))
		// GRAPH_TABLE is implicitly lateral in PG19; the explicit LATERAL keyword
		// is a syntax error before it. Joining it as a plain comma FROM item still
		// lets the pattern correlate to the preceding From items.
		sb.WriteString(", ")
		sb.WriteString(block)
		sb.WriteString(" ")
		sb.WriteString(pgQuoteIdent(alias))
	} else {
		sb.WriteString("SELECT * FROM ")
		sb.WriteString(block)
	}
	if opts.Limit > 0 {
		fmt.Fprintf(&sb, "\nLIMIT %d", opts.Limit)
	}
	return sb.String(), nil
}

// RowDecoder turns one query result row (positional []any) into a slice of
// per-binding Events. It does not deduplicate across rows; callers track
// seen IDs.
type RowDecoder struct {
	Bindings []decoderBinding
}

type decoderBinding struct {
	Alias      string   `json:"alias"`
	ElementOID uint32   `json:"element_oid"`
	Kind       string   `json:"kind"`
	Labels     []string `json:"labels"`
	propCols   []propRef
	srcKeyCols []int
	dstKeyCols []int
	// idCols are the streamed-row column indices whose values synthesize this
	// element's identity. The common case is the KEY columns (exposed as
	// properties). When the KEY columns are NOT exposed as properties the element
	// is "degraded": idCols falls back to the projected property columns so the
	// element still gets a stable id (dedup is then best-effort — two rows with
	// identical visible properties merge). An edge with neither projectable keys
	// nor properties has empty idCols and derives its id from its resolved
	// endpoints instead (see DecodeRaw).
	idCols []int
	// srcAlias / dstAlias name the endpoint vertex bindings for within-row
	// linking (see Binding.SourceAlias). Empty falls back to value-based linking
	// via srcKeyCols / dstKeyCols.
	srcAlias     string
	dstAlias     string
	srcVertexOID uint32 // edges only: oid of the source vertex element
	dstVertexOID uint32 // edges only: oid of the destination vertex element
}

// BindingViews returns a JSON-safe summary of the decoder's bindings, for
// use in the "meta" event so the UI can render shapes before data arrives.
func (d *RowDecoder) BindingViews() []BindingView {
	out := make([]BindingView, len(d.Bindings))
	for i, b := range d.Bindings {
		props := make([]string, len(b.propCols))
		for j, p := range b.propCols {
			props[j] = p.name
		}
		out[i] = BindingView{
			Alias:      b.Alias,
			ElementOID: b.ElementOID,
			Kind:       b.Kind,
			Labels:     b.Labels,
			Properties: props,
		}
	}
	return out
}

// BindingView is the JSON-safe shape of a binding for the meta event.
type BindingView struct {
	Alias      string   `json:"alias"`
	ElementOID uint32   `json:"element_oid"`
	Kind       string   `json:"kind"`
	Labels     []string `json:"labels"`
	Properties []string `json:"properties"`
}

type propRef struct {
	idx  int
	name string
}

// Decode produces one Event per binding for the given row, synthesizing ids
// from the same row used for property values. Equivalent to DecodeRaw(row, row).
func (d *RowDecoder) Decode(values []any) []Event {
	return d.DecodeRaw(values, values)
}

// DecodeRaw is Decode but derives synthetic ids (vertex PK, edge endpoint keys)
// from idVals while reading property values from propVals.
//
// Callers that mutate the row for JSON output (jsonifyRow) MUST pass the
// untouched raw row as idVals: jsonify rewrites some values into display-
// friendly but id-unstable forms — most importantly a NUMERIC loses its scale
// distinction, so a vertex PK numeric(10,0) and the referencing edge key
// numeric(10,2) would stringify to "42" vs "42.00" and never link. Deriving ids
// from the raw pgtype values (where formatPKPart canonicalizes them) keeps the
// two sides equal. idVals and propVals must be index-compatible.
//
// If any identity value is NULL for a binding (outer-join-shaped matches — not
// in v0 PG19, but defensive), the binding is skipped.
//
// Linking runs in two passes because an edge may borrow its endpoint ids from
// the vertex bindings in the SAME row (within-row linking — see
// Binding.SourceAlias). Pass 1 synthesizes every element's own id; pass 2 builds
// events, resolving edge endpoints against the pass-1 map and falling back to
// the value-based scheme (FK value == referenced PK value) when no within-row
// endpoint is available.
func (d *RowDecoder) DecodeRaw(idVals, propVals []any) []Event {
	// Pass 1: each element's own identity from its idCols (KEY columns when
	// exposed, else the projected property columns). A property-less edge has no
	// idCols and is absent here; it derives an id from its endpoints in pass 2.
	rowID := make(map[string]string, len(d.Bindings))
	for _, b := range d.Bindings {
		if k, ok := joinKey(idVals, b.idCols); ok {
			rowID[b.Alias] = fmt.Sprintf("%d:%s", b.ElementOID, k)
		}
	}

	out := make([]Event, 0, len(d.Bindings))
	for _, b := range d.Bindings {
		switch b.Kind {
		case "v":
			id, ok := rowID[b.Alias]
			if !ok {
				continue
			}
			out = append(out, b.baseEvent(id, propVals, EventVertex))
		case "e":
			src := b.resolveEndpoint(b.srcAlias, b.srcKeyCols, b.srcVertexOID, rowID, idVals)
			dst := b.resolveEndpoint(b.dstAlias, b.dstKeyCols, b.dstVertexOID, rowID, idVals)
			// An edge needs both endpoints to attach to the canvas; emitting one
			// with a blank source/destination would be a dangling edge the
			// renderer can't place. Skip it — the build-time
			// unresolvableEndpointWarning explains the persistent case (FK columns
			// not exposed and the endpoint vertex not bound in the pattern).
			if src == "" || dst == "" {
				continue
			}
			id, ok := rowID[b.Alias]
			if !ok {
				// Property-less edge whose KEY isn't exposed (e.g. NO PROPERTIES +
				// a restricted KEY): identify it by its endpoints. Parallel edges
				// between the same pair then merge — covered by the degraded warning.
				id = fmt.Sprintf("%d:%s", b.ElementOID, encodeParts(src, dst))
			}
			ev := b.baseEvent(id, propVals, EventEdge)
			ev.Source = src
			ev.Destination = dst
			out = append(out, ev)
		}
	}
	return out
}

// baseEvent builds the per-binding event shell (id, labels, properties, kind).
func (b decoderBinding) baseEvent(id string, propVals []any, kind EventKind) Event {
	ev := Event{
		Kind:       kind,
		Binding:    b.Alias,
		Labels:     b.Labels,
		Properties: make(map[string]any, len(b.propCols)),
		ID:         id,
	}
	for _, p := range b.propCols {
		ev.Properties[p.name] = propVals[p.idx]
	}
	return ev
}

// resolveEndpoint returns the id of one edge endpoint. It prefers within-row
// linking — the endpoint vertex binding's own id from this row, which is correct
// regardless of whether any KEY column is exposed. It falls back to the
// value-based scheme (the edge's projected FK columns formatted against the
// referenced vertex element oid) for anonymous endpoints, edges-only queries,
// and the /expand path. Returns "" when neither is available.
func (b decoderBinding) resolveEndpoint(alias string, keyCols []int, vertexOID uint32, rowID map[string]string, idVals []any) string {
	if alias != "" {
		if id, ok := rowID[alias]; ok {
			return id
		}
	}
	if vertexOID != 0 {
		if k, ok := joinKey(idVals, keyCols); ok {
			return fmt.Sprintf("%d:%s", vertexOID, k)
		}
	}
	return ""
}

// encodeParts joins strings into the same collision-free JSON-array form joinKey
// uses, so an endpoint-derived edge id can't alias a differently-split pair.
func encodeParts(parts ...string) string {
	out, err := json.Marshal(parts)
	if err != nil {
		return ""
	}
	return string(out)
}

// joinKey produces a stable, unambiguous string from the values at the
// given column indices. Returns (_, false) if any value is nil, so we
// don't emit half-formed ids.
//
// The encoding is JSON-array form: `["a","b,c"]`. JSON's escape rules
// guarantee that two distinct part-sequences cannot collide — that
// matters because the synthesized id participates in client-side dedup
// (`Map<string, vertex>`) and in edge endpoint resolution (the same
// formatter is used on both sides). A naive `strings.Join(parts, ",")`
// could merge `("a","b,c")` and `("a,b","c")` into the same id — see
// projection_test.go for the regression.
//
// Each part is normalized through formatPKPart so common pgx-returned
// types (UUID, numeric, time) get a canonical text form. Mixed type
// representations of the same logical value (e.g. `[16]byte` vs
// `pgtype.UUID`) thus collapse to the same string.
func joinKey(values []any, idxs []int) (string, bool) {
	if len(idxs) == 0 {
		return "", false
	}
	parts := make([]string, len(idxs))
	for i, idx := range idxs {
		v := values[idx]
		if v == nil {
			return "", false
		}
		parts[i] = formatPKPart(v)
	}
	out, err := json.Marshal(parts)
	if err != nil {
		// json.Marshal on a []string can't fail in practice, but we keep
		// the second return for defense in depth.
		return "", false
	}
	return string(out), true
}

// formatPKPart returns a canonical text representation of one PK column
// value. The contract: two values that PostgreSQL would consider equal at
// the SQL level produce the same string, regardless of which pgx Go-type
// path they came through.
//
// Type coverage is empirical — based on what pgx.Rows.Values() returns
// for the standard PG types. Add cases as new bug reports arrive rather
// than speculatively widening it.
func formatPKPart(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case []byte:
		// bytea and "raw" UUIDs that some configurations return as bytes.
		return hex.EncodeToString(x)
	case [16]byte:
		// pgx's default UUID decoder; canonical lowercase hyphenated form.
		return FormatUUIDBytes(x)
	case pgtype.UUID:
		if !x.Valid {
			return ""
		}
		return FormatUUIDBytes(x.Bytes)

	// Integers. The vertex-PK path and the edge src/dst-key path must
	// produce identical strings for the same logical value even when pgx
	// hands one side a raw int64 and the other a pgtype.Int8 (or the value
	// arrives as a Numeric — see the Numeric case, which also yields a plain
	// decimal string). Normalize every integer width to base-10 text.
	case int:
		return strconv.FormatInt(int64(x), 10)
	case int16:
		return strconv.FormatInt(int64(x), 10)
	case int32:
		return strconv.FormatInt(int64(x), 10)
	case int64:
		return strconv.FormatInt(x, 10)
	case uint32:
		return strconv.FormatUint(uint64(x), 10)
	case uint64:
		return strconv.FormatUint(x, 10)
	case pgtype.Int2:
		if !x.Valid {
			return ""
		}
		return strconv.FormatInt(int64(x.Int16), 10)
	case pgtype.Int4:
		if !x.Valid {
			return ""
		}
		return strconv.FormatInt(int64(x.Int32), 10)
	case pgtype.Int8:
		if !x.Valid {
			return ""
		}
		return strconv.FormatInt(x.Int64, 10)

	// Booleans -> canonical "true"/"false".
	case bool:
		return strconv.FormatBool(x)
	case pgtype.Bool:
		if !x.Valid {
			return ""
		}
		return strconv.FormatBool(x.Bool)

	// Floats. Use the shortest round-trippable form ('g', -1) so 1.0 and
	// the same value through pgtype.Float8 collapse to one string.
	case float32:
		return strconv.FormatFloat(float64(x), 'g', -1, 32)
	case float64:
		return strconv.FormatFloat(x, 'g', -1, 64)
	case pgtype.Float4:
		if !x.Valid {
			return ""
		}
		return strconv.FormatFloat(float64(x.Float32), 'g', -1, 32)
	case pgtype.Float8:
		if !x.Valid {
			return ""
		}
		return strconv.FormatFloat(x.Float64, 'g', -1, 64)

	// Text wrapper -> the underlying string (mirrors the bare-string case).
	case pgtype.Text:
		if !x.Valid {
			return ""
		}
		return x.String

	case pgtype.Numeric:
		s, err := x.Value()
		if err != nil || s == nil {
			return fmt.Sprintf("%v", v)
		}
		if str, ok := s.(string); ok {
			return normalizeNumericText(str)
		}
		return fmt.Sprintf("%v", s)
	case time.Time:
		// RFC3339Nano is unambiguous and round-trippable. Same logical
		// timestamp formats identically regardless of the in-memory zone.
		return x.UTC().Format(time.RFC3339Nano)
	case pgtype.Timestamptz:
		if !x.Valid {
			return ""
		}
		return x.Time.UTC().Format(time.RFC3339Nano)
	case pgtype.Timestamp:
		if !x.Valid {
			return ""
		}
		return x.Time.UTC().Format(time.RFC3339Nano)
	case pgtype.Date:
		if !x.Valid {
			return ""
		}
		return x.Time.UTC().Format("2006-01-02")
	default:
		return fmt.Sprintf("%v", v)
	}
}

// normalizeNumericText canonicalizes a NUMERIC's text form for id synthesis.
// PostgreSQL treats 42, 42.0 and 42.00 as equal, but pgtype.Numeric.Value()
// preserves the display scale, so a vertex PK and the referencing edge key
// declared with different scales would otherwise synthesize mismatched ids and
// fail to link on the canvas. We strip trailing fractional zeros (and a bare
// trailing dot). NaN / Infinity / scientific forms are left untouched.
func normalizeNumericText(s string) string {
	if !strings.Contains(s, ".") {
		return s
	}
	if strings.ContainsAny(s, "eEnN") { // scientific / NaN / Infinity
		return s
	}
	s = strings.TrimRight(s, "0")
	return strings.TrimRight(s, ".")
}

// FormatUUIDBytes returns the canonical lowercase 8-4-4-4-12 UUID form for
// a raw 16-byte value. Exported so the api package can share one
// implementation instead of carrying a copy.
func FormatUUIDBytes(b [16]byte) string {
	const hexchars = "0123456789abcdef"
	out := make([]byte, 36)
	j := 0
	for i, c := range b {
		if i == 4 || i == 6 || i == 8 || i == 10 {
			out[j] = '-'
			j++
		}
		out[j] = hexchars[c>>4]
		out[j+1] = hexchars[c&0x0f]
		j += 2
	}
	return string(out)
}

func projectColumn(alias, propName, outName string) string {
	return pgQuoteIdent(alias) + "." + pgQuoteIdent(propName) + " AS " + pgQuoteIdent(outName)
}

// makePropertyFilter turns the optional DisplayProperties allow-list into
// a "should I project this?" predicate. Empty list means "yes to all";
// names that don't exist on the element are an error so the caller hears
// about typos rather than silently dropping data.
func makePropertyFilter(allow []string, props []Property, elemAlias string) (func(string) bool, error) {
	if len(allow) == 0 {
		return func(string) bool { return true }, nil
	}
	declared := make(map[string]struct{}, len(props))
	for _, p := range props {
		declared[p.Name] = struct{}{}
	}
	want := make(map[string]struct{}, len(allow))
	for _, name := range allow {
		if _, ok := declared[name]; !ok {
			return nil, fmt.Errorf("display_properties names %q which is not a declared property of element %q", name, elemAlias)
		}
		want[name] = struct{}{}
	}
	return func(name string) bool {
		_, ok := want[name]
		return ok
	}, nil
}

// nonEmptyTrimmed returns the input with whitespace-only entries dropped and
// the survivors trimmed. Used to decide whether a caller actually supplied a
// custom COLUMNS list (mirrors the From-item filtering in assembleSQL).
func nonEmptyTrimmed(in []string) []string {
	var out []string
	for _, s := range in {
		if t := strings.TrimSpace(s); t != "" {
			out = append(out, t)
		}
	}
	return out
}

// heuristicDisplayProperties picks a small, human-meaningful display set for a
// wide element when the caller gave no explicit DisplayProperties. Preference
// order: a conventional name-ish column (name/title/label/display_name), then
// the first text-typed property, then — failing both — the first declared
// property so we never project an empty body. PK / edge keys are added by the
// caller regardless, so this only governs the descriptive payload.
func heuristicDisplayProperties(props []Property) []string {
	nameish := map[string]struct{}{
		"name": {}, "title": {}, "label": {}, "display_name": {}, "displayname": {},
	}
	// First pass: a conventional name-ish column (case-insensitive).
	for _, p := range props {
		if _, ok := nameish[strings.ToLower(p.Name)]; ok {
			return []string{p.Name}
		}
	}
	// Second pass: the first text-ish property.
	for _, p := range props {
		if isTextType(p.Type) {
			return []string{p.Name}
		}
	}
	// Fallback: the first declared property, if any.
	if len(props) > 0 {
		return []string{props[0].Name}
	}
	return nil
}

// propertiesForLabel returns the subset of props declared on the given label.
// A property with no Labels recorded (e.g. older metadata) is conservatively
// kept, so scoping never silently drops a property it can't classify.
func propertiesForLabel(props []Property, label string) []Property {
	out := make([]Property, 0, len(props))
	for _, p := range props {
		if len(p.Labels) == 0 || slices.Contains(p.Labels, label) {
			out = append(out, p)
		}
	}
	return out
}

// isTextType reports whether a declared property type name is a textual SQL
// type. Matches the common pg_type names so the heuristic can favour
// human-readable columns over numeric / temporal ones.
func isTextType(t string) bool {
	switch strings.ToLower(strings.TrimSpace(t)) {
	case "text", "varchar", "character varying", "char", "character", "bpchar", "name", "citext":
		return true
	}
	return false
}

// missingKeyProperties returns the subset of cols that are not accessible as
// declared properties on the given element. Used to validate that PK / source
// / dest key columns are projectable inside the COLUMNS clause.
func missingKeyProperties(el *Element, cols []string) []string {
	var missing []string
	for _, c := range cols {
		if _, ok := propertyForColumn(el, c); !ok {
			missing = append(missing, c)
		}
	}
	return missing
}

// propertyForColumn returns the SQL/PGQ property name that exposes an
// underlying table column. The ideal case is a property with the same name as
// the column. We also accept a property alias over a plain column expression,
// e.g. PROPERTIES (id AS person_id), because projecting person_id still gives
// the stable PK/FK value needed to synthesize graph identities.
func propertyForColumn(el *Element, col string) (string, bool) {
	for _, p := range el.Properties {
		if p.Name == col {
			return p.Name, true
		}
	}
	for _, p := range el.Properties {
		if p.Expression != nil && simpleColumnExprMatches(*p.Expression, col) {
			return p.Name, true
		}
	}
	return "", false
}

func simpleColumnExprMatches(expr, col string) bool {
	e := strings.TrimSpace(expr)
	return e == col || e == pgQuoteIdent(col)
}

// validateAlias rejects characters that would break the projected column
// names. SQL/PGQ aliases are PG identifiers, so this is conservative.
func validateAlias(a string) error {
	if a == "" {
		return errors.New("alias must not be empty")
	}
	if strings.Contains(a, sep) {
		return fmt.Errorf("alias must not contain %q", sep)
	}
	for _, r := range a {
		switch {
		case r >= 'a' && r <= 'z',
			r >= 'A' && r <= 'Z',
			r >= '0' && r <= '9',
			r == '_':
		default:
			return fmt.Errorf("alias contains unsupported character %q", r)
		}
	}
	return nil
}
