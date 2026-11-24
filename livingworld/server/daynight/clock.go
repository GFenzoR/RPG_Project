// Package daynight is the living world's clock (livingworld/README.md "Día y noche"): a
// day of data/livingworld/daynight.yaml's day_minutes (dawn and dusk are its first and last
// minutes) followed by a night of night_minutes, and a moon whose phase changes once a day
// over lunar_days days. The time of day is shared world state, so the server owns it: the
// game loop keeps one Clock, sends every player the world time at login and every
// sync_seconds (and at once after a staff change), and the client interpolates between
// them and draws the sky, the light and the shadows. Nothing in the game rules reads it.
//
// Every method runs on the game loop goroutine: no locks, no wall clock (time is the tick
// number the loop passes; the start comes from the server's injected clock), no I/O. The
// package never imports server/: the glue is server/internal/session/daynight.go.
package daynight

import (
	"bytes"
	"errors"
	"fmt"
	"os"

	"go.yaml.in/yaml/v3"
)

// Cycle is the `cycle` block of data/livingworld/daynight.yaml (schema
// livingworld-daynight.schema.json), the part the server reads.
type Cycle struct {
	// DayMinutes and NightMinutes are the real minutes of the day and of the night.
	DayMinutes   int `yaml:"day_minutes"`
	NightMinutes int `yaml:"night_minutes"`
	// DawnMinutes and DuskMinutes: the first and last minutes of the day, the smooth
	// transitions from and to the night.
	DawnMinutes int `yaml:"dawn_minutes"`
	DuskMinutes int `yaml:"dusk_minutes"`
	// LunarDays is how many days the moon takes from new to new (phase 0 new,
	// LunarDays/2 full).
	LunarDays int `yaml:"lunar_days"`
	// SyncSeconds is how often every player is sent the world time again.
	SyncSeconds int `yaml:"sync_seconds"`
}

// Config is data/livingworld/daynight.yaml. Sky is the client's block (colours, the
// brightness floor, shadow strengths): the server keeps it opaque.
type Config struct {
	Cycle Cycle     `yaml:"cycle"`
	Sky   yaml.Node `yaml:"sky"`
}

// ParseConfig decodes data/livingworld/daynight.yaml and checks its cycle.
func ParseConfig(raw []byte) (Cycle, error) {
	var c Config
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	dec.KnownFields(true)
	if err := dec.Decode(&c); err != nil {
		return Cycle{}, fmt.Errorf("decode day and night: %w", err)
	}
	if err := c.Cycle.Check(); err != nil {
		return Cycle{}, err
	}
	return c.Cycle, nil
}

// LoadConfig reads and checks the file at path.
func LoadConfig(path string) (Cycle, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return Cycle{}, fmt.Errorf("read day and night: %w", err)
	}
	c, err := ParseConfig(raw)
	if err != nil {
		return Cycle{}, fmt.Errorf("%s: %w", path, err)
	}
	return c, nil
}

// Check reports a cycle the Clock cannot run with.
func (c Cycle) Check() error {
	switch {
	case c.DayMinutes < 1 || c.NightMinutes < 1:
		return errors.New("day and night: day_minutes and night_minutes must be >= 1")
	case c.DayMinutes+c.NightMinutes > 24*60:
		return errors.New("day and night: a cycle lasts at most 24 hours")
	case c.DawnMinutes < 0 || c.DuskMinutes < 0 || c.DawnMinutes+c.DuskMinutes > c.DayMinutes:
		return errors.New("day and night: dawn_minutes and dusk_minutes must fit in the day")
	case c.LunarDays < 2:
		return errors.New("day and night: lunar_days must be >= 2")
	case c.SyncSeconds < 1:
		return errors.New("day and night: sync_seconds must be >= 1")
	}
	return nil
}

const minuteMs = 60_000

// DayMs is the day's length in milliseconds (dawn and dusk included).
func (c Cycle) DayMs() int64 { return int64(c.DayMinutes) * minuteMs }

// NightMs is the night's length in milliseconds.
func (c Cycle) NightMs() int64 { return int64(c.NightMinutes) * minuteMs }

// DawnMs is the dawn's length in milliseconds (the start of the day).
func (c Cycle) DawnMs() int64 { return int64(c.DawnMinutes) * minuteMs }

// DuskMs is the dusk's length in milliseconds (the end of the day).
func (c Cycle) DuskMs() int64 { return int64(c.DuskMinutes) * minuteMs }

// CycleMs is a whole day and night in milliseconds.
func (c Cycle) CycleMs() int64 { return c.DayMs() + c.NightMs() }

// Phase is the part of the cycle.
type Phase uint8

// The phases, in the cycle's order.
const (
	Dawn Phase = iota
	Day
	Dusk
	Night
)

// String is the phase's name (staff messages pick their text by it).
func (p Phase) String() string {
	switch p {
	case Dawn:
		return "dawn"
	case Day:
		return "day"
	case Dusk:
		return "dusk"
	default:
		return "night"
	}
}

// Time is a moment of the world: the day since the world's epoch and how far into it.
type Time struct {
	// Day counts cycles since the epoch (the moon follows it).
	Day int64
	// CycleMs is how far into the cycle: 0 is the start of dawn, DayMs the start of night.
	CycleMs int64
	// Rate is world milliseconds per real millisecond (0: stopped by staff, 1: normal).
	Rate int64
}

// Phase is the part of the cycle t is in.
func (c Cycle) Phase(t Time) Phase {
	switch {
	case t.CycleMs >= c.DayMs():
		return Night
	case t.CycleMs < c.DawnMs():
		return Dawn
	case t.CycleMs >= c.DayMs()-c.DuskMs():
		return Dusk
	default:
		return Day
	}
}

// MoonPhase is the phase of the moon in the sky at t: 0 new moon, LunarDays/2 full moon.
// It is t's day's moon, except at dawn: a night belongs to the day it fell on, so the
// dawn after it still has that day's moon (day - 1), as the client draws it
// (livingworld/client/src/sky.ts skyAt). How bright it is, the client works out.
func (c Cycle) MoonPhase(t Time) int {
	day := t.Day
	if c.Phase(t) == Dawn {
		day--
	}
	return int(floorMod(day, int64(c.LunarDays)))
}

// MaxRate caps a staff speed-up (a day in a few seconds would only flicker).
const MaxRate = 600

// Clock is the world's time. The world time is a number of milliseconds that runs at Rate
// world ms per real ms from an anchor: (anchorMs at tick anchorTick).
type Clock struct {
	c          Cycle
	tickMs     int64
	anchorMs   int64
	anchorTick int64
	rate       int64
	syncTicks  int64
	nextSync   int64
	changed    bool
}

// New starts a clock whose world time at tick 0 is epochMs (the server passes its clock's
// Unix time at start: the cycle then goes on across restarts, the same for every server).
func New(c Cycle, tickMs int, epochMs int64) *Clock {
	tm := int64(max(tickMs, 1))
	sync := max(int64(c.SyncSeconds)*1000/tm, 1)
	// The first sync is one interval in: a player that joins gets the time with its login.
	return &Clock{c: c, tickMs: tm, anchorMs: epochMs, rate: 1, syncTicks: sync, nextSync: sync}
}

// Frozen makes a new clock start stopped (rate 0) without a sync of its own: the E2E
// server's fixed time (-world-time). Call it before the first tick.
func (k *Clock) Frozen() *Clock {
	k.rate = 0
	return k
}

// Cycle is the clock's cycle.
func (k *Clock) Cycle() Cycle { return k.c }

// WorldMs is the world time at tick.
func (k *Clock) WorldMs(tick int64) int64 {
	return k.anchorMs + (tick-k.anchorTick)*k.tickMs*k.rate
}

// At is the moment of the world at tick.
func (k *Clock) At(tick int64) Time {
	ms := k.WorldMs(tick)
	cycle := k.c.CycleMs()
	day := floorDiv(ms, cycle)
	return Time{Day: day, CycleMs: ms - day*cycle, Rate: k.rate}
}

// reanchor makes tick the anchor, keeping the world time it has.
func (k *Clock) reanchor(tick int64) {
	k.anchorMs = k.WorldMs(tick)
	k.anchorTick = tick
	k.changed = true
}

// Set moves the time of day to cycleMs (wrapped into the cycle), on the same day.
func (k *Clock) Set(tick, cycleMs int64) {
	k.reanchor(tick)
	t := k.At(tick)
	k.anchorMs = t.Day*k.c.CycleMs() + floorMod(cycleMs, k.c.CycleMs())
}

// SetMoon moves to the nearest day (this one or a later one) whose moon phase is phase,
// keeping the time of day.
func (k *Clock) SetMoon(tick int64, phase int) {
	k.reanchor(tick)
	t := k.At(tick)
	ahead := floorMod(int64(phase)-int64(k.c.MoonPhase(t)), int64(k.c.LunarDays))
	k.anchorMs += ahead * k.c.CycleMs()
}

// SetRate makes the world time run at rate world ms per real ms from tick on (0 stops it;
// clamped to 0..MaxRate).
func (k *Clock) SetRate(tick, rate int64) {
	k.reanchor(tick)
	k.rate = min(max(rate, 0), MaxRate)
}

// SyncDue reports whether the players are due the world time at tick: every sync_seconds,
// and at once after a Set, SetMoon or SetRate.
func (k *Clock) SyncDue(tick int64) bool {
	if !k.changed && tick < k.nextSync {
		return false
	}
	k.changed = false
	k.nextSync = tick + k.syncTicks
	return true
}

// PhaseStart is the cycle position staff names by word: dawn (mid-dawn), morning (a
// quarter of the day), noon, afternoon (three quarters), dusk (mid-dusk), night and
// midnight (mid-night). ok is false for any other word.
func (c Cycle) PhaseStart(word string) (cycleMs int64, ok bool) {
	day := c.DayMs()
	switch word {
	case "dawn":
		return c.DawnMs() / 2, true
	case "morning":
		return day / 4, true
	case "noon", "day":
		return day / 2, true
	case "afternoon":
		return day * 3 / 4, true
	case "dusk":
		return day - c.DuskMs()/2, true
	case "night", "midnight":
		return day + c.NightMs()/2, true
	}
	return 0, false
}

func floorDiv(a, b int64) int64 {
	q := a / b
	if (a%b != 0) && ((a < 0) != (b < 0)) {
		q--
	}
	return q
}

func floorMod(a, b int64) int64 { return a - floorDiv(a, b)*b }
