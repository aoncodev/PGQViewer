package api

// Characterization tests for validateQueryRequest, extracted from the query
// handler. They lock in the mode-specific required-field rules so the
// decomposition stays behaviour-preserving.

import (
	"encoding/json"
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
		{
			name: "graph custom columns ok",
			req: queryRequest{
				Mode: "graph", GraphOID: 42, Match: "(a)",
				Bindings: []sqlpgq.Binding{{Alias: "a", ElementOID: 1}},
				Columns:  []string{"a.name AS who"},
			},
		},
		{
			name: "graph empty column rejected",
			req: queryRequest{
				Mode: "graph", GraphOID: 42, Match: "(a)",
				Bindings: []sqlpgq.Binding{{Alias: "a", ElementOID: 1}},
				Columns:  []string{"a.name", "  "},
			},
			wantErr: "columns[1] must not be empty",
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

// TestQueryRequest_NewFieldsDecode pins the wire names of the new request
// fields (columns, explain, explain_analyze, params in graph mode).
func TestQueryRequest_NewFieldsDecode(t *testing.T) {
	body := `{
		"mode":"graph",
		"graph_oid":42,
		"match":"(a)",
		"bindings":[{"alias":"a","element_oid":1}],
		"columns":["a.name AS who","b.born"],
		"params":[5,"x"],
		"explain":true,
		"explain_analyze":false
	}`
	var req queryRequest
	if err := json.Unmarshal([]byte(body), &req); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(req.Columns) != 2 || req.Columns[0] != "a.name AS who" {
		t.Fatalf("columns decoded wrong: %v", req.Columns)
	}
	if len(req.Params) != 2 {
		t.Fatalf("params decoded wrong: %v", req.Params)
	}
	if !req.Explain || req.ExplainAnalyze {
		t.Fatalf("explain flags decoded wrong: %v / %v", req.Explain, req.ExplainAnalyze)
	}
}
