package sqlpgq_test

// Tests for the per-binding DisplayProperties allow-list. We assert:
//   - omitting it preserves today's behaviour (project every property).
//   - providing one narrows the projection to the named properties.
//   - PK + edge-endpoint key columns are always projected regardless.
//   - typos surface as a clear error rather than silently dropping.

import (
	"strings"
	"testing"

	"github.com/aoncodev/PGQViewer/server/internal/sqlpgq"
)

func wideGraphMetadata() *sqlpgq.GraphMetadata {
	return &sqlpgq.GraphMetadata{
		Graph: sqlpgq.Graph{Schema: "public", Name: "wide"},
		Vertices: []sqlpgq.Element{{
			OID:    500,
			Alias:  "wide_v",
			Kind:   "v",
			PK:     []string{"id"},
			Labels: []string{"thing"},
			Properties: []sqlpgq.Property{
				{Name: "id", Type: "integer"},
				{Name: "name", Type: "text"},
				{Name: "color", Type: "text"},
				{Name: "weight", Type: "numeric"},
				{Name: "notes", Type: "text"},
			},
		}},
	}
}

func TestDisplayProperties_DefaultProjectsAll(t *testing.T) {
	md := wideGraphMetadata()
	pq, err := sqlpgq.BuildProjection(md,
		[]sqlpgq.Binding{{Alias: "a", ElementOID: 500}},
		"(a IS thing)", "", 0)
	if err != nil {
		t.Fatalf("BuildProjection: %v", err)
	}
	for _, p := range []string{"a__p__name", "a__p__color", "a__p__weight", "a__p__notes"} {
		if !strings.Contains(pq.SQL, p) {
			t.Errorf("expected default projection to include %q\n%s", p, pq.SQL)
		}
	}
}

func TestDisplayProperties_NarrowsProjection(t *testing.T) {
	md := wideGraphMetadata()
	pq, err := sqlpgq.BuildProjection(md,
		[]sqlpgq.Binding{{
			Alias:             "a",
			ElementOID:        500,
			DisplayProperties: []string{"name", "color"},
		}},
		"(a IS thing)", "", 0)
	if err != nil {
		t.Fatalf("BuildProjection: %v", err)
	}
	// PK column is always projected.
	if !strings.Contains(pq.SQL, "a__pk__id") {
		t.Errorf("PK should always be projected:\n%s", pq.SQL)
	}
	// Allow-listed properties are present.
	for _, want := range []string{"a__p__name", "a__p__color"} {
		if !strings.Contains(pq.SQL, want) {
			t.Errorf("expected %q in projection:\n%s", want, pq.SQL)
		}
	}
	// Filtered properties are absent.
	for _, gone := range []string{"a__p__weight", "a__p__notes"} {
		if strings.Contains(pq.SQL, gone) {
			t.Errorf("expected %q to be filtered out:\n%s", gone, pq.SQL)
		}
	}
}

func TestDisplayProperties_PKAlwaysProjected(t *testing.T) {
	// The user might "narrow" without including the PK column. The
	// projection must still emit it (otherwise the synthetic id would
	// be NULL on every row and no events would dedup).
	md := wideGraphMetadata()
	pq, err := sqlpgq.BuildProjection(md,
		[]sqlpgq.Binding{{
			Alias:             "a",
			ElementOID:        500,
			DisplayProperties: []string{"name"}, // intentionally omits "id"
		}},
		"(a IS thing)", "", 0)
	if err != nil {
		t.Fatalf("BuildProjection: %v", err)
	}
	if !strings.Contains(pq.SQL, "a__pk__id") {
		t.Errorf("PK projection a__pk__id should appear even when not in display_properties:\n%s", pq.SQL)
	}
}

func TestDisplayProperties_UnknownNameErrors(t *testing.T) {
	md := wideGraphMetadata()
	_, err := sqlpgq.BuildProjection(md,
		[]sqlpgq.Binding{{
			Alias:             "a",
			ElementOID:        500,
			DisplayProperties: []string{"nonexistent_prop"},
		}},
		"(a IS thing)", "", 0)
	if err == nil {
		t.Fatal("expected error for unknown display property")
	}
	if !strings.Contains(err.Error(), "nonexistent_prop") {
		t.Errorf("error should name the unknown property, got: %v", err)
	}
}
