package sqlpgq

// Graph identifies a property graph at the catalog level.
type Graph struct {
	OID    uint32 `json:"oid"`
	Schema string `json:"schema"`
	Name   string `json:"name"`
	Owner  string `json:"owner"`
}

// GraphMetadata is the full descriptor returned by GetMetadata.
type GraphMetadata struct {
	Graph      Graph     `json:"graph"`
	Definition string    `json:"definition"`
	Vertices   []Element `json:"vertices"`
	Edges      []Element `json:"edges"`
}

// Element describes a single VERTEX or EDGE table within a property graph.
type Element struct {
	OID        uint32     `json:"oid"`
	Alias      string     `json:"alias"`
	Kind       string     `json:"kind"` // "v" | "e"
	Table      TableRef   `json:"table"`
	PK         []string   `json:"pk"`
	Labels     []string   `json:"labels"`
	Properties []Property `json:"properties"`
	// Source / Destination are set only when Kind == "e".
	Source      *EdgeEnd `json:"source,omitempty"`
	Destination *EdgeEnd `json:"destination,omitempty"`
	// Diagnostics is the set of catalog-shape problems detected at metadata
	// load time. Empty in the happy path. See Diagnostic.Code for the
	// taxonomy. Producers MUST keep entries actionable — each one is shown
	// directly to the user.
	Diagnostics []Diagnostic `json:"diagnostics,omitempty"`
}

// Diagnostic flags a property-graph configuration that PostgreSQL 19 accepts
// but that breaks the viewer's identity-synthesis assumptions. We surface
// these so users see why the canvas might look wrong.
//
// Codes (stable, for client-side messaging):
//
//   - "non-unique-key" (warning): the element's KEY columns are not covered
//     by a non-partial unique index, so multiple underlying rows can
//     produce the same synthetic id and silently merge on the canvas.
//   - "ref-not-vertex-key" (error): an edge's SOURCE/DESTINATION REFERENCES
//     columns do not equal the referenced vertex element's KEY columns, so
//     synthesized endpoint ids will not match any vertex's synthesized id.
type Diagnostic struct {
	Code     string `json:"code"`
	Severity string `json:"severity"` // "warning" | "error"
	Message  string `json:"message"`
	// Field optionally names the offending sub-field (e.g. "source",
	// "destination"). Empty when the diagnostic applies to the element as a
	// whole.
	Field string `json:"field,omitempty"`
}

// TableRef is the underlying relation backing an element.
type TableRef struct {
	OID    uint32 `json:"oid"`
	Schema string `json:"schema"`
	Name   string `json:"name"`
}

// EdgeEnd describes one end of an edge's FK relationship.
//
// We don't carry the per-column equality operators (pgesrceqop /
// pgedesteqop) because verification against PG19's propgraphcmds.c
// (lines 424-454) shows they're always the type-default `=` — the user
// has no syntax to pick a non-default opclass on REFERENCES, so the
// information is constant and informational.
type EdgeEnd struct {
	Vertex    string   `json:"vertex"`     // alias of the referenced vertex element
	VertexOID uint32   `json:"vertex_oid"` // oid of the referenced vertex element
	Key       []string `json:"key"`        // FK columns in the edge table
	Ref       []string `json:"ref"`        // referenced columns in the vertex table
}

// Property is one declared property on a graph.
type Property struct {
	Name string `json:"name"`
	Type string `json:"type"`
	// Expression renders the source-side expression (via pg_get_expr on the
	// node tree in pg_propgraph_label_property.plpexpr). For a plain column
	// reference it'll match Name; for a computed property like `i + j AS k`
	// it carries the expression text.
	Expression *string `json:"expression,omitempty"`
}

// LabelCount carries the row count of an element's underlying table along
// with the labels it carries. The meta-chart aggregates these client-side
// to derive per-label counts.
type LabelCount struct {
	ElementOID uint32   `json:"element_oid"`
	Alias      string   `json:"alias"`
	Kind       string   `json:"kind"`
	Labels     []string `json:"labels"`
	Count      int64    `json:"count"`
}

