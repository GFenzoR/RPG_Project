package session

import (
	"fmt"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
)

// The guided tutorial (T4.2): the steps of data/tutorial.yaml, advanced by the server's
// own events at constant cost (one int compare for a player outside the tutorial). Its
// progress lives in the character's storage values (quest_state):
//
//   - tutorial.step: the current step index + 1 (0 = never started).
//   - tutorial.count: events counted toward the current step.
//   - tutorial.done: tutorialDone (finished) or tutorialSkipped. It never comes back.
const (
	tutKey      = "tutorial." // storage key prefix (not i18n keys)
	tutStepKey  = tutKey + "step"
	tutCountKey = tutKey + "count"
	tutDoneKey  = tutKey + "done"

	tutorialDone    = 1
	tutorialSkipped = 2
)

// System messages of the tutorial (i18n keys).
const (
	msgTutorialDone    = "tutorial.completed"
	msgTutorialSkipped = "tutorial.skipped"
)

// EconTutorial is the economy log source of the tutorial's reward.
const EconTutorial = "tutorial"

// initTutorial checks Config.Tutorial against the content and the map.
func (w *World) initTutorial() error {
	t := w.cfg.Tutorial
	if t == nil {
		return nil
	}
	if w.m.Island(t.Island) == nil {
		return fmt.Errorf("session: tutorial island %q is not an island of the map", t.Island)
	}
	if err := t.Check(w.cfg.Vocations, w.cfg.Monsters, w.cfg.Items, w.cfg.Spells, w.cfg.NPCs, w.cfg.Quests, w.cfg.Recipes); err != nil {
		return fmt.Errorf("session: %w", err)
	}
	return nil
}

// tutorialJoin resumes p's tutorial, or starts it for a new character: never played
// (level 1, no experience), residing on the tutorial island, and with no tutorial state.
// A character that existed before the tutorial did has experience or levels, so it never
// sees it.
func (w *World) tutorialJoin(p *Player) {
	t := w.cfg.Tutorial
	if t == nil || p.storage.Get(tutDoneKey) != 0 {
		return
	}
	step := p.storage.Get(tutStepKey)
	if step == 0 {
		if p.level != 1 || p.experience != 0 || p.town != t.Island {
			return
		}
		w.tutorialEnter(p, 0)
		return
	}
	if step < 0 || int(step) > len(t.Steps) {
		w.tutorialEnd(p, tutorialSkipped) // the data shrank under it: end without reward
		return
	}
	p.tut = int(step)
	if !t.Steps[p.tut-1].For(p.vocation.ID) { // the step's vocations changed
		w.tutorialEnter(p, p.tut-1)
		return
	}
	w.sendTutorial(p)
}

// tutorialEnter makes step i (or the next one for p's vocation) current, or finishes
// the tutorial past the last step.
func (w *World) tutorialEnter(p *Player, i int) {
	t := w.cfg.Tutorial
	for i < len(t.Steps) && !t.Steps[i].For(p.vocation.ID) {
		i++
	}
	if i >= len(t.Steps) {
		w.tutorialEnd(p, tutorialDone)
		return
	}
	p.tut = i + 1
	p.storage.Set(tutStepKey, int64(p.tut))
	p.storage.Set(tutCountKey, 0)
	w.sendTutorial(p)
}

// tutorialEvent counts one server event toward p's current step. ref is the content id
// of what the event is about (monster, item, spell, npc, recipe or quest).
func (w *World) tutorialEvent(p *Player, event, ref string) {
	if p.tut == 0 {
		return
	}
	s := &w.cfg.Tutorial.Steps[p.tut-1]
	if s.When.Event != event || s.When.Ref != "" && s.When.Ref != ref {
		return
	}
	n := p.storage.Get(tutCountKey) + 1
	if n < int64(s.When.N()) {
		p.storage.Set(tutCountKey, n)
		w.sendTutorial(p)
		return
	}
	w.tutorialEnter(p, p.tut)
}

// tutorialSkip ends p's tutorial at the player's request, without reward.
func (w *World) tutorialSkip(p *Player) {
	if p.tut == 0 {
		return
	}
	w.tutorialEnd(p, tutorialSkipped)
}

// tutorialEnd ends the tutorial for good: done gives the reward.
func (w *World) tutorialEnd(p *Player, how int64) {
	t := w.cfg.Tutorial
	p.tut = 0
	p.storage.Set(tutStepKey, 0)
	p.storage.Set(tutCountKey, 0)
	p.storage.Set(tutDoneKey, how)
	state := pb.TutorialState_TUTORIAL_STATE_SKIPPED
	if how == tutorialDone {
		state = pb.TutorialState_TUTORIAL_STATE_DONE
		p.emit(systemMsg(msgTutorialDone))
		for _, r := range t.Rewards {
			w.tutorialReward(p, r)
		}
	} else {
		p.emit(systemMsg(msgTutorialSkipped))
	}
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_TutorialStep{TutorialStep: &pb.TutorialStep{
		State: state, Total: uint32(len(t.Steps)),
	}}})
}

func (w *World) tutorialReward(p *Player, r content.TutorialReward) {
	if r.Gold > 0 {
		w.giveMoney(p, r.Gold)
		w.econGold(p, EconTutorial, EconTutorial, r.Gold)
		p.emit(systemMsg(msgReceivedGold, num("amount", int(r.Gold))))
		return
	}
	def := w.cfg.Items[r.Item]
	w.giveItem(p, def, r.N())
	w.econItem(p, EconTutorial, EconTutorial, def, r.N())
	p.questDirty = true
}

// sendTutorial tells p's client the current step and its progress.
func (w *World) sendTutorial(p *Player) {
	t := w.cfg.Tutorial
	s := &t.Steps[p.tut-1]
	// Numbered among the steps of p's vocation, so that a skipped one leaves no gap
	// (at most 64 steps, and only on a tutorial change).
	index, total := 0, 0
	for i := range t.Steps {
		if t.Steps[i].For(p.vocation.ID) {
			if i < p.tut-1 {
				index++
			}
			total++
		}
	}
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_TutorialStep{TutorialStep: &pb.TutorialStep{
		State:     pb.TutorialState_TUTORIAL_STATE_ACTIVE,
		StepId:    s.ID,
		Index:     uint32(index),
		Total:     uint32(total),
		Text:      &pb.LocalizedText{Key: s.Text, Params: []*pb.TextParam{num("count", s.When.N())}},
		Highlight: s.Highlight,
		Progress:  uint32(p.storage.Get(tutCountKey)),
		Count:     uint32(s.When.N()),
	}}})
}

// TutorialStep returns p's current tutorial step id, or "" (tests). Loop goroutine only.
func (p *Player) TutorialStep(w *World) string {
	if p.tut == 0 {
		return ""
	}
	return w.cfg.Tutorial.Steps[p.tut-1].ID
}
