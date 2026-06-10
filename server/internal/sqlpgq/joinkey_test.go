package sqlpgq

// Internal tests for the joinKey / formatPKPart pair. Lives in the
// production package so the unexported helpers are accessible without
// widening their visibility.

import (
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

func TestFormatPKPart_CommonTypes(t *testing.T) {
	tests := []struct {
		name string
		in   any
		want string
	}{
		{"nil", nil, ""},
		{"string", "abc", "abc"},
		{"string-with-comma", "b,c", "b,c"},
		{"int32", int32(42), "42"},
		{"int64", int64(42), "42"},
		{"int64-big", int64(9007199254740993), "9007199254740993"}, // > 2^53
		{"bytea", []byte{0xde, 0xad, 0xbe, 0xef}, "deadbeef"},
		{"uuid-array", [16]byte{0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0}, "12345678-9abc-def0-1234-56789abcdef0"},
		{"time-utc", time.Date(2026, 5, 19, 12, 34, 56, 0, time.UTC), "2026-05-19T12:34:56Z"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := formatPKPart(tc.in)
			if got != tc.want {
				t.Errorf("formatPKPart(%v) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// Cross-type UUID equivalence: a UUID returned as [16]byte vs the same
// UUID returned as pgtype.UUID must format identically. The renderer
// uses the formatted string as a dedup key; divergence would mean the
// "same" vertex appears twice on the canvas.
func TestFormatPKPart_UUIDPathEquivalence(t *testing.T) {
	raw := [16]byte{0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89}
	asArray := formatPKPart(raw)
	asPgtype := formatPKPart(pgtype.UUID{Bytes: raw, Valid: true})
	if asArray != asPgtype {
		t.Errorf("[16]byte=%q != pgtype.UUID=%q", asArray, asPgtype)
	}
}

// Time-zone equivalence: the same instant in different in-memory zones
// must format identically. Otherwise a vertex projected through one
// query (where pgx returns time.Time in UTC) and the same vertex
// projected through another (with a session timezone) would not merge.
func TestFormatPKPart_TimeZoneNormalized(t *testing.T) {
	utc := time.Date(2026, 5, 19, 12, 34, 56, 0, time.UTC)
	loc := time.FixedZone("UTC+9", 9*3600)
	jst := utc.In(loc)
	if formatPKPart(utc) != formatPKPart(jst) {
		t.Errorf("formatPKPart should normalize timezone: utc=%q jst=%q",
			formatPKPart(utc), formatPKPart(jst))
	}
}

// The headline regression: composite PKs with a comma in one column.
// Before the fix, joinKey did `strings.Join(parts, ",")` and these two
// rows produced the same id `"a,b,c"` → silent vertex merge.
func TestJoinKey_CompositePKWithCommas_NoCollision(t *testing.T) {
	row1 := []any{"a", "b,c"}
	row2 := []any{"a,b", "c"}
	idxs := []int{0, 1}

	k1, ok1 := joinKey(row1, idxs)
	k2, ok2 := joinKey(row2, idxs)
	if !ok1 || !ok2 {
		t.Fatalf("joinKey ok = (%v, %v), want both true", ok1, ok2)
	}
	if k1 == k2 {
		t.Errorf("joinKey should not collide on commas: row1=%q row2=%q (got %q)",
			row1, row2, k1)
	}
}

// Empty index list returns false (we can't synthesize half an id).
func TestJoinKey_EmptyIndexes(t *testing.T) {
	if _, ok := joinKey([]any{"a"}, nil); ok {
		t.Errorf("joinKey with no idxs should return false")
	}
}

// NULL in any column aborts id synthesis: a partial id is worse than
// no event for that binding.
func TestJoinKey_NullInPK(t *testing.T) {
	row := []any{"a", nil, "c"}
	if _, ok := joinKey(row, []int{0, 1, 2}); ok {
		t.Errorf("joinKey should return false when a PK column is NULL")
	}
}

// Sanity: the output is well-formed JSON. The renderer doesn't parse it,
// but if we ever need to decode an id back for diagnostics, this keeps
// the door open.
func TestJoinKey_JSONShape(t *testing.T) {
	k, ok := joinKey([]any{"hello", int64(42)}, []int{0, 1})
	if !ok {
		t.Fatal("joinKey returned false unexpectedly")
	}
	if !strings.HasPrefix(k, "[") || !strings.HasSuffix(k, "]") {
		t.Errorf("joinKey output should be a JSON array, got %q", k)
	}
}
