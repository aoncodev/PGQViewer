package sqlpgq_test

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aoncodev/PGQViewer/server/internal/pg"
	"github.com/aoncodev/PGQViewer/server/internal/sqlpgq"
)

// These tests run against the local pgqviewer-pg19 container described in
// PLAN.md. They are skipped automatically when PGVIEWER_TEST_DSN is unset,
// so `go test ./...` stays green on a fresh checkout.
//
// To enable:
//
//	export PGVIEWER_TEST_DSN='postgres://postgres:postgres@127.0.0.1:5435/pgviewer?sslmode=disable'
//	go test ./internal/sqlpgq -v
func dsnOrSkip(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("PGVIEWER_TEST_DSN")
	if dsn == "" {
		t.Skip("PGVIEWER_TEST_DSN not set; skipping integration test")
	}
	return dsn
}

func openPool(t *testing.T) (context.Context, *pgPool) {
	t.Helper()
	dsn := dsnOrSkip(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)

	pool, err := pg.Open(ctx, pg.ConnectInput{DSN: dsn})
	if err != nil {
		t.Fatalf("open pool: %v", err)
	}
	t.Cleanup(pool.Close)
	return ctx, &pgPool{pool}
}

// pgPool is a tiny shim so we don't import *pgxpool.Pool's full type signature
// throughout the test file. It satisfies sqlpgq.Queryer transitively via the
// underlying *pgxpool.Pool.
type pgPool struct{ inner sqlpgq.Queryer }

func (p *pgPool) Q() sqlpgq.Queryer { return p.inner }

func TestListGraphs_FindsDemoSocial(t *testing.T) {
	ctx, p := openPool(t)
	graphs, err := sqlpgq.ListGraphs(ctx, p.Q())
	if err != nil {
		t.Fatalf("ListGraphs: %v", err)
	}
	var found *sqlpgq.Graph
	for i := range graphs {
		if graphs[i].Schema == "public" && graphs[i].Name == "social" {
			found = &graphs[i]
		}
	}
	if found == nil {
		t.Fatalf("expected public.social in %v", graphs)
	}
	if found.OID == 0 {
		t.Errorf("graph oid should be non-zero, got %d", found.OID)
	}
}

func TestGetMetadata_SocialGraph(t *testing.T) {
	ctx, p := openPool(t)
	graphs, err := sqlpgq.ListGraphs(ctx, p.Q())
	if err != nil {
		t.Fatalf("ListGraphs: %v", err)
	}
	var oid uint32
	for _, g := range graphs {
		if g.Schema == "public" && g.Name == "social" {
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
	if md.Graph.Name != "social" {
		t.Errorf("graph.name = %q", md.Graph.Name)
	}
	if md.Definition == "" {
		t.Errorf("definition should not be empty")
	}

	if len(md.Vertices) != 1 {
		t.Fatalf("vertices = %d, want 1", len(md.Vertices))
	}
	v := md.Vertices[0]
	if v.Alias != "people" || v.Kind != "v" {
		t.Errorf("vertex = %+v", v)
	}
	if !equal(v.PK, []string{"id"}) {
		t.Errorf("vertex.PK = %v", v.PK)
	}
	if !equal(v.Labels, []string{"person"}) {
		t.Errorf("vertex.Labels = %v", v.Labels)
	}
	wantProps := map[string]string{"id": "integer", "name": "text", "born": "integer"}
	if len(v.Properties) != len(wantProps) {
		t.Errorf("vertex.Properties len = %d, want %d (%v)", len(v.Properties), len(wantProps), v.Properties)
	}
	for _, p := range v.Properties {
		if got, ok := wantProps[p.Name]; !ok || got != p.Type {
			t.Errorf("unexpected vertex property %+v", p)
		}
	}

	if len(md.Edges) != 1 {
		t.Fatalf("edges = %d, want 1", len(md.Edges))
	}
	e := md.Edges[0]
	if e.Alias != "knows" || e.Kind != "e" {
		t.Errorf("edge = %+v", e)
	}
	if !equal(e.PK, []string{"src", "dst"}) {
		t.Errorf("edge.PK = %v", e.PK)
	}
	if e.Source == nil || e.Source.Vertex != "people" {
		t.Errorf("edge.Source = %+v", e.Source)
	}
	if !equal(e.Source.Key, []string{"src"}) || !equal(e.Source.Ref, []string{"id"}) {
		t.Errorf("edge.Source keys = %+v", e.Source)
	}
	if e.Destination == nil || e.Destination.Vertex != "people" {
		t.Errorf("edge.Destination = %+v", e.Destination)
	}
	if !equal(e.Destination.Key, []string{"dst"}) || !equal(e.Destination.Ref, []string{"id"}) {
		t.Errorf("edge.Destination keys = %+v", e.Destination)
	}
}

func TestGetMetadata_NotFound(t *testing.T) {
	ctx, p := openPool(t)
	_, err := sqlpgq.GetMetadata(ctx, p.Q(), 0)
	if err != sqlpgq.ErrNotFound {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestGetCounts_SocialGraph(t *testing.T) {
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

	counts, err := sqlpgq.GetCounts(ctx, p.Q(), oid)
	if err != nil {
		t.Fatalf("GetCounts: %v", err)
	}
	// We test the *shape* of the response, not the exact count value:
	// `Count` is now `pg_class.reltuples`, which is whatever ANALYZE
	// last wrote (or -1 when ANALYZE has never run). Asserting an exact
	// number would couple us to autovacuum's timing in the test
	// container.
	want := map[string]bool{"people": true, "knows": true}
	if len(counts) != len(want) {
		t.Fatalf("counts len = %d, want %d (%v)", len(counts), len(want), counts)
	}
	for _, c := range counts {
		if _, ok := want[c.Alias]; !ok {
			t.Errorf("unexpected alias %q in counts", c.Alias)
		}
		if len(c.Labels) == 0 {
			t.Errorf("expected at least one label for %s", c.Alias)
		}
	}
}

// selfRefGraph builds an in-memory self-referential metadata (people -knows->
// people) for unit-testing BuildRecursiveExpansion without a database.
func selfRefGraph() (*sqlpgq.GraphMetadata, *sqlpgq.Element) {
	md := &sqlpgq.GraphMetadata{
		Graph: sqlpgq.Graph{Schema: "public", Name: "social"},
		Vertices: []sqlpgq.Element{{
			OID:        100,
			Alias:      "people",
			Kind:       "v",
			Table:      sqlpgq.TableRef{Schema: "public", Name: "people"},
			PK:         []string{"id"},
			Labels:     []string{"person"},
			Properties: []sqlpgq.Property{{Name: "id", Type: "integer"}, {Name: "name", Type: "text"}},
		}},
		Edges: []sqlpgq.Element{{
			OID:         200,
			Alias:       "knows",
			Kind:        "e",
			Table:       sqlpgq.TableRef{Schema: "public", Name: "knows"},
			PK:          []string{"src", "dst"},
			Labels:      []string{"knows"},
			Properties:  []sqlpgq.Property{{Name: "src", Type: "integer"}, {Name: "dst", Type: "integer"}},
			Source:      &sqlpgq.EdgeEnd{VertexOID: 100, Vertex: "people", Key: []string{"src"}, Ref: []string{"id"}},
			Destination: &sqlpgq.EdgeEnd{VertexOID: 100, Vertex: "people", Key: []string{"dst"}, Ref: []string{"id"}},
		}},
	}
	return md, &md.Vertices[0]
}

func TestBuildRecursiveExpansion_OneHopIsPlainJoinWithParams(t *testing.T) {
	md, anchor := selfRefGraph()
	qs, err := sqlpgq.BuildRecursiveExpansion(md, anchor, []string{"3"}, nil, 0, 1)
	if err != nil {
		t.Fatalf("BuildRecursiveExpansion: %v", err)
	}
	// Self-edge emits both directions.
	if len(qs) != 2 {
		t.Fatalf("want 2 queries (outgoing + incoming), got %d", len(qs))
	}
	for _, q := range qs {
		if strings.Contains(q.Query.SQL, "RECURSIVE") {
			t.Errorf("1-hop query should not be recursive:\n%s", q.Query.SQL)
		}
		if len(q.Params) != 1 || q.Params[0] != "3" {
			t.Errorf("want params [3], got %v", q.Params)
		}
		if !strings.Contains(q.Query.SQL, "$1") {
			t.Errorf("query should bind $1, not inline a literal:\n%s", q.Query.SQL)
		}
		if strings.Contains(q.Query.SQL, "'3'") {
			t.Errorf("query should not inline the PK literal:\n%s", q.Query.SQL)
		}
		// Decoder column-naming must match the projection scheme.
		for _, want := range []string{`"a__pk__id"`, `"b__pk__id"`, `"k__pk__src"`, `"k__sk__src"`, `"k__dk__dst"`} {
			if !strings.Contains(q.Query.SQL, want) {
				t.Errorf("SQL missing %s:\n%s", want, q.Query.SQL)
			}
		}
	}
}

func TestBuildRecursiveExpansion_MultiHopUsesRecursiveCTE(t *testing.T) {
	md, anchor := selfRefGraph()
	qs, err := sqlpgq.BuildRecursiveExpansion(md, anchor, []string{"3"}, nil, 0, 3)
	if err != nil {
		t.Fatalf("BuildRecursiveExpansion: %v", err)
	}
	if len(qs) != 2 {
		t.Fatalf("want 2 queries, got %d", len(qs))
	}
	for _, q := range qs {
		if !strings.Contains(q.Query.SQL, "WITH RECURSIVE frontier") {
			t.Errorf("multi-hop query should use WITH RECURSIVE:\n%s", q.Query.SQL)
		}
		if !strings.Contains(q.Query.SQL, "fr.depth < 3") {
			t.Errorf("multi-hop query should bound depth at 3:\n%s", q.Query.SQL)
		}
		if len(q.Params) != 1 || q.Params[0] != "3" {
			t.Errorf("want params [3], got %v", q.Params)
		}
	}
}

func TestBuildRecursiveExpansion_DefaultDepthMatchesOneHop(t *testing.T) {
	md, anchor := selfRefGraph()
	// maxDepth <= 0 should behave as 1 (no recursion), matching legacy 1-hop.
	qs, err := sqlpgq.BuildRecursiveExpansion(md, anchor, []string{"3"}, nil, 0, 0)
	if err != nil {
		t.Fatalf("BuildRecursiveExpansion: %v", err)
	}
	for _, q := range qs {
		if strings.Contains(q.Query.SQL, "RECURSIVE") {
			t.Errorf("default depth should not be recursive:\n%s", q.Query.SQL)
		}
	}
}

func equal[T comparable](a, b []T) bool {
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
