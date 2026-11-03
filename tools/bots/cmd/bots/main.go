// Command bots is the load test (T1.17): headless players (server/pkg/bot) that
// register, create a character, enter the Isla del Puerto and play: they walk with real
// paths on the map, fight monsters, chat and open NPC dialogs, each under its own rate
// limit. It reports tick, RAM, CPU, latency, bandwidth and disconnects, compared with
// docs/07-performance-budget.md.
//
//	make bots N=100                    # starts its own server (tools/bots/loadtest.sh)
//	make bots N=300 SCENARIO=stress
//	make bots N=20 URL=http://host:8080 # against a running server
//
// Bots enter over -ramp, then play together for -duration (the steady window that the
// report measures). Server numbers come from the server's internal /metrics (-metrics);
// without it the report only has what the bots measure.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"math/rand/v2"
	"net"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/GFenzoR/RPG_Project/server/pkg/bot"
)

// maxBots caps a single load-testing run.
const maxBots = 1000

type config struct {
	n          int
	url        string
	duration   time.Duration
	ramp       time.Duration
	prefix     string
	seed       uint64
	scenario   scenario
	worldPath  string
	metricsURL string
	reportPath string
	minGap     time.Duration
	// requireMetrics fails the run when /metrics cannot be read (loadtest.sh started
	// the server itself, so the server numbers must be there).
	requireMetrics bool
}

func main() {
	var c config
	scName := flag.String("scenario", "base", "base (spread over the island) or stress (packed in the town)")
	flag.IntVar(&c.n, "n", 10, "number of bots to run")
	flag.StringVar(&c.url, "url", "http://localhost:8080", "game server base URL")
	flag.DurationVar(&c.duration, "duration", 30*time.Second, "steady window: how long all bots play together")
	flag.DurationVar(&c.ramp, "ramp", -1, "time over which bots enter (default 200 ms per bot, at most 60 s)")
	flag.StringVar(&c.prefix, "prefix", "load", "account prefix: bots reuse accounts with the same prefix")
	flag.Uint64Var(&c.seed, "seed", 1, "random seed of the bots' behaviour")
	flag.StringVar(&c.worldPath, "world", "../../build/world.bin", "compiled map for path planning (missing: bots walk at random)")
	flag.StringVar(&c.metricsURL, "metrics", "", "server's internal /metrics (default "+localMetricsURL+" when -url is on this machine; empty elsewhere: client-side numbers only)")
	flag.StringVar(&c.reportPath, "report", "", "write the JSON report here")
	flag.BoolVar(&c.requireMetrics, "require-metrics", false, "fail if the server's /metrics cannot be read")
	flag.DurationVar(&c.minGap, "min-gap", 250*time.Millisecond, "bot rate limit: minimum time between two commands of a bot")
	flag.Parse()

	if err := validateCount(c.n); err != nil {
		fmt.Fprintln(os.Stderr, "bots:", err)
		os.Exit(2)
	}
	metricsSet := false
	flag.Visit(func(fl *flag.Flag) { metricsSet = metricsSet || fl.Name == "metrics" })
	if !metricsSet && isLoopback(c.url) {
		c.metricsURL = localMetricsURL
	}
	if c.reportPath != "" {
		// Fail now, not after a 10-minute run.
		if st, err := os.Stat(filepath.Dir(c.reportPath)); err != nil || !st.IsDir() {
			fmt.Fprintf(os.Stderr, "bots: the directory of -report %s does not exist\n", c.reportPath)
			os.Exit(2)
		}
	}
	if err := checkPrefix(c.prefix, c.n); err != nil {
		fmt.Fprintln(os.Stderr, "bots:", err)
		os.Exit(2)
	}
	sc, err := scenarioByName(*scName)
	if err != nil {
		fmt.Fprintln(os.Stderr, "bots:", err)
		os.Exit(2)
	}
	c.scenario = sc
	if c.ramp < 0 {
		c.ramp = defaultRamp(c.n)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	rep := run(ctx, c)
	stop()
	rep.summary(os.Stdout)
	if c.reportPath != "" {
		raw, err := json.MarshalIndent(rep, "", "  ")
		if err != nil {
			fmt.Fprintln(os.Stderr, "bots: report:", err)
			os.Exit(1)
		}
		if err := os.WriteFile(c.reportPath, append(raw, '\n'), 0o644); err != nil {
			fmt.Fprintln(os.Stderr, "bots:", err)
			os.Exit(1)
		}
		fmt.Println("report:", c.reportPath)
	}
	if rep.FailedToEnter > 0 || rep.Disconnects > 0 || rep.OtherErrors > 0 {
		os.Exit(1)
	}
}

// localMetricsURL is the default -metrics-addr of a gameserver on this machine.
const localMetricsURL = "http://127.0.0.1:9100/metrics"

// isLoopback reports whether the server URL is on this machine, where the default
// metrics address belongs to it (and not to some other local server than the one tested).
func isLoopback(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	host := u.Hostname()
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func defaultRamp(n int) time.Duration {
	return min(time.Duration(n)*200*time.Millisecond, time.Minute)
}

// perAccount is how many bots share an account (the server's character limit): fewer
// logins, which the per-IP login limit would otherwise throttle.
const perAccount = 10

// fleet tracks the bots of a run.
type fleet struct {
	mu      sync.Mutex
	bots    []*bot.Bot
	rep     *Report
	acts    actions
	entered sync.WaitGroup // one per bot: done when it entered or failed to
}

func (f *fleet) fail(i int, err error, entered bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	msg := fmt.Sprintf("bot %d: %v", i, err)
	fmt.Fprintln(os.Stderr, msg)
	if len(f.rep.Errors) < 20 {
		f.rep.Errors = append(f.rep.Errors, msg)
	}
	if !entered {
		f.rep.FailedToEnter++
		return
	}
	if errors.Is(err, errDisconnected) {
		f.rep.Disconnects++
		reason := strings.TrimPrefix(err.Error(), errDisconnected.Error()+": ")
		if reason == "" {
			reason = "CONNECTION_LOST"
		}
		if f.rep.DisconnectReason == nil {
			f.rep.DisconnectReason = map[string]int{}
		}
		f.rep.DisconnectReason[reason]++
		return
	}
	f.rep.OtherErrors++
}

func run(ctx context.Context, c config) *Report {
	rep := &Report{Scenario: c.scenario.name, Bots: c.n, StartedAt: time.Now().UTC(), RampSeconds: c.ramp.Seconds(), MetricsURL: c.metricsURL}
	var nav *bot.Nav
	if _, err := os.Stat(c.worldPath); err == nil {
		if nav, err = bot.LoadNav(c.worldPath); err != nil {
			fmt.Fprintln(os.Stderr, "bots:", err)
		}
	} else {
		fmt.Fprintf(os.Stderr, "bots: no map at %s (make mapcompile): bots walk at random\n", c.worldPath)
	}

	f := &fleet{rep: rep}
	play, stopPlay := context.WithCancel(ctx)
	defer stopPlay()
	var all sync.WaitGroup
	start := time.Now()
	for g := 0; g*perAccount < c.n; g++ {
		first, last := g*perAccount, min((g+1)*perAccount, c.n)
		f.entered.Add(last - first)
		all.Add(1)
		go func() {
			defer all.Done()
			if sleep(play, time.Until(start.Add(rampAt(c, first)))) != nil {
				for range last - first {
					f.entered.Done()
				}
				return
			}
			lctx, cancel := context.WithTimeout(play, 5*time.Minute)
			defer cancel()
			email, password := account(c.prefix, g)
			token, err := bot.New(c.url).Login(lctx, email, password)
			if err != nil {
				for i := first; i < last; i++ {
					if play.Err() == nil { // not a failure when the run was interrupted
						f.fail(i, err, false)
					}
					f.entered.Done()
				}
				return
			}
			var bots sync.WaitGroup
			for i := first; i < last; i++ {
				bots.Add(1)
				go func() {
					defer bots.Done()
					runBot(play, c, f, nav, token, i, start.Add(rampAt(c, i)))
				}()
			}
			bots.Wait()
		}()
	}

	// Steady window: from the moment every bot is in (or failed) until -duration later.
	waitGroup(ctx, &f.entered)
	rep.Entered = len(f.snapshot())
	steadyStart := time.Now()
	// What the bots received counts from here, like the latency and the server numbers.
	base := map[*bot.Bot]bot.Stats{}
	for _, b := range f.snapshot() {
		b.TakeLatencies()
		base[b] = b.Stats()
	}
	samples := sampleMetrics(play, c.metricsURL, c.duration)

	var lat []time.Duration
	var bytes int
	for _, b := range f.snapshot() {
		lat = append(lat, b.TakeLatencies()...)
		s, b0 := b.Stats(), base[b]
		bytes += s.Bytes - b0.Bytes
		rep.Client.Steps += s.Moves - b0.Moves
		rep.Client.WalksRejected += s.Rejected - b0.Rejected
		rep.Client.DialogMessages += s.Dialogs - b0.Dialogs
		rep.Client.ChatReceived += s.Chat - b0.Chat
	}
	rep.SteadySeconds = time.Since(steadyStart).Seconds()
	stopPlay()
	all.Wait()

	rep.Client.LatencyMS = latencyPercentiles(lat)
	rep.Client.LatencySamples = len(lat)
	if rep.Entered > 0 && rep.SteadySeconds > 0 {
		rep.Client.BytesPerPlayer = num(round(float64(bytes) / rep.SteadySeconds / float64(rep.Entered)))
	} else {
		rep.Client.BytesPerPlayer = nan
	}
	rep.Client.Actions = f.acts
	if len(samples) >= 2 {
		rep.Server = serverReport(samples[0], samples[len(samples)-1], samples)
	} else if c.metricsURL != "" {
		msg := fmt.Sprintf("could not read %s: no server numbers in the report", c.metricsURL)
		fmt.Fprintln(os.Stderr, "bots:", msg)
		if c.requireMetrics {
			rep.Errors = append(rep.Errors, msg)
			rep.OtherErrors++
		}
	}
	rep.checks()
	return rep
}

// rampAt is when bot i enters, relative to the start.
func rampAt(c config, i int) time.Duration {
	return time.Duration(int64(c.ramp) * int64(i) / int64(c.n))
}

func (f *fleet) snapshot() []*bot.Bot {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]*bot.Bot(nil), f.bots...)
}

// runBot enters bot i at time `at` and plays until ctx ends.
func runBot(ctx context.Context, c config, f *fleet, nav *bot.Nav, token string, i int, at time.Time) {
	b := bot.New(c.url)
	defer b.Close()
	entered := false
	enter := func() {
		if !entered {
			entered = true
			f.entered.Done()
		}
	}
	defer enter()
	if err := sleep(ctx, time.Until(at)); err != nil {
		return
	}
	ectx, cancel := context.WithTimeout(ctx, time.Minute)
	err := b.Play(ectx, token, name(c.prefix, i), "guardian")
	cancel()
	if err != nil {
		if ctx.Err() == nil {
			f.fail(i, err, false)
		}
		return
	}
	f.mu.Lock()
	f.bots = append(f.bots, b)
	f.mu.Unlock()
	enter()

	p := &player{
		b: b, nav: nav, sc: c.scenario, home: c.scenario.areaFor(i),
		r:    rand.New(rand.NewPCG(c.seed, uint64(i))),
		pace: pacer{minGap: c.minGap, now: time.Now},
	}
	err = p.run(ctx)
	f.mu.Lock()
	f.acts.add(p.acts)
	f.mu.Unlock()
	if err != nil {
		f.fail(i, err, true)
		return
	}
	lctx, lcancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer lcancel()
	if err := b.Logout(lctx); err != nil {
		f.fail(i, fmt.Errorf("logout: %w", err), true)
	}
}

// sampleMetrics scrapes the server's metrics every few seconds for d. It returns the
// samples (empty without a URL or a reachable server).
func sampleMetrics(ctx context.Context, url string, d time.Duration) []sample {
	end := time.Now().Add(d)
	var out []sample
	for {
		if url != "" {
			if s, err := scrape(ctx, url); err == nil {
				out = append(out, s)
			}
		}
		left := time.Until(end)
		if left <= 0 || ctx.Err() != nil {
			return out
		}
		if sleep(ctx, min(left, 5*time.Second)) != nil {
			return out
		}
	}
}

func waitGroup(ctx context.Context, wg *sync.WaitGroup) {
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-ctx.Done():
	}
}

// account returns the credentials of account g (bots g*10 .. g*10+9). The domain is
// new in T1.17, so accounts that the T1.4 bot filled with its own characters
// ("load-0@bots.local") are never reused and do not hit the character limit.
func account(prefix string, g int) (email, password string) {
	return fmt.Sprintf("%s-%d@load.bots.local", prefix, g), "bot-password"
}

// validPrefix is what -prefix accepts: the second word of every name and the start of
// every email. Letters only, so prefixes cannot fold into the same names ("load100" and
// "load300" would both be "Load").
var validPrefix = regexp.MustCompile(`^[a-z]{2,12}$`)

// name returns bot i's character name: "Bot" plus i in base 26 ("Botaa", "Botab", ...
// "Botba"), then the prefix as a second word ("Botaa Load"), so runs with different
// prefixes do not collide on the global names. The prefix must be valid (checkPrefix).
func name(prefix string, i int) string {
	s := []byte{byte('a' + i%26)}
	i /= 26
	for {
		s = append([]byte{byte('a' + i%26)}, s...)
		i /= 26
		if i == 0 {
			break
		}
	}
	return "Bot" + string(s) + " " + strings.ToUpper(prefix[:1]) + prefix[1:]
}

// The server's reserved name rules (server/internal/auth/validate.go, which tools/bots
// cannot import): parts are matched in the lowercased name without spaces, words as
// whole words. Keep them in sync.
var (
	reservedNameParts = []string{
		"admin", "gamemaster", "moderat", "moderad", "soporte", "support",
		"staff", "tutor", "sistema", "system", "official", "oficial",
	}
	reservedNameWords = map[string]bool{"gm": true, "cm": true, "god": true, "mod": true, "dev": true}
)

// reservedName reports whether the server would refuse name as posing as staff.
func reservedName(name string) bool {
	words := strings.Split(strings.ToLower(name), " ")
	joined := strings.Join(words, "")
	for _, part := range reservedNameParts {
		if strings.Contains(joined, part) {
			return true
		}
	}
	for _, w := range words {
		if reservedNameWords[w] {
			return true
		}
	}
	return false
}

// checkPrefix rejects a prefix that is not 2-12 lowercase letters or that gives one of
// the first n bots a name the server refuses ("dev"; "mine" gives "Botad Mine", which
// contains "admin").
func checkPrefix(prefix string, n int) error {
	if !validPrefix.MatchString(prefix) {
		return fmt.Errorf("prefix must be 2-12 lowercase letters (a-z), got %q", prefix)
	}
	for i := range n {
		if nm := name(prefix, i); reservedName(nm) {
			return fmt.Errorf("prefix %q gives bot %d the name %q, which the server reserves for staff", prefix, i, nm)
		}
	}
	return nil
}

// validateCount checks that the requested number of bots is usable.
func validateCount(n int) error {
	if n < 1 || n > maxBots {
		return fmt.Errorf("n must be between 1 and %d, got %d", maxBots, n)
	}
	return nil
}
