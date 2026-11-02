package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestProbe(t *testing.T) {
	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer ok.Close()
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer down.Close()
	stuck := make(chan struct{})
	slow := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-stuck:
		}
	}))
	defer slow.Close()
	defer close(stuck)

	if err := probe(ok.URL, time.Second); err != nil {
		t.Errorf("healthy server: %v", err)
	}
	if err := probe(down.URL, time.Second); err == nil {
		t.Error("503 must fail")
	}
	if err := probe(slow.URL, 50*time.Millisecond); err == nil {
		t.Error("timeout must fail")
	}
	if err := probe("http://127.0.0.1:1/", time.Second); err == nil {
		t.Error("connection refused must fail")
	}
}
