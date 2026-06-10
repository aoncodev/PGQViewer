package api

// Characterization tests for validateQueryRequest, extracted from the query
// handler. They lock in the mode-specific required-field rules so the
// decomposition stays behaviour-preserving.

import (
	"testing"

	"github.com/aoncodev/PGQViewer/server/internal/sqlpgq"
)

func TestValidateQueryRequest(t *testing.T) {
	tests := []struct {
		name    string
		req     queryRequest
		wantErr string // "" means expect no error
	}{
		{
			name: "sql ok",
			req:  queryRequest{Mode: "sql", SQL: "SELECT 1"},
		},
		{
			name:    "sql missing statement",
			req:     queryRequest{Mode: "sql"},
			wantErr: "sql is required",
		},
		{
			name: "graph ok",
			req: queryRequest{
				Mode:     "graph",
				GraphOID: 42,
				Match:    "(a)",
				Bindings: []sqlpgq.Binding{{Alias: "a", ElementOID: 1}},
			},
		},
		{
			name:    "graph missing oid",
			req:     queryRequest{Mode: "graph", Match: "(a)", Bindings: []sqlpgq.Binding{{Alias: "a"}}},
			wantErr: "graph_oid is required",
		},
		{
			name:    "graph missing match",
			req:     queryRequest{Mode: "graph", GraphOID: 42, Bindings: []sqlpgq.Binding{{Alias: "a"}}},
			wantErr: "match is required",
		},
		{
			name:    "graph missing bindings",
			req:     queryRequest{Mode: "graph", GraphOID: 42, Match: "(a)"},
			wantErr: "bindings is required",
		},
		{
			name:    "unknown mode",
			req:     queryRequest{Mode: "cypher"},
			wantErr: "mode must be 'sql' or 'graph'",
		},
		{
			name:    "empty mode",
			req:     queryRequest{},
			wantErr: "mode must be 'sql' or 'graph'",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateQueryRequest(tt.req)
			switch {
			case tt.wantErr == "" && err != nil:
				t.Fatalf("unexpected error: %v", err)
			case tt.wantErr != "" && err == nil:
				t.Fatalf("expected error %q, got nil", tt.wantErr)
			case tt.wantErr != "" && err.Error() != tt.wantErr:
				t.Fatalf("error = %q, want %q", err.Error(), tt.wantErr)
			}
		})
	}
}
