package content_test

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
)

func TestTutorialData(t *testing.T) {
	dir := filepath.Join("..", "..", "..", "data")
	tut, err := content.LoadTutorial(dir)
	if err != nil || tut == nil {
		t.Fatalf("load: %v", err)
	}
	vocs, _ := content.LoadVocations(dir)
	mons, _ := content.LoadMonsters(dir)
	items, _ := content.LoadItems(dir)
	spells, _ := content.LoadSpells(dir)
	npcs, _ := content.LoadNPCs(dir)
	quests, _ := content.LoadQuests(dir)
	recipes, _ := content.LoadRecipes(dir)
	check := func() error { return tut.Check(vocs, mons, items, spells, npcs, quests, recipes) }
	if err := check(); err != nil {
		t.Fatal(err)
	}
	if last := tut.Steps[len(tut.Steps)-1].When; last.Event != content.TriggerQuestStart || quests[last.Ref].Chapter != 1 {
		t.Fatalf("the tutorial must end at a Chapter 1 quest, ends at %+v", last)
	}

	for _, c := range []struct {
		edit func()
		want string
	}{
		{func() { tut.Steps[0].When.Event = "dance" }, "unknown event"},
		{func() { tut.Steps[1].When.Ref = "nobody" }, "unknown ref"},
		{func() { tut.Steps[1].ID = tut.Steps[0].ID }, "duplicate"},
		{func() { tut.Steps[0].Vocations = []string{"bard"} }, "unknown vocation"},
		{func() { tut.Rewards = []content.TutorialReward{{Gold: 50000}} }, "at most 1000"},
	} {
		saved := *tut
		saved.Steps = append([]content.TutorialStep(nil), tut.Steps...)
		c.edit()
		if err := check(); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("want %q, got %v", c.want, err)
		}
		*tut = saved
	}
}
