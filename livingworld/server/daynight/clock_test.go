package daynight

import (
	"math"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// cycle is the owner's decision: 180 minutes of day, 60 of night, 15 of dawn and dusk.
var cycle = Cycle{DayMinutes: 180, NightMinutes: 60, DawnMinutes: 15, DuskMinutes: 15, LunarDays: 8, SyncSeconds: 60}

const tickMs = 50

// ticks is how many ticks make ms.
func ticks(ms int64) int64 { return ms / tickMs }

func TestRepoConfigIsTheOwnersCycle(t *testing.T) {
	_, file, _, _ := runtime.Caller(0)
	path := filepath.Join(filepath.Dir(file), "..", "..", "..", "data", "livingworld", "daynight.yaml")
	c, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if c.DayMinutes != 180 || c.NightMinutes != 60 || c.CycleMs() != 240*60_000 {
		t.Fatalf("data/livingworld/daynight.yaml: day %d night %d, want 180 and 60 (owner decision)", c.DayMinutes, c.NightMinutes)
	}
	if c.DawnMinutes <= 0 || c.DuskMinutes <= 0 || c.LunarDays < 2 {
		t.Fatalf("dawn %d dusk %d lunar %d", c.DawnMinutes, c.DuskMinutes, c.LunarDays)
	}
}

func TestParseConfigRejects(t *testing.T) {
	for name, raw := range map[string]string{
		"unknown key":  "cycle: {day_minutes: 1, night_minutes: 1, dawn_minutes: 0, dusk_minutes: 0, lunar_days: 2, sync_seconds: 1, hours: 3}\nsky: {}",
		"no night":     "cycle: {day_minutes: 10, night_minutes: 0, dawn_minutes: 0, dusk_minutes: 0, lunar_days: 2, sync_seconds: 1}",
		"dawn too big": "cycle: {day_minutes: 10, night_minutes: 5, dawn_minutes: 6, dusk_minutes: 6, lunar_days: 2, sync_seconds: 1}",
		"no moon":      "cycle: {day_minutes: 10, night_minutes: 5, dawn_minutes: 1, dusk_minutes: 1, lunar_days: 1, sync_seconds: 1}",
		"no sync":      "cycle: {day_minutes: 10, night_minutes: 5, dawn_minutes: 1, dusk_minutes: 1, lunar_days: 4, sync_seconds: 0}",
	} {
		if _, err := ParseConfig([]byte(raw)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// The sky block is the client's: any keys.
	if _, err := ParseConfig([]byte("cycle: {day_minutes: 10, night_minutes: 5, dawn_minutes: 1, dusk_minutes: 1, lunar_days: 4, sync_seconds: 1}\nsky: {anything: 1}")); err != nil {
		t.Fatal(err)
	}
}

func TestLoadConfigMissingFile(t *testing.T) {
	_, err := LoadConfig(filepath.Join(t.TempDir(), "none.yaml"))
	if err == nil || !os.IsNotExist(unwrapAll(err)) {
		t.Fatalf("err = %v, want a not-exist error", err)
	}
}

func unwrapAll(err error) error {
	for {
		u, ok := err.(interface{ Unwrap() error })
		if !ok {
			return err
		}
		err = u.Unwrap()
	}
}

func TestCycleAndPhases(t *testing.T) {
	k := New(cycle, tickMs, 0)
	min := func(m int64) int64 { return ticks(m * 60_000) }
	for _, c := range []struct {
		at    int64
		phase Phase
	}{
		{0, Dawn}, {min(14), Dawn}, {min(15), Day}, {min(90), Day}, {min(164), Day},
		{min(165), Dusk}, {min(179), Dusk}, {min(180), Night}, {min(239), Night},
		{min(240), Dawn}, // the next day
	} {
		if got := cycle.Phase(k.At(c.at)); got != c.phase {
			t.Errorf("minute %d: %v, want %v", c.at*tickMs/60_000, got, c.phase)
		}
	}
	if d := k.At(min(240)).Day; d != 1 {
		t.Fatalf("day after one cycle = %d, want 1", d)
	}
	if p := k.At(min(250)).CycleMs; p != 10*60_000 {
		t.Fatalf("cycle position = %d", p)
	}
}

func TestEpochFromInjectedClock(t *testing.T) {
	// The world time at tick 0 is the epoch the server passes (its clock's Unix time):
	// 5 days and 200 minutes in, night of day 5.
	epoch := 5*cycle.CycleMs() + 200*60_000
	k := New(cycle, tickMs, epoch)
	tm := k.At(0)
	if tm.Day != 5 || tm.CycleMs != 200*60_000 || cycle.Phase(tm) != Night || tm.Rate != 1 {
		t.Fatalf("At(0) = %+v", tm)
	}
	// Deterministic: the same ticks give the same time, whatever the wall clock does.
	if a, b := k.At(1234), New(cycle, tickMs, epoch).At(1234); a != b {
		t.Fatalf("%+v != %+v", a, b)
	}
}

func TestMoonPhases(t *testing.T) {
	if l := cycle.MoonLight(Time{Day: 0}); l != 0 {
		t.Fatalf("new moon light %v", l)
	}
	if l := cycle.MoonLight(Time{Day: 4}); math.Abs(l-1) > 1e-9 {
		t.Fatalf("full moon light %v", l)
	}
	if a, b := cycle.MoonLight(Time{Day: 2}), cycle.MoonLight(Time{Day: 6}); math.Abs(a-b) > 1e-9 || a <= 0 || a >= 1 {
		t.Fatalf("quarter moons %v %v", a, b)
	}
	if p := cycle.MoonPhase(Time{Day: 8}); p != 0 {
		t.Fatalf("phase after a lunar month = %d", p)
	}
	if p := cycle.MoonPhase(Time{Day: -1}); p != 7 {
		t.Fatalf("phase of day -1 = %d", p)
	}
}

func TestAdminSet(t *testing.T) {
	k := New(cycle, tickMs, 3*cycle.CycleMs()+10*60_000)
	k.SyncDue(0)
	noon, _ := cycle.PhaseStart("noon")
	k.Set(100, noon)
	tm := k.At(100)
	if tm.Day != 3 || tm.CycleMs != noon || cycle.Phase(tm) != Day {
		t.Fatalf("after set noon: %+v", tm)
	}
	if !k.SyncDue(100) {
		t.Fatal("a staff change is not synced at once")
	}
	if k.SyncDue(101) {
		t.Fatal("synced again right after")
	}
	// Time runs on from there.
	if got := k.At(100 + ticks(60_000)).CycleMs; got != noon+60_000 {
		t.Fatalf("a minute later: %d", got)
	}
	night, _ := cycle.PhaseStart("night")
	k.Set(200, night)
	if cycle.Phase(k.At(200)) != Night {
		t.Fatal("set night")
	}
	// The moon: the next day with a full moon, same time of day.
	k.SetMoon(300, 4)
	tm = k.At(300)
	if cycle.MoonPhase(tm) != 4 || tm.Day < 3 || cycle.Phase(tm) != Night {
		t.Fatalf("set full moon: %+v", tm)
	}
	day := tm.Day
	k.SetMoon(300, 4)
	if k.At(300).Day != day {
		t.Fatal("setting the moon it has moved the day")
	}
}

func TestAdminRate(t *testing.T) {
	k := New(cycle, tickMs, 0)
	k.SetRate(10, 0)
	if a, b := k.At(10), k.At(5000); a.CycleMs != b.CycleMs || b.Rate != 0 {
		t.Fatalf("stopped clock moved: %+v %+v", a, b)
	}
	k.SetRate(5000, 60)
	before := k.At(5000).CycleMs
	if got := k.At(5000 + ticks(1000)).CycleMs; got != before+60_000 {
		t.Fatalf("x60: a second is %d ms", got-before)
	}
	k.SetRate(6000, 1_000_000)
	if k.At(6000).Rate != MaxRate {
		t.Fatal("rate not clamped")
	}
	k.SetRate(6000, -3)
	if k.At(6000).Rate != 0 {
		t.Fatal("negative rate not clamped")
	}
}

func TestSyncEvery(t *testing.T) {
	k := New(cycle, tickMs, 0)
	if !k.SyncDue(0) {
		t.Fatal("first sync")
	}
	every := ticks(int64(cycle.SyncSeconds) * 1000)
	if k.SyncDue(every - 1) {
		t.Fatal("synced early")
	}
	if !k.SyncDue(every) {
		t.Fatal("not synced after sync_seconds")
	}
}

func TestPhaseStart(t *testing.T) {
	for _, w := range []string{"dawn", "morning", "noon", "day", "afternoon", "dusk", "night", "midnight"} {
		ms, ok := cycle.PhaseStart(w)
		if !ok || ms < 0 || ms >= cycle.CycleMs() {
			t.Errorf("%s: %d %v", w, ms, ok)
		}
		want := map[string]Phase{"dawn": Dawn, "dusk": Dusk, "night": Night, "midnight": Night}[w]
		if strings.Contains("dawn dusk night midnight", w) && cycle.Phase(Time{CycleMs: ms}) != want {
			t.Errorf("%s lands in %v", w, cycle.Phase(Time{CycleMs: ms}))
		}
	}
	if _, ok := cycle.PhaseStart("teatime"); ok {
		t.Fatal("unknown word accepted")
	}
}
