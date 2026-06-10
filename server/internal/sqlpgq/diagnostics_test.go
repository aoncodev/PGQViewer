package sqlpgq_test

import (
	"context"
	"strings"
	"testing"

	"github.com/aoncodev/PGQViewer/server/internal/sqlpgq"
)

// Test fixtures that exercise SQL/PGQ catalog shapes PG19 accepts but that
// break the viewer's identity-synthesis assumptions. Created idempotently
// at test start; harmless to leave behind between runs.
//
// The DDL is kept inline so the file documents exactly what shape each
// test relies on.
const diagnosticsFixtureSQL = `
DROP PROPERTY GRAPH IF EXISTS bugtest_nonunique_g;
DROP PROPERTY GRAPH IF EXISTS bugtest_refmismatch_g;
DROP TABLE IF EXISTS bugtest_nonunique_v;
DROP TABLE IF EXISTS bugtest_refmismatch_edge;
DROP TABLE IF EXISTS bugtest_refmismatch_vertex;

-- Bug #0: KEY column with no unique index. PG19 accepts this without
-- diagnostic, and the viewer must surface a non-unique-key warning.
CREATE TABLE bugtest_nonunique_v (
    a int,
    b text
);
CREATE PROPERTY GRAPH bugtest_nonunique_g
    VERTEX TABLES (
        bugtest_nonunique_v KEY (a)
            LABEL bugtest_v PROPERTIES ALL COLUMNS
    );

-- Bug #2: edge REFERENCES a unique-but-not-KEY column of the source vertex.
-- The vertex's KEY defaults to id (PK), but the edge's REFERENCES points at
-- email (which has its own UNIQUE constraint). PG19 accepts this; the viewer
-- must surface a ref-not-vertex-key error and refuse the projection.
CREATE TABLE bugtest_refmismatch_vertex (
    id    int PRIMARY KEY,
    email text UNIQUE NOT NULL
);
CREATE TABLE bugtest_refmismatch_edge (
    eid           int PRIMARY KEY,
    src_email     text NOT NULL REFERENCES bugtest_refmismatch_vertex (email),
    dst_email     text NOT NULL REFERENCES bugtest_refmismatch_vertex (email)
);
CREATE PROPERTY GRAPH bugtest_refmismatch_g
    VERTEX TABLES (
        bugtest_refmismatch_vertex
            LABEL bugtest_person PROPERTIES ALL COLUMNS
    )
    EDGE TABLES (
        bugtest_refmismatch_edge
            SOURCE      KEY (src_email) REFERENCES bugtest_refmismatch_vertex (email)
            DESTINATION KEY (dst_email) REFERENCES bugtest_refmismatch_vertex (email)
            LABEL bugtest_knows PROPERTIES ALL COLUMNS
    );
`

// setupDiagnosticsFixture runs the fixture DDL. We split on statement
// boundaries because pgx's simple-protocol Exec handles only one statement
// per call when bound to the extended protocol path most tests use.
func setupDiagnosticsFixture(t *testing.T, ctx context.Context, q sqlpgq.Queryer) {
	t.Helper()
	stmts := splitSQLStatements(diagnosticsFixtureSQL)
	for _, stmt := range stmts {
		stmt = strings.TrimSpace(stmt)
		if stmt == "" {
			continue
		}
		rows, err := q.Query(ctx, stmt)
		if err != nil {
			t.Fatalf("fixture stmt failed: %v\nstmt:\n%s", err, stmt)
		}
		rows.Close()
	}
}

// splitSQLStatements strips line comments (`--…\n`) and then splits on
// semicolons. The fixture is plain DDL with no string literals containing
// semicolons or block comments, so this is sufficient.
func splitSQLStatements(s string) []string {
	var b strings.Builder
	for _, line := range strings.Split(s, "\n") {
		if idx := strings.Index(line, "--"); idx >= 0 {
			line = line[:idx]
		}
		b.WriteString(line)
		b.WriteByte('\n')
	}
	return strings.Split(b.String(), ";")
}

func TestGetMetadata_FlagsNonUniqueKey(t *testing.T) {
	ctx, p := openPool(t)
	setupDiagnosticsFixture(t, ctx, p.Q())

	oid := graphOIDByName(t, ctx, p, "bugtest_nonunique_g")
	md, err := sqlpgq.GetMetadata(ctx, p.Q(), oid)
	if err != nil {
		t.Fatalf("GetMetadata: %v", err)
	}
	if len(md.Vertices) != 1 {
		t.Fatalf("want 1 vertex, got %d", len(md.Vertices))
	}
	v := md.Vertices[0]
	if got := findDiagnostic(v.Diagnostics, "non-unique-key"); got == nil {
		t.Fatalf("expected non-unique-key diagnostic on %q, got %+v", v.Alias, v.Diagnostics)
	} else if got.Severity != "warning" {
		t.Errorf("non-unique-key severity = %q, want warning", got.Severity)
	}
}

func TestGetMetadata_FlagsRefNotVertexKey(t *testing.T) {
	ctx, p := openPool(t)
	setupDiagnosticsFixture(t, ctx, p.Q())

	oid := graphOIDByName(t, ctx, p, "bugtest_refmismatch_g")
	md, err := sqlpgq.GetMetadata(ctx, p.Q(), oid)
	if err != nil {
		t.Fatalf("GetMetadata: %v", err)
	}
	if len(md.Edges) != 1 {
		t.Fatalf("want 1 edge, got %d", len(md.Edges))
	}
	e := md.Edges[0]
	srcDiag := findDiagnostic(e.Diagnostics, "ref-not-vertex-key")
	if srcDiag == nil {
		t.Fatalf("expected ref-not-vertex-key diagnostic on edge %q, got %+v", e.Alias, e.Diagnostics)
	}
	if srcDiag.Severity != "error" {
		t.Errorf("ref-not-vertex-key severity = %q, want error", srcDiag.Severity)
	}

	// Both source AND destination are mismatched in the fixture; we expect
	// two diagnostics, one per side.
	sides := map[string]bool{}
	for _, d := range e.Diagnostics {
		if d.Code == "ref-not-vertex-key" {
			sides[d.Field] = true
		}
	}
	if !sides["source"] || !sides["destination"] {
		t.Errorf("expected both source and destination diagnostics, got %v", sides)
	}
}

func TestBuildProjection_RefusesOnRefNotVertexKey(t *testing.T) {
	ctx, p := openPool(t)
	setupDiagnosticsFixture(t, ctx, p.Q())

	oid := graphOIDByName(t, ctx, p, "bugtest_refmismatch_g")
	md, err := sqlpgq.GetMetadata(ctx, p.Q(), oid)
	if err != nil {
		t.Fatalf("GetMetadata: %v", err)
	}

	var edgeOID uint32
	for _, e := range md.Edges {
		if e.Alias == "bugtest_refmismatch_edge" {
			edgeOID = e.OID
		}
	}
	if edgeOID == 0 {
		t.Fatalf("edge not found in metadata")
	}

	_, err = sqlpgq.BuildProjection(md,
		[]sqlpgq.Binding{{Alias: "k", ElementOID: edgeOID}},
		"(a IS bugtest_person)-[k IS bugtest_knows]->(b IS bugtest_person)",
		"", 0,
	)
	if err == nil {
		t.Fatalf("BuildProjection should have refused on edge with ref-not-vertex-key error")
	}
	if !strings.Contains(err.Error(), "REFERENCES columns") {
		t.Errorf("error message should mention REFERENCES columns, got: %v", err)
	}
}

func TestBuildProjection_AllowsNonUniqueKeyWarning(t *testing.T) {
	ctx, p := openPool(t)
	setupDiagnosticsFixture(t, ctx, p.Q())

	oid := graphOIDByName(t, ctx, p, "bugtest_nonunique_g")
	md, err := sqlpgq.GetMetadata(ctx, p.Q(), oid)
	if err != nil {
		t.Fatalf("GetMetadata: %v", err)
	}
	v := md.Vertices[0]
	// warning-severity diagnostic should NOT block projection — the user has
	// been warned, but a partially-wrong canvas beats no canvas at all.
	_, err = sqlpgq.BuildProjection(md,
		[]sqlpgq.Binding{{Alias: "a", ElementOID: v.OID}},
		"(a IS bugtest_v)",
		"", 0,
	)
	if err != nil {
		t.Fatalf("BuildProjection should allow non-unique-key warning, got: %v", err)
	}
}

func TestGetMetadata_SocialGraphHasNoDiagnostics(t *testing.T) {
	ctx, p := openPool(t)
	oid := graphOIDByName(t, ctx, p, "social")
	md, err := sqlpgq.GetMetadata(ctx, p.Q(), oid)
	if err != nil {
		t.Fatalf("GetMetadata: %v", err)
	}
	for _, v := range md.Vertices {
		if len(v.Diagnostics) > 0 {
			t.Errorf("vertex %q unexpectedly has diagnostics: %+v", v.Alias, v.Diagnostics)
		}
	}
	for _, e := range md.Edges {
		if len(e.Diagnostics) > 0 {
			t.Errorf("edge %q unexpectedly has diagnostics: %+v", e.Alias, e.Diagnostics)
		}
	}
}

// --- helpers ---------------------------------------------------------------

func graphOIDByName(t *testing.T, ctx context.Context, p *pgPool, name string) uint32 {
	t.Helper()
	graphs, err := sqlpgq.ListGraphs(ctx, p.Q())
	if err != nil {
		t.Fatalf("ListGraphs: %v", err)
	}
	for _, g := range graphs {
		if g.Name == name {
			return g.OID
		}
	}
	t.Fatalf("graph %q not found", name)
	return 0
}

func findDiagnostic(diags []sqlpgq.Diagnostic, code string) *sqlpgq.Diagnostic {
	for i := range diags {
		if diags[i].Code == code {
			return &diags[i]
		}
	}
	return nil
}
