// Package webui serves the embedded renderer bundle.
//
// The build pipeline (`pnpm build` at the repo root, or the Dockerfile)
// copies apps/renderer/dist into this package's dist/ directory before
// `go build`, making the production binary fully self-contained: one
// executable serving both the /api/v1 endpoints and the SPA.
//
// When no bundle has been copied (a plain `go build` during backend
// development), Handler returns nil and the server runs API-only — in that
// workflow the renderer is served by Vite with its /api proxy anyway.
package webui

import (
	"embed"
	"io/fs"
	"net/http"
	"strings"
)

// all: so Vite's dot-prefixed files (and the .gitkeep placeholder that
// keeps this directory present for go:embed) are included.
//
//go:embed all:dist
var distFS embed.FS

// Handler returns an http.Handler for the embedded SPA, or nil when the
// build didn't embed a bundle (no dist/index.html).
//
// Routing: exact asset paths are served as files; everything else falls
// back to index.html so a hard refresh on any client-side route still
// boots the app. API routes never reach this handler — the caller mounts
// it only for non-/api paths.
func Handler() http.Handler {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		return nil
	}
	if _, err := fs.Stat(sub, "index.html"); err != nil {
		return nil
	}
	fileServer := http.FileServerFS(sub)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p != "" && p != "index.html" {
			if _, err := fs.Stat(sub, p); err == nil {
				fileServer.ServeHTTP(w, r)
				return
			}
		}
		// SPA fallback. Serve index.html at "/" — http.FileServerFS
		// handles the index lookup and sets Content-Type; rewriting the
		// path (rather than calling ServeContent ourselves) keeps ETag /
		// range handling in one place.
		r2 := r.Clone(r.Context())
		r2.URL.Path = "/"
		fileServer.ServeHTTP(w, r2)
	})
}
