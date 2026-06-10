# PGQViewer — single-image build: the Go binary serves the embedded renderer
# at / and the API at /api/v1. See server/internal/webui.
#
#   docker build -t pgqviewer .
#   docker run --rm -p 8080:8080 -v pgqviewer-data:/data pgqviewer
#
# The endpoint is unauthenticated and opens outbound database connections on
# behalf of whoever reaches it — publish the port on loopback or a trusted
# network only.

# ---- stage 1: renderer bundle ------------------------------------------------
FROM node:22-bookworm-slim AS web

# apps/renderer is a self-contained pnpm workspace (own lockfile).
RUN corepack enable && corepack prepare pnpm@11.0.9 --activate

WORKDIR /src/renderer
COPY apps/renderer/package.json apps/renderer/pnpm-lock.yaml apps/renderer/pnpm-workspace.yaml apps/renderer/.npmrc ./
RUN pnpm install --frozen-lockfile

COPY apps/renderer/ ./
RUN pnpm build

# ---- stage 2: Go binary with embedded UI --------------------------------------
FROM golang:1.25-bookworm AS build

WORKDIR /src/server
COPY server/go.mod server/go.sum ./
RUN go mod download

COPY server/ ./
COPY --from=web /src/renderer/dist/ internal/webui/dist/
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/pgqviewer-server ./cmd/pgqviewer-server

# ---- stage 3: runtime ----------------------------------------------------------
FROM alpine:3.21

# ca-certificates: TLS to PostgreSQL (sslmode=require/verify-*).
RUN apk add --no-cache ca-certificates \
 && addgroup -S pgq && adduser -S -G pgq pgq \
 && mkdir -p /data && chown pgq:pgq /data

COPY --from=build /out/pgqviewer-server /usr/local/bin/pgqviewer-server

# App store (saved connections, SQLite) lands in $XDG_DATA_HOME/PGQViewer/.
ENV XDG_DATA_HOME=/data
VOLUME /data

USER pgq
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/pgqviewer-server"]
CMD ["--http", ":8080"]
