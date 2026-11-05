package bot

import (
	"math"
	"math/rand/v2"
	"time"
)

// Profile is a pace of play for headless clients (T4.1, bot detection). The same profiles
// drive tools/bots (-profile) and the deterministic detection test of the server
// (internal/session/antibot_sim_test.go), so the detector is tested against the
// behaviour the load test produces. All randomness comes from the caller's *rand.Rand.
type Profile struct {
	Name string
	// Between two actions: Action, varied log-normally by Spread (0 = always the same).
	Action time.Duration
	Spread float64
	// A pause of PauseMin..PauseMax every PauseEvery on average (0 = never).
	PauseEvery         time.Duration
	PauseMin, PauseMax time.Duration
	// After a hit, the heal comes Heal later, ± HealJitter (uniform).
	Heal, HealJitter time.Duration
	// Wander walks at random around its spot; otherwise it loops a fixed square.
	Wander bool
	// Beat is the pace of the actions besides walking (a training spell, using an item,
	// a chat line), varied log-normally by BeatSpread (0 = a metronome).
	Beat       time.Duration
	BeatSpread float64
}

// Human plays like a person: uneven pace, breaks, slow and varied reactions, its own way.
func Human() Profile {
	return Profile{Name: "human", Action: 900 * time.Millisecond, Spread: 0.5,
		PauseEvery: 20 * time.Minute, PauseMin: 4 * time.Minute, PauseMax: 10 * time.Minute,
		Heal: 1200 * time.Millisecond, HealJitter: 700 * time.Millisecond, Wander: true,
		Beat: 4 * time.Second, BeatSpread: 0.6}
}

// Mechanical plays like a script: a fixed beat, no breaks, instant heals, the same loop.
func Mechanical() Profile {
	return Profile{Name: "mechanical", Action: 600 * time.Millisecond, Heal: 100 * time.Millisecond,
		Beat: 2500 * time.Millisecond}
}

// ProfileByName returns "human" or "mechanical".
func ProfileByName(name string) (Profile, bool) {
	switch name {
	case "human":
		return Human(), true
	case "mechanical":
		return Mechanical(), true
	}
	return Profile{}, false
}

// Delay is the wait before the next action.
func (p Profile) Delay(r *rand.Rand) time.Duration {
	if p.Spread <= 0 {
		return p.Action
	}
	f := math.Exp(r.NormFloat64()*p.Spread - p.Spread*p.Spread/2) // mean 1
	return time.Duration(float64(p.Action) * f)
}

// BeatDelay is the wait before the next action besides walking.
func (p Profile) BeatDelay(r *rand.Rand) time.Duration {
	if p.BeatSpread <= 0 {
		return p.Beat
	}
	return time.Duration(float64(p.Beat) * math.Exp(r.NormFloat64()*p.BeatSpread-p.BeatSpread*p.BeatSpread/2))
}

// Pause returns how long to stop now (0 = keep playing), given the wait since the last
// action: on average one pause every PauseEvery.
func (p Profile) Pause(r *rand.Rand, step time.Duration) time.Duration {
	if p.PauseEvery <= 0 || r.Float64() >= float64(step)/float64(p.PauseEvery) {
		return 0
	}
	return p.PauseMin + time.Duration(r.Int64N(int64(p.PauseMax-p.PauseMin)+1))
}

// HealDelay is how long after a hit the heal comes.
func (p Profile) HealDelay(r *rand.Rand) time.Duration {
	if p.HealJitter <= 0 {
		return p.Heal
	}
	return p.Heal - p.HealJitter + time.Duration(r.Int64N(int64(2*p.HealJitter)+1))
}

// loop is the fixed square a Mechanical profile walks.
var loop = func() []Direction {
	var out []Direction
	for _, d := range []Direction{East, South, West, North} {
		for range 6 {
			out = append(out, d)
		}
	}
	return out
}()

// Step is the i-th step: a fixed loop, or a random one that drifts back towards the
// spot when off by dx, dy tiles.
func (p Profile) Step(r *rand.Rand, i, dx, dy int) Direction {
	if !p.Wander {
		return loop[i%len(loop)]
	}
	switch {
	case dx > 4:
		return West
	case dx < -4:
		return East
	case dy > 4:
		return North
	case dy < -4:
		return South
	}
	return [...]Direction{North, East, South, West}[r.IntN(4)]
}
