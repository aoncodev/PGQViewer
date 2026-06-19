package sqlpgq

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestNormalizeElementLists pins the JSON contract that an element's list fields
// serialize as `[]`, never `null` — the renderer types them as plain arrays and
// reads `.length`/`.some` on them, so a nil slice (e.g. a NO PROPERTIES edge)
// would crash the schema sidebar. Regression for the keyless-graph blank page.
func TestNormalizeElementLists(t *testing.T) {
	// An edge with everything empty: nil Properties/Labels/PK and an endpoint
	// with nil Key/Ref — the shape a `NO PROPERTIES` / hidden-key edge produces.
	e := &Element{
		OID:    1,
		Alias:  "follows",
		Kind:   "e",
		Source: &EdgeEnd{VertexOID: 2},
	}
	normalizeElementLists(e)

	if e.Properties == nil || e.Labels == nil || e.PK == nil {
		t.Fatalf("list fields must be non-nil after normalize: %+v", e)
	}
	if e.Source.Key == nil || e.Source.Ref == nil {
		t.Fatalf("edge-end Key/Ref must be non-nil after normalize: %+v", e.Source)
	}

	b, err := json.Marshal(e)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	out := string(b)
	for _, want := range []string{`"properties":[]`, `"labels":[]`, `"pk":[]`, `"key":[]`, `"ref":[]`} {
		if !strings.Contains(out, want) {
			t.Errorf("marshaled element missing %s:\n%s", want, out)
		}
	}
	if strings.Contains(out, "null") {
		t.Errorf("no list field should marshal as null:\n%s", out)
	}
}
