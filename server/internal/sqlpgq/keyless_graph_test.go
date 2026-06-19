package sqlpgq_test

import (
	"strings"
	"testing"

	"github.com/aoncodev/PGQViewer/server/internal/sqlpgq"
)

// Integration tests for GitHub issue #1 ("Key columns not exposed as
// properties") against a live PostgreSQL 19. They expect two graphs to exist:
//
//	CREATE TABLE people (id int PRIMARY KEY, name text NOT NULL, born int);
//	CREATE TABLE knows (src int REFERENCES people(id), dst int REFERENCES people(id),
//	                    since int, PRIMARY KEY (src, dst));
//	CREATE TABLE acct (id int PRIMARY KEY, email text, full_name text);
//
//	-- relies on the SQL/PGQ default (all columns exposed as properties)
//	CREATE PROPERTY GRAPH g_default
//	  VERTEX TABLES ( people LABEL person )
//	  EDGE TABLES ( knows SOURCE KEY (src) REFERENCES people (id)
//	                      DESTINATION KEY (dst) REFERENCES people (id) LABEL knows );
//
//	-- explicit PROPERTIES list that OMITS the key column `id`
//	CREATE PROPERTY GRAPH g_partial
//	  VERTEX TABLES ( acct LABEL acct PROPERTIES (email, full_name) );
//
// Run with: PGVIEWER_TEST_DSN=postgres://postgres:postgres@127.0.0.1:5440/postgres?sslmode=disable

func findGraph(t *testing.T, graphs []sqlpgq.Graph, name string) sqlpgq.Graph {
	t.Helper()
	for _, g := range graphs {
		if g.Name == name {
			return g
		}
	}
	t.Skipf("graph %q not found (set up the issue-1 fixtures first)", name)
	return sqlpgq.Graph{}
}

func elemByAlias(t *testing.T, els []sqlpgq.Element, alias string) sqlpgq.Element {
	t.Helper()
	for _, e := range els {
		if e.Alias == alias {
			return e
		}
	}
	t.Fatalf("element alias %q not found in %+v", alias, els)
	return sqlpgq.Element{}
}

// TestDefaultPropertiesGraphProjects is the core claim of issue #1: a graph
// created WITHOUT `PROPERTIES ALL COLUMNS` (relying on the documented default)
// exposes its key columns as properties, so graph mode must build a projection
// without error.
func TestDefaultPropertiesGraphProjects(t *testing.T) {
	ctx, p := openPool(t)
	graphs, err := sqlpgq.ListGraphs(ctx, p.Q())
	if err != nil {
		t.Fatalf("ListGraphs: %v", err)
	}
	g := findGraph(t, graphs, "g_default")
	md, err := sqlpgq.GetMetadata(ctx, p.Q(), g.OID)
	if err != nil {
		t.Fatalf("GetMetadata: %v", err)
	}
	people := elemByAlias(t, md.Vertices, "people")
	knows := elemByAlias(t, md.Edges, "knows")

	pq, err := sqlpgq.BuildProjection(md,
		[]sqlpgq.Binding{
			{Alias: "a", ElementOID: people.OID, Label: "person"},
			{Alias: "k", ElementOID: knows.OID, Label: "knows"},
			{Alias: "b", ElementOID: people.OID, Label: "person"},
		},
		"(a IS person)-[k IS knows]->(b IS person)", "", 0)
	if err != nil {
		t.Fatalf("default-properties graph should be projectable, got error: %v", err)
	}
	for _, want := range []string{`"id"`, `"src"`, `"dst"`} {
		if !strings.Contains(pq.SQL, want) {
			t.Errorf("generated COLUMNS missing key column %s:\n%s", want, pq.SQL)
		}
	}
	t.Logf("default graph projected OK:\n%s", pq.SQL)
}

// TestPartialPropertiesGraphDegrades confirms that a graph which restricts
// PROPERTIES and leaves out the key column is NO LONGER rejected: PG can still
// query it (selecting only declared properties), so the viewer matches that by
// degrading to a property-derived identity and rendering it, with a warning.
// This resolves the issue #1 report that the viewer was more restrictive than
// PostgreSQL itself.
func TestPartialPropertiesGraphDegrades(t *testing.T) {
	ctx, p := openPool(t)
	graphs, err := sqlpgq.ListGraphs(ctx, p.Q())
	if err != nil {
		t.Fatalf("ListGraphs: %v", err)
	}
	g := findGraph(t, graphs, "g_partial")
	md, err := sqlpgq.GetMetadata(ctx, p.Q(), g.OID)
	if err != nil {
		t.Fatalf("GetMetadata: %v", err)
	}
	acct := elemByAlias(t, md.Vertices, "acct")

	pq, err := sqlpgq.BuildProjection(md,
		[]sqlpgq.Binding{{Alias: "a", ElementOID: acct.OID, Label: "acct"}},
		"(a IS acct)", "", 0)
	if err != nil {
		t.Fatalf("partial-properties graph should now degrade, got error: %v", err)
	}
	// The un-exposed PK (`id`) must NOT be projected — PG would reject it.
	if strings.Contains(pq.SQL, "__pk__") {
		t.Errorf("degraded projection must not reference the un-exposed key:\n%s", pq.SQL)
	}
	if len(pq.Warnings) == 0 {
		t.Errorf("expected a degraded-identity warning for the partial graph")
	}
	// The query must actually run against PG and return the declared properties.
	rows, err := p.Q().Query(ctx, pq.SQL)
	if err != nil {
		t.Fatalf("degraded projection failed to run: %v\nSQL:\n%s", err, pq.SQL)
	}
	rows.Close()
	t.Logf("partial graph degraded OK:\n%s\nwarnings: %v", pq.SQL, pq.Warnings)
}
