package sqlpgq_test

import (
	"context"
	"strings"
	"testing"

	"github.com/aoncodev/PGQViewer/server/internal/sqlpgq"
)

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
