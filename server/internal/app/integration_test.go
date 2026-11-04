//go:build integration

package app_test

import (
	"context"
	"errors"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/app"
	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/metrics"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
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
	mets := metrics.New()
	a, err := app.New(app.Config{
		Metrics:   mets,
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

	// What tools/bots does: see the other player, measure a Ping, chat, and the server's
	// metrics count the connections, the ticks and the bytes sent.
	if ps := b1.Creatures(bot.KindPlayer); len(ps) != 1 || ps[0].ID != b2.CreatureID() || !b1.Sees(b2.CreatureID()) {
		t.Fatalf("b1 sees players %+v, want b2 (%d)", ps, b2.CreatureID())
	}
	if err := b1.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	waitStat(ctx, t, b1, func(s bot.Stats) bool { return s.Pongs >= 1 })
	if lat := b1.TakeLatencies(); len(lat) != 1 || lat[0] <= 0 || lat[0] > 5*time.Second {
		t.Fatalf("latencies %v", lat)
	}
	if err := b2.Say(ctx, "hello"); err != nil {
		t.Fatal(err)
	}
	waitStat(ctx, t, b1, func(s bot.Stats) bool { return s.Chat >= 1 })
	if got := gauge(t, mets, "ws_connections"); got != 2 {
		t.Fatalf("ws_connections = %v, want 2", got)
	}
	if got := gauge(t, mets, "ws_sent_bytes_total"); got <= 0 {
		t.Fatalf("ws_sent_bytes_total = %v", got)
	}

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

// gauge returns the value of a gauge or counter without labels.
func gauge(t *testing.T, m *metrics.Metrics, name string) float64 {
	t.Helper()
	fams, err := m.Registry().Gather()
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range fams {
		if f.GetName() != name {
			continue
		}
		mt := f.GetMetric()[0]
		if mt.GetGauge() != nil {
			return mt.GetGauge().GetValue()
		}
		return mt.GetCounter().GetValue()
	}
	t.Fatalf("no metric %s", name)
	return 0
}

// TestStaffBan runs a GM's commands on the whole stack (T2.6): the role comes from the
// database at login, a ban disconnects the online player with BANNED and refuses its
// next login, and every command lands in the audit log.
func TestStaffBan(t *testing.T) {
	st := storetest.Open(t, "it_app_staff", true)
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
		Store: st, Clock: clock.Real{}, Seed: 1, Vocations: vocations, Balance: balance, Items: items,
		Map: worldtest.Map(t, 0, 0, 7, "................", ".......T........", "................"),
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
	wall := clock.Real{}

	gm := bot.New(srv.URL)
	token, err := gm.Login(ctx, "gm@bots.local", "bot-password")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := st.SetRole(ctx, "gm@bots.local", store.RoleGM, store.AuditEntry{At: wall.Now(), Source: store.AuditCLI, ActorName: "cli:test"}); err != nil {
		t.Fatal(err)
	}
	if err := gm.Play(ctx, token, "Warden", "guardian"); err != nil {
		t.Fatal(err)
	}
	victim := bot.Account{Email: "pl@bots.local", Password: "bot-password", Character: "Bot Pia", Vocation: "guardian"}
	pl := bot.New(srv.URL)
	if err := pl.Enter(ctx, victim); err != nil {
		t.Fatal(err)
	}
	// The player cannot run staff commands: nothing happens to the GM.
	if err := pl.Say(ctx, "/ban Warden 1d no"); err != nil {
		t.Fatal(err)
	}
	if err := gm.Say(ctx, "/ban bot pia 1d botting"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-pl.Done():
	case <-ctx.Done():
		t.Fatal("banned player still connected")
	}
	if got := pl.Disconnected(); got != "BANNED" {
		t.Fatalf("player disconnected with %q", got)
	}
	_, err = bot.New(srv.URL).Login(ctx, victim.Email, victim.Password)
	var apiErr *bot.APIError
	if !errors.As(err, &apiErr) || apiErr.Status != 403 || apiErr.Code != "account_banned" {
		t.Fatalf("login of the banned account: %v", err)
	}
	select {
	case <-gm.Done():
		t.Fatalf("GM disconnected (%s)", gm.Disconnected())
	default:
	}

	// The audit log has the role change and the ban, written outside the tick.
	deadline := wall.Now().Add(5 * time.Second)
	for {
		es, err := st.ListAudit(ctx, 10)
		if err != nil {
			t.Fatal(err)
		}
		if len(es) == 2 && es[0].Action == "ban" && es[0].Result == "ok" && es[0].TargetName == "Bot Pia" &&
			es[0].ActorName == "Warden" && es[0].Args["reason"] == "botting" && es[1].Action == "set_role" {
			break
		}
		if wall.Now().After(deadline) {
			t.Fatalf("audit log %+v", es)
		}
		<-wall.After(20 * time.Millisecond)
	}
}
