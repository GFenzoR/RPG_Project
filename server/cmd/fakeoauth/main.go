// Command fakeoauth serves the fake OAuth provider of internal/oauth/oauthtest (Google
// under /google, Discord under /discord) for the E2E suite. Tests only: it signs in
// whoever POST /test/next says.
//
//	go run ./cmd/fakeoauth -addr 127.0.0.1:18027
package main

import (
	"flag"
	"log"
	"net/http"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/oauth/oauthtest"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:18027", "listen address")
	flag.Parse()
	f := oauthtest.New()
	f.Base = "http://" + *addr
	srv := &http.Server{Addr: *addr, Handler: f, ReadHeaderTimeout: 5 * time.Second}
	log.Fatal(srv.ListenAndServe())
}
