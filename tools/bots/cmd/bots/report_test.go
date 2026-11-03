package main

import (
	"context"
	"math"
	"strings"
	"testing"
	"time"
)

const exposition = `# HELP tick_duration_ms Time to process one game tick, in milliseconds.
# TYPE tick_duration_ms histogram
tick_duration_ms_bucket{le="1"} 50
tick_duration_ms_bucket{le="2"} 90
tick_duration_ms_bucket{le="10"} 99
tick_duration_ms_bucket{le="+Inf"} 100
tick_duration_ms_sum 120.5
tick_duration_ms_count 100
ws_connections 10
process_resident_memory_bytes 1.048576e+08
process_cpu_seconds_total 12.5
ws_sent_bytes_total 5000
`

func TestParseMetricsAndHistogramQuantiles(t *testing.T) {
	s, err := parseMetrics(strings.NewReader(exposition))
	if err != nil {
		t.Fatal(err)
	}
	if s["ws_connections"] != 10 || s["process_resident_memory_bytes"] != 104857600 {
		t.Fatalf("parsed %v", s)
	}
	bs := buckets("tick_duration_ms", s, nil)
	if len(bs) != 4 || !math.IsInf(bs[3].le, 1) {
		t.Fatalf("buckets %v", bs)
	}
	for _, tc := range []struct{ q, want float64 }{
		{0.25, 0.5}, // inside the first bucket, interpolated from 0
		{0.5, 1},    // exactly the first bound
		{0.7, 1.5},  // halfway through (1, 2]
		{0.99, 10},  // the 99th observation is in (2, 10]
		{0.995, 10}, // in +Inf: the largest finite bound
	} {
		if got := histQuantile(tc.q, bs); math.Abs(got-tc.want) > 1e-9 {
			t.Errorf("histQuantile(%v) = %v, want %v", tc.q, got, tc.want)
		}
	}
	// A window is the difference of two scrapes.
	base := map[string]float64{`tick_duration_ms_bucket{le="1"}`: 50, `tick_duration_ms_bucket{le="2"}`: 50,
		`tick_duration_ms_bucket{le="10"}`: 50, `tick_duration_ms_bucket{le="+Inf"}`: 50}
	if got := histQuantile(0.5, buckets("tick_duration_ms", s, base)); math.Abs(got-1.625) > 1e-9 {
		t.Errorf("windowed p50 = %v, want 1.625", got)
	}
	if !math.IsNaN(histQuantile(0.5, nil)) {
		t.Error("empty histogram should be NaN")
	}
}

func TestServerReportAndChecks(t *testing.T) {
	s, _ := parseMetrics(strings.NewReader(exposition))
	first := sample{at: time.Unix(0, 0), series: map[string]float64{"process_cpu_seconds_total": 2.5, "ws_connections": 10}}
	last := sample{at: time.Unix(10, 0), series: s}
	r := serverReport(first, last, []sample{first, last})
	if r.CPUCores != 1 || r.BytesPerPlayer != 50 || r.RSSMBMax != 100 || r.Ticks != 100 || r.TickMS.Max != 10 {
		t.Fatalf("server report %+v", r)
	}
	rep := &Report{Server: r, Client: ClientReport{LatencyMS: Percentiles{P95: 70}}, Disconnects: 1}
	rep.checks()
	ok := map[string]bool{}
	for _, c := range rep.Checks {
		ok[c.Metric] = c.OK
	}
	// p99 is exactly 10 ms here: the budget is strict (< 10).
	if ok["tick p99 (ms)"] || !ok["RSS max (MB)"] || ok["command latency p95 (ms)"] || ok["disconnects"] {
		t.Fatalf("checks %+v", rep.Checks)
	}
	var sb strings.Builder
	rep.summary(&sb)
	if !strings.Contains(sb.String(), "| command latency p95 (ms) | < 60 | 70.00 | **NO** |") {
		t.Fatalf("summary:\n%s", sb.String())
	}
}

func TestLatencyPercentiles(t *testing.T) {
	var lat []time.Duration
	for i := 100; i >= 1; i-- {
		lat = append(lat, time.Duration(i)*time.Millisecond)
	}
	p := latencyPercentiles(lat)
	if p.P50 != 50 || p.P95 != 95 || p.P99 != 99 || p.Max != 100 {
		t.Fatalf("percentiles %+v", p)
	}
}

func TestPacerSpacesCommands(t *testing.T) {
	now := time.Unix(100, 0)
	p := pacer{minGap: 250 * time.Millisecond, now: func() time.Time { return now }}
	ctx := context.Background()
	if err := p.wait(ctx); err != nil { // the first command goes at once
		t.Fatal(err)
	}
	if want := now.Add(250 * time.Millisecond); !p.next.Equal(want) {
		t.Fatalf("next = %v, want %v", p.next, want)
	}
	now = now.Add(time.Second) // idle for longer than the gap: no wait
	start := time.Now()
	if err := p.wait(ctx); err != nil || time.Since(start) > 100*time.Millisecond {
		t.Fatalf("wait after idle: %v, took %v", err, time.Since(start))
	}
	// Back to back: the second waits for the gap (the real sleep is short here).
	p.minGap = 20 * time.Millisecond
	p.next = now.Add(20 * time.Millisecond)
	start = time.Now()
	if err := p.wait(ctx); err != nil || time.Since(start) < 15*time.Millisecond {
		t.Fatalf("back-to-back wait: %v, took %v", err, time.Since(start))
	}
	cctx, cancel := context.WithCancel(ctx)
	cancel()
	p.next = now.Add(time.Hour)
	if err := p.wait(cctx); err == nil {
		t.Fatal("wait ignores a cancelled context")
	}
}

func TestScenarios(t *testing.T) {
	base, err := scenarioByName("base")
	if err != nil || !base.fight || len(base.areas) < 5 {
		t.Fatalf("base %+v %v", base, err)
	}
	seen := map[string]bool{}
	for i := range len(base.areas) {
		seen[base.areaFor(i).name] = true
	}
	if len(seen) != len(base.areas) {
		t.Fatalf("round robin covers %d of %d areas", len(seen), len(base.areas))
	}
	stress, _ := scenarioByName("stress")
	if stress.fight || stress.areaFor(299).name != "town" {
		t.Fatalf("stress %+v", stress)
	}
	if _, err := scenarioByName("nope"); err == nil {
		t.Fatal("unknown scenario accepted")
	}
}
