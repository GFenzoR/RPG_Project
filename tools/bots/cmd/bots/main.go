// Command bots runs headless clients (server/pkg/bot) against a running game server:
// each bot registers, creates a character, enters the world and walks at random.
//
//	make run-server              # in another terminal
//	make bots N=20 DURATION=30s
//
// This is the minimal bot of T1.4; the load-test scenarios and report arrive in T1.17.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"math/rand/v2"
	"os"
	"os/signal"
	"sync"
	"time"

	"github.com/GFenzoR/RPG_Project/server/pkg/bot"
)

// maxBots caps a single load-testing run.
const maxBots = 1000

func main() {
	n := flag.Int("n", 10, "number of bots to run")
	url := flag.String("url", "http://localhost:8080", "game server base URL")
	duration := flag.Duration("duration", 30*time.Second, "how long each bot walks")
	prefix := flag.String("prefix", "load", "account prefix: bots reuse accounts with the same prefix")
	seed := flag.Uint64("seed", 1, "random seed of the walks")
	flag.Parse()

	if err := validateCount(*n); err != nil {
		fmt.Fprintln(os.Stderr, "bots:", err)
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	total, failed := run(ctx, *url, *n, *duration, *prefix, *seed)
	stop()
	fmt.Printf("bots: %d bots, %d failed; steps %d, rejected %d, batches %d, bytes %d\n",
		*n, failed, total.Moves, total.Rejected, total.Batches, total.Bytes)
	if failed > 0 {
		os.Exit(1)
	}
}

// perAccount is how many bots share an account (the server's character limit): fewer
// logins, which the per-IP login limit would otherwise throttle.
const perAccount = 10

func run(ctx context.Context, url string, n int, d time.Duration, prefix string, seed uint64) (bot.Stats, int) {
	var (
		mu     sync.Mutex
		total  bot.Stats
		failed int
		wg     sync.WaitGroup
	)
	report := func(i int, s bot.Stats, err error) {
		mu.Lock()
		defer mu.Unlock()
		if err != nil {
			fmt.Fprintf(os.Stderr, "bot %d: %v\n", i, err)
			failed++
		}
		total.Moves += s.Moves
		total.Rejected += s.Rejected
		total.Batches += s.Batches
		total.Bytes += s.Bytes
	}
	for g := 0; g*perAccount < n; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			first, last := g*perAccount, min((g+1)*perAccount, n)
			lctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
			defer cancel()
			email, password := account(prefix, g)
			token, err := bot.New(url).Login(lctx, email, password)
			if err != nil {
				for i := first; i < last; i++ {
					report(i, bot.Stats{}, err)
				}
				return
			}
			var bots sync.WaitGroup
			for i := first; i < last; i++ {
				bots.Add(1)
				go func() {
					defer bots.Done()
					s, err := walkOne(ctx, url, token, i, d, rand.New(rand.NewPCG(seed, uint64(i))))
					report(i, s, err)
				}()
			}
			bots.Wait()
		}()
	}
	wg.Wait()
	return total, failed
}

func walkOne(ctx context.Context, url, token string, i int, d time.Duration, r *rand.Rand) (bot.Stats, error) {
	b := bot.New(url)
	defer b.Close()
	ectx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := b.Play(ectx, token, name(i), "guardian"); err != nil {
		return bot.Stats{}, err
	}
	end := time.Now().Add(d)
	for time.Now().Before(end) && ctx.Err() == nil {
		steps := make([]bot.Direction, 1+r.IntN(8))
		for j := range steps {
			steps[j] = bot.Direction(r.IntN(8))
		}
		if err := b.WalkPath(ctx, steps); err != nil {
			return b.Stats(), err
		}
		select {
		case <-ctx.Done():
		case <-b.Done():
			return b.Stats(), errors.New("disconnected: " + b.Disconnected())
		case <-time.After(time.Duration(500+r.IntN(1500)) * time.Millisecond):
		}
	}
	lctx, lcancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer lcancel()
	return b.Stats(), b.Logout(lctx)
}

// account returns the credentials of account g (bots g*10 .. g*10+9).
func account(prefix string, g int) (email, password string) {
	return fmt.Sprintf("%s-%d@bots.local", prefix, g), "bot-password"
}

// name returns bot i's character name: one capitalized word of letters, "Bot" and i in
// base 26 ("Botaa", "Botab", ... "Botba"). A single word cannot be one of the staff
// words the server refuses (Gm, Cm, Mod...). Names are global, so a second -prefix only
// gets fresh names on a fresh database.
func name(i int) string {
	s := []byte{byte('a' + i%26)}
	i /= 26
	for {
		s = append([]byte{byte('a' + i%26)}, s...)
		i /= 26
		if i == 0 {
			break
		}
	}
	return "Bot" + string(s)
}

// validateCount checks that the requested number of bots is usable.
func validateCount(n int) error {
	if n < 1 || n > maxBots {
		return fmt.Errorf("n must be between 1 and %d, got %d", maxBots, n)
	}
	return nil
}
