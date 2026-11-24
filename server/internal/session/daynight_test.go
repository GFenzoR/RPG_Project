package session_test

import (
	"slices"
	"testing"

	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
)

// Day and night (daynight.go, livingworld/README.md "Día y noche"): a player gets the world
// time at login, everyone gets it every sync_seconds and at once after a staff /time; the
// clock starts at the epoch the app passes and runs on the ticks.

// dayNight: the owner's 180 + 60 minute cycle, synced every 2 s.
func dayNight() *session.DayNightCycle {
	return &session.DayNightCycle{DayMinutes: 180, NightMinutes: 60, DawnMinutes: 15, DuskMinutes: 15, LunarDays: 8, SyncSeconds: 2}
}

const cycleMs = 240 * 60_000

func clocksOf(evs []*pb.ServerMessage) []*pb.WorldClock {
	return find(evs, (*pb.ServerMessage).GetWorldClock)
}

func TestWorldClockAtLoginAndOnSync(t *testing.T) {
	// Epoch: day 3, minute 100 (day).
	a := newAdminHarness(t, func(c *session.Config) {
		c.DayNight = dayNight()
		c.DayNightEpochMs = 3*cycleMs + 100*60_000
	})
	cl, _ := a.joinAs("Sun", session.RolePlayer, pos(2, 2))
	evs := cl.take()
	got := clocksOf(evs)
	if len(got) != 1 || got[0].GetDay() != 3 || got[0].GetRate() != 1 {
		t.Fatalf("login clocks %v", got)
	}
	if ms := got[0].GetCycleMs(); ms < 100*60_000 || ms > 100*60_000+1000 {
		t.Fatalf("login cycle_ms %d", ms)
	}
	// The Welcome comes first: the clock right after it.
	if evs[0].GetWelcome() == nil || evs[1].GetWorldClock() == nil {
		t.Fatalf("order: %T, %T", evs[0].GetMessage(), evs[1].GetMessage())
	}
	// Every 2 s (40 ticks) again, and the time ran on with the ticks.
	a.sim.RunTicks(40)
	got = clocksOf(cl.take())
	if len(got) != 1 {
		t.Fatalf("got %d syncs in 2 s, want 1", len(got))
	}
	tm, phase, ok := a.w.WorldTime(a.sim.Tick())
	if !ok || phase != "day" || tm.Day != 3 {
		t.Fatalf("world time %+v %s", tm, phase)
	}
}

func TestWorldClockOffWithoutData(t *testing.T) {
	a := newAdminHarness(t)
	cl, _ := a.joinAs("Nobody", session.RolePlayer, pos(2, 2))
	a.sim.RunTicks(100)
	if got := clocksOf(cl.take()); len(got) != 0 {
		t.Fatalf("clock without day and night: %v", got)
	}
	gm, _ := a.joinAs("Warden", session.RoleGM, pos(4, 4))
	if got := a.cmd(gm, "/time noon"); !slices.Equal(got, []string{"gm.usage"}) {
		t.Fatalf("/time without a cycle: %v", got)
	}
}

func TestStaffSetsTheTime(t *testing.T) {
	a := newAdminHarness(t, func(c *session.Config) { c.DayNight = dayNight() })
	gm, _ := a.joinAs("Warden", session.RoleGM, pos(2, 2))
	pl, _ := a.joinAs("Plain", session.RolePlayer, pos(5, 5))
	a.sim.RunTicks(5)
	pl.take()

	if got := a.cmd(gm, "/time night"); !slices.Equal(got, []string{"gm.time_night"}) {
		t.Fatalf("/time night: %v", got)
	}
	if aud := a.lastAudit(t); aud.Action != "set_time" || aud.Result != "ok" {
		t.Fatalf("audit %+v", aud)
	}
	// Everyone gets the new time at once.
	got := clocksOf(pl.take())
	if len(got) != 1 || got[0].GetCycleMs() < 180*60_000 {
		t.Fatalf("player clocks after /time night: %v", got)
	}
	if _, phase, _ := a.w.WorldTime(a.sim.Tick()); phase != "night" {
		t.Fatalf("phase %s", phase)
	}

	a.sim.RunTicks(40)
	if got := a.cmd(gm, "/time moon 4"); !slices.Equal(got, []string{"gm.time_night"}) {
		t.Fatalf("/time moon 4: %v", got)
	}
	if tm, _, _ := a.w.WorldTime(a.sim.Tick()); tm.Day%8 != 4 {
		t.Fatalf("moon day %d", tm.Day)
	}
	a.takeJobs()

	a.sim.RunTicks(40)
	if got := a.cmd(gm, "/time speed 0"); !slices.Equal(got, []string{"gm.time_night"}) {
		t.Fatalf("/time speed 0: %v", got)
	}
	before, _, _ := a.w.WorldTime(a.sim.Tick())
	a.sim.RunTicks(200)
	after, _, _ := a.w.WorldTime(a.sim.Tick())
	if before.CycleMs != after.CycleMs || after.Rate != 0 {
		t.Fatalf("stopped clock moved: %+v -> %+v", before, after)
	}
	a.takeJobs()

	a.sim.RunTicks(40)
	if got := a.cmd(gm, "/time 20"); !slices.Equal(got, []string{"gm.time_day"}) {
		t.Fatalf("/time 20: %v", got)
	}
	a.takeJobs()
	// Just telling the time is not audited.
	a.sim.RunTicks(40)
	if got := a.cmd(gm, "/time"); !slices.Equal(got, []string{"gm.time_day"}) {
		t.Fatalf("/time: %v", got)
	}
	if js := a.takeJobs(); len(js) != 0 {
		t.Fatalf("telling the time was audited: %+v", js)
	}
	for _, bad := range []string{"/time teatime", "/time moon 9", "/time speed 9999", "/time 240", "/time a b c"} {
		a.sim.RunTicks(40)
		if got := a.cmd(gm, bad); !slices.Equal(got, []string{"gm.usage"}) {
			t.Errorf("%q: %v", bad, got)
		}
	}

	// A player cannot.
	a.sim.RunTicks(40)
	if got := a.cmd(pl, "/time noon"); !slices.Equal(got, []string{"command.unknown"}) {
		t.Fatalf("player /time: %v", got)
	}
}
