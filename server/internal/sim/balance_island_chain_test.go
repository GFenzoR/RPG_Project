package sim_test

// The quest chain of the starting island (docs/02 "Capítulo 1", owner's request of
// 2026-11-26): the main line's quests of chapter 1, each opened by the one before it.
//
//   - Their experience alone, with no kill counted, carries a new character to level 8
//     and stays under level 9: the two levels left to the boat's level 10 are hunted.
//   - The chain is one line from ch1_shipwreck: every quest of the chapter is on it, and a
//     character that only ever earned the experience of the quests before one is never
//     under its min_level, nor under the level its giver asks for.
//   - No reward is worth much more than a level and a half when it is handed in, counting
//     the kills the chain itself asks for on the way (a quest's kill steps, nothing else).
//
// Deterministic: sums over data/, no dice. DEBUG_BALANCE=1 prints the curve docs/02 quotes.

import (
	"os"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
)

const (
	islandChainChapter = 1
	islandChainRoot    = "ch1_shipwreck"
	// islandChainLevel is the level the chain's experience reaches, and not the next one.
	islandChainLevel = 8
	// islandExitRoute leaves the starting island; islandExitLevel is what it asks for.
	islandExitRoute = "puerto_to_bosque"
	islandExitLevel = 10
	// maxLevelsPerReward: "about a level and a half". ch1_shipwreck, the first one, is the
	// largest (1.63 after its six wolves and five bats); every other is under one level.
	maxLevelsPerReward = 1.7
)

// levelAt is the level, with its fraction towards the next one, of a total experience.
func levelAt(e content.Experience, xp int64) float64 {
	n := 1
	for e.TotalFor(n+1) <= xp {
		n++
	}
	lo, hi := e.TotalFor(n), e.TotalFor(n+1)
	return float64(n) + float64(xp-lo)/float64(hi-lo)
}

// chainOffer is how a quest of the chain is given: the quest that must be completed
// before it (its giver's option asks for it) and the level that option asks for.
type chainOffer struct {
	after string
	level int
}

// chainOffers reads, from the dialogs, every option that starts a quest (directly, or by
// leading to the node whose accept does) and asks for another quest to be completed.
func chainOffers(npcs content.NPCs) map[string]chainOffer {
	out := map[string]chainOffer{}
	for _, n := range npcs {
		starts := map[string][]string{} // node -> quests its options start
		for id, node := range n.Dialog.Nodes {
			for _, o := range node.Options {
				for _, a := range o.Action {
					if a.StartQuest != "" {
						starts[id] = append(starts[id], a.StartQuest)
					}
				}
			}
		}
		for _, node := range n.Dialog.Nodes {
			for _, o := range node.Options {
				offer := chainOffer{}
				for _, c := range o.If {
					if c.QuestState != nil && c.QuestState.State == "completed" {
						offer.after = c.QuestState.Quest
					}
					offer.level = max(offer.level, c.LevelAtLeast)
				}
				if offer.after == "" {
					continue
				}
				quests := starts[o.Goto]
				for _, a := range o.Action {
					if a.StartQuest != "" {
						quests = append(quests, a.StartQuest)
					}
				}
				for _, q := range quests {
					out[q] = offer
				}
			}
		}
	}
	return out
}

func TestIslandQuestChain(t *testing.T) {
	d := loadData(t)
	quests, err := content.LoadQuests(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	npcs, err := content.LoadNPCs(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	routes, err := content.LoadBoatRoutes(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	exp := d.balance.Experience
	debug := os.Getenv("DEBUG_BALANCE") != ""

	// The chain, in order: from the root, the quest whose offer asks for the last one.
	offers := chainOffers(npcs)
	next := map[string]string{}
	for id, o := range offers {
		if q := quests[id]; q == nil || q.Chapter != islandChainChapter {
			continue
		}
		if other, taken := next[o.after]; taken {
			t.Fatalf("%s and %s both follow %s: the island chain is one line", other, id, o.after)
		}
		next[o.after] = id
	}
	if quests[islandChainRoot] == nil {
		t.Fatalf("no quest %s", islandChainRoot)
	}
	chain := []string{islandChainRoot}
	for id, ok := next[islandChainRoot]; ok; id, ok = next[id] {
		if len(chain) > len(quests) {
			t.Fatal("the island chain loops")
		}
		chain = append(chain, id)
	}
	inChain := map[string]bool{}
	for _, id := range chain {
		inChain[id] = true
	}
	for id, q := range quests {
		if q.Chapter == islandChainChapter && !inChain[id] {
			t.Errorf("%s is of chapter %d but no quest of the chain opens it", id, islandChainChapter)
		}
	}
	if len(chain) < 2 {
		t.Fatalf("the island chain is %v: no quest follows %s", chain, islandChainRoot)
	}

	var questXP, total int64 // the quests' experience alone, and with the chain's own kills
	for _, id := range chain {
		q := quests[id]
		if q.Repeatable != nil || q.Milestone {
			t.Errorf("%s: a quest of the island chain is taken once and alone", id)
		}
		// Never blocked: the experience of the quests before it is enough for its levels.
		have := int(levelAt(exp, questXP))
		if q.MinLevel > have {
			t.Errorf("%s: min_level %d, but the quests before it only give level %d", id, q.MinLevel, have)
		}
		if o := offers[id]; o.level > have {
			t.Errorf("%s: its giver asks for level %d, but the quests before it only give level %d", id, o.level, have)
		}
		var kills int64
		for _, s := range q.Steps {
			if k := s.CompleteWhen.Kill; k != nil {
				m := d.monsters[k.Monster]
				if m == nil {
					t.Fatalf("%s: unknown monster %s", id, k.Monster)
				}
				kills += m.Experience * int64(k.Count)
			}
		}
		xp, _, _ := rewardSums(q)
		if xp <= 0 {
			t.Errorf("%s gives no experience", id)
		}
		before := levelAt(exp, total+kills)
		after := levelAt(exp, total+kills+xp)
		if after-before > maxLevelsPerReward {
			t.Errorf("%s: its %d xp are %.2f levels at once (%.2f -> %.2f), over %.1f",
				id, xp, after-before, before, after, maxLevelsPerReward)
		}
		questXP, total = questXP+xp, total+kills+xp
		if debug {
			t.Logf("%-16s xp %5d  quests alone %5d = level %.2f  | kills %4d  with them %5d = level %.2f (+%.2f)",
				id, xp, questXP, levelAt(exp, questXP), kills, total, after, after-before)
		}
	}

	if lo, hi := exp.TotalFor(islandChainLevel), exp.TotalFor(islandChainLevel+1); questXP < lo || questXP >= hi {
		t.Errorf("the island chain gives %d xp = level %.2f: want level %d (%d) and under %d (%d)",
			questXP, levelAt(exp, questXP), islandChainLevel, lo, islandChainLevel+1, hi)
	}

	// The way out asks for the level the hunt after the chain reaches.
	found := false
	for _, r := range routes {
		if r.ID != islandExitRoute {
			continue
		}
		found = true
		if r.Requires.Level != islandExitLevel {
			t.Errorf("%s asks for level %d, want %d", r.ID, r.Requires.Level, islandExitLevel)
		}
		if !inChain[r.Requires.Quest] {
			t.Errorf("%s asks for quest %q, which is not of the island chain", r.ID, r.Requires.Quest)
		}
	}
	if !found {
		t.Errorf("no boat route %s", islandExitRoute)
	}
	if total >= exp.TotalFor(islandExitLevel) {
		t.Errorf("the chain and its kills give %d xp: level %d, the boat's, must be hunted", total, islandExitLevel)
	}
}
