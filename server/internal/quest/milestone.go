package quest

import "github.com/GFenzoR/RPG_Project/server/internal/content"

// Milestone quests (docs/02 "Quests de hito"): their last step is a sigils step, the
// cooperative plates of the map. The session finds who stands on each plate in a tick and
// asks Cooperative whether that group completes it; the rules are here, pure and
// deterministic, so the engine tests play every case without a world.

// Candidate is a character standing on a sigil plate, as the session sees it in a tick.
type Candidate struct {
	Name     string
	Level    int
	Vocation string
	// Staff: a staff member never counts (a GM cannot carry anyone through a milestone).
	Staff bool
	// Alive: health above 0. Online: connected, not link-dead (logging out on a plate is
	// leaving it).
	Alive, Online bool
	// HasGear: the milestone's gear requirement holds (true when it has none).
	HasGear bool
	// OnStep: the quest is in progress with its sigils step current.
	OnStep bool
}

// Failure is why a candidate on a full set of plates does not count.
type Failure uint8

// Failures, in the order they are checked: the first one is what the player hears.
const (
	FailNone Failure = iota
	FailStep
	FailVocation
	FailLevel
	FailGear
)

// Key is the i18n key (client.yaml) of the message that tells the player.
func (f Failure) Key() string {
	return [...]string{"", "milestone.fail_step", "milestone.fail_vocation", "milestone.fail_level", "milestone.fail_gear"}[f]
}

// Counts reports whether c holds a plate at all: a living, connected, non-staff player.
// One who does not is as if the plate were empty.
func (c *Candidate) Counts() bool { return c != nil && c.Alive && c.Online && !c.Staff }

// Check returns the first requirement of milestone q that c misses on a plate of
// vocation plate ("" = any): the quest on its sigils step, the plate's vocation, the
// level and the gear.
func Check(q *content.Quest, plate string, c *Candidate) Failure {
	r := q.Requires
	switch {
	case !c.OnStep:
		return FailStep
	case plate != "" && c.Vocation != plate:
		return FailVocation
	case r != nil && c.Level < r.Level:
		return FailLevel
	case !c.HasGear:
		return FailGear
	}
	return FailNone
}

// Outcome is what a set of plates does in a tick.
type Outcome struct {
	// Occupied is how many plates hold a candidate that counts (Counts).
	Occupied int
	// Full: every plate is occupied. Then Fails says, per plate, what its candidate
	// misses; Done is set when nobody misses anything: the step completes for all of them.
	Full  bool
	Fails []Failure
	Done  bool
}

// Cooperative evaluates the plates of milestone q: plates[i] is the vocation of plate i
// ("" = any), on[i] who stands on it (nil: nobody). A milestone with more plates than
// players, or fewer, never completes (the session refuses such a map when it starts).
func Cooperative(q *content.Quest, plates []string, on []*Candidate) Outcome {
	var o Outcome
	if q == nil || q.Requires == nil || len(plates) != q.Requires.Players || len(on) != len(plates) {
		return o
	}
	for _, c := range on {
		if c.Counts() {
			o.Occupied++
		}
	}
	if o.Occupied < len(plates) {
		return o
	}
	o.Full = true
	o.Fails = make([]Failure, len(plates))
	o.Done = true
	for i, c := range on {
		o.Fails[i] = Check(q, plates[i], c)
		if o.Fails[i] != FailNone {
			o.Done = false
		}
	}
	return o
}

// OnSigils reports whether quest id is in progress on its sigils step.
func (e *Engine) OnSigils(l *Log, id string) bool {
	q, i, ok := e.current(l, id)
	return ok && i == q.SigilsStep()
}

// CompleteSigils completes the sigils step of milestone id for the character of l (its
// rewards follow, as for any last step). It does nothing unless that step is current.
func (e *Engine) CompleteSigils(l *Log, id string, h Host) bool {
	if !e.OnSigils(l, id) {
		return false
	}
	q, i, _ := e.current(l, id)
	e.complete(l, q, i, h)
	return true
}

// Milestones returns the milestone quests, in id order (shared: do not modify).
func (e *Engine) Milestones() []*content.Quest { return e.milestones }
