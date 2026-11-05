package httpapi

import (
	"net/http"
	"time"
)

// RequestObserver receives one call per finished API request (internal/metrics). route
// is the matched ServeMux pattern ("GET /api/status"), or "unmatched": a fixed, small
// set, never the raw path, so the metric's cardinality stays bounded.
type RequestObserver func(route string, code int, d time.Duration)

// unmatchedRoute labels requests that matched no pattern.
const unmatchedRoute = "unmatched"

// statusWriter remembers the status code written (200 if the handler never called
// WriteHeader).
type statusWriter struct {
	http.ResponseWriter
	code int
}

func (s *statusWriter) WriteHeader(code int) {
	if s.code == 0 {
		s.code = code
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusWriter) Write(b []byte) (int, error) {
	if s.code == 0 {
		s.code = http.StatusOK
	}
	return s.ResponseWriter.Write(b)
}

// Flush keeps streaming working through the wrapper.
func (s *statusWriter) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		if s.code == 0 {
			s.code = http.StatusOK
		}
		f.Flush()
	}
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (s *statusWriter) Unwrap() http.ResponseWriter { return s.ResponseWriter }

// observe reports every request to a.cfg.Observe. It must wrap the handler chain that ends
// in the routes' ServeMux without replacing *http.Request on the way (the mux sets
// r.Pattern on the request it receives, which is how the route is read back here).
func (a *api) observe(next http.Handler) http.Handler {
	if a.cfg.Observe == nil {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := a.cfg.Clock.Now()
		sw := &statusWriter{ResponseWriter: w}
		// Deferred so a response aborted by recoverer (http.ErrAbortHandler after a panic
		// with the response started) is still counted, as a 500, before the panic goes on.
		defer func() {
			v := recover()
			route := r.Pattern
			if route == "" {
				route = unmatchedRoute
			}
			code := sw.code
			switch {
			case v != nil:
				code = http.StatusInternalServerError
			case code == 0:
				code = http.StatusOK
			}
			a.cfg.Observe(route, code, a.cfg.Clock.Now().Sub(start))
			if v != nil {
				panic(v) //nolint:forbidigo // re-raise for net/http (it is http.ErrAbortHandler)
			}
		}()
		next.ServeHTTP(sw, r)
	})
}
