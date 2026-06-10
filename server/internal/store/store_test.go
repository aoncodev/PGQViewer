package store_test

import (
	"context"
	"testing"

	"github.com/aoncodev/PGQViewer/server/internal/store"
)

func openMem(t *testing.T) *store.Store {
	t.Helper()
	s, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func TestConnectionsCRUD(t *testing.T) {
	ctx := context.Background()
	s := openMem(t)

	c, err := s.CreateConnection(ctx, store.NewConnection{
		Name: "local pg19", Host: "127.0.0.1", Port: 5435,
		Database: "pgviewer", User: "postgres", Password: "secret",
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if c.ID == 0 || c.SSLMode != "prefer" {
		t.Errorf("got %+v", c)
	}

	list, err := s.ListConnections(ctx)
	if err != nil || len(list) != 1 {
		t.Fatalf("list = %v err=%v", list, err)
	}

	got, err := s.GetConnection(ctx, c.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Password != "secret" {
		t.Errorf("password lost: got %q", got.Password)
	}

	if err := s.DeleteConnection(ctx, c.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := s.GetConnection(ctx, c.ID); err != store.ErrNotFound {
		t.Errorf("expected ErrNotFound after delete, got %v", err)
	}
}

