// Package metrics holds the server's Prometheus metrics (docs/07-performance-budget.md):
// tick duration, network output and online sessions, plus the standard process (CPU,
// RSS) and Go runtime collectors. The handler is served on an internal-only listener
// (gameserver -metrics-addr), never through the public API.
//
// Every update is an atomic operation, cheap enough for the game loop and the
// per-connection writers.
package metrics

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/GFenzoR/RPG_Project/server/internal/game"
)

// TickBuckets are the tick_duration_ms buckets, fine below the 10 ms p99 budget.
var TickBuckets = []float64{0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12.5, 15, 20, 30, 50, 100, 250}

// Metrics is the set of server metrics. A nil *Metrics is valid and records nothing.
type Metrics struct {
	reg          *prometheus.Registry
	tickDuration prometheus.Histogram
	tickOverruns prometheus.Counter
	tickCommands prometheus.Counter
	queuePending prometheus.Gauge
	bytesSent    prometheus.Counter
	batchesSent  prometheus.Counter
	connections  prometheus.Gauge
	// economyAlerts counts the economy alerts by kind (T4.1, session.Alert*).
	economyAlerts *prometheus.CounterVec
}

// New registers the metrics on a fresh registry.
func New() *Metrics {
	m := &Metrics{
		reg: prometheus.NewRegistry(),
		tickDuration: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name: "tick_duration_ms", Help: "Time to process one game tick, in milliseconds.",
			Buckets: TickBuckets,
		}),
		tickOverruns: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "tick_overruns_total", Help: "Ticks that took longer than the tick period.",
		}),
		tickCommands: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "tick_commands_total", Help: "Commands executed by the game loop.",
		}),
		queuePending: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "command_queue_pending", Help: "Commands left in the queue after the last tick.",
		}),
		bytesSent: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "ws_sent_bytes_total", Help: "WebSocket payload bytes sent to players.",
		}),
		batchesSent: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "ws_sent_batches_total", Help: "WebSocket batches (frames) sent to players.",
		}),
		connections: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "ws_connections", Help: "Open game WebSocket connections.",
		}),
		economyAlerts: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "economy_alerts_total", Help: "Economy alerts: mismatch (possible duplication), gold_outlier, items_outlier, log_dropped.",
		}, []string{"kind"}),
	}
	m.reg.MustRegister(m.tickDuration, m.tickOverruns, m.tickCommands, m.queuePending,
		m.bytesSent, m.batchesSent, m.connections, m.economyAlerts,
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
		collectors.NewGoCollector())
	return m
}

// Handler serves the metrics in the Prometheus text format.
func (m *Metrics) Handler() http.Handler {
	return promhttp.HandlerFor(m.reg, promhttp.HandlerOpts{})
}

// Registry returns the registry (tests gather from it).
func (m *Metrics) Registry() *prometheus.Registry { return m.reg }

// ObserveTick records one tick; it is game.Config.OnTick.
func (m *Metrics) ObserveTick(s game.TickStats) {
	if m == nil {
		return
	}
	m.tickDuration.Observe(float64(s.Duration) / 1e6)
	m.tickCommands.Add(float64(s.Commands))
	m.queuePending.Set(float64(s.Pending))
	if s.Overrun {
		m.tickOverruns.Inc()
	}
}

// Sent records a batch of n bytes written to a player.
func (m *Metrics) Sent(n int) {
	if m == nil {
		return
	}
	m.bytesSent.Add(float64(n))
	m.batchesSent.Inc()
}

// ConnOpened and ConnClosed track the open game connections.
func (m *Metrics) ConnOpened() {
	if m != nil {
		m.connections.Inc()
	}
}

// ConnClosed is the counterpart of ConnOpened.
func (m *Metrics) ConnClosed() {
	if m != nil {
		m.connections.Dec()
	}
}

// EconomyAlert counts an economy alert of kind (session.Config.Alert). Called on the
// game loop: a counter increment, no blocking.
func (m *Metrics) EconomyAlert(kind string) {
	if m != nil {
		m.economyAlerts.WithLabelValues(kind).Inc()
	}
}
