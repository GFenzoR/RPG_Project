package metrics

import (
	"io"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/game"
)

func TestMetricsRecordAndServe(t *testing.T) {
	m := New()
	m.ObserveTick(game.TickStats{Duration: 2500 * time.Microsecond, Commands: 3, Pending: 1})
	m.ObserveTick(game.TickStats{Duration: 60 * time.Millisecond, Overrun: true})
	m.Sent(100)
	m.Sent(28)
	m.ConnOpened()
	m.ConnOpened()
	m.ConnClosed()

	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/metrics", nil))
	body, _ := io.ReadAll(rec.Body)
	for _, want := range []string{
		`tick_duration_ms_bucket{le="3"} 1`,
		`tick_duration_ms_bucket{le="100"} 2`,
		"tick_duration_ms_count 2",
		"tick_overruns_total 1",
		"tick_commands_total 3",
		"command_queue_pending 0",
		"ws_sent_bytes_total 128",
		"ws_sent_batches_total 2",
		"ws_connections 1",
		"process_cpu_seconds_total",
		"process_resident_memory_bytes",
	} {
		if !strings.Contains(string(body), want) {
			t.Errorf("metrics lack %q", want)
		}
	}
}

func TestNilMetricsRecordNothing(t *testing.T) {
	var m *Metrics
	m.ObserveTick(game.TickStats{Duration: time.Millisecond})
	m.Sent(1)
	m.ConnOpened()
	m.ConnClosed()
}

// BenchmarkObserveTick is the cost the metrics add to every tick.
func BenchmarkObserveTick(b *testing.B) {
	m := New()
	s := game.TickStats{Duration: 700 * time.Microsecond, Commands: 40, Pending: 0}
	b.ReportAllocs()
	for b.Loop() {
		m.ObserveTick(s)
	}
}
