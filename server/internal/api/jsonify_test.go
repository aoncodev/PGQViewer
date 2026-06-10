package api

// Unit tests for jsonify. The function is unexported, so the test lives
// in the same package. We cover the cases todo.md item #7 cares about:
// precision loss for big ints / numeric, opaque struct types becoming
// readable strings, and pass-through for values that are already
// JSON-clean.

import (
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

func TestJsonify_BigIntStringified(t *testing.T) {
	// 2^53 + 1: the smallest int the JS Number type rounds incorrectly.
	const beyondJSSafe int64 = 9007199254740993
	got := jsonify(beyondJSSafe)
	s, ok := got.(string)
	if !ok {
		t.Fatalf("expected string for int64 > 2^53, got %T (%v)", got, got)
	}
	if s != "9007199254740993" {
		t.Errorf("got %q, want %q", s, "9007199254740993")
	}
}

func TestJsonify_SafeIntPassthrough(t *testing.T) {
	got := jsonify(int64(42))
	if got != int64(42) {
		t.Errorf("safe int64 should pass through unchanged, got %T(%v)", got, got)
	}
}

func TestJsonify_Bytea(t *testing.T) {
	got := jsonify([]byte{0xde, 0xad, 0xbe, 0xef})
	if got != `\xdeadbeef` {
		t.Errorf("got %q, want %q", got, `\xdeadbeef`)
	}
}

func TestJsonify_UUIDArray(t *testing.T) {
	in := [16]byte{0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0}
	got := jsonify(in)
	if got != "12345678-9abc-def0-1234-56789abcdef0" {
		t.Errorf("got %v, want canonical UUID", got)
	}
}

func TestJsonify_UUIDPgtype(t *testing.T) {
	in := pgtype.UUID{Bytes: [16]byte{0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89}, Valid: true}
	got := jsonify(in)
	if got != "abcdef01-2345-6789-abcd-ef0123456789" {
		t.Errorf("got %v, want canonical UUID", got)
	}
}

func TestJsonify_InvalidUUIDReturnsNil(t *testing.T) {
	if jsonify(pgtype.UUID{Valid: false}) != nil {
		t.Errorf("invalid pgtype.UUID should jsonify to nil")
	}
}

func TestJsonify_NumericStringified(t *testing.T) {
	// pgtype.Numeric for "1234567890.1234567890" should not round-trip
	// through JS as a Number; stringify it.
	n := pgtype.Numeric{}
	if err := n.Scan("1234567890.1234567890"); err != nil {
		t.Fatalf("scan numeric: %v", err)
	}
	got := jsonify(n)
	s, ok := got.(string)
	if !ok {
		t.Fatalf("expected string for numeric, got %T(%v)", got, got)
	}
	if s == "" {
		t.Errorf("numeric stringified to empty value")
	}
}

func TestJsonify_Interval(t *testing.T) {
	tests := []struct {
		name string
		in   pgtype.Interval
		want string
	}{
		{
			"hms-only",
			pgtype.Interval{Microseconds: int64((1*3600 + 23*60 + 45) * 1_000_000), Valid: true},
			"01:23:45",
		},
		{
			"years-mons-days-hms",
			pgtype.Interval{Months: 14, Days: 3, Microseconds: int64(45 * 60 * 1_000_000), Valid: true},
			"1 years 2 mons 3 days 00:45:00",
		},
		{
			"zero",
			pgtype.Interval{Valid: true},
			"00:00:00",
		},
		{
			"microseconds",
			pgtype.Interval{Microseconds: 1_500_000, Valid: true},
			"00:00:01.500000",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := jsonify(tc.in)
			if got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestJsonify_NilPassthrough(t *testing.T) {
	if jsonify(nil) != nil {
		t.Errorf("nil should pass through")
	}
}

func TestJsonify_TimeUnchanged(t *testing.T) {
	now := time.Now()
	got := jsonify(now)
	if _, ok := got.(time.Time); !ok {
		t.Errorf("time.Time should pass through unchanged, got %T", got)
	}
}
