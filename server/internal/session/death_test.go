package session_test

import (
	"fmt"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/sim"
	"github.com/GFenzoR/RPG_Project/server/internal/skills"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

type ctxFunc func(*game.TickContext)

func (f ctxFunc) Execute(ctx *game.TickContext) { f(ctx) }

func deathHarness(t *testing.T, opts ...option) *harness {
	t.Helper()
	return newHarness(t, worldtest.Open(t, 0, 0, 64, 64), append([]option{func(c *session.Config) {
		c.Monsters = content.Monsters{}
		c.Items = testItems()
	}}, opts...)...)
}

// geared joins a level-level guardian at (40, 40) wearing a sword, a shield, a tunic and
// a backpack with coins, holding the given blessings.
func (h *harness) geared(name string, level int, blessings int) (*fakeClient, *session.Player) {
	h.t.Helper()
	nextChar++
	storage := map[string]int64{}
	for i := range blessings {
		storage[fmt.Sprintf("bless.b%d", i)] = 1
	}
	storage["flag.kept"] = 1
	e := testBalance().Experience
	c := session.Character{ID: nextChar, AccountID: nextChar, Name: name, Vocation: "guardian", Level: level,
		Experience: e.TotalFor(level) + 100, Health: 1, Mana: 0, Pos: pos(40, 40), HasPos: true,
		Skills: []session.SkillState{{ID: "sword", Level: 30, Tries: 10}}, Storage: storage, InventoryLoaded: true,
		Inventory: []session.ItemState{
			{ItemID: swordID, Count: 1, Slot: int(slotRight)},
			{ItemID: shieldID, Count: 1, Slot: int(slotLeft)},
			{ItemID: tunicID, Count: 1, Slot: int(slotArmor)},
			{ItemID: packID, Count: 1, Slot: int(slotBackpack), Items: []session.ItemState{{ItemID: coinID, Count: 50}}},
		}}
	return h.joinChar(c)
}

func (h *harness) kill(p *session.Player) {
	h.sim.Command(ctxFunc(func(ctx *game.TickContext) { h.w.DieForTest(ctx, p) }))
	h.sim.Step()
}

// equipped lists the item ids p wears, by slot.
func equipped(p *session.Player) map[pb.EquipmentSlot]string {
	out := map[pb.EquipmentSlot]string{}
	for s := pb.EquipmentSlot(1); s <= pb.EquipmentSlot_EQUIPMENT_SLOT_AMMO; s++ {
		if it := p.Equipped(s); it != nil {
			out[s] = it.Def().ID
		}
	}
	return out
}

func corpseItems(h *harness) []string {
	var out []string
	for _, c := range h.w.CorpsesAt(pos(40, 40)) {
		for _, it := range c.Item.Items() {
			out = append(out, it.Def().ID)
		}
	}
	return out
}

// Death with 0, 3 and 5 blessings: experience and skills lost by the blessings, items
// moved (never lost) to the corpse, blessings consumed, other storage kept, full health
// and mana at the temple, and the death saved at once.
func TestDeathBlessings(t *testing.T) {
	d := testBalance().Death
	for _, b := range []int{0, 3, 5} {
		t.Run(fmt.Sprintf("%d blessings", b), func(t *testing.T) {
			h := deathHarness(t)
			cl, p := h.geared("Hero", 20, b)
			if got := h.w.Blessings(p); got != b {
				t.Fatalf("blessings = %d", got)
			}
			xp, sword := p.Experience(), h.w.Skill(p, "sword")
			before := len(equipped(p))
			cl.take()
			saves := len(h.saves)
			h.kill(p)

			pen := skills.DeathPenalty(d, b, 20)
			if want := skills.LoseExperience(xp, pen.XPPct); p.Experience() != want {
				t.Errorf("experience %d -> %d, want %d", xp, p.Experience(), want)
			}
			if got := h.w.Skill(p, "sword"); got.Level > sword.Level || got.Level == sword.Level && got.Tries >= sword.Tries {
				t.Errorf("sword %+v -> %+v: nothing lost", sword, got)
			}
			if h.w.Blessings(p) != 0 || p.Storage("flag.kept") != 1 {
				t.Errorf("blessings %d, flag %d", h.w.Blessings(p), p.Storage("flag.kept"))
			}
			dropped := corpseItems(h)
			if len(dropped)+len(equipped(p)) != before {
				t.Errorf("items lost: corpse %v, equipped %v", dropped, equipped(p))
			}
			switch b {
			case 0:
				if equipped(p)[slotBackpack] != "" {
					t.Error("the backpack must always drop without blessings")
				}
			case 5:
				if len(dropped) != 0 {
					t.Errorf("dropped %v with every blessing", dropped)
				}
			}
			if cur, mx := p.Health(); cur != mx || h.w.Mana(p) != p.MaxMana() {
				t.Errorf("health %d/%d mana %d", cur, mx, h.w.Mana(p))
			}
			if chebyshev(p.Pos(), h.w.Map().Islands()[0].Temple) > 3 {
				t.Errorf("woke at %v", p.Pos())
			}
			msgs := find(cl.take(), (*pb.ServerMessage).GetChatMessage)
			if len(msgs) == 0 || msgs[len(msgs)-1].GetLocalized().GetKey() != "death.died" {
				t.Errorf("messages %v", msgs)
			}
			if len(h.saves) != saves+1 || h.saves[len(h.saves)-1].Experience != p.Experience() {
				t.Errorf("death not saved: %d saves", len(h.saves)-saves)
			}
			h.checkInvariants()
		})
	}
}

// Up to novice_max_level a death drops nothing and costs the minimum experience.
func TestDeathNovice(t *testing.T) {
	h := deathHarness(t)
	_, p := h.geared("Novice", 5, 0)
	xp, items := p.Experience(), equipped(p)
	h.kill(p)
	if len(corpseItems(h)) != 0 || len(equipped(p)) != len(items) {
		t.Errorf("novice dropped %v", corpseItems(h))
	}
	if want := skills.LoseExperience(xp, testBalance().Death.XPLossPctAllBlessings); p.Experience() != want {
		t.Errorf("experience %d, want %d", p.Experience(), want)
	}
	if h.w.Level(p) < 1 {
		t.Errorf("level %d", h.w.Level(p))
	}
}

// Losing experience can cost levels: the maximums follow the new level.
func TestDeathLosesLevel(t *testing.T) {
	h := deathHarness(t)
	_, p := h.geared("Edge", 20, 0) // 100 xp above level 20: 10 % takes it to 19
	h.kill(p)
	if h.w.Level(p) != 19 {
		t.Fatalf("level %d", h.w.Level(p))
	}
	if _, mx := p.Health(); mx != testVocations["guardian"].AtLevel(19).Health {
		t.Errorf("max health %d", mx)
	}
}

// The same seed drops the same items.
func TestDeathDropIsDeterministic(t *testing.T) {
	run := func() []string {
		h := deathHarness(t, func(c *session.Config) { c.Balance.Death.EquipmentDropPct = 50 })
		_, p := h.geared("Lucky", 20, 0)
		h.kill(p)
		return corpseItems(h)
	}
	a, b := run(), run()
	if fmt.Sprint(a) != fmt.Sprint(b) {
		t.Fatalf("drops differ: %v vs %v", a, b)
	}
	if len(a) < 2 { // the backpack always, and with seed 7 at least one more piece
		t.Fatalf("dropped %v", a)
	}
}

// Only the owner takes things out of its corpse during corpse_owner_only_ms; then
// anyone can.
func TestDeathCorpseOwnerOnly(t *testing.T) {
	h := deathHarness(t, func(c *session.Config) { c.Balance.Death.EquipmentDropPct = 100 })
	owner, p := h.geared("Owner", 20, 0)
	other, _ := h.join("Other", at(41, 40))
	h.kill(p)
	corpse := h.w.CorpsesAt(pos(40, 40))[0]
	pack := corpse.Item.Items()[0] // everything drops, in slot order: the backpack first
	if pack.Def().ID != "backpack" || len(corpse.Item.Items()) != 4 {
		t.Fatalf("corpse holds %v", corpseItems(h))
	}

	open := func(cl *fakeClient) uint32 {
		cl.take()
		h.input(cl, useItem(onTile(pos(40, 40)), corpseID, 1))
		h.sim.Step()
		opens := find(cl.take(), (*pb.ServerMessage).GetContainerOpen)
		if len(opens) != 1 {
			t.Fatalf("corpse not opened: %v", opens)
		}
		return opens[0].GetContainerId()
	}
	otherID := open(other)
	h.input(other, moveItem(inContainer(otherID, 0), packID, 0, onTile(pos(41, 40)), 1))
	h.sim.Step()
	if msgs := find(other.take(), (*pb.ServerMessage).GetChatMessage); len(msgs) != 1 ||
		msgs[0].GetLocalized().GetKey() != "death.corpse_not_owner" {
		t.Errorf("messages %v", msgs)
	}
	if len(corpse.Item.Items()) != 4 || len(h.w.GroundAt(pos(41, 40))) != 0 {
		t.Fatal("another player took from the corpse")
	}

	// The owner walks back (teleported here) and takes its backpack.
	h.sim.Command(gameFunc(func() { h.w.Teleport(p, pos(39, 40)) }))
	h.sim.Step()
	id := open(owner)
	h.input(owner, moveItem(inContainer(id, 0), packID, 0, inSlot(slotBackpack), 1))
	h.sim.Step()
	if p.Equipped(slotBackpack) != pack {
		t.Fatalf("owner could not take its backpack: %v", find(owner.take(), (*pb.ServerMessage).GetChatMessage))
	}

	// After the reservation, anyone can take what is left.
	h.sim.RunTicks(testBalance().Death.CorpseOwnerOnlyMs / 50)
	left := corpse.Item.Items()[0] // its window stayed open
	other.take()
	h.input(other, moveItem(inContainer(otherID, 0), uint32(left.Def().Numeric), 0, onTile(pos(41, 40)), uint32(left.Count())))
	h.sim.Step()
	if len(h.w.GroundAt(pos(41, 40))) == 0 {
		t.Errorf("other still blocked: %v", find(other.take(), (*pb.ServerMessage).GetChatMessage))
	}
}

// A player killed by a monster wakes at its residence temple with the death rules.
func TestDeathByMonsterRespawnsAtTemple(t *testing.T) {
	def := wolfDef()
	def.Attacks[0].Min, def.Attacks[0].Max = 60, 60
	h := monsterHarness(t, []*content.Monster{def}, spawnAt("wolf", 40, 42, 0, 600))
	cl, p := h.geared("Victim", 20, 0)
	h.sim.RunUntil(func() bool { return chebyshev(p.Pos(), h.w.Map().Islands()[0].Temple) <= 3 }, sim.MaxSeconds(60))
	if cur, mx := p.Health(); cur != mx || h.w.Mana(p) != p.MaxMana() {
		t.Errorf("health %d/%d mana %d", cur, mx, h.w.Mana(p))
	}
	if len(corpseItems(h)) == 0 {
		t.Error("no corpse with the backpack where it died")
	}
	var died bool
	for _, m := range find(cl.take(), (*pb.ServerMessage).GetChatMessage) {
		died = died || m.GetLocalized().GetKey() == "death.died"
	}
	if !died {
		t.Error("no death.died message")
	}
}
