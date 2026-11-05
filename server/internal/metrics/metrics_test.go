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
	m.EconomyAlertKinds("mismatch", "log_dropped")
	m.EconomyAlert("mismatch")
	m.PersistenceError(WriterCharacter, OutcomeRetry)
	m.PersistenceError(WriterCharacter, OutcomeRetry)
	m.PersistenceError(WriterEconomy, OutcomeRejected)
	m.HTTPRequest("GET /api/highscores", 503, 20*time.Millisecond)
	m.HTTPRequest("GET /healthz", 200, time.Millisecond)
	online := 7
	if err := m.PlayersOnline(func() int { return online }); err != nil {
		t.Fatal(err)
	}

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
		`economy_alerts_total{kind="mismatch"} 1`,
		`economy_alerts_total{kind="log_dropped"} 0`,
		`persistence_errors_total{outcome="retry",writer="character"} 2`,
		`persistence_errors_total{outcome="rejected",writer="economy"} 1`,
		`persistence_errors_total{outcome="abandoned",writer="audit"} 0`,
		`http_requests_total{code="503",route="GET /api/highscores"} 1`,
		`http_requests_total{code="200",route="GET /healthz"} 1`,
		`http_request_duration_seconds_bucket{route="GET /api/highscores",le="0.025"} 1`,
		"players_online 7",
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
	m.EconomyAlert("mismatch")
	m.EconomyAlertKinds("mismatch")
	m.PersistenceError(WriterAudit, OutcomeRetry)
	m.HTTPRequest("GET /healthz", 200, time.Millisecond)
	if err := m.PlayersOnline(func() int { return 1 }); err != nil {
		t.Fatal(err)
	}
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
