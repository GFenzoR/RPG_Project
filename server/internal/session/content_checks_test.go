package session_test

import (
	"strings"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
)

// The server refuses content whose food or quest drops would misbehave (content audit m2
// and m9), as it refuses any other broken content: the data of data/ with one thing
// broken at a time.
func TestStartupRefusesBrokenFoodAndQuestDrops(t *testing.T) {
	for _, c := range []struct {
		name  string
		spoil func(*session.Config)
		want  string
	}{
		{"food without well_fed", func(c *session.Config) {
			delete(c.Balance.Conditions, "well_fed")
		}, "is food but"},
		{"well_fed of another kind", func(c *session.Config) {
			c.Balance.Conditions["well_fed"].Kind = content.ConditionInvisible
		}, "is food but"},
		{"well_fed that does not add up", func(c *session.Config) {
			c.Balance.Conditions["well_fed"].Stacking = content.StackRefresh
		}, "must stack with add"},
		{"pure food longer than well_fed lasts", func(c *session.Config) {
			c.Items["ship_biscuit"].Consumable.FoodMs = c.Balance.Conditions["well_fed"].MaxMs + 1
		}, "could never be eaten"},
		{"a quest drop no quest asks for", func(c *session.Config) {
			w := c.Monsters["slagbound_warden"]
			w.Loot = append(w.Loot, content.LootEntry{Item: "pruebas_key", Chance: 1, EachPlayer: true})
		}, "has_item of no quest step"},
		{"a tradeable quest drop", func(c *session.Config) {
			c.Items["forge_seal"].Tradeable = true
		}, "tradeable: false and value: 0"},
		{"a quest drop with a value", func(c *session.Config) {
			c.Items["forge_seal"].Value = 5
		}, "tradeable: false and value: 0"},
		{"a step between a quest drop and its delivery", func(c *session.Config) {
			// [kill, has_item, kill, deliver]: at the delivery a lost seal would never
			// come back (quest.Engine.Needs counts the done has_item step only while the
			// step right after it is current).
			q := c.Quests["ch3_warden"]
			kill := content.QuestStepDef{ID: "again", Description: "d",
				CompleteWhen: content.Completion{Kill: &content.Kill{Monster: "ash_hound", Count: 1}}}
			q.Steps = append(q.Steps[:2:2], kill, q.Steps[2])
		}, "must be followed by its delivery"},
		{"a quest drop without a delivery", func(c *session.Config) {
			q := c.Quests["ch3_warden"]
			q.Steps = q.Steps[:2:2]
		}, "must be followed by its delivery"},
		{"a delivery that does not take the quest drop", func(c *session.Config) {
			// The keeper reads the seal and gives it back: the done take_seal step would
			// stop counting at the delivery, but the player keeps a seal to show again.
			o := &c.NPCs["volcan_keeper"].Dialog.Nodes["ch3_warden"].Options[0]
			if o.Goto != "ch3_seal_read" {
				t.Fatalf("the keeper's first ch3_warden option goes to %q", o.Goto)
			}
			o.Action = nil
		}, `its delivery must take the quest drop: no option of npc "volcan_keeper" that leads to node "ch3_seal_read"`},
	} {
		t.Run(c.name, func(t *testing.T) {
			cfg := dataConfig(t, nil)
			c.spoil(&cfg)
			_, err := session.New(cfg)
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("session.New = %v, want an error with %q", err, c.want)
			}
		})
	}
	// The data as it is starts.
	if _, err := session.New(dataConfig(t, nil)); err != nil {
		t.Fatal(err)
	}
}
