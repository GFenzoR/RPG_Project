//go:build integration

package app_test

import (
	"context"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/app"
	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/store/storetest"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
	"github.com/GFenzoR/RPG_Project/server/pkg/bot"
)

// TestBotEntersAndWalks runs the whole server (Postgres, HTTP API, gateway, game loop
// on the real clock, persistence) and the bot from pkg/bot: register, create a
// character, POST /api/play, Hello, walk, see another player, log out, log in again at
// the saved position, and get saved at shutdown.
func TestBotEntersAndWalks(t *testing.T) {
	st := storetest.Open(t, "it_app", true)
	data := filepath.Join("..", "..", "..", "data")
	vocations, err := content.LoadVocations(data)
	if err != nil {
		t.Fatal(err)
	}
	balance, err := content.LoadBalance(data)
	if err != nil {
		t.Fatal(err)
	}
	items, err := content.LoadItems(data)
	if err != nil {
		t.Fatal(err)
	}
	a, err := app.New(app.Config{
		Items:     items,
		Store:     st,
		Clock:     clock.Real{},
		Seed:      1,
		Vocations: vocations,
		Balance:   balance,
		Map:       worldtest.Map(t, 0, 0, 7, "................", "................", ".......T........", "................", "................"),
	})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(a.Handler())
	defer srv.Close()
	runCtx, stop := context.WithCancel(context.Background())
	runDone := make(chan error, 1)
	go func() { runDone <- a.Run(runCtx) }()
	defer func() {
		stop()
		if err := <-runDone; err != nil {
			t.Error(err)
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	accA := bot.Account{Email: "bot-a@bots.local", Password: "bot-password", Character: "Bot Ana", Vocation: "guardian"}
	b1 := bot.New(srv.URL)
	if err := b1.Enter(ctx, accA); err != nil {
		t.Fatal(err)
	}
	start := b1.Pos()
	if start != (bot.Pos{X: 7, Y: 2, Z: 7}) {
		t.Fatalf("new character at %v, want the temple", start)
	}
	if err := b1.WalkPath(ctx, []bot.Direction{bot.East, bot.East, bot.SouthEast}); err != nil {
		t.Fatal(err)
	}
	if err := b1.WaitMoves(ctx, 3); err != nil {
		t.Fatal(err)
	}
	if got := b1.Pos(); got != (bot.Pos{X: 10, Y: 3, Z: 7}) {
		t.Fatalf("after walking at %v", got)
	}

	b2 := bot.New(srv.URL)
	if err := b2.Enter(ctx, bot.Account{Email: "bot-b@bots.local", Password: "bot-password", Character: "Bot Bea", Vocation: "arcanist"}); err != nil {
		t.Fatal(err)
	}
	waitStat(ctx, t, b1, func(s bot.Stats) bool { return s.Appear >= 1 })

	if err := b1.Logout(ctx); err != nil {
		t.Fatal(err)
	}
	waitStat(ctx, t, b2, func(s bot.Stats) bool { return s.Disappear >= 1 })

	// The final save reaches Postgres shortly after the logout.
	deadline := wall.Now().Add(5 * time.Second)
	for {
		c, err := st.PlayCharacter(ctx, 1, 1, wall.Now())
		if err != nil {
			t.Fatal(err)
		}
		if c.HasPos && c.X == 10 && c.Y == 3 && c.Z == 7 {
			// A character that never played got the starting backpack, saved with it.
			if len(c.Inventory) != 1 || c.Inventory[0].Slot != 3 || c.Inventory[0].ItemID != int(items[balance.Inventory.StartContainer].Numeric) {
				t.Fatalf("saved inventory %+v", c.Inventory)
			}
			break
		}
		if wall.Now().After(deadline) {
			t.Fatalf("saved character %+v", c)
		}
		<-wall.After(20 * time.Millisecond)
	}

	again := bot.New(srv.URL)
	if err := again.Enter(ctx, accA); err != nil {
		t.Fatal(err)
	}
	if got := again.Pos(); got != (bot.Pos{X: 10, Y: 3, Z: 7}) {
		t.Fatalf("re-login at %v, want the saved 10,3,7", got)
	}

	// b2 walks, then the server shuts down: Run saves it and closes the sockets.
	if err := b2.WalkPath(ctx, []bot.Direction{bot.West}); err != nil {
		t.Fatal(err)
	}
	if err := b2.WaitMoves(ctx, 1); err != nil {
		t.Fatal(err)
	}
	want := b2.Pos()
	stop()
	if err := <-runDone; err != nil {
		t.Fatal(err)
	}
	runDone <- nil
	select {
	case <-b2.Done():
	case <-ctx.Done():
		t.Fatal("b2 still connected after shutdown")
	}
	if got := b2.Disconnected(); got != "SERVER_SHUTDOWN" {
		t.Fatalf("b2 disconnected with %q", got)
	}
	c, err := st.PlayCharacter(ctx, 2, 2, wall.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !c.HasPos || c.X != want.X || c.Y != want.Y {
		t.Fatalf("shutdown save %+v, want %v", c, want)
	}
}

func waitStat(ctx context.Context, t *testing.T, b *bot.Bot, cond func(bot.Stats) bool) {
	t.Helper()
	for !cond(b.Stats()) {
		select {
		case <-ctx.Done():
			t.Fatalf("stats %+v", b.Stats())
		case <-wall.After(10 * time.Millisecond):
		}
	}
}

var wall clock.Clock = clock.Real{}
