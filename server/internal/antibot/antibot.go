// Package antibot holds the behaviour signals and the suspicion score of T4.1
// (docs/01-architecture.md "Trampas y anti-bot", docs/02-game-design.md "Anti-bot y
// anti-AFK"). It is pure: no clock, no randomness, no world. The game loop feeds a
// Tracker per character with times in milliseconds of game time (tick × 50) and asks
// for the signals once per evaluation; every update costs the same whatever the history.
//
// A signal is a number in [0, 1]: 0 is nothing unusual, 1 is as machine-like as the
// configuration says. The score adds the weighted signals at each evaluation and decays
// with a half-life, so a single odd minute fades and only a sustained pattern builds up.
package antibot

import (
	"math"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
)

// Signal indexes of Signals.
const (
	Regularity = iota // time between actions with too little variance
	Reaction          // heals a constant, inhumanly short time after a hit
	Route             // the same exact path walked again and again
	Session           // very long play without a pause
	Income            // experience or gold per hour far above peers of its level
	NumSignals
)

// Kinds of action, measured apart for the regularity: a script repeats one action on a
// beat even when other actions (heals answering hits) fall in between.
const (
	KindSpell = iota // a spell or a rune
	KindItem         // using or moving an item, gathering, crafting
	KindChat         // a chat line
	KindOther        // a target, an NPC, a shop, a presence answer
	NumKinds
)

// Names are the signal names (logs, audit, balance.yaml).
var Names = [NumSignals]string{"regularity", "reaction", "route", "session", "income"}

// Signals are the values of the signals, by index.
type Signals [NumSignals]float64

// ewma is an exponentially weighted mean and variance (West's update), constant cost.
type ewma struct {
	n        int
	mean, vr float64
}

func (e *ewma) add(x, alpha float64) {
	e.n++
	if e.n == 1 {
		e.mean, e.vr = x, 0
		return
	}
	d := x - e.mean
	e.mean += alpha * d
	e.vr = (1 - alpha) * (e.vr + alpha*d*d)
}

func (e *ewma) std() float64 { return math.Sqrt(max(e.vr, 0)) }

// alpha is the weight of a new sample in the running statistics (about the last 100).
const alpha = 0.02

// routeTable is how many recent route segments are remembered for repeats.
const routeTable = 128

// Tracker follows one character's behaviour.
type Tracker struct {
	lastAction int64           // ms of the last real action (0 = none yet)
	lastOf     [NumKinds]int64 // ms of the last action of each kind
	interval   [NumKinds]ewma  // ms between actions of each kind (pauses excluded)

	lastHurt int64 // ms of the last damage taken that no heal answered yet
	reaction ewma  // ms from a hit to the heal that answered it
	fast     ewma  // 1 if that reaction was faster than fast_ms, else 0

	steps    [32]uint64 // last steps (position and direction), a ring
	stepHead int
	stepN    int
	segments [routeTable]uint64 // hashes of recent segments of `segment` steps, a ring
	segHead  int
	segRep   ewma // 1 if a new segment repeats a remembered one, else 0

	activeSince int64 // ms since the play without a pause started
}

// Action records a real action of kind at ms. A gap of at least cfg.PauseMs since the
// last action is a pause: it restarts the continuous session, and since the last action
// of the same kind it is not an interval. paced marks an action that came as soon as its
// cooldown allowed (a held hotkey): the server set that pace, so it is no interval either.
func (t *Tracker) Action(ms int64, kind int, paced bool, cfg *content.AntiBot) {
	if t.lastAction == 0 || ms-t.lastAction >= int64(cfg.PauseMs) {
		t.activeSince = ms
	}
	t.lastAction = ms
	if kind < 0 || kind >= NumKinds {
		kind = KindOther
	}
	if last := t.lastOf[kind]; last > 0 && !paced {
		if gap := ms - last; gap > 0 && gap < int64(cfg.PauseMs) {
			t.interval[kind].add(float64(gap), alpha)
		}
	}
	t.lastOf[kind] = ms
}

// Active reports whether the character did something within cfg.PauseMs before ms.
func (t *Tracker) Active(ms int64, cfg *content.AntiBot) bool {
	return t.lastAction > 0 && ms-t.lastAction < int64(cfg.PauseMs)
}

// Steps also count as activity for the continuous session (not for the regularity).
func (t *Tracker) stepped(ms int64, cfg *content.AntiBot) {
	if t.lastAction == 0 || ms-t.lastAction >= int64(cfg.PauseMs) {
		t.activeSince = ms
	}
	t.lastAction = ms
}

// Hurt records damage taken at ms; the next heal within the reaction window answers it.
func (t *Tracker) Hurt(ms int64) {
	if t.lastHurt == 0 {
		t.lastHurt = ms
	}
}

// Heal records a heal (own spell or consumable) at ms.
func (t *Tracker) Heal(ms int64, cfg *content.AntiBot) {
	if t.lastHurt == 0 {
		return
	}
	r := ms - t.lastHurt
	t.lastHurt = 0
	c := cfg.Signals.Reaction
	if r < 0 || r > int64(c.WindowMs) {
		return
	}
	t.reaction.add(float64(r), alpha)
	f := 0.0
	if r <= int64(c.FastMs) {
		f = 1
	}
	t.fast.add(f, alpha)
}

// Step records a step to (x, y, z) facing dir.
func (t *Tracker) Step(ms int64, x, y uint16, z uint8, dir uint8, cfg *content.AntiBot) {
	t.stepped(ms, cfg)
	t.steps[t.stepHead] = uint64(x) | uint64(y)<<16 | uint64(z)<<32 | uint64(dir)<<40
	t.stepHead = (t.stepHead + 1) % len(t.steps)
	t.stepN++
	k := min(max(cfg.Signals.Route.Segment, 2), len(t.steps))
	if t.stepN < k {
		return
	}
	// FNV-1a over the last k steps: k is small and fixed, so the cost is constant.
	h := uint64(14695981039346656037)
	for i := k; i >= 1; i-- {
		h ^= t.steps[(t.stepHead-i+len(t.steps))%len(t.steps)]
		h *= 1099511628211
	}
	rep := 0.0
	for _, s := range t.segments {
		if s == h {
			rep = 1
			break
		}
	}
	t.segRep.add(rep, alpha)
	t.segments[t.segHead] = h
	t.segHead = (t.segHead + 1) % len(t.segments)
}

// ramp maps v from [lo, hi] to [0, 1], clamped (lo > hi ramps downwards).
func ramp(v, lo, hi float64) float64 {
	if hi == lo {
		if v >= hi {
			return 1
		}
		return 0
	}
	return min(max((v-lo)/(hi-lo), 0), 1)
}

// Signals returns the signals at ms. incomeRatio is the character's income per hour over
// the median of its level band (0 when there are too few peers to compare).
//
// While the character is idle (no action for cfg.PauseMs) every signal is 0: frozen
// statistics must not keep adding points to someone who is away.
func (t *Tracker) Signals(ms int64, incomeRatio float64, cfg *content.AntiBot) Signals {
	var s Signals
	if t.lastAction == 0 || ms-t.lastAction >= int64(cfg.PauseMs) {
		return s
	}
	sc := cfg.Signals
	r := sc.Regularity
	for _, iv := range t.interval { // the most regular kind of action
		if iv.n >= r.MinSamples && iv.mean > 0 {
			s[Regularity] = max(s[Regularity], ramp(iv.std()/iv.mean, r.CVHigh, r.CVLow)) // low variation → 1
		}
	}
	if r := sc.Reaction; t.reaction.n >= r.MinSamples {
		consistent := ramp(t.reaction.std(), float64(r.StdMs)*2, float64(r.StdMs))
		s[Reaction] = t.fast.mean * consistent
	}
	if r := sc.Route; t.segRep.n >= r.MinSteps {
		s[Route] = ramp(t.segRep.mean, r.RepeatLow, r.RepeatHigh)
	}
	s[Session] = ramp(float64(ms-t.activeSince), float64(sc.Session.LowMs), float64(sc.Session.HighMs))
	s[Income] = ramp(incomeRatio, sc.Income.RatioLow, sc.Income.RatioHigh)
	return s
}

// Weights returns the weight of each signal.
func Weights(cfg *content.AntiBot) Signals {
	sc := cfg.Signals
	return Signals{sc.Regularity.Weight, sc.Reaction.Weight, sc.Route.Weight, sc.Session.Weight, sc.Income.Weight}
}

// Points is the weighted sum of s.
func Points(s Signals, cfg *content.AntiBot) float64 {
	w := Weights(cfg)
	p := 0.0
	for i := range s {
		p += w[i] * s[i]
	}
	return p
}

// Decay is the factor the score keeps over elapsedMs (half-life cfg.HalfLifeMs).
func Decay(elapsedMs int64, cfg *content.AntiBot) float64 {
	if cfg.HalfLifeMs <= 0 {
		return 1
	}
	return math.Pow(0.5, float64(elapsedMs)/float64(cfg.HalfLifeMs))
}

// Level returns the response level of score: 0 none, then LevelLog, LevelNotify,
// LevelPresence and LevelSuspend.
func Level(score float64, cfg *content.AntiBot) int {
	th := cfg.Thresholds
	switch {
	case score >= th.Suspend:
		return LevelSuspend
	case score >= th.Presence:
		return LevelPresence
	case score >= th.Notify:
		return LevelNotify
	case score >= th.Log:
		return LevelLog
	}
	return 0
}

// Threshold returns the score at which level starts.
func Threshold(level int, cfg *content.AntiBot) float64 {
	th := cfg.Thresholds
	switch level {
	case LevelLog:
		return th.Log
	case LevelNotify:
		return th.Notify
	case LevelPresence:
		return th.Presence
	case LevelSuspend:
		return th.Suspend
	}
	return 0
}

// Response levels, in order (graded responses).
const (
	LevelLog = 1 + iota
	LevelNotify
	LevelPresence
	LevelSuspend
)

// Median returns the median of xs, reordering it (0 for none).
func Median(xs []float64) float64 {
	if len(xs) == 0 {
		return 0
	}
	// Insertion sort: bands are small and this runs once per evaluation round.
	for i := 1; i < len(xs); i++ {
		for j := i; j > 0 && xs[j] < xs[j-1]; j-- {
			xs[j], xs[j-1] = xs[j-1], xs[j]
		}
	}
	m := len(xs) / 2
	if len(xs)%2 == 1 {
		return xs[m]
	}
	return (xs[m-1] + xs[m]) / 2
}
