package clientip

import (
	"net/http/httptest"
	"testing"
)

func TestKey(t *testing.T) {
	cases := []struct {
		remote, xff string
		trust       bool
		want        string
	}{
		{"203.0.113.7:5000", "", false, "203.0.113.7"},
		{"203.0.113.7:5000", "198.51.100.1", false, "203.0.113.7"}, // header ignored without trust
		{"10.0.0.2:5000", "1.2.3.4, 198.51.100.1", true, "198.51.100.1"},
		{"10.0.0.2:5000", "", true, "10.0.0.2"},
		{"[2001:db8:1:2:3:4:5:6]:443", "", false, "2001:db8:1:2::/64"},
		{"[::ffff:192.0.2.9]:80", "", false, "192.0.2.9"},
		{"pipe", "", false, "pipe"},
	}
	for _, c := range cases {
		r := httptest.NewRequest("GET", "/ws", nil)
		r.RemoteAddr = c.remote
		if c.xff != "" {
			r.Header.Set("X-Forwarded-For", c.xff)
		}
		if got := Key(r, c.trust); got != c.want {
			t.Errorf("%s / %q (trust %v): %q, want %q", c.remote, c.xff, c.trust, got, c.want)
		}
	}
}

func TestIsLoopback(t *testing.T) {
	for key, want := range map[string]bool{
		"127.0.0.1": true, "127.5.0.1": true, "::/64": true, "203.0.113.7": false,
		"2001:db8::/64": false, "pipe": false,
	} {
		if got := IsLoopback(key); got != want {
			t.Errorf("%q: %v, want %v", key, got, want)
		}
	}
}
