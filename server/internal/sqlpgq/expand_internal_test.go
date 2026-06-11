package sqlpgq

import (
	"strings"
	"testing"
)

// TestRecursiveProjectionColumns_ComputedPropertyQualified pins that a computed
// (non-plain) property is projected via a correlated single-table subquery, not
// as a bare unqualified expression. On a self-referential graph the expansion
// join brings av/ke/bv (all the SAME table) into scope at once, so emitting a
// raw `(name || '!')` fails at runtime with "column reference is ambiguous".
// Regression for the computed-expression expansion fix.
func TestRecursiveProjectionColumns_ComputedPropertyQualified(t *testing.T) {
	shout := "name || '!'" // a computed expression, not a plain column reference
	person := &Element{
		OID: 100, Alias: "people", Kind: "v", PK: []string{"id"},
		Table:  TableRef{Schema: "public", Name: "people"},
		Labels: []string{"person"},
		Properties: []Property{
			{Name: "name", Type: "text"},                      // plain column
			{Name: "shout", Type: "text", Expression: &shout}, // computed
		},
	}
	edge := &Element{
		OID: 200, Alias: "knows", Kind: "e", PK: []string{"src", "dst"},
		Table:       TableRef{Schema: "public", Name: "knows"},
		Labels:      []string{"knows"},
		Source:      &EdgeEnd{VertexOID: 100, Key: []string{"src"}, Ref: []string{"id"}},
		Destination: &EdgeEnd{VertexOID: 100, Key: []string{"dst"}, Ref: []string{"id"}},
	}

	// Self-referential: anchor and "other" are the same vertex element.
	cols := recursiveProjectionColumns(person, edge, person)

	var shoutCol, nameCol string
	for _, c := range cols {
		if strings.Contains(c, "a__p__shout") {
			shoutCol = c
		}
		if strings.Contains(c, "a__p__name") {
			nameCol = c
		}
	}
	if shoutCol == "" {
		t.Fatalf("computed property column not emitted; got:\n%s", strings.Join(cols, "\n"))
	}
	// Plain column stays a simple qualified reference.
	if nameCol == "" || !strings.Contains(nameCol, `av."name"`) {
		t.Fatalf("plain property should be a qualified column ref; got: %q", nameCol)
	}
	// Computed property must be a correlated subquery over the element's own
	// table, NOT a bare `(name || '!') AS ...` that is ambiguous in the join.
	if !strings.Contains(shoutCol, "SELECT") || !strings.Contains(shoutCol, `"public"."people" __e`) {
		t.Fatalf("computed property not wrapped in a correlated subquery:\n%s", shoutCol)
	}
	if !strings.Contains(shoutCol, `__e."id" = av."id"`) {
		t.Fatalf("computed property subquery not correlated on the element KEY:\n%s", shoutCol)
	}
}
