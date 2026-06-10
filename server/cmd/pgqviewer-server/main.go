// pgqviewer-server is the web backend for PGQViewer. When the build embeds
// the renderer bundle (see internal/webui), it serves the whole app —
// SPA at /, API at /api/v1 — from one binary.
//
// Auto-port mode (default, no flags):
//   - Binds to 127.0.0.1:0; the OS picks a free port.
//   - Prints `LISTEN=127.0.0.1:<port>\n` to stdout once listening so a
//     wrapping process or script can discover the address.
//
// Fixed-address mode:
//   - Bind explicitly with `--http 127.0.0.1:8080` (dev, Docker).
//   - Binding beyond loopback exposes an UNAUTHENTICATED endpoint that
//     opens outbound database connections — only do that on a network
//     where every peer is trusted.
//
// Graceful shutdown on SIGINT/SIGTERM closes every open pool.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/aoncodev/PGQViewer/server/internal/api"
	"github.com/aoncodev/PGQViewer/server/internal/config"
	"github.com/aoncodev/PGQViewer/server/internal/session"
	"github.com/aoncodev/PGQViewer/server/internal/store"
	"github.com/aoncodev/PGQViewer/server/internal/webui"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Parse(os.Args[1:])
	if err != nil {
		return err
	}
	logger := newLogger(cfg.LogLevel)

	bind := cfg.HTTPAddr
	if cfg.AutoPortMode() {
		bind = "127.0.0.1:0"
	}
	ln, err := net.Listen("tcp", bind)
	if err != nil {
		return fmt.Errorf("listen %s: %w", bind, err)
	}

	sm := session.NewManager()

	dbPath, err := store.DefaultDBPath()
	if err != nil {
		return fmt.Errorf("resolve app db path: %w", err)
	}
	st, err := store.Open(dbPath)
	if err != nil {
		return fmt.Errorf("open app store: %w", err)
	}
	defer st.Close()
	logger.Info("app store opened", "path", st.Path())

	var handler http.Handler = api.New(logger, sm, st).Router()
	// When the build embedded the renderer bundle (pnpm build / Dockerfile),
	// serve it for every non-/api path so the binary is the whole app. A
	// bare `go build` has no bundle and stays API-only — Vite serves the UI
	// in that workflow.
	if ui := webui.Handler(); ui != nil {
		mux := http.NewServeMux()
		mux.Handle("/api/", handler)
		mux.Handle("/", ui)
		handler = mux
		logger.Info("serving embedded web UI at /")
	}
	srv := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
	}

	// Announce the bound address. In auto-port mode this is how a wrapping
	// process or script discovers our port; with --http it is informational.
	addr := ln.Addr().String()
	fmt.Printf("LISTEN=%s\n", addr)
	logger.Info("pgqviewer-server listening", "addr", addr, "mode", modeName(cfg))

	serverErr := make(chan error, 1)
	go func() { serverErr <- srv.Serve(ln) }()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	select {
	case <-stop:
		logger.Info("shutdown requested")
	case err := <-serverErr:
		if !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("serve: %w", err)
		}
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
	sm.CloseAll(shutdownCtx)
	logger.Info("shutdown complete")
	return nil
}

func newLogger(level string) *slog.Logger {
	var lvl slog.Level
	switch level {
	case "debug":
		lvl = slog.LevelDebug
	case "warn":
		lvl = slog.LevelWarn
	case "error":
		lvl = slog.LevelError
	default:
		lvl = slog.LevelInfo
	}
	h := slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: lvl})
	return slog.New(h)
}

func modeName(c config.Config) string {
	if c.AutoPortMode() {
		return "auto-port"
	}
	return "http"
}
