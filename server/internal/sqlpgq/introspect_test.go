package sqlpgq_test

import (
	"context"
	"os"
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
//   export PGVIEWER_TEST_DSN='postgres://postgres:postgres@127.0.0.1:5435/pgviewer?sslmode=disable'
//   go test ./internal/sqlpgq -v
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
