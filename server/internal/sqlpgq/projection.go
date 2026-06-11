package sqlpgq

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
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
// vertex" UX. PK and edge-endpoint key columns are always projected
// regardless, since the synthetic id and endpoint linking need them. A
// non-empty list lets a renderer (or a power-user hitting the HTTP API
// directly) trim wide graphs down to a sane payload size — see todo.md
// item #6.
type Binding struct {
	Alias             string   `json:"alias"`
	ElementOID        uint32   `json:"element_oid"`
	DisplayProperties []string `json:"display_properties,omitempty"`
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

		// PK columns — always projected. Position recorded in pkCols for
		// the decoder to assemble the synthetic id.
		for _, c := range el.PK {
			out := b.Alias + sep + prefixPK + sep + c
			propName, _ := propertyForColumn(el, c)
			db.pkCols = append(db.pkCols, addCol(b.Alias, propName, out, prefixPK))
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
		effectiveDisplay := b.DisplayProperties
		var didTrim bool
		if len(effectiveDisplay) == 0 && len(el.Properties) > wideElementPropertyThreshold {
			effectiveDisplay = heuristicDisplayProperties(el)
			didTrim = true
		}
		propFilter, err := makePropertyFilter(effectiveDisplay, el)
		if err != nil {
			return nil, fmt.Errorf("binding %q: %w", b.Alias, err)
		}
		var projectedProps []string
		for _, p := range el.Properties {
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
				Total:      len(el.Properties),
				Projected:  projectedProps,
			})
		}

		// Edge source / destination key columns. We project the key columns
		// of the *edge* table — those values equal the corresponding PK
		// values of the source / destination vertex (FK = referenced PK).
		if el.Kind == "e" {
			if el.Source != nil {
				for _, c := range el.Source.Key {
					out := b.Alias + sep + prefixSK + sep + c
					propName, _ := propertyForColumn(el, c)
					db.srcKeyCols = append(db.srcKeyCols, addCol(b.Alias, propName, out, prefixSK))
				}
				db.srcVertexOID = el.Source.VertexOID
			}
			if el.Destination != nil {
				for _, c := range el.Destination.Key {
					out := b.Alias + sep + prefixDK + sep + c
					propName, _ := propertyForColumn(el, c)
					db.dstKeyCols = append(db.dstKeyCols, addCol(b.Alias, propName, out, prefixDK))
				}
				db.dstVertexOID = el.Destination.VertexOID
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
	}, nil
}

// validateBinding rejects a binding the projection cannot honour: an element
// carrying an error-severity diagnostic, or one whose PK / edge-endpoint key
// columns are not declared as properties.
//
// Warning-severity diagnostics (e.g. non-unique KEY) flow through unblocked —
// they're surfaced via the metadata so the UI can render an advisory banner.
//
// The key-column rule exists because SQL/PGQ only allows declared properties
// in COLUMNS, and the projection synthesizes element identity from PK / FK
// column values, so those columns must be exposed as properties.
func validateBinding(b Binding, el *Element) error {
	for _, d := range el.Diagnostics {
		if d.Severity == "error" {
			return fmt.Errorf("binding %q (%s): %s", b.Alias, el.Alias, d.Message)
		}
	}
	if missing := missingKeyProperties(el, el.PK); len(missing) > 0 {
		return fmt.Errorf(
			"binding %q (%s): PK columns %v are not declared as properties — recreate the property graph with PROPERTIES ALL COLUMNS or list them in PROPERTIES (...)",
			b.Alias, el.Alias, missing,
		)
	}
	if el.Kind != "e" {
		return nil
	}
	if el.Source != nil {
		if missing := missingKeyProperties(el, el.Source.Key); len(missing) > 0 {
			return fmt.Errorf(
				"binding %q (%s): source key columns %v are not declared as properties",
				b.Alias, el.Alias, missing,
			)
		}
	}
	if el.Destination != nil {
		if missing := missingKeyProperties(el, el.Destination.Key); len(missing) > 0 {
			return fmt.Errorf(
				"binding %q (%s): destination key columns %v are not declared as properties",
				b.Alias, el.Alias, missing,
			)
		}
	}
	return nil
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
	Alias        string   `json:"alias"`
	ElementOID   uint32   `json:"element_oid"`
	Kind         string   `json:"kind"`
	Labels       []string `json:"labels"`
	pkCols       []int    // column indices (in the streamed row) for PK
	propCols     []propRef
	srcKeyCols   []int
	dstKeyCols   []int
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

// Decode produces one Event per binding for the given row. If any of the
// PK values are NULL for a binding (which happens with outer-join-shaped
// matches — not in v0 PG19, but defensive anyway), the binding is skipped.
func (d *RowDecoder) Decode(values []any) []Event {
	out := make([]Event, 0, len(d.Bindings))
	for _, b := range d.Bindings {
		pk, ok := joinKey(values, b.pkCols)
		if !ok {
			continue
		}
		ev := Event{
			Binding:    b.Alias,
			Labels:     b.Labels,
			Properties: make(map[string]any, len(b.propCols)),
			ID:         fmt.Sprintf("%d:%s", b.ElementOID, pk),
		}
		for _, p := range b.propCols {
			ev.Properties[p.name] = values[p.idx]
		}
		switch b.Kind {
		case "v":
			ev.Kind = EventVertex
		case "e":
			ev.Kind = EventEdge
			if sk, ok := joinKey(values, b.srcKeyCols); ok && b.srcVertexOID != 0 {
				ev.Source = fmt.Sprintf("%d:%s", b.srcVertexOID, sk)
			}
			if dk, ok := joinKey(values, b.dstKeyCols); ok && b.dstVertexOID != 0 {
				ev.Destination = fmt.Sprintf("%d:%s", b.dstVertexOID, dk)
			}
		default:
			continue
		}
		out = append(out, ev)
	}
	return out
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
			return str
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
func makePropertyFilter(allow []string, el *Element) (func(string) bool, error) {
	if len(allow) == 0 {
		return func(string) bool { return true }, nil
	}
	declared := make(map[string]struct{}, len(el.Properties))
	for _, p := range el.Properties {
		declared[p.Name] = struct{}{}
	}
	want := make(map[string]struct{}, len(allow))
	for _, name := range allow {
		if _, ok := declared[name]; !ok {
			return nil, fmt.Errorf("display_properties names %q which is not a declared property of element %q", name, el.Alias)
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
func heuristicDisplayProperties(el *Element) []string {
	nameish := map[string]struct{}{
		"name": {}, "title": {}, "label": {}, "display_name": {}, "displayname": {},
	}
	// First pass: a conventional name-ish column (case-insensitive).
	for _, p := range el.Properties {
		if _, ok := nameish[strings.ToLower(p.Name)]; ok {
			return []string{p.Name}
		}
	}
	// Second pass: the first text-ish property.
	for _, p := range el.Properties {
		if isTextType(p.Type) {
			return []string{p.Name}
		}
	}
	// Fallback: the first declared property, if any.
	if len(el.Properties) > 0 {
		return []string{el.Properties[0].Name}
	}
	return nil
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
