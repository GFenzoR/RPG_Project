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

// num is a measured value: NaN means "not measured" (the series was missing or had no
// data). It is written as null in the JSON and as "n/a" in the summary.
type num float64

func (n num) measured() bool { return !math.IsNaN(float64(n)) && !math.IsInf(float64(n), 0) }

// MarshalJSON writes NaN and ±Inf, which JSON cannot hold, as null.
func (n num) MarshalJSON() ([]byte, error) {
	if !n.measured() {
		return []byte("null"), nil
	}
	return []byte(strconv.FormatFloat(float64(n), 'f', -1, 64)), nil
}

// format prints n with prec decimals, or "n/a".
func (n num) format(prec int) string {
	if !n.measured() {
		return "n/a"
	}
	return strconv.FormatFloat(float64(n), 'f', prec, 64)
}

var nan = num(math.NaN())

// Percentiles in milliseconds.
type Percentiles struct {
	P50 num `json:"p50"`
	P95 num `json:"p95"`
	P99 num `json:"p99"`
	Max num `json:"max"`
}

// ServerReport comes from /metrics over the steady window (every bot in the world).
type ServerReport struct {
	// TickMS.Max is the upper bound of the highest non-empty bucket; with
	// TickMaxOverflow the slowest tick was above it (in the +Inf bucket).
	TickMS          Percentiles `json:"tick_ms"`
	TickMaxOverflow bool        `json:"tick_max_overflow,omitempty"`
	Ticks           num         `json:"ticks"`
	Overruns        num         `json:"tick_overruns"`
	RSSMBMax        num         `json:"rss_mb_max"`
	RSSMBEnd        num         `json:"rss_mb_end"`
	CPUCores        num         `json:"cpu_cores_avg"` // CPU seconds per second of the server process
	BytesPerPlayer  num         `json:"bytes_per_player_s"`
	ConnectionsMax  num         `json:"connections_max"`
}

// ClientReport is what the bots measured themselves. Latency, bytes and the received
// counters cover the steady window; Actions covers each bot since it entered (ramp and
// window).
type ClientReport struct {
	// LatencyMS is the Ping round trip: received by the server, run on the next tick and
	// sent in that tick's batch, over loopback (the command latency of docs/07).
	LatencyMS      Percentiles `json:"latency_ms"`
	LatencySamples int         `json:"latency_samples"`
	BytesPerPlayer num         `json:"bytes_per_player_s"`
	Actions        actions     `json:"actions_since_entry"`
	Steps          int         `json:"steps"`
	// WalksRejected counts WalkRejected messages: one per walk the server cut short
	// (a blocked tile), not one per step.
	WalksRejected int `json:"walks_rejected"`
	// DialogMessages counts DialogOpen messages: one when a dialog opens and one more
	// per option chosen (the next node).
	DialogMessages int `json:"dialog_open_messages"`
	ChatReceived   int `json:"chat_received"`
}

// Check is one budget line of docs/07-performance-budget.md.
type Check struct {
	Metric string `json:"metric"`
	Budget string `json:"budget"`
	Value  num    `json:"value"`
	OK     bool   `json:"ok"`
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
	MetricsURL       string         `json:"metrics_url,omitempty"`
	Server           *ServerReport  `json:"server,omitempty"`
	Client           ClientReport   `json:"client"`
	Checks           []Check        `json:"checks"`
}

// get returns a series of s, NaN if it is missing.
func get(s sample, name string) float64 {
	if v, ok := s.series[name]; ok {
		return v
	}
	return math.NaN()
}

// serverReport derives the server numbers from the scrapes of the steady window. A
// series missing from the scrapes leaves its numbers unmeasured (NaN), never 0.
func serverReport(first, last sample, all []sample) *ServerReport {
	tick := buckets("tick_duration_ms", last.series, first.series)
	const mb = 1 << 20
	r := &ServerReport{
		TickMS: Percentiles{
			P50: num(round(histQuantile(0.50, tick))),
			P95: num(round(histQuantile(0.95, tick))),
			P99: num(round(histQuantile(0.99, tick))),
			Max: nan,
		},
		Ticks:    num(get(last, "tick_duration_ms_count") - get(first, "tick_duration_ms_count")),
		Overruns: num(get(last, "tick_overruns_total") - get(first, "tick_overruns_total")),
		RSSMBEnd: num(round(get(last, "process_resident_memory_bytes") / mb)),
		RSSMBMax: nan, ConnectionsMax: nan, CPUCores: nan, BytesPerPlayer: nan,
	}
	for i := len(tick) - 1; i >= 0 && r.Ticks > 0; i-- {
		if i == 0 || tick[i].count > tick[i-1].count {
			r.TickMS.Max = num(tick[i].le)
			if math.IsInf(tick[i].le, 1) {
				r.TickMaxOverflow = true
				r.TickMS.Max = nan
				if i > 0 {
					r.TickMS.Max = num(tick[i-1].le) // only "above the last bound" is known
				}
			}
			break
		}
	}
	wall := last.at.Sub(first.at).Seconds()
	var connSum, rssMax, connMax float64
	rssN, conns := 0, 0
	for _, s := range all {
		if v := get(s, "process_resident_memory_bytes"); !math.IsNaN(v) && v > 0 {
			rssMax = max(rssMax, v)
			rssN++
		}
		if v := get(s, "ws_connections"); !math.IsNaN(v) {
			connMax = max(connMax, v)
			connSum += v
			conns++
		}
	}
	if rssN > 0 {
		r.RSSMBMax = num(round(rssMax / mb))
	}
	if conns > 0 {
		r.ConnectionsMax = num(connMax)
	}
	if r.RSSMBEnd <= 0 {
		r.RSSMBEnd = nan
	}
	if wall > 0 {
		r.CPUCores = num(round((get(last, "process_cpu_seconds_total") - get(first, "process_cpu_seconds_total")) / wall))
		if conns > 0 {
			if avg := connSum / float64(conns); avg > 0 {
				r.BytesPerPlayer = num(round((get(last, "ws_sent_bytes_total") - get(first, "ws_sent_bytes_total")) / wall / avg))
			}
		}
	}
	return r
}

func latencyPercentiles(lat []time.Duration) Percentiles {
	slices.Sort(lat)
	p := Percentiles{P50: num(quantile(0.50, lat)), P95: num(quantile(0.95, lat)), P99: num(quantile(0.99, lat)), Max: nan}
	if len(lat) > 0 {
		p.Max = num(ms(lat[len(lat)-1]))
	}
	return p
}

// checks compares the report with docs/07-performance-budget.md. The tick and RAM
// budgets are stated for 100 players; they are checked in every scenario so a stress
// run shows the headroom left. An unmeasured value fails its check.
func (r *Report) checks() {
	add := func(metric, budget string, v num, ok bool) {
		r.Checks = append(r.Checks, Check{metric, budget, v, ok && v.measured()})
	}
	if s := r.Server; s != nil {
		add("tick p99 (ms)", "< 10", s.TickMS.P99, s.TickMS.P99 < 10)
		add("RSS max (MB)", "< 600", s.RSSMBMax, s.RSSMBMax < 600)
		add("server output per player (B/s)", "< 4096", s.BytesPerPlayer, s.BytesPerPlayer < 4096)
	} else {
		add("client input per player (B/s)", "< 4096", r.Client.BytesPerPlayer, r.Client.BytesPerPlayer < 4096)
	}
	add("command latency p95 (ms)", "< 60", r.Client.LatencyMS.P95, r.Client.LatencyMS.P95 < 60)
	add("disconnects", "0", num(r.Disconnects+r.FailedToEnter), r.Disconnects+r.FailedToEnter == 0)
}

// summary is the human-readable report (Markdown, to paste in a PR).
func (r *Report) summary(w io.Writer) {
	fmt.Fprintf(w, "## Load test: %s, %d bots\n\n", r.Scenario, r.Bots)
	fmt.Fprintf(w, "Entered %d/%d, disconnects %d, other errors %d; ramp %.0f s, steady window %.0f s.\n",
		r.Entered, r.Bots, r.Disconnects, r.OtherErrors, r.RampSeconds, r.SteadySeconds)
	if r.MetricsURL != "" {
		fmt.Fprintf(w, "Server metrics: %s.\n", r.MetricsURL)
	}
	fmt.Fprintln(w)
	fmt.Fprintln(w, "| Metric | Value |")
	fmt.Fprintln(w, "|---|---|")
	if s := r.Server; s != nil {
		bound := "≤"
		if s.TickMaxOverflow {
			bound = ">"
		}
		fmt.Fprintf(w, "| tick p50 / p95 / p99 (ms) | %s / %s / %s (max %s %s, %s ticks, %s overruns) |\n",
			s.TickMS.P50.format(2), s.TickMS.P95.format(2), s.TickMS.P99.format(2), bound, s.TickMS.Max.format(2),
			s.Ticks.format(0), s.Overruns.format(0))
		fmt.Fprintf(w, "| RSS max / end (MB) | %s / %s |\n", s.RSSMBMax.format(1), s.RSSMBEnd.format(1))
		fmt.Fprintf(w, "| server CPU (cores) | %s |\n", s.CPUCores.format(2))
		fmt.Fprintf(w, "| server output per player (B/s) | %s |\n", s.BytesPerPlayer.format(0))
	}
	c := r.Client
	fmt.Fprintf(w, "| command latency p50 / p95 / p99 / max (ms) | %s / %s / %s / %s (%d pings) |\n",
		c.LatencyMS.P50.format(2), c.LatencyMS.P95.format(2), c.LatencyMS.P99.format(2), c.LatencyMS.Max.format(2), c.LatencySamples)
	fmt.Fprintf(w, "| client input per player (B/s) | %s |\n", c.BytesPerPlayer.format(0))
	fmt.Fprintf(w, "| steps / walks cut short | %d / %d |\n", c.Steps, c.WalksRejected)
	fmt.Fprintf(w, "| actions since entry (ramp + window) | %d walks, %d attacks, %d says, %d NPC talks (%d dialogs) |\n\n",
		c.Actions.Walks, c.Actions.Attacks, c.Actions.Says, c.Actions.Talks, c.Actions.Dialogs)
	fmt.Fprintln(w, "| Budget (docs/07) | Limit | Measured | OK |")
	fmt.Fprintln(w, "|---|---|---|---|")
	for _, ch := range r.Checks {
		ok := "yes"
		if !ch.OK {
			ok = "**NO**"
		}
		fmt.Fprintf(w, "| %s | %s | %s | %s |\n", ch.Metric, ch.Budget, ch.Value.format(2), ok)
	}
	for _, e := range r.Errors {
		fmt.Fprintln(w, "- error:", e)
	}
}
