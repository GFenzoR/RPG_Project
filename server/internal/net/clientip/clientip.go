// Package clientip derives the per-client key that rate limits and connection caps
// count by. It follows the rule of the HTTP API's limiter (httpapi clientKey): the last
// X-Forwarded-For entry when the server trusts its proxy (Caddy appends the address it
// saw), otherwise the TCP peer; an IPv4 address and ::1 as is and an IPv6 address as its /64,
// since one subscriber usually owns a whole /64 and could rotate through it.
package clientip

import (
	"net"
	"net/http"
	"net/netip"
	"strings"
)

// Key returns the client key of r.
func Key(r *http.Request, trustProxy bool) string {
	host := ""
	if trustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			host = strings.TrimSpace(parts[len(parts)-1])
		}
	}
	if host == "" {
		h, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			h = r.RemoteAddr
		}
		host = h
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return host
	}
	addr = addr.Unmap()
	if addr.Is6() && !addr.IsLoopback() { // ::1 stays itself: its /64 also holds ::2..
		if p, err := addr.Prefix(64); err == nil {
			return p.String()
		}
	}
	return addr.String()
}

// IsLoopback reports whether key (from Key) is a loopback address: 127.0.0.0/8 or ::1
// (an IPv6 /64 never is, not even "::/64").
func IsLoopback(key string) bool {
	addr, err := netip.ParseAddr(key)
	return err == nil && addr.IsLoopback()
}
