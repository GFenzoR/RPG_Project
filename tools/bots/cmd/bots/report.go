package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"math"
	"net/http"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
)

// sample is one scrape of the server's /metrics: series (name plus labels, as printed)
// to value.
type sample struct {
	at     time.Time
	series map[string]float64
}

// parseMetrics reads the Prometheus text format; it keeps only what the report needs.
func parseMetrics(r io.Reader) (map[string]float64, error) {
	out := map[string]float64{}
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || line[0] == '#' {
			continue
		}
		i := strings.LastIndexByte(line, ' ')
		if i < 0 {
			continue
		}
		v, err := strconv.ParseFloat(line[i+1:], 64)
		if err != nil {
			continue
		}
		out[line[:i]] = v
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("metrics: %w", err)
	}
	return out, nil
}

func scrape(ctx context.Context, url string) (sample, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return sample{}, fmt.Errorf("metrics: %w", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return sample{}, fmt.Errorf("metrics: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return sample{}, fmt.Errorf("metrics: %s", resp.Status)
	}
	s, err := parseMetrics(resp.Body)
	return sample{at: time.Now(), series: s}, err
}

type bucket struct{ le, count float64 }

// buckets returns the cumulative buckets of histogram name in s minus those in base
// (nil base: from zero), sorted by bound.
func buckets(name string, s, base map[string]float64) []bucket {
	prefix := name + `_bucket{le="`
	var out []bucket
	for k, v := range s {
		if !strings.HasPrefix(k, prefix) {
			continue
		}
		le, err := strconv.ParseFloat(strings.TrimSuffix(k[len(prefix):], `"}`), 64)
		if err != nil {
			continue
		}
		out = append(out, bucket{le, v - base[k]})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].le < out[j].le })
	return out
}

// histQuantile is Prometheus' histogram_quantile: linear interpolation inside the
// bucket that holds the q-th observation. Observations in the +Inf bucket return the
// largest finite bound.
func histQuantile(q float64, bs []bucket) float64 {
	if len(bs) == 0 || bs[len(bs)-1].count == 0 {
		return math.NaN()
	}
	rank := q * bs[len(bs)-1].count
	prevLe, prevCount := 0.0, 0.0
	for _, b := range bs {
		if b.count >= rank {
			if math.IsInf(b.le, 1) {
				return prevLe
			}
			if b.count == prevCount {
				return b.le
			}
			return prevLe + (b.le-prevLe)*(rank-prevCount)/(b.count-prevCount)
		}
		prevLe, prevCount = b.le, b.count
	}
	return prevLe
}

// quantile is the nearest-rank quantile of sorted durations, in milliseconds.
func quantile(q float64, sorted []time.Duration) float64 {
	if len(sorted) == 0 {
		return math.NaN()
	}
	i := int(math.Ceil(q*float64(len(sorted)))) - 1
	return ms(sorted[max(0, min(i, len(sorted)-1))])
}

func ms(d time.Duration) float64 { return round(float64(d) / 1e6) }

func round(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return v
	}
	return math.Round(v*100) / 100
}

// Percentiles in milliseconds.
type Percentiles struct {
	P50 float64 `json:"p50"`
	P95 float64 `json:"p95"`
	P99 float64 `json:"p99"`
	Max float64 `json:"max"`
}

// ServerReport comes from /metrics over the steady window (every bot in the world).
type ServerReport struct {
	TickMS         Percentiles `json:"tick_ms"` // Max is the upper bound of the highest non-empty bucket
	Ticks          float64     `json:"ticks"`
	Overruns       float64     `json:"tick_overruns"`
	RSSMBMax       float64     `json:"rss_mb_max"`
	RSSMBEnd       float64     `json:"rss_mb_end"`
	CPUCores       float64     `json:"cpu_cores_avg"` // CPU seconds per second of the server process
	BytesPerPlayer float64     `json:"bytes_per_player_s"`
	ConnectionsMax float64     `json:"connections_max"`
}

// ClientReport is what the bots measured themselves.
type ClientReport struct {
	// LatencyMS is the Ping round trip: received by the server, run on the next tick and
	// sent in that tick's batch, over loopback (docs/07 "latencia de comando").
	LatencyMS      Percentiles `json:"latency_ms"`
	LatencySamples int         `json:"latency_samples"`
	BytesPerPlayer float64     `json:"bytes_per_player_s"`
	Actions        actions     `json:"actions"`
	Steps          int         `json:"steps"`
	StepsRejected  int         `json:"steps_rejected"`
	DialogsOpened  int         `json:"dialogs_opened"`
	ChatReceived   int         `json:"chat_received"`
}

// Check is one budget line of docs/07-performance-budget.md.
type Check struct {
	Metric string  `json:"metric"`
	Budget string  `json:"budget"`
	Value  float64 `json:"value"`
	OK     bool    `json:"ok"`
}

// Report is the JSON written by -report.
type Report struct {
	Scenario         string         `json:"scenario"`
	Bots             int            `json:"bots"`
	Entered          int            `json:"entered"`
	FailedToEnter    int            `json:"failed_to_enter"`
	Disconnects      int            `json:"disconnects"`
	DisconnectReason map[string]int `json:"disconnect_reasons,omitempty"`
	OtherErrors      int            `json:"other_errors"` // e.g. a failed logout
	Errors           []string       `json:"errors,omitempty"`
	StartedAt        time.Time      `json:"started_at"`
	RampSeconds      float64        `json:"ramp_s"`
	SteadySeconds    float64        `json:"steady_s"`
	Server           *ServerReport  `json:"server,omitempty"`
	Client           ClientReport   `json:"client"`
	Checks           []Check        `json:"checks"`
}

// serverReport derives the server numbers from the scrapes of the steady window.
func serverReport(first, last sample, all []sample) *ServerReport {
	tick := buckets("tick_duration_ms", last.series, first.series)
	r := &ServerReport{
		TickMS: Percentiles{
			P50: round(histQuantile(0.50, tick)),
			P95: round(histQuantile(0.95, tick)),
			P99: round(histQuantile(0.99, tick)),
		},
		Ticks:    last.series["tick_duration_ms_count"] - first.series["tick_duration_ms_count"],
		Overruns: last.series["tick_overruns_total"] - first.series["tick_overruns_total"],
		RSSMBEnd: round(last.series["process_resident_memory_bytes"] / (1 << 20)),
	}
	for i := len(tick) - 1; i >= 0; i-- {
		if i == 0 || tick[i].count > tick[i-1].count {
			r.TickMS.Max = tick[i].le
			if math.IsInf(r.TickMS.Max, 1) && i > 0 {
				r.TickMS.Max = tick[i-1].le // only "above the last bound" is known
			}
			break
		}
	}
	wall := last.at.Sub(first.at).Seconds()
	var connSum float64
	for _, s := range all {
		r.RSSMBMax = max(r.RSSMBMax, round(s.series["process_resident_memory_bytes"]/(1<<20)))
		r.ConnectionsMax = max(r.ConnectionsMax, s.series["ws_connections"])
		connSum += s.series["ws_connections"]
	}
	if wall > 0 {
		r.CPUCores = round((last.series["process_cpu_seconds_total"] - first.series["process_cpu_seconds_total"]) / wall)
		if avgConns := connSum / float64(len(all)); avgConns > 0 {
			r.BytesPerPlayer = round((last.series["ws_sent_bytes_total"] - first.series["ws_sent_bytes_total"]) / wall / avgConns)
		}
	}
	return r
}

func latencyPercentiles(lat []time.Duration) Percentiles {
	slices.Sort(lat)
	p := Percentiles{P50: quantile(0.50, lat), P95: quantile(0.95, lat), P99: quantile(0.99, lat)}
	if len(lat) > 0 {
		p.Max = ms(lat[len(lat)-1])
	}
	return p
}

// checks compares the report with docs/07-performance-budget.md. The tick and RAM
// budgets are stated for 100 players; they are checked in every scenario so a stress
// run shows the headroom left.
func (r *Report) checks() {
	add := func(metric, budget string, v float64, ok bool) {
		r.Checks = append(r.Checks, Check{metric, budget, v, ok && !math.IsNaN(v)})
	}
	if s := r.Server; s != nil {
		add("tick p99 (ms)", "< 10", s.TickMS.P99, s.TickMS.P99 < 10)
		add("RSS max (MB)", "< 600", s.RSSMBMax, s.RSSMBMax < 600)
		add("server output per player (B/s)", "< 4096", s.BytesPerPlayer, s.BytesPerPlayer < 4096)
	} else {
		add("client input per player (B/s)", "< 4096", r.Client.BytesPerPlayer, r.Client.BytesPerPlayer < 4096)
	}
	add("command latency p95 (ms)", "< 60", r.Client.LatencyMS.P95, r.Client.LatencyMS.P95 < 60)
	add("disconnects", "0", float64(r.Disconnects+r.FailedToEnter), r.Disconnects+r.FailedToEnter == 0)
}

// summary is the human-readable report (Markdown, to paste in a PR).
func (r *Report) summary(w io.Writer) {
	fmt.Fprintf(w, "## Load test: %s, %d bots\n\n", r.Scenario, r.Bots)
	fmt.Fprintf(w, "Entered %d/%d, disconnects %d, other errors %d; ramp %.0f s, steady window %.0f s.\n\n",
		r.Entered, r.Bots, r.Disconnects, r.OtherErrors, r.RampSeconds, r.SteadySeconds)
	fmt.Fprintln(w, "| Metric | Value |")
	fmt.Fprintln(w, "|---|---|")
	if s := r.Server; s != nil {
		fmt.Fprintf(w, "| tick p50 / p95 / p99 (ms) | %.2f / %.2f / %.2f (max ≤ %.2f, %0.f ticks, %0.f overruns) |\n",
			s.TickMS.P50, s.TickMS.P95, s.TickMS.P99, s.TickMS.Max, s.Ticks, s.Overruns)
		fmt.Fprintf(w, "| RSS max / end (MB) | %.1f / %.1f |\n", s.RSSMBMax, s.RSSMBEnd)
		fmt.Fprintf(w, "| server CPU (cores) | %.2f |\n", s.CPUCores)
		fmt.Fprintf(w, "| server output per player (B/s) | %.0f |\n", s.BytesPerPlayer)
	}
	c := r.Client
	fmt.Fprintf(w, "| command latency p50 / p95 / p99 / max (ms) | %.2f / %.2f / %.2f / %.2f (%d pings) |\n",
		c.LatencyMS.P50, c.LatencyMS.P95, c.LatencyMS.P99, c.LatencyMS.Max, c.LatencySamples)
	fmt.Fprintf(w, "| client input per player (B/s) | %.0f |\n", c.BytesPerPlayer)
	fmt.Fprintf(w, "| actions | %d walks, %d attacks, %d says, %d NPC talks (%d dialogs) |\n",
		c.Actions.Walks, c.Actions.Attacks, c.Actions.Says, c.Actions.Talks, c.DialogsOpened)
	fmt.Fprintf(w, "| steps / rejected | %d / %d |\n\n", c.Steps, c.StepsRejected)
	fmt.Fprintln(w, "| Budget (docs/07) | Limit | Measured | OK |")
	fmt.Fprintln(w, "|---|---|---|---|")
	for _, ch := range r.Checks {
		ok := "yes"
		if !ch.OK {
			ok = "**NO**"
		}
		fmt.Fprintf(w, "| %s | %s | %.2f | %s |\n", ch.Metric, ch.Budget, ch.Value, ok)
	}
	for _, e := range r.Errors {
		fmt.Fprintln(w, "- error:", e)
	}
}
