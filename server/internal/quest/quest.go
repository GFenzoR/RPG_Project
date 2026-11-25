// Package quest runs the quests of data/quests over a character's storage values
// (quest_state in the database), with the step semantics of docs/06-content-data.md:
//
//   - Steps complete in order; only the current step's complete_when is evaluated. When
//     the last one completes, the rewards are given and the quest is completed.
//   - kill counts kills since the step became the current one.
//   - has_item and flag_equals are evaluated when the step becomes current and after
//     every relevant change (Recheck, SetFlag).
//   - A completed step never goes back.
//   - reach is evaluated when the step becomes current and after every move or
//     relocation of the character (Moved), through Host.Inside.
//   - A completed quest is final, unless it is repeatable: Start takes it again once its
//     cooldown passed since it was done (the done_at key, unix seconds of Host.Now), from
//     the first step, and its rewards are given every time.
//
// It is pure game logic: the caller (the session, on the game loop goroutine) owns the
// Log and applies rewards through Host. Every change of a quest's state, step or kill
// count reaches Host.Notify as an Event (a SetStep too, StepSet, even when the step does
// not complete): the host refreshes what it derives from the Log there (its quest log).
package quest

import (
	"maps"
	"sort"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
)

// State is where a character is in a quest.
type State uint8

// Quest states, stored as the value of the "quest.<id>" key (0 = no row).
const (
	NotStarted State = iota
	InProgress
	Completed
)

// String returns the state as written in quest_state conditions.
func (s State) String() string {
	return [...]string{content.QuestNotStarted, content.QuestInProgress, content.QuestCompleted}[s]
}

// Storage keys of a character's Log.
func stateKey(q string) string  { return "quest." + q }
func stepKey(q string) string   { return "quest." + q + ".step" }
func killsKey(q string) string  { return "quest." + q + ".kills" }
func doneAtKey(q string) string { return "quest." + q + ".done_at" }

// FlagKey is the storage key of a content flag (set_flag, flag_equals).
func FlagKey(key string) string { return "flag." + key }

// Log is the storage values of one character. A missing key is 0.
type Log struct{ v map[string]int64 }

// NewLog builds a log from saved values (copied).
func NewLog(values map[string]int64) *Log {
	l := &Log{v: make(map[string]int64, len(values))}
	for k, v := range values {
		if v != 0 {
			l.v[k] = v
		}
	}
	return l
}

// Get returns a storage value.
func (l *Log) Get(key string) int64 { return l.v[key] }

// Set changes a storage value; 0 removes it.
func (l *Log) Set(key string, v int64) {
	if v == 0 {
		delete(l.v, key)
	} else {
		l.v[key] = v
	}
}

// Values returns a copy of every non-zero value (for a snapshot).
func (l *Log) Values() map[string]int64 { return maps.Clone(l.v) }

// EventKind tells the Host what happened.
type EventKind uint8

// Event kinds: a quest started, a step was completed, a kill was counted, the quest
// was completed, a quest was moved to a step (set_quest_step).
const (
	Started EventKind = iota + 1
	StepDone
	KillProgress
	Done
	StepSet
)

// Event is a change the player should hear about.
type Event struct {
	Kind  EventKind
	Quest *content.Quest
	// Step is the step that just completed (StepDone), is counting kills (KillProgress)
	// or was made current (StepSet).
	Step *content.QuestStepDef
	// Kills is the kill count of the step (KillProgress).
	Kills int
}

// Host is the character the engine runs for.
type Host interface {
	// ItemCount is how many units of item the character carries (equipment and every
	// nested container).
	ItemCount(item string) int
	// Reward gives an xp, gold or item reward (set_flag rewards are the engine's).
	Reward(q *content.Quest, r content.QuestReward)
	// Notify reports an event.
	Notify(e Event)
	// Now is the game clock in unix seconds (the loop's injected clock, never the wall
	// clock read directly): a repeatable quest stores when it was done with it.
	Now() int64
	// Inside reports whether the character stands in the place of a reach step.
	Inside(r *content.Reach) bool
}

// Engine runs the quests of data/quests.
type Engine struct {
	quests     content.Quests
	ids        []string // sorted: deterministic order
	milestones []*content.Quest
}

// NewEngine builds an engine over quests.
func NewEngine(quests content.Quests) *Engine {
	e := &Engine{quests: quests}
	for id := range quests {
		e.ids = append(e.ids, id)
	}
	sort.Strings(e.ids)
	for _, id := range e.ids {
		if q := quests[id]; q.Milestone {
			e.milestones = append(e.milestones, q)
		}
	}
	return e
}

// Quest returns a quest definition, or nil.
func (e *Engine) Quest(id string) *content.Quest { return e.quests[id] }

// Needs reports whether a quest in progress asks for item: a has_item step of item for
// more than have units that is the current step or the one just before it (a quest drop,
// content audit m9). The step after a quest drop's has_item is its delivery (the startup
// checks it), so the done step counts while the delivery is current: whoever lost the
// item before handing it in (a death, a drop) can get another from the next kill, as a
// done step never goes back. Once handed in, the delivery is done and nothing is asked.
func (e *Engine) Needs(l *Log, item string, have int) bool {
	for _, id := range e.ids {
		q, i, ok := e.current(l, id)
		if !ok {
			continue
		}
		for k := max(0, i-1); k <= i; k++ {
			if c := q.Steps[k].CompleteWhen.HasItem; c != nil && c.Item == item && c.N() > have {
				return true
			}
		}
	}
	return false
}

// State returns the character's state in quest id and, in progress, its current step.
func (e *Engine) State(l *Log, id string) (State, string) {
	q := e.quests[id]
	if q == nil {
		return NotStarted, ""
	}
	switch l.Get(stateKey(id)) {
	case int64(InProgress):
		i := int(l.Get(stepKey(id)))
		if i < 0 || i >= len(q.Steps) {
			return InProgress, ""
		}
		return InProgress, q.Steps[i].ID
	case int64(Completed):
		return Completed, ""
	}
	return NotStarted, ""
}

// Available reports whether Start would start quest id at now (unix seconds): it was
// never started, or it is repeatable and was done at least its cooldown ago.
func (e *Engine) Available(l *Log, id string, now int64) bool {
	q := e.quests[id]
	if q == nil {
		return false
	}
	switch l.Get(stateKey(id)) {
	case 0:
		return true
	case int64(Completed):
		return q.Repeatable != nil && now >= e.availableAt(l, q)
	}
	return false
}

// CoolingDown reports whether quest id is repeatable, done, and waits for its cooldown at
// now (unix seconds).
func (e *Engine) CoolingDown(l *Log, id string, now int64) bool {
	q := e.quests[id]
	return q != nil && q.Repeatable != nil && l.Get(stateKey(id)) == int64(Completed) && now < e.availableAt(l, q)
}

// availableAt is when a done repeatable quest can be started again (unix seconds): its
// done_at plus the cooldown; 0 without done_at (done before the quest was repeatable).
func (e *Engine) availableAt(l *Log, q *content.Quest) int64 {
	done := l.Get(doneAtKey(q.ID))
	if done == 0 {
		return 0
	}
	return done + q.Repeatable.CooldownSeconds()
}

// Start starts quest id. It does nothing (and returns false) if the quest does not exist
// or is not available (Available): in progress, completed, or a repeatable one still
// cooling down. A repeatable one starts again from its first step with no kills counted.
func (e *Engine) Start(l *Log, id string, h Host) bool {
	q := e.quests[id]
	if q == nil || !e.Available(l, id, h.Now()) {
		return false
	}
	l.Set(doneAtKey(id), 0)
	l.Set(stateKey(id), int64(InProgress))
	h.Notify(Event{Kind: Started, Quest: q})
	e.enter(l, q, 0, h)
	return true
}

// SetStep moves a quest in progress to step (set_quest_step), forwards or back. It
// reports the move (StepSet) before the step is evaluated, so the host hears of it even
// when the step does not complete right away (a reach step elsewhere, a kill step).
func (e *Engine) SetStep(l *Log, id, step string, h Host) bool {
	q := e.quests[id]
	if q == nil || l.Get(stateKey(id)) != int64(InProgress) {
		return false
	}
	i := q.StepIndex(step)
	if i < 0 {
		return false
	}
	h.Notify(Event{Kind: StepSet, Quest: q, Step: &q.Steps[i]})
	e.enter(l, q, i, h)
	return true
}

// SetFlag sets a content flag and re-evaluates the flag_equals steps.
func (e *Engine) SetFlag(l *Log, key string, v int64, h Host) {
	l.Set(FlagKey(key), v)
	e.Recheck(l, h)
}

// Killed counts a kill of monster for every current kill step on it.
func (e *Engine) Killed(l *Log, monster string, h Host) {
	for _, id := range e.ids {
		q, i, ok := e.current(l, id)
		if !ok {
			continue
		}
		k := q.Steps[i].CompleteWhen.Kill
		if k == nil || k.Monster != monster {
			continue
		}
		n := l.Get(killsKey(id)) + 1
		l.Set(killsKey(id), n)
		h.Notify(Event{Kind: KillProgress, Quest: q, Step: &q.Steps[i], Kills: int(n)})
		if n >= int64(k.Count) {
			e.complete(l, q, i, h)
		}
	}
}

// ReachedNode completes the current dialog_action steps on node of npc.
func (e *Engine) ReachedNode(l *Log, npc, node string, h Host) {
	for _, id := range e.ids {
		q, i, ok := e.current(l, id)
		if !ok {
			continue
		}
		if d := q.Steps[i].CompleteWhen.DialogAction; d != nil && d.NPC == npc && d.Node == node {
			e.complete(l, q, i, h)
		}
	}
}

// Moved completes the current reach steps the character now stands in (after it moved or
// was relocated: the session calls it only for characters with a reach step current).
func (e *Engine) Moved(l *Log, h Host) {
	for _, id := range e.ids {
		q, i, ok := e.current(l, id)
		if !ok {
			continue
		}
		if r := q.Steps[i].CompleteWhen.Reach; r != nil && h.Inside(r) {
			e.complete(l, q, i, h)
		}
	}
}

// Reaches appends to out the reach completions of the current steps of every quest in
// progress, in quest id order (the session indexes them to check moves cheaply).
func (e *Engine) Reaches(l *Log, out []*content.Reach) []*content.Reach {
	for _, id := range e.ids {
		if q, i, ok := e.current(l, id); ok && q.Steps[i].CompleteWhen.Reach != nil {
			out = append(out, q.Steps[i].CompleteWhen.Reach)
		}
	}
	return out
}

// Entry is one quest of a character's quest log (docs/05 "Diario de misiones").
type Entry struct {
	Quest *content.Quest
	// State is InProgress or Completed.
	State State
	// Step is the current step (InProgress), or nil.
	Step *content.QuestStepDef
	// Kills is the kill count of a current kill step.
	Kills int
	// AvailableAt is when a completed repeatable quest can be started again (unix
	// seconds); 0 for any other.
	AvailableAt int64
}

// Entries returns the character's quest log: every quest it has started or completed, in
// quest id order.
func (e *Engine) Entries(l *Log) []Entry {
	var out []Entry
	for _, id := range e.ids {
		q := e.quests[id]
		switch l.Get(stateKey(id)) {
		case int64(InProgress):
			en := Entry{Quest: q, State: InProgress}
			if _, i, ok := e.current(l, id); ok {
				en.Step = &q.Steps[i]
				if q.Steps[i].CompleteWhen.Kill != nil {
					en.Kills = int(l.Get(killsKey(id)))
				}
			}
			out = append(out, en)
		case int64(Completed):
			en := Entry{Quest: q, State: Completed}
			if q.Repeatable != nil {
				en.AvailableAt = e.availableAt(l, q)
			}
			out = append(out, en)
		}
	}
	return out
}

// Recheck evaluates the current has_item, flag_equals and reach steps (after the
// character's inventory or flags changed).
func (e *Engine) Recheck(l *Log, h Host) {
	for _, id := range e.ids {
		if q, i, ok := e.current(l, id); ok && e.holds(l, q.Steps[i].CompleteWhen, h) {
			e.complete(l, q, i, h)
		}
	}
}

// current returns quest id and its current step index if it is in progress.
func (e *Engine) current(l *Log, id string) (*content.Quest, int, bool) {
	if l.Get(stateKey(id)) != int64(InProgress) {
		return nil, 0, false
	}
	q := e.quests[id]
	i := int(l.Get(stepKey(id)))
	if q == nil || i < 0 || i >= len(q.Steps) {
		return nil, 0, false
	}
	return q, i, true
}

func (e *Engine) holds(l *Log, c content.Completion, h Host) bool {
	switch {
	case c.HasItem != nil:
		return h.ItemCount(c.HasItem.Item) >= c.HasItem.N()
	case c.FlagEquals != nil:
		return l.Get(FlagKey(c.FlagEquals.Key)) == c.FlagEquals.Value
	case c.Reach != nil:
		return h.Inside(c.Reach)
	}
	return false
}

// enter makes step i current: its kill count starts at 0 and has_item, flag_equals and
// reach are evaluated right away.
func (e *Engine) enter(l *Log, q *content.Quest, i int, h Host) {
	l.Set(stepKey(q.ID), int64(i))
	l.Set(killsKey(q.ID), 0)
	if e.holds(l, q.Steps[i].CompleteWhen, h) {
		e.complete(l, q, i, h)
	}
}

// complete finishes step i and enters the next one, or completes the quest.
func (e *Engine) complete(l *Log, q *content.Quest, i int, h Host) {
	h.Notify(Event{Kind: StepDone, Quest: q, Step: &q.Steps[i]})
	if i+1 < len(q.Steps) {
		e.enter(l, q, i+1, h)
		return
	}
	l.Set(stateKey(q.ID), int64(Completed))
	l.Set(stepKey(q.ID), 0)
	l.Set(killsKey(q.ID), 0)
	if q.Repeatable != nil {
		l.Set(doneAtKey(q.ID), max(h.Now(), 1)) // 0 would remove the key
	}
	var flags []content.Flag
	for _, r := range q.Rewards {
		if r.SetFlag != nil {
			flags = append(flags, *r.SetFlag)
			continue
		}
		h.Reward(q, r)
	}
	h.Notify(Event{Kind: Done, Quest: q})
	for _, f := range flags {
		e.SetFlag(l, f.Key, f.Value, h)
	}
}

// CurrentStep returns the current step of quest id while it is in progress, or nil.
func (e *Engine) CurrentStep(l *Log, id string) *content.QuestStepDef {
	q := e.quests[id]
	if q == nil || l.Get(stateKey(id)) != int64(InProgress) {
		return nil
	}
	if _, i, ok := e.current(l, id); ok {
		return &q.Steps[i]
	}
	return nil
}
