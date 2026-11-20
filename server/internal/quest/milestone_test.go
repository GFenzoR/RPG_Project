package quest

import (
	"strings"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
)

const milestoneYAML = `
id: m
name: n
milestone: true
title: t
requires:
  level: 20
  players: 2
  vocations: [guardian, druid]
  gear: { item: lantern }
steps:
  - { id: talk, description: d, complete_when: { dialog_action: { npc: a, node: go } } }
  - id: plates
    description: d
    complete_when: { sigils: { x: 10, y: 10, z: 7, radius: 2, to: { x: 20, y: 20, z: 7 } } }
rewards:
  - { xp: 100 }
`

func milestone(t *testing.T) *content.Quest {
	t.Helper()
	q, err := content.ParseQuest([]byte(milestoneYAML))
	if err != nil {
		t.Fatal(err)
	}
	return q
}

// ready is a candidate that meets everything on a plate of vocation v.
func ready(v string) *Candidate {
	return &Candidate{Name: v, Level: 25, Vocation: v, Alive: true, Online: true, HasGear: true, OnStep: true}
}

func TestMilestoneParse(t *testing.T) {
	if q := milestone(t); q.SigilsStep() != 1 || q.Requires.Players != 2 {
		t.Fatalf("sigils step %d, players %d", q.SigilsStep(), q.Requires.Players)
	}
	bad := map[string]string{
		"no requires":          strings.Replace(milestoneYAML, "requires:", "x_requires:", 1),
		"no title":             strings.Replace(milestoneYAML, "title: t\n", "", 1),
		"too many players":     strings.Replace(milestoneYAML, "players: 2", "players: 5", 1),
		"vocations count":      strings.Replace(milestoneYAML, "[guardian, druid]", "[guardian]", 1),
		"repeatable":           strings.Replace(milestoneYAML, "milestone: true", "milestone: true\nrepeatable: { cooldown_hours: 1 }", 1),
		"gear item and weapon": strings.Replace(milestoneYAML, "{ item: lantern }", "{ item: lantern, weapon: sword }", 1),
		"equipped weapon":      strings.Replace(milestoneYAML, "{ item: lantern }", "{ weapon: sword, equipped: true }", 1),
		"sigils not last": strings.Replace(milestoneYAML, "rewards:", `  - { id: after, description: d, complete_when: { kill: { monster: w, count: 1 } } }
rewards:`, 1),
		"sigils off a milestone": strings.Replace(strings.Replace(strings.Replace(milestoneYAML, "milestone: true\n", "", 1),
			"title: t\n", "", 1), "requires:", "x:", 1),
		"radius": strings.Replace(milestoneYAML, "radius: 2", "radius: 9", 1),
	}
	for name, raw := range bad {
		if _, err := content.ParseQuest([]byte(raw)); err == nil {
			t.Errorf("%s: parsed", name)
		}
	}
}

func TestCooperativeCompletes(t *testing.T) {
	q := milestone(t)
	o := Cooperative(q, []string{"guardian", "druid"}, []*Candidate{ready("guardian"), ready("druid")})
	if !o.Full || !o.Done || o.Occupied != 2 {
		t.Fatalf("outcome %+v", o)
	}
}

func TestCooperativePartialOccupancy(t *testing.T) {
	q := milestone(t)
	o := Cooperative(q, []string{"guardian", "druid"}, []*Candidate{ready("guardian"), nil})
	if o.Full || o.Done || o.Occupied != 1 || o.Fails != nil {
		t.Fatalf("one plate held: %+v", o)
	}
}

func TestCooperativeWrongVocation(t *testing.T) {
	q := milestone(t)
	o := Cooperative(q, []string{"guardian", "druid"}, []*Candidate{ready("guardian"), ready("ranger")})
	if !o.Full || o.Done || o.Fails[0] != FailNone || o.Fails[1] != FailVocation {
		t.Fatalf("a ranger on the druid's plate: %+v", o)
	}
	// A plate without a vocation takes anyone.
	o = Cooperative(q, []string{"", ""}, []*Candidate{ready("ranger"), ready("ranger")})
	if !o.Done {
		t.Fatalf("plates for anyone: %+v", o)
	}
}

func TestCooperativeRequirements(t *testing.T) {
	q := milestone(t)
	low, noGear, noStep := ready("druid"), ready("druid"), ready("druid")
	low.Level = 19
	noGear.HasGear = false
	noStep.OnStep = false
	for _, c := range []struct {
		c    *Candidate
		want Failure
	}{{low, FailLevel}, {noGear, FailGear}, {noStep, FailStep}} {
		o := Cooperative(q, []string{"guardian", "druid"}, []*Candidate{ready("guardian"), c.c})
		if !o.Full || o.Done || o.Fails[1] != c.want || o.Fails[1].Key() == "" {
			t.Errorf("want %v: %+v", c.want, o)
		}
	}
	// The first failure in order is the one told: the step before the level.
	both := ready("druid")
	both.OnStep, both.Level = false, 1
	if f := Check(q, "druid", both); f != FailStep {
		t.Fatalf("failure %v, want the step first", f)
	}
}

func TestCooperativeStaffAndLogout(t *testing.T) {
	q := milestone(t)
	staff := ready("druid")
	staff.Staff = true
	gone := ready("druid")
	gone.Online = false // logged out (or link-dead) on the plate
	dead := ready("druid")
	dead.Alive = false
	for name, c := range map[string]*Candidate{"staff": staff, "logged out": gone, "dead": dead} {
		o := Cooperative(q, []string{"guardian", "druid"}, []*Candidate{ready("guardian"), c})
		if o.Full || o.Done || o.Occupied != 1 {
			t.Errorf("%s holds a plate: %+v", name, o)
		}
	}
	// Plates and requires out of step never complete.
	if o := Cooperative(q, []string{"guardian"}, []*Candidate{ready("guardian")}); o.Done || o.Full {
		t.Fatalf("one plate for two players: %+v", o)
	}
}

func TestCompleteSigils(t *testing.T) {
	q := milestone(t)
	e := NewEngine(content.Quests{"m": q})
	l := NewLog(nil)
	h := &host{items: map[string]int{}}
	if e.CompleteSigils(l, "m", h) {
		t.Fatal("completed before the quest started")
	}
	e.Start(l, "m", h)
	if e.OnSigils(l, "m") || e.CompleteSigils(l, "m", h) {
		t.Fatal("completed on the talk step")
	}
	e.ReachedNode(l, "a", "go", h)
	if !e.OnSigils(l, "m") {
		t.Fatal("not on the plates step")
	}
	if !e.CompleteSigils(l, "m", h) {
		t.Fatal("not completed")
	}
	if s, _ := e.State(l, "m"); s != Completed || len(h.rewards) != 1 {
		t.Fatalf("state %v, rewards %v", s, h.rewards)
	}
	// Once per character: done, it is never on the step again.
	if e.OnSigils(l, "m") || e.CompleteSigils(l, "m", h) || len(h.rewards) != 1 {
		t.Fatal("completed twice")
	}
	if ms := e.Milestones(); len(ms) != 1 || ms[0] != q {
		t.Fatalf("milestones %v", ms)
	}
}
