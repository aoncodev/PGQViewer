package sqlpgq_test

import (
	"context"
	"strings"
	"testing"

	"github.com/aoncodev/PGQViewer/server/internal/sqlpgq"
	"github.com/jackc/pgx/v5/pgtype"
)

// numericFromString builds a pgtype.Numeric from a decimal string, mirroring
// the way pgx hands back a NUMERIC column value.
func numericFromString(t *testing.T, s string) pgtype.Numeric {
	t.Helper()
	var n pgtype.Numeric
	if err := n.Scan(s); err != nil {
		t.Fatalf("scan numeric %q: %v", s, err)
	}
	return n
}

// TestFormatPKPart_IDCollapse pins the contract that the vertex-PK path and
// the edge src/dst-key path produce identical synthetic ids for the same
// logical value regardless of which pgx Go-type the value arrives as. Both
// paths funnel through formatPKPart (exercised here via the decoder), so a
// numeric 42 arriving as int64 on one side and pgtype.Numeric on the other
// must collapse to the same id — otherwise an edge endpoint would never line
// up with its vertex on the canvas.
func TestFormatPKPart_IDCollapse(t *testing.T) {
	idExpr := "id"
	srcExpr := "src"
	dstExpr := "dst"
	md := &sqlpgq.GraphMetadata{
		Graph: sqlpgq.Graph{Schema: "public", Name: "g"},
		Vertices: []sqlpgq.Element{{
			OID:    100,
			Alias:  "people",
			Kind:   "v",
			PK:     []string{"id"},
			Labels: []string{"person"},
			Properties: []sqlpgq.Property{
				{Name: "person_id", Type: "integer", Expression: &idExpr},
			},
		}},
		Edges: []sqlpgq.Element{{
			OID:    200,
			Alias:  "knows",
			Kind:   "e",
			PK:     []string{"src", "dst"},
			Labels: []string{"knows"},
			Properties: []sqlpgq.Property{
				{Name: "from_id", Type: "integer", Expression: &srcExpr},
				{Name: "to_id", Type: "integer", Expression: &dstExpr},
			},
			Source:      &sqlpgq.EdgeEnd{VertexOID: 100, Key: []string{"src"}, Ref: []string{"id"}},
			Destination: &sqlpgq.EdgeEnd{VertexOID: 100, Key: []string{"dst"}, Ref: []string{"id"}},
		}},
	}

	// Build a projection over the vertex to get the vertex id string, and one
	// over the edge to get the source endpoint id string, for the same logical
	// value 42 — but supply different Go representations on each side.
	vpq, err := sqlpgq.BuildProjection(md,
		[]sqlpgq.Binding{{Alias: "a", ElementOID: 100}}, "(a IS person)", "", 0)
	if err != nil {
		t.Fatalf("vertex BuildProjection: %v", err)
	}
	epq, err := sqlpgq.BuildProjection(md,
		[]sqlpgq.Binding{{Alias: "k", ElementOID: 200}}, "()-[k IS knows]->()", "", 0)
	if err != nil {
		t.Fatalf("edge BuildProjection: %v", err)
	}

	cases := []struct {
		name      string
		vertexVal any // value for the vertex PK column (person_id)
		srcVal    any // value for the edge source key column (from_id)
	}{
		{"int64 vs pgtype.Numeric", int64(42), numericFromString(t, "42")},
		{"int32 vs int64", int32(42), int64(42)},
		{"pgtype.Int4 vs int", pgtype.Int4{Int32: 42, Valid: true}, int(42)},
		{"int vs pgtype.Numeric", int(7), numericFromString(t, "7")},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// Vertex row: [pk(person_id), prop(person_id)] — one PK col, one prop.
			vEvents := vpq.Decoder.Decode([]any{tc.vertexVal, tc.vertexVal})
			if len(vEvents) != 1 {
				t.Fatalf("vertex events = %d, want 1", len(vEvents))
			}
			vertexID := vEvents[0].ID

			// Edge row layout (sorted alias "k"): pk(src), pk(dst), prop(from_id),
			// prop(to_id), sk(src), dk(dst). Set src side to srcVal, dst to a
			// distinct value so the source id derives from srcVal.
			eEvents := epq.Decoder.Decode([]any{
				tc.srcVal, int64(999), // pk src, pk dst
				tc.srcVal, int64(999), // prop from_id, to_id
				tc.srcVal, int64(999), // sk src, dk dst
			})
			if len(eEvents) != 1 {
				t.Fatalf("edge events = %d, want 1", len(eEvents))
			}
			if eEvents[0].Source != vertexID {
				t.Fatalf("edge source id %q != vertex id %q", eEvents[0].Source, vertexID)
			}
		})
	}
}

// TestFormatPKPart_BoolFloatText covers the canonical-form contract for the
// newly broadened scalar types: a value arriving as a raw Go type and the
// same value arriving as its pgtype wrapper must produce the same id.
func TestFormatPKPart_BoolFloatText(t *testing.T) {
	keyExpr := "k"
	mkMD := func() *sqlpgq.GraphMetadata {
		return &sqlpgq.GraphMetadata{
			Graph: sqlpgq.Graph{Schema: "public", Name: "g"},
			Vertices: []sqlpgq.Element{{
				OID:    100,
				Alias:  "v",
				Kind:   "v",
				PK:     []string{"k"},
				Labels: []string{"l"},
				Properties: []sqlpgq.Property{
					{Name: "key", Type: "text", Expression: &keyExpr},
				},
			}},
		}
	}
	pq, err := sqlpgq.BuildProjection(mkMD(),
		[]sqlpgq.Binding{{Alias: "v", ElementOID: 100}}, "(v IS l)", "", 0)
	if err != nil {
		t.Fatalf("BuildProjection: %v", err)
	}

	id := func(pkVal any) string {
		evs := pq.Decoder.Decode([]any{pkVal, pkVal})
		if len(evs) != 1 {
			t.Fatalf("events = %d, want 1", len(evs))
		}
		return evs[0].ID
	}

	pairs := []struct {
		name string
		a, b any
	}{
		{"bool", true, pgtype.Bool{Bool: true, Valid: true}},
		{"float8", float64(1.5), pgtype.Float8{Float64: 1.5, Valid: true}},
		{"text", "hello", pgtype.Text{String: "hello", Valid: true}},
		{"int4-raw-vs-wrapped", int32(3), pgtype.Int4{Int32: 3, Valid: true}},
	}
	for _, p := range pairs {
		t.Run(p.name, func(t *testing.T) {
			if got, want := id(p.a), id(p.b); got != want {
				t.Fatalf("ids differ: %q vs %q", got, want)
			}
		})
	}
}

// TestFormatPKPart_NumericScale pins that NUMERIC values PG considers equal but
// that arrive with different display scales (e.g. a vertex PK numeric(10,0) and
// the referencing edge key numeric(10,2)) synthesize the SAME id, so the edge
// still links to its vertex. Regression for the numeric-scale id fix.
func TestFormatPKPart_NumericScale(t *testing.T) {
	md := &sqlpgq.GraphMetadata{
		Graph: sqlpgq.Graph{Schema: "public", Name: "g"},
		Vertices: []sqlpgq.Element{{
			OID: 100, Alias: "v", Kind: "v", PK: []string{"id"},
			Labels:     []string{"l"},
			Properties: []sqlpgq.Property{{Name: "id", Type: "numeric"}},
		}},
	}
	pq, err := sqlpgq.BuildProjection(md,
		[]sqlpgq.Binding{{Alias: "v", ElementOID: 100}}, "(v IS l)", "", 0)
	if err != nil {
		t.Fatalf("BuildProjection: %v", err)
	}
	id := func(s string) string {
		n := numericFromString(t, s)
		evs := pq.Decoder.Decode([]any{n, n})
		if len(evs) != 1 {
			t.Fatalf("events=%d, want 1", len(evs))
		}
		return evs[0].ID
	}
	if a, b := id("42"), id("42.00"); a != b {
		t.Fatalf("numeric 42 and 42.00 must share an id, got %q vs %q", a, b)
	}
	if a, b := id("42.50"), id("42.5"); a != b {
		t.Fatalf("numeric 42.50 and 42.5 must share an id, got %q vs %q", a, b)
	}
}

// TestBuildProjection_CustomColumns checks that a caller-supplied COLUMNS list
// is emitted verbatim, the query is flagged tabular with a nil decoder, and
// params are carried through.
func TestBuildProjection_CustomColumns(t *testing.T) {
	md := &sqlpgq.GraphMetadata{
		Graph: sqlpgq.Graph{Schema: "public", Name: "g"},
		Vertices: []sqlpgq.Element{{
			OID: 100, Alias: "people", Kind: "v", PK: []string{"id"},
			Labels:     []string{"person"},
			Properties: []sqlpgq.Property{{Name: "name", Type: "text"}},
		}},
	}
	pq, err := sqlpgq.BuildProjectionWithOpts(sqlpgq.ProjectionOpts{
		Metadata: md,
		Bindings: []sqlpgq.Binding{{Alias: "a", ElementOID: 100}},
		Match:    "(a IS person)",
		Columns:  []string{"a.name AS who", "count(*) OVER () AS n"},
		Params:   []any{int64(5)},
	})
	if err != nil {
		t.Fatalf("BuildProjectionWithOpts: %v", err)
	}
	if !pq.Tabular {
		t.Fatalf("expected Tabular=true")
	}
	if pq.Decoder != nil {
		t.Fatalf("expected nil Decoder for tabular query")
	}
	if !strings.Contains(pq.SQL, "a.name AS who") || !strings.Contains(pq.SQL, "count(*) OVER () AS n") {
		t.Fatalf("custom columns not emitted verbatim:\n%s", pq.SQL)
	}
	if len(pq.Params) != 1 {
		t.Fatalf("params not carried: %v", pq.Params)
	}
}

// TestBuildProjection_LateralForm pins that the lateral From form joins
// GRAPH_TABLE WITHOUT the LATERAL keyword — PG19 rejects `LATERAL GRAPH_TABLE`,
// which is already implicitly lateral. Regression for the LATERAL fix.
func TestBuildProjection_LateralForm(t *testing.T) {
	md := &sqlpgq.GraphMetadata{
		Graph: sqlpgq.Graph{Schema: "public", Name: "social"},
		Vertices: []sqlpgq.Element{{
			OID: 100, Alias: "people", Kind: "v", PK: []string{"id"},
			Labels:     []string{"person"},
			Properties: []sqlpgq.Property{{Name: "id", Type: "integer"}, {Name: "name", Type: "text"}},
		}},
	}
	pq, err := sqlpgq.BuildProjectionWithOpts(sqlpgq.ProjectionOpts{
		Metadata:     md,
		Bindings:     []sqlpgq.Binding{{Alias: "a", ElementOID: 100}},
		Match:        "(a IS person)",
		LateralFrom:  []string{"(VALUES (1)) v(x)"},
		LateralAlias: "gt",
	})
	if err != nil {
		t.Fatalf("BuildProjectionWithOpts: %v", err)
	}
	if strings.Contains(strings.ToUpper(pq.SQL), "LATERAL") {
		t.Fatalf("lateral form must NOT contain the LATERAL keyword (PG19 rejects it):\n%s", pq.SQL)
	}
	if !strings.Contains(pq.SQL, "GRAPH_TABLE") {
		t.Fatalf("expected GRAPH_TABLE in lateral form:\n%s", pq.SQL)
	}
	if !strings.Contains(pq.SQL, "(VALUES (1)) v(x)") || !strings.Contains(pq.SQL, `"gt"`) {
		t.Fatalf("lateral From item / alias missing:\n%s", pq.SQL)
	}
}

// TestBuildProjection_WideElementTrim checks that an element with more than the
// threshold count of properties and no explicit DisplayProperties is trimmed
// to a heuristic display set, with PK still projected and a TrimInfo recorded.
func TestBuildProjection_WideElementTrim(t *testing.T) {
	props := []sqlpgq.Property{{Name: "id", Type: "integer"}}
	for i := 0; i < 40; i++ {
		props = append(props, sqlpgq.Property{Name: padName("col", i), Type: "integer"})
	}
	// Inject a name-ish column the heuristic should prefer.
	props = append(props, sqlpgq.Property{Name: "name", Type: "text"})

	md := &sqlpgq.GraphMetadata{
		Graph: sqlpgq.Graph{Schema: "public", Name: "g"},
		Vertices: []sqlpgq.Element{{
			OID: 100, Alias: "wide", Kind: "v", PK: []string{"id"},
			Labels: []string{"w"}, Properties: props,
		}},
	}
	pq, err := sqlpgq.BuildProjection(md,
		[]sqlpgq.Binding{{Alias: "a", ElementOID: 100}}, "(a IS w)", "", 0)
	if err != nil {
		t.Fatalf("BuildProjection: %v", err)
	}
	if len(pq.Trimmed) != 1 {
		t.Fatalf("expected 1 TrimInfo, got %d", len(pq.Trimmed))
	}
	if pq.Trimmed[0].Total != len(props) {
		t.Fatalf("TrimInfo.Total = %d, want %d", pq.Trimmed[0].Total, len(props))
	}
	// PK still projected.
	if !strings.Contains(pq.SQL, `"a__pk__id"`) {
		t.Fatalf("PK not projected after trim:\n%s", pq.SQL)
	}
	// Heuristic picked the name-ish column.
	if !strings.Contains(pq.SQL, `"a__p__name"`) {
		t.Fatalf("expected name column in trimmed projection:\n%s", pq.SQL)
	}
	// A non-displayed numeric column must be absent from the property block.
	if strings.Contains(pq.SQL, `"a__p__col0"`) {
		t.Fatalf("trim did not drop wide columns:\n%s", pq.SQL)
	}
}

// TestBuildProjection_ColumnMap verifies the synthetic-alias -> (binding,
// property) mapping is populated for the auto-projection.
func TestBuildProjection_ColumnMap(t *testing.T) {
	md := &sqlpgq.GraphMetadata{
		Graph: sqlpgq.Graph{Schema: "public", Name: "g"},
		Vertices: []sqlpgq.Element{{
			OID: 100, Alias: "people", Kind: "v", PK: []string{"id"},
			Labels: []string{"person"},
			Properties: []sqlpgq.Property{
				{Name: "id", Type: "integer"},
				{Name: "name", Type: "text"},
			},
		}},
	}
	pq, err := sqlpgq.BuildProjection(md,
		[]sqlpgq.Binding{{Alias: "a", ElementOID: 100}}, "(a IS person)", "", 0)
	if err != nil {
		t.Fatalf("BuildProjection: %v", err)
	}
	want := map[string]sqlpgq.ColumnMapping{
		"a__pk__id": {Column: "a__pk__id", Alias: "a", Property: "id", Role: "pk"},
		"a__p__name": {Column: "a__p__name", Alias: "a", Property: "name", Role: "p"},
	}
	got := map[string]sqlpgq.ColumnMapping{}
	for _, m := range pq.ColumnMap {
		got[m.Column] = m
	}
	for col, exp := range want {
		if got[col] != exp {
			t.Fatalf("ColumnMap[%q] = %+v, want %+v", col, got[col], exp)
		}
	}
}

// padName produces a deterministic property name like "col0", "col1".
func padName(prefix string, i int) string {
	return prefix + itoa(i)
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b [20]byte
	pos := len(b)
	for i > 0 {
		pos--
		b[pos] = byte('0' + i%10)
		i /= 10
	}
	return string(b[pos:])
}

func TestBuildProjection_SocialGraph(t *testing.T) {
	ctx, p := openPool(t)
	graphs, err := sqlpgq.ListGraphs(ctx, p.Q())
	if err != nil {
		t.Fatalf("ListGraphs: %v", err)
	}
	var oid uint32
	for _, g := range graphs {
		if g.Name == "social" {
			oid = g.OID
		}
	}
	if oid == 0 {
		t.Fatalf("social graph not found")
	}

	md, err := sqlpgq.GetMetadata(ctx, p.Q(), oid)
	if err != nil {
		t.Fatalf("GetMetadata: %v", err)
	}

	var peopleOID, knowsOID uint32
	for _, v := range md.Vertices {
		if v.Alias == "people" {
			peopleOID = v.OID
		}
	}
	for _, e := range md.Edges {
		if e.Alias == "knows" {
			knowsOID = e.OID
		}
	}

	pq, err := sqlpgq.BuildProjection(md,
		[]sqlpgq.Binding{
			{Alias: "a", ElementOID: peopleOID},
			{Alias: "k", ElementOID: knowsOID},
			{Alias: "b", ElementOID: peopleOID},
		},
		"(a IS person)-[k IS knows]->(b IS person)",
		"",
		0,
	)
	if err != nil {
		t.Fatalf("BuildProjection: %v", err)
	}

	// Sanity-check the SQL: all expected column aliases must appear.
	for _, want := range []string{
		`"a__pk__id"`, `"a__p__name"`, `"a__p__born"`,
		`"k__pk__src"`, `"k__pk__dst"`, `"k__p__since"`,
		`"k__sk__src"`, `"k__dk__dst"`,
		`"b__pk__id"`,
	} {
		if !strings.Contains(pq.SQL, want) {
			t.Errorf("SQL missing %s\n--- SQL ---\n%s", want, pq.SQL)
		}
	}

	// Run it and stream into events using the decoder.
	rows, err := p.Q().Query(context.Background(), pq.SQL)
	if err != nil {
		t.Fatalf("query: %v\nSQL:\n%s", err, pq.SQL)
	}
	defer rows.Close()

	vertices := map[string]bool{}
	edges := map[string]bool{}
	for rows.Next() {
		vals, err := rows.Values()
		if err != nil {
			t.Fatalf("scan: %v", err)
		}
		for _, ev := range pq.Decoder.Decode(vals) {
			switch ev.Kind {
			case sqlpgq.EventVertex:
				vertices[ev.ID] = true
			case sqlpgq.EventEdge:
				edges[ev.ID] = true
				if ev.Source == "" || ev.Destination == "" {
					t.Errorf("edge missing endpoints: %+v", ev)
				}
			}
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows err: %v", err)
	}

	// Demo data: 4 people, 4 knows. Match returns 4 rows; each row binds 3
	// elements (a, k, b). After deduplication by id we expect at most 4
	// unique vertices and 4 unique edges. With this dataset, all 4 vertices
	// and all 4 edges appear.
	if len(vertices) != 4 {
		t.Errorf("vertices = %d (%v), want 4", len(vertices), vertices)
	}
	if len(edges) != 4 {
		t.Errorf("edges = %d (%v), want 4", len(edges), edges)
	}
}

func TestBuildProjection_RejectsUnknownBinding(t *testing.T) {
	md := &sqlpgq.GraphMetadata{
		Graph:    sqlpgq.Graph{Schema: "public", Name: "g"},
		Vertices: []sqlpgq.Element{{OID: 100, Alias: "x", Kind: "v", PK: []string{"id"}}},
	}
	_, err := sqlpgq.BuildProjection(md,
		[]sqlpgq.Binding{{Alias: "a", ElementOID: 999}},
		"(a)", "", 0)
	if err == nil {
		t.Fatal("expected error for unknown element_oid")
	}
}

func TestBuildProjection_RejectsBadAlias(t *testing.T) {
	md := &sqlpgq.GraphMetadata{
		Graph:    sqlpgq.Graph{Schema: "public", Name: "g"},
		Vertices: []sqlpgq.Element{{OID: 100, Alias: "x", Kind: "v", PK: []string{"id"}}},
	}
	_, err := sqlpgq.BuildProjection(md,
		[]sqlpgq.Binding{{Alias: "a__b", ElementOID: 100}},
		"(a__b)", "", 0)
	if err == nil {
		t.Fatal("expected error for alias containing separator")
	}
}

func TestBuildProjection_AllowsKeyColumnPropertyAlias(t *testing.T) {
	idExpr := "id"
	md := &sqlpgq.GraphMetadata{
		Graph: sqlpgq.Graph{Schema: "public", Name: "g"},
		Vertices: []sqlpgq.Element{{
			OID:    100,
			Alias:  "people",
			Kind:   "v",
			PK:     []string{"id"},
			Labels: []string{"person"},
			Properties: []sqlpgq.Property{
				{Name: "person_id", Type: "integer", Expression: &idExpr},
				{Name: "name", Type: "text"},
			},
		}},
	}

	pq, err := sqlpgq.BuildProjection(md,
		[]sqlpgq.Binding{{Alias: "a", ElementOID: 100}},
		"(a IS person)", "", 0)
	if err != nil {
		t.Fatalf("BuildProjection: %v", err)
	}
	if !strings.Contains(pq.SQL, `"a"."person_id" AS "a__pk__id"`) {
		t.Fatalf("PK projection did not use aliased property:\n%s", pq.SQL)
	}

	events := pq.Decoder.Decode([]any{int32(42), int32(42), "Alice"})
	if len(events) != 1 {
		t.Fatalf("events len = %d, want 1 (%+v)", len(events), events)
	}
	if events[0].ID != `100:["42"]` {
		t.Fatalf(`event id = %q, want 100:["42"]`, events[0].ID)
	}
	if events[0].Properties["person_id"] != int32(42) {
		t.Fatalf("person_id property = %#v", events[0].Properties["person_id"])
	}
}

func TestBuildProjection_AllowsAliasedEdgeKeyProperties(t *testing.T) {
	idExpr := "id"
	srcExpr := "src"
	dstExpr := "dst"
	md := &sqlpgq.GraphMetadata{
		Graph: sqlpgq.Graph{Schema: "public", Name: "g"},
		Vertices: []sqlpgq.Element{{
			OID:    100,
			Alias:  "people",
			Kind:   "v",
			PK:     []string{"id"},
			Labels: []string{"person"},
			Properties: []sqlpgq.Property{
				{Name: "person_id", Type: "integer", Expression: &idExpr},
			},
		}},
		Edges: []sqlpgq.Element{{
			OID:    200,
			Alias:  "knows",
			Kind:   "e",
			PK:     []string{"src", "dst"},
			Labels: []string{"knows"},
			Properties: []sqlpgq.Property{
				{Name: "from_id", Type: "integer", Expression: &srcExpr},
				{Name: "to_id", Type: "integer", Expression: &dstExpr},
			},
			Source: &sqlpgq.EdgeEnd{
				VertexOID: 100,
				Key:       []string{"src"},
				Ref:       []string{"id"},
			},
			Destination: &sqlpgq.EdgeEnd{
				VertexOID: 100,
				Key:       []string{"dst"},
				Ref:       []string{"id"},
			},
		}},
	}

	pq, err := sqlpgq.BuildProjection(md,
		[]sqlpgq.Binding{{Alias: "k", ElementOID: 200}},
		"()-[k IS knows]->()", "", 0)
	if err != nil {
		t.Fatalf("BuildProjection: %v", err)
	}
	for _, want := range []string{
		`"k"."from_id" AS "k__pk__src"`,
		`"k"."to_id" AS "k__pk__dst"`,
		`"k"."from_id" AS "k__sk__src"`,
		`"k"."to_id" AS "k__dk__dst"`,
	} {
		if !strings.Contains(pq.SQL, want) {
			t.Fatalf("SQL missing %s:\n%s", want, pq.SQL)
		}
	}

	events := pq.Decoder.Decode([]any{int32(1), int32(2), int32(1), int32(2), int32(1), int32(2)})
	if len(events) != 1 {
		t.Fatalf("events len = %d, want 1 (%+v)", len(events), events)
	}
	ev := events[0]
	if ev.ID != `200:["1","2"]` || ev.Source != `100:["1"]` || ev.Destination != `100:["2"]` {
		t.Fatalf("decoded edge = %+v", ev)
	}
}

func TestBuildProjection_RejectsMissingKeyProperty(t *testing.T) {
	md := &sqlpgq.GraphMetadata{
		Graph: sqlpgq.Graph{Schema: "public", Name: "g"},
		Vertices: []sqlpgq.Element{{
			OID:        100,
			Alias:      "people",
			Kind:       "v",
			PK:         []string{"id"},
			Labels:     []string{"person"},
			Properties: []sqlpgq.Property{{Name: "name", Type: "text"}},
		}},
	}

	_, err := sqlpgq.BuildProjection(md,
		[]sqlpgq.Binding{{Alias: "a", ElementOID: 100}},
		"(a IS person)", "", 0)
	if err == nil {
		t.Fatal("expected missing key property error")
	}
	if !strings.Contains(err.Error(), "PK columns [id] are not declared as properties") {
		t.Fatalf("unexpected error: %v", err)
	}
}
