// Package config parses CLI flags and environment for pgqviewer-server.
//
// Two run modes:
//   - auto-port (default): bind to 127.0.0.1:0 (OS picks a port) and print
//     LISTEN=<addr> on stdout so a wrapping process can discover it.
//   - http: bind to an explicit address (e.g. --http 127.0.0.1:8080) for
//     dev and Docker deployments.
package config

import (
	"flag"
	"fmt"
	"os"
)

type Config struct {
	// HTTPAddr is the bind address. Empty => auto-port mode (127.0.0.1:0).
	HTTPAddr string
	// LogLevel: debug | info | warn | error.
	LogLevel string
}

func Parse(args []string) (Config, error) {
	fs := flag.NewFlagSet("pgqviewer-server", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)

	cfg := Config{LogLevel: "info"}
	fs.StringVar(&cfg.HTTPAddr, "http", "", "bind address for web mode (e.g. :8080); empty means auto-port mode on 127.0.0.1:0")
	fs.StringVar(&cfg.LogLevel, "log-level", cfg.LogLevel, "log level: debug|info|warn|error")

	if err := fs.Parse(args); err != nil {
		return Config{}, fmt.Errorf("parse flags: %w", err)
	}
	return cfg, nil
}

// AutoPortMode reports whether the server should bind to a random localhost
// port and print its discovered address on stdout.
func (c Config) AutoPortMode() bool { return c.HTTPAddr == "" }
