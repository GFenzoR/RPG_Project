// Command healthcheck is the Docker HEALTHCHECK probe of the gameserver image. The image is
// distroless (no shell, curl or wget), so this tiny static binary does the HTTP GET.
//
//	healthcheck [url]   (default http://127.0.0.1:8080/healthz)
//
// Exit status 0 means the URL answered 2xx within the timeout; anything else exits 1.
package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"time"
)

const (
	defaultURL = "http://127.0.0.1:8080/healthz"
	timeout    = 3 * time.Second
)

func main() {
	url := defaultURL
	if len(os.Args) > 1 {
		url = os.Args[1]
	}
	if err := probe(url, timeout); err != nil {
		fmt.Fprintln(os.Stderr, "healthcheck:", err)
		os.Exit(1)
	}
}

// probe GETs url and returns nil only for a 2xx answer received within timeout.
func probe(url string, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return fmt.Errorf("request: %w", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("get %s: %w", url, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("get %s: status %d", url, resp.StatusCode)
	}
	return nil
}
