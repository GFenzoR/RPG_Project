package session_test

import (
	"fmt"
	"maps"
	"path/filepath"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/quest"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/sim"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/compile"
)

// The walk through Thimblewick (docs/16-probar-el-juego.md, "Qué probar, en
// orden") played as a player would, on the real world compiled with the dev islands and
// the real content of data/, as make play starts the server: new characters wake up at
// the sandbox island's temple. Every step goes through client messages (talk, walk, buy,
// use, craft, step); the tests only set up what the guide says to get from the
// instructor anyway when that is not the point of the test.

// sandbox is the server of make play: the real world with the dev islands and every
// content file of data/, start town pruebas, saves and transfers acknowledged at once (a
// database that keeps up).
type sandbox struct {
	*harness
	m         *world.Map
	pf        *world.Pathfinder
	items     content.Items
	vocations content.Vocations
	spells    content.Spells
	transfers []session.Transfer
	// healers say how each player heals itself in huntPen (nil: it does not).
	healers map[*session.Player]func()
	// casters cast an attack spell on huntPen's target, every two seconds (nil: they do not).
	casters map[*session.Player]func(target uint32)
	// seen are the remains huntWith already counted.
	seen map[*session.Corpse]bool
	// packs are the open backpack windows (packWindow).
	packs map[*session.Player]packWin
	// mayDie lets a hunt end in a death, recorded in deaths, instead of failing the test.
	mayDie bool
	deaths []*session.Player
}

// The places of the sandbox island the tests use (docs/16, "La isla, sector por sector").
var (
	sbTemple     = at3(2095, 2086, 7)
	sbVault      = at3(2117, 2101, 7) // the practice gate
	sbBoard      = at3(2091, 2103, 7)
	sbForge      = at3(2070, 2102, 7)
	sbAnvil      = at3(2073, 2102, 7)
	sbHearth     = at3(2076, 2102, 7)
	sbHouseDoor  = at3(2088, 2114, 7)
	sbHouseExit  = at3(2088, 2115, 7)
	sbStairsDown = at3(2121, 2090, 7)
	sbStairsUp   = at3(2121, 2090, 8)
	sbTrapdoor   = at3(2116, 2090, 7)
	sbLadderUp   = at3(2116, 2090, 8)
	sbHole       = at3(2119, 2094, 7)
	sbRopeSpot   = at3(2119, 2094, 8)
	sbTeleport   = at3(2113, 2104, 8)
	sbTeleportTo = at3(2095, 2094, 7)
)

func newSandbox(t *testing.T) *sandbox {
	t.Helper()
	root := filepath.Join("..", "..", "..")
	dir := filepath.Join(root, "data")
	m, err := compile.Build(root, compile.Options{DevIslands: true})
	if err != nil {
		t.Fatal(err)
	}
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	// dataConfig took out the dialog teleports that miss its small map (the ferryman's):
	// on the real map they all land.
	npcs, err := content.LoadNPCs(dir)
	must(err)
	routes, err := content.LoadBoatRoutes(dir)
	must(err)
	spells, err := content.LoadSpells(dir)
	must(err)
	recipes, err := content.LoadRecipes(dir)
	must(err)
	tutorial, err := content.LoadTutorial(dir)
	must(err)
	living, err := session.LoadLivingWorld(dir)
	must(err)
	s := &sandbox{m: m, pf: world.NewPathfinder(m, 0), healers: map[*session.Player]func(){},
		casters: map[*session.Player]func(uint32){}, seen: map[*session.Corpse]bool{}, packs: map[*session.Player]packWin{}}
	s.harness = dataHarnessWith(t, func(cfg *session.Config) {
		cfg.Map, cfg.StartTown = m, "pruebas"
		cfg.NPCs, cfg.BoatRoutes, cfg.Spells, cfg.Recipes, cfg.Tutorial = npcs, routes, spells, recipes, tutorial
		cfg.LivingWorld = living
		cfg.Quests = realQuests(t) // dataConfig parked the reach steps (parkReachSteps)
		s.items, s.vocations, s.spells = cfg.Items, cfg.Vocations, spells
		save := cfg.Save
		cfg.Save = func(sn session.Snapshot) bool {
			save(sn)
			s.ack(sn)
			return true
		}
		cfg.Transfer = func(tr session.Transfer) bool {
			s.transfers = append(s.transfers, tr)
			for _, sn := range tr.Snapshots {
				s.ack(sn)
			}
			return true
		}
	})
	return s
}

// ack acknowledges a written snapshot on the next tick, as the Saver does once it wrote
// it (never in the tick that submitted it: Save and Transfer run on the loop).
func (s *sandbox) ack(sn session.Snapshot) {
	s.sim.Schedule(1, func(ctx *game.TickContext) { s.w.Saved(sn.CharacterID, sn.Seq).Execute(ctx) })
}

// newcomer logs in a character that never played (level 1, its vocation's starting health and
// mana): it wakes up at the temple of the start town with the starting backpack.
func (s *sandbox) newcomer(id int64, name, vocation string) (*fakeClient, *session.Player) {
	s.t.Helper()
	start := s.vocations[vocation].Start
	cl, p := s.joinChar(session.Character{ID: id, AccountID: id, Name: name, Vocation: vocation, Level: 1,
		Health: start.Health, Mana: start.Mana})
	s.sim.Step()
	cl.take()
	return cl, p
}

func (s *sandbox) num(id string) uint32 {
	s.t.Helper()
	it := s.items[id]
	if it == nil {
		s.t.Fatalf("no item %s in data/items", id)
	}
	return uint32(it.Numeric)
}

// walkTo walks p to `to` as the client does: an A* path on the map (around creatures,
// houses and the tiles that move whoever steps on them, but the goal) sent as WalkPath,
// again if something got in the way.
func (s *sandbox) walkTo(cl *fakeClient, p *session.Player, to world.Pos) {
	s.t.Helper()
	s.walkWithin(cl, p, to, 0)
}

// walkWithin is walkTo that settles for a tile at most near tiles from `to` when creatures
// keep standing in the way.
func (s *sandbox) walkWithin(cl *fakeClient, p *session.Player, to world.Pos, near int) {
	s.t.Helper()
	s.walkGroup([]fighter{{cl: cl, p: p}}, to, near, nil)
	cl.take()
}

// walkGroup walks every player of team to `to` at once (walkTo), and settles for tiles at
// most near tiles from it when creatures (one another, too) keep standing in the way.
// during runs before every tick of the walk (nil: nothing).
func (s *sandbox) walkGroup(team []fighter, to world.Pos, near int, during func()) {
	s.t.Helper()
	for try := 0; ; try++ {
		var left []fighter
		for _, f := range team {
			nearBy := f.p.Pos().Z == to.Z && chebyshev(f.p.Pos(), to) <= near
			if f.p.Pos() != to && (try == 0 || !nearBy) {
				left = append(left, f)
			}
		}
		if len(left) == 0 {
			return
		}
		if try == 8 {
			s.t.Fatalf("%v did not get to %v", left[0].p.Pos(), to)
		}
		for _, f := range left {
			// No path: a creature stands in a narrow way; the next try waits for it.
			if steps, ok := s.pathFor(f.p, to); ok {
				s.input(f.cl, walkPath(steps...))
			}
		}
		s.sim.RunUntil(func() bool {
			if during != nil {
				during()
			}
			for _, f := range left {
				if f.p.Walking() {
					return false
				}
			}
			return true
		}, sim.MaxSeconds(300))
		for range 20 {
			if during != nil {
				during()
			}
			s.sim.Step()
		}
	}
}

// pathFor is the walk the client sends for p to `to`: A* on the map around creatures,
// houses (but the one of `to`) and the tiles that move whoever steps on them (but `to`).
func (s *sandbox) pathFor(p *session.Player, to world.Pos) ([]pb.Direction, bool) {
	busy := map[world.Pos]bool{}
	for _, m := range s.w.Monsters() {
		busy[m.Pos()] = true
	}
	for _, n := range s.w.NPCs() {
		busy[n.Pos()] = true
	}
	for _, o := range s.w.Players() {
		if o != p {
			busy[o.Pos()] = true
		}
	}
	house := s.m.HouseAt(to)
	path, ok := s.pf.FindAvoiding(p.Pos(), to, nil, func(q world.Pos) bool {
		if q == to {
			return false
		}
		h := s.m.HouseAt(q)
		return busy[q] || s.m.MovesOnStep(q) || h != nil && h != house
	})
	if !ok || len(path) == 0 {
		return nil, false
	}
	steps := make([]pb.Direction, len(path))
	for i, d := range path {
		steps[i] = pb.Direction(d + 1)
	}
	return steps, true
}

// walkNear walks p next to `to` (a tile it cannot stand on: an NPC, a station, a vein),
// to the free walkable neighbour nearest p (no other creature on it).
func (s *sandbox) walkNear(cl *fakeClient, p *session.Player, to world.Pos) {
	s.t.Helper()
	if chebyshev(p.Pos(), to) == 1 && p.Pos().Z == to.Z {
		return
	}
	taken := map[world.Pos]bool{}
	for _, o := range s.w.Players() {
		taken[o.Pos()] = o != p
	}
	for _, m := range s.w.Monsters() {
		taken[m.Pos()] = true
	}
	best, found := world.Pos{}, false
	for dy := -1; dy <= 1; dy++ {
		for dx := -1; dx <= 1; dx++ {
			q := world.Pos{X: uint16(int(to.X) + dx), Y: uint16(int(to.Y) + dy), Z: to.Z}
			if q == to || taken[q] || !s.m.Walkable(q) || s.m.MovesOnStep(q) || s.m.HouseAt(q) != nil {
				continue
			}
			if !found || chebyshev(p.Pos(), q) < chebyshev(p.Pos(), best) {
				best, found = q, true
			}
		}
	}
	if !found {
		s.t.Fatalf("nothing walkable next to %v", to)
	}
	s.walkTo(cl, p, best)
}

// talk walks up to the NPC kind and greets it.
func (s *sandbox) talk(cl *fakeClient, p *session.Player, kind string) *pb.DialogOpen {
	s.t.Helper()
	n := s.npc(kind)
	if chebyshev(p.Pos(), n.Pos()) > session.TalkRange {
		s.walkNear(cl, p, n.Pos())
	}
	return s.lastDialog(s.send(cl, talkMsg(n.ID())))
}

// say picks the option key of d and returns the next window (nil if it closed).
func (s *sandbox) say(cl *fakeClient, d *pb.DialogOpen, key string) (*pb.DialogOpen, []*pb.ServerMessage) {
	s.t.Helper()
	evs := s.pick(cl, d, key)
	ds := find(evs, (*pb.ServerMessage).GetDialogOpen)
	if len(ds) == 0 {
		return nil, evs
	}
	return ds[len(ds)-1], evs
}

func hasOption(d *pb.DialogOpen, key string) bool {
	for _, o := range d.Options {
		if o.Text.Key == key {
			return true
		}
	}
	return false
}

// TestSandboxInstructor: a newcomer wakes up at the sandbox temple (no tutorial: that is
// Puerto's), and the instructor gives experience, money and healing, and the practice
// quest: three bilge rats of pen 1, handed in for its reward.
func TestSandboxInstructor(t *testing.T) {
	s := newSandbox(t)
	cl, p := s.newcomer(5001, "Novata", "guardian")
	if p.Pos() != sbTemple {
		t.Fatalf("a newcomer wakes up at %v, want the sandbox temple %v", p.Pos(), sbTemple)
	}
	if step := p.TutorialStep(s.w); step != "" {
		t.Fatalf("a newcomer of the sandbox island is in the tutorial at %q", step)
	}

	d := s.talk(cl, p, "pruebas_trainer")
	for _, k := range []string{"npc.pruebas_trainer.opt_quest", "npc.pruebas_trainer.opt_xp",
		"npc.pruebas_trainer.opt_train", "npc.pruebas_trainer.opt_gold", "npc.pruebas_trainer.opt_heal", "dialog.bye"} {
		if !hasOption(d, k) {
			t.Fatalf("the instructor's greeting has no %s: %v", k, d.Options)
		}
	}
	// Experience: 5000 is level 8 (TestSandboxArena asks twice for 50 000: level 20).
	d, _ = s.say(cl, d, "npc.pruebas_trainer.opt_xp")
	d, _ = s.say(cl, d, "npc.pruebas_trainer.opt_xp_small")
	if lvl := s.w.Level(p); lvl != 8 {
		t.Fatalf("5000 experience: level %d, want 8", lvl)
	}
	d, _ = s.say(cl, d, "dialog.back")
	// Money: one gold coin per pick.
	d, _ = s.say(cl, d, "npc.pruebas_trainer.opt_gold")
	if s.w.Money(p) != 10000 || s.w.CountItem(p, "gold_coin") != 1 {
		t.Fatalf("money: %d (%d gold coins)", s.w.Money(p), s.w.CountItem(p, "gold_coin"))
	}
	d, _ = s.say(cl, d, "npc.pruebas_trainer.opt_gold")
	if s.w.Money(p) != 20000 {
		t.Fatalf("money after asking twice: %d", s.w.Money(p))
	}
	d, _ = s.say(cl, d, "dialog.back")
	// The quest: offer, accept.
	d, _ = s.say(cl, d, "npc.pruebas_trainer.opt_quest")
	d, evs := s.say(cl, d, "dialog.accept")
	if !messageKeys(evs)["dialog.quest_started"] {
		t.Fatalf("accept: %v", messageKeys(evs))
	}
	if st, step := s.w.QuestState(p, "pruebas_rats"); st != quest.InProgress || step != "hunt_rats" {
		t.Fatalf("quest %v at %q", st, step)
	}
	s.say(cl, d, "dialog.bye")

	// A hand axe from the provisioner, then the rats of pen 1.
	shop := s.openShop(cl, p)
	shop.buy("hatchet", 1)
	s.equip(cl, p, "hatchet", slotRight)
	s.huntPen(cl, p, "bilge_rat", 3, penGap(1), penAway(1))
	if st, step := s.w.QuestState(p, "pruebas_rats"); st != quest.InProgress || step != "report" {
		t.Fatalf("after three rats: quest %v at %q", st, step)
	}

	// Back at the temple: heal (health and mana), then hand the quest in.
	d = s.talk(cl, p, "pruebas_trainer")
	if hasOption(d, "npc.pruebas_trainer.opt_quest") || !hasOption(d, "npc.pruebas_trainer.opt_quest_done") {
		t.Fatalf("greeting with the rats done: %v", d.Options)
	}
	s.sim.Command(gameFunc(func() { p.SetHealthForTest(10); p.SetManaForTest(0) }))
	s.sim.Step()
	d, _ = s.say(cl, d, "npc.pruebas_trainer.opt_heal")
	if hp, maxHP := p.Health(); hp != maxHP || p.Mana() != p.MaxMana() {
		t.Fatalf("healed to %d of %d health, %d of %d mana", hp, maxHP, p.Mana(), p.MaxMana())
	}
	d, _ = s.say(cl, d, "dialog.back")
	xp, money := p.Experience(), s.w.Money(p)
	doneAt := s.sim.Now()
	d, evs = s.say(cl, d, "npc.pruebas_trainer.opt_quest_done")
	if st, _ := s.w.QuestState(p, "pruebas_rats"); st != quest.Completed {
		t.Fatalf("handed in: quest %v", st)
	}
	if p.Experience() != xp+200 || s.w.Money(p) != money+50 {
		t.Fatalf("reward: %d experience, %d money (want +200, +50)", p.Experience()-xp, s.w.Money(p)-money)
	}
	// A task (repeatable, docs/06 "Quest"): the quest log says when it comes back, three
	// minutes after it was done, and meanwhile she only says the pen is filling up.
	if e := logEntry(t, evs, "pruebas_rats"); e.GetState() != pb.QuestLogState_QUEST_LOG_STATE_COOLING || !e.GetRepeatable() ||
		e.GetAvailableAt() != uint64(doneAt.Unix()+180)*1000 {
		t.Fatalf("quest log after the hand-in: %v (done at %v)", e, doneAt)
	}
	d, _ = s.say(cl, d, "dialog.back")
	if hasOption(d, "npc.pruebas_trainer.opt_quest") || hasOption(d, "npc.pruebas_trainer.opt_quest_done") ||
		!hasOption(d, "npc.pruebas_trainer.opt_quest_cooling") {
		t.Fatalf("greeting after the quest: %v", d.Options)
	}
	if d, _ = s.say(cl, d, "npc.pruebas_trainer.opt_quest_cooling"); d.Text.Key != "npc.pruebas_trainer.quest_cooling" {
		t.Fatalf("cooling down: %s", d.Text.Key)
	}
	s.say(cl, d, "dialog.bye")
	s.sim.Clock().Advance(3 * time.Minute)
	s.sim.Step()
	d = s.talk(cl, p, "pruebas_trainer")
	if !hasOption(d, "npc.pruebas_trainer.opt_quest") || hasOption(d, "npc.pruebas_trainer.opt_quest_cooling") {
		t.Fatalf("greeting three minutes later: %v", d.Options)
	}
	// Again from the first step, no rat counted, and rewarded again.
	d, _ = s.say(cl, d, "npc.pruebas_trainer.opt_quest")
	d, evs = s.say(cl, d, "dialog.accept")
	if e := logEntry(t, evs, "pruebas_rats"); e.GetState() != pb.QuestLogState_QUEST_LOG_STATE_ACTIVE || e.GetStepId() != "hunt_rats" ||
		e.GetKills() != 0 || e.GetKillsNeeded() != 3 || e.GetAvailableAt() != 0 {
		t.Fatalf("quest log of the second turn: %v", e)
	}
	s.say(cl, d, "dialog.bye")
	s.huntPen(cl, p, "bilge_rat", 3, penGap(1), penAway(1))
	d = s.talk(cl, p, "pruebas_trainer")
	xp, money = p.Experience(), s.w.Money(p)
	s.say(cl, d, "npc.pruebas_trainer.opt_quest_done")
	if st, _ := s.w.QuestState(p, "pruebas_rats"); st != quest.Completed || p.Experience() != xp+200 || s.w.Money(p) != money+50 {
		t.Fatalf("second turn: quest %v, %d experience, %d money (want +200, +50)", st, p.Experience()-xp, s.w.Money(p)-money)
	}
}

// shopWin is the provisioner's shop window, open on a client.
type shopWin struct {
	s    *sandbox
	cl   *fakeClient
	p    *session.Player
	d    *pb.DialogOpen
	open *pb.ShopOpen
}

// openShop walks up to the provisioner and opens his shop.
func (s *sandbox) openShop(cl *fakeClient, p *session.Player) *shopWin {
	s.t.Helper()
	d := s.talk(cl, p, "pruebas_merchant")
	evs := s.pick(cl, d, "dialog.trade")
	shops := find(evs, (*pb.ServerMessage).GetShopOpen)
	if len(shops) != 1 {
		s.t.Fatalf("the provisioner's trade option opened %d shops: %v", len(shops), messageKeys(evs))
	}
	return &shopWin{s: s, cl: cl, p: p, d: d, open: shops[0]}
}

func (w *shopWin) offer(id string) *pb.ShopOffer {
	for _, o := range w.open.Offers {
		if o.ItemId == w.s.num(id) {
			return o
		}
	}
	return nil
}

func (w *shopWin) refresh(evs []*pb.ServerMessage) {
	if o := find(evs, (*pb.ServerMessage).GetShopOpen); len(o) > 0 {
		w.open = o[len(o)-1]
	}
}

// buy buys n of id and checks it was paid at the shop's price and carried.
func (w *shopWin) buy(id string, n uint32) {
	w.s.t.Helper()
	o := w.offer(id)
	if o == nil || o.BuyPrice == 0 {
		w.s.t.Fatalf("the provisioner does not sell %s", id)
	}
	money, had := w.s.w.Money(w.p), w.s.w.CountItem(w.p, id)
	evs := w.s.send(w.cl, &pb.ClientMessage{Message: &pb.ClientMessage_ShopBuy{ShopBuy: &pb.ShopBuy{
		DialogId: w.d.DialogId, ItemId: o.ItemId, Count: n}}})
	w.refresh(evs)
	if paid := money - w.s.w.Money(w.p); paid != int64(o.BuyPrice)*int64(n) || w.s.w.CountItem(w.p, id) != had+int(n) {
		w.s.t.Fatalf("buy %d %s at %d: paid %d, carries %d (had %d): %v", n, id, o.BuyPrice, paid,
			w.s.w.CountItem(w.p, id), had, messageKeys(evs))
	}
}

// sell sells n of id and checks it was paid at the shop's price.
func (w *shopWin) sell(id string, n uint32) {
	w.s.t.Helper()
	o := w.offer(id)
	if o == nil || o.SellPrice == 0 {
		w.s.t.Fatalf("the provisioner does not buy %s", id)
	}
	money, had := w.s.w.Money(w.p), w.s.w.CountItem(w.p, id)
	evs := w.s.send(w.cl, &pb.ClientMessage{Message: &pb.ClientMessage_ShopSell{ShopSell: &pb.ShopSell{
		DialogId: w.d.DialogId, ItemId: o.ItemId, Count: n}}})
	w.refresh(evs)
	if got := w.s.w.Money(w.p) - money; got != int64(o.SellPrice)*int64(n) || w.s.w.CountItem(w.p, id) != had-int(n) {
		w.s.t.Fatalf("sell %d %s at %d: got %d, carries %d (had %d): %v", n, id, o.SellPrice, got,
			w.s.w.CountItem(w.p, id), had, messageKeys(evs))
	}
}

// packWindow returns the window of p's backpack, opening it the first time (the client
// keeps it open: a second use would close it).
func (s *sandbox) packWindow(cl *fakeClient, p *session.Player) uint32 {
	s.t.Helper()
	pack := p.Equipped(slotBackpack)
	if w, ok := s.packs[p]; ok && w.pack == pack {
		return w.id
	}
	for range 2 {
		evs := s.send(cl, useItem(inSlot(slotBackpack), uint32(pack.Def().Numeric), 0))
		if o := find(evs, (*pb.ServerMessage).GetContainerOpen); len(o) == 1 {
			s.packs[p] = packWin{pack, o[0].ContainerId}
			return o[0].ContainerId
		}
	}
	s.t.Fatal("the backpack does not open")
	return 0
}

// packWin is an open backpack window: the backpack and the window id.
type packWin struct {
	pack *session.Item
	id   uint32
}

// packIndex is the index of the first stack of id in p's backpack.
func (s *sandbox) packIndex(p *session.Player, id string) uint32 {
	s.t.Helper()
	for i, it := range p.Equipped(slotBackpack).Items() {
		if it.Def().ID == id {
			return uint32(i)
		}
	}
	s.t.Fatalf("no %s in the backpack", id)
	return 0
}

// equip drags id from the backpack to slot.
func (s *sandbox) equip(cl *fakeClient, p *session.Player, id string, slot pb.EquipmentSlot) {
	s.t.Helper()
	// What the slot holds (the start_kit's weapon or shield) goes to the floor first.
	if old := p.Equipped(slot); old != nil {
		s.send(cl, moveItem(inSlot(slot), s.num(old.Def().ID), 0, onTile(p.Pos()), uint32(old.Count())))
	}
	win := s.packWindow(cl, p)
	n := uint32(1)
	if s.items[id].Stackable {
		n = uint32(s.w.CountItem(p, id))
	}
	evs := s.send(cl, moveItem(inContainer(win, s.packIndex(p, id)), s.num(id), 0, inSlot(slot), n))
	if eq := p.Equipped(slot); eq == nil || eq.Def().ID != id {
		s.t.Fatalf("equip %s in %v: %v", id, slot, systemKeys(evs))
	}
}

// fighter is a player of a hunt and its client.
type fighter struct {
	cl *fakeClient
	p  *session.Player
}

// huntPen walks p to `in` (the gap of a pen) and fights the monsters of kind there, with
// chase on, until n of them died. It returns the loot of the remains they left.
func (s *sandbox) huntPen(cl *fakeClient, p *session.Player, kind string, n int, in, away world.Pos) [][]*pb.ItemStack {
	s.t.Helper()
	return s.huntWith([]fighter{{cl: cl, p: p}}, kind, n, in, away)
}

// huntWith is huntPen for a group: all of them walk to `in` and attack the monster
// nearest the first one. When no monster of kind is left in view, they step out to
// `away` until one is back: monsters do not respawn where a player looks. Below 70 %
// health each heals itself as its healer says (s.healers), at most once a second, and
// casters cast at the target every two seconds (s.casters); none may die (unless
// s.mayDie: the hunt stops at the first death).
func (s *sandbox) huntWith(team []fighter, kind string, n int, in, away world.Pos) [][]*pb.ItemStack {
	s.t.Helper()
	lead := team[0].p
	var loot [][]*pb.ItemStack
	healAt, castAt := map[*session.Player]int64{}, map[*session.Player]int64{}
	// A death costs experience (death.xp_loss_pct), which nothing else takes.
	var died *session.Player
	xp := map[*session.Player]int64{}
	for _, f := range team {
		xp[f.p] = f.p.Experience()
	}
	watch := func(target *session.Monster) {
		now := int64(s.sim.Tick())
		for _, f := range team {
			if f.p.Experience() < xp[f.p] {
				died = f.p
			}
			xp[f.p] = f.p.Experience()
			for _, b := range f.cl.batches {
				for _, e := range b.Events {
					if e.GetChatMessage().GetLocalized().GetKey() == "death.died" {
						died = f.p
					}
				}
			}
			f.cl.batches = nil
			if hp, maxHP := f.p.Health(); hp*10 < maxHP*7 && s.healers[f.p] != nil && now >= healAt[f.p] {
				s.healers[f.p]()
				healAt[f.p] = now + 20
			}
			if c := s.casters[f.p]; c != nil && target != nil && now >= castAt[f.p] {
				c(target.ID())
				castAt[f.p] = now + 40
			}
		}
	}
	walk := func(to world.Pos) { s.walkGroup(team, to, 3, func() { watch(nil) }) }
	for _, f := range team {
		s.input(f.cl, fightMode(pb.FightStance_FIGHT_STANCE_OFFENSIVE, true))
	}
	walk(in)
	// attacker is a monster after one of the team: they fight back whatever it is.
	attacker := func() *session.Monster {
		for _, m := range s.w.Monsters() {
			for _, f := range team {
				if m.TargetID() == f.p.ID() {
					return m
				}
			}
		}
		return nil
	}
	// kill fights m until it dies and reports where it was last seen.
	kill := func(m *session.Monster) world.Pos {
		for _, f := range team {
			s.input(f.cl, setTarget(m.ID()))
		}
		last := m.Pos()
		s.sim.RunUntil(func() bool {
			watch(m)
			for _, o := range s.w.Monsters() {
				if o == m {
					last = o.Pos()
					return died != nil
				}
			}
			return true
		}, sim.MaxSeconds(600))
		return last
	}
	for killed := 0; killed < n && died == nil; {
		target := s.nearest(kind, lead.Pos(), 12)
		if target == nil {
			if m := attacker(); m != nil {
				kill(m)
				continue
			}
			walk(away)
			s.sim.RunUntil(func() bool {
				watch(nil)
				return died != nil || s.nearest(kind, in, 8) != nil || attacker() != nil
			}, sim.MaxSeconds(600))
			if died == nil && attacker() == nil {
				walk(in)
			}
			continue
		}
		last := kill(target)
		if died != nil {
			break
		}
		killed++
		// The remains lie where it died: where it was last seen, or a step further.
		for dy := -1; dy <= 1; dy++ {
			for dx := -1; dx <= 1; dx++ {
				for _, c := range s.w.CorpsesAt(at3(int(last.X)+dx, int(last.Y)+dy, int(last.Z))) {
					if !s.seen[c] && c.Monster == kind {
						s.seen[c] = true
						loot = append(loot, c.Loot())
					}
				}
			}
		}
	}
	if died != nil {
		if s.mayDie {
			s.deaths = append(s.deaths, died)
			return loot
		}
		s.t.Fatalf("player %d (level %d) died hunting %s: %s", died.ID(), s.w.Level(died), kind, s.monstersNear(in))
	}
	return loot
}

// nearest is the monster of kind on p's floor nearest p, at most within tiles of it.
func (s *sandbox) nearest(kind string, p world.Pos, within int) *session.Monster {
	var best *session.Monster
	for _, m := range s.w.Monsters() {
		if d := chebyshev(m.Pos(), p); m.Kind() == kind && m.Pos().Z == p.Z && d <= within &&
			(best == nil || d < chebyshev(best.Pos(), p)) {
			best = m
		}
	}
	return best
}

// huntForLoot hunts kind at `in` with team (huntWith) until one of them leaves loot, at
// most most kills (with s.mayDie, until one of the team dies: then nil).
func (s *sandbox) huntForLoot(kind string, in, away world.Pos, most int, team ...fighter) []*pb.ItemStack {
	s.t.Helper()
	for range most {
		for _, l := range s.huntWith(team, kind, 1, in, away) {
			if len(l) > 0 {
				return l
			}
		}
		if len(s.deaths) > 0 {
			return nil
		}
	}
	s.t.Fatalf("%d %s left no loot", most, kind)
	return nil
}

// TestSandboxProvisioner: the provisioner's shop shows what data/ says he sells and buys,
// at those prices; a newcomer pays with the instructor's gold coin (the change comes back
// in smaller coins), buys a ranger's kit, the key and a rope, sells him what he buys
// back and cannot sell him what he sells. Money cannot be made buying and selling: no
// shop of data/ buys an item for what a shop sells it (make validate checks that), and no
// recipe makes of what shops sell more than shops pay for what it makes.
func TestSandboxProvisioner(t *testing.T) {
	s := newSandbox(t)
	cl, p := s.newcomer(5002, "Tendera", "ranger")
	d := s.talk(cl, p, "pruebas_trainer")
	s.say(cl, d, "npc.pruebas_trainer.opt_gold")

	dir := filepath.Join("..", "..", "..", "data")
	npcs, err := content.LoadNPCs(dir)
	if err != nil {
		t.Fatal(err)
	}
	def := npcs["pruebas_merchant"].Shop
	want := map[uint32][2]uint64{}
	for _, o := range def.Sells {
		w := want[s.num(o.Item)]
		w[0] = uint64(o.Price)
		want[s.num(o.Item)] = w
	}
	for _, o := range def.Buys {
		w := want[s.num(o.Item)]
		w[1] = uint64(o.Price)
		want[s.num(o.Item)] = w
	}
	shop := s.openShop(cl, p)
	if shop.open.Money != 10000 || len(shop.open.Offers) != len(want) {
		t.Fatalf("shop with %d money, %d lines (want 10000, %d)", shop.open.Money, len(shop.open.Offers), len(want))
	}
	for _, o := range shop.open.Offers {
		if w := want[o.ItemId]; w != [2]uint64{o.BuyPrice, o.SellPrice} {
			t.Errorf("item %d: sold at %d, bought at %d; data/ says %d and %d", o.ItemId, o.BuyPrice, o.SellPrice, w[0], w[1])
		}
	}

	for _, b := range []struct {
		id string
		n  uint32
	}{{"short_bow", 1}, {"arrow", 60}, {"patched_tunic", 1}, {"sailcloth_cap", 1}, {"canvas_trousers", 1},
		{"tarred_boots", 1}, {"seaweed_poultice", 2}, {"ship_biscuit", 5}, {"rope", 1}, {"pruebas_key", 1}} {
		shop.buy(b.id, b.n) // each purchase checks its price
	}
	if s.w.CountItem(p, "gold_coin") != 0 || s.w.Money(p) == 0 {
		t.Fatalf("after shopping: %d money, %d gold coins (the gold coin breaks into change)", s.w.Money(p), s.w.CountItem(p, "gold_coin"))
	}
	for _, slot := range []struct {
		id   string
		slot pb.EquipmentSlot
	}{{"short_bow", slotRight}, {"arrow", pb.EquipmentSlot_EQUIPMENT_SLOT_AMMO}, {"patched_tunic", slotArmor},
		{"sailcloth_cap", slotHead}, {"canvas_trousers", pb.EquipmentSlot_EQUIPMENT_SLOT_LEGS},
		{"tarred_boots", pb.EquipmentSlot_EQUIPMENT_SLOT_FEET}} {
		s.equip(cl, p, slot.id, slot.slot)
	}

	// He does not buy back what he sells (a sale he refuses changes nothing).
	money := s.w.Money(p)
	for _, id := range []string{"rope", "pruebas_key", "seaweed_poultice", "ship_biscuit"} {
		evs := s.send(cl, &pb.ClientMessage{Message: &pb.ClientMessage_ShopSell{ShopSell: &pb.ShopSell{
			DialogId: shop.d.DialogId, ItemId: s.num(id), Count: 1}}})
		if !hasKey(evs, "inventory.not_possible") || s.w.Money(p) != money || s.w.CountItem(p, id) == 0 {
			t.Fatalf("sold %s back: %v", id, systemKeys(evs))
		}
	}
	// What he buys (TestSandboxTrades sells him what it gathers and makes).
	for _, o := range def.Buys {
		s.sim.Command(gameFunc(func() { s.w.GiveForTest(p, o.Item, 2) }))
		s.sim.Step()
		shop.sell(o.Item, 2)
	}

	// Every shop of data/: none buys an item for what one sells it (as make validate
	// checks), and no recipe pays more for its output than its inputs cost.
	recipes, err := content.LoadRecipes(dir)
	if err != nil {
		t.Fatal(err)
	}
	cheapest, dearest := map[string]int64{}, map[string]int64{}
	for _, n := range npcs {
		if n.Shop == nil {
			continue
		}
		for _, o := range n.Shop.Sells {
			if c, ok := cheapest[o.Item]; !ok || o.Price < c {
				cheapest[o.Item] = o.Price
			}
		}
		for _, o := range n.Shop.Buys {
			dearest[o.Item] = max(dearest[o.Item], o.Price)
		}
	}
	for item, buys := range dearest {
		if sells, ok := cheapest[item]; ok && buys >= sells {
			t.Errorf("%s: a shop sells it for %d and a shop buys it for %d", item, sells, buys)
		}
	}
	for _, r := range recipes {
		cost, bought := int64(0), true
		for _, in := range r.Inputs {
			c, ok := cheapest[in.Item]
			cost += c * int64(in.Count)
			bought = bought && ok
		}
		if pays := dearest[r.Output.Item] * int64(r.Output.Count); bought && pays >= cost {
			t.Errorf("recipe %s: its inputs cost %d at the shops and its output sells for %d", r.ID, cost, pays)
		}
	}
}

// TestSandboxFerry: the ferryman of the sandbox dock takes 20 coins for a one-way trip to
// each real island, landing where the real boats land; without the fare nobody sails.
// Whoever dies there wakes up back at the sandbox temple.
func TestSandboxFerry(t *testing.T) {
	s := newSandbox(t)
	cl, p := s.newcomer(5003, "Viajera", "druid")
	d := s.talk(cl, p, "pruebas_ferryman")
	d, _ = s.say(cl, d, "dialog.ask_travel")
	before := p.Pos()
	_, evs := s.say(cl, d, "npc.pruebas_ferryman.to_harbour")
	if p.Pos() != before || s.w.Money(p) != 0 {
		t.Fatalf("sailed without the fare to %v: %v", p.Pos(), messageKeys(evs))
	}
	dock := p.Pos()
	for i, trip := range []struct {
		opt, island string
		to          world.Pos
	}{
		{"npc.pruebas_ferryman.to_harbour", "puerto", at3(3201, 6432, 7)},
		{"npc.pruebas_ferryman.to_forest", "bosque", at3(4120, 6100, 7)},
		{"npc.pruebas_ferryman.to_volcan", "volcan", at3(3617, 5795, 7)},
	} {
		if i > 0 { // back on the dock, as a GM's /tp would bring it
			s.sim.Command(gameFunc(func() { s.w.Teleport(p, dock) }))
			s.sim.Step()
			cl.take()
		}
		s.sim.Command(gameFunc(func() { s.w.GiveForTest(p, "copper_coin", 25) }))
		s.sim.Step()
		d := s.talk(cl, p, "pruebas_ferryman")
		d, _ = s.say(cl, d, "dialog.ask_travel")
		s.say(cl, d, trip.opt)
		is := s.m.Island(trip.island)
		if chebyshev(p.Pos(), trip.to) > 1 || p.Pos().Z != trip.to.Z || is == nil || !inIsland(is, p.Pos()) {
			t.Fatalf("%s: landed at %v, want by %v", trip.opt, p.Pos(), trip.to)
		}
		if s.w.Money(p) != 5 {
			t.Fatalf("%s: %d coins left of 25", trip.opt, s.w.Money(p))
		}
		s.sim.Command(gameFunc(func() { s.w.TakeForTest(p, "copper_coin", 5) }))
		s.sim.Step()
	}
	// The trip is one way: whoever dies on the real islands without a home town wakes up
	// back at the sandbox temple (the start town of make play).
	s.sim.Command(ctxFunc(func(ctx *game.TickContext) { s.w.DieForTest(ctx, p) }))
	s.sim.RunTicks(5)
	if p = s.w.PlayerByCharacter(5003); p == nil {
		t.Fatal("the character left the world when it died")
	}
	if p.Pos() != sbTemple {
		t.Fatalf("died on Karvask: woke up at %v, want the sandbox temple", p.Pos())
	}
}

func inIsland(is *world.Island, p world.Pos) bool { return is.Rect.Contains(int(p.X), int(p.Y)) }

// gear is a purchase at the provisioner and where it is worn (0: kept in the backpack).
type gear struct {
	id   string
	n    uint32
	slot pb.EquipmentSlot
}

// hero is a newcomer of vocation voc that asks the instructor for experience (each pick
// is 50 000, or 5000 if small) and gold coins, then buys kit at the provisioner and
// wears it. Below 70 % health it heals: a druid with verdant_mend, anyone else with a
// seaweed poultice if it carries one.
func (s *sandbox) hero(id int64, name, voc string, big, small, gold int, kit ...gear) (*fakeClient, *session.Player) {
	s.t.Helper()
	cl, p := s.newcomer(id, name, voc)
	d := s.talk(cl, p, "pruebas_trainer")
	if big+small > 0 {
		d, _ = s.say(cl, d, "npc.pruebas_trainer.opt_xp")
		for range big {
			d, _ = s.say(cl, d, "npc.pruebas_trainer.opt_xp_big")
		}
		for range small {
			d, _ = s.say(cl, d, "npc.pruebas_trainer.opt_xp_small")
		}
		d, _ = s.say(cl, d, "dialog.back")
	}
	for range gold {
		d, _ = s.say(cl, d, "npc.pruebas_trainer.opt_gold")
	}
	s.say(cl, d, "dialog.back")
	if len(kit) > 0 {
		shop := s.openShop(cl, p)
		for _, g := range kit {
			shop.buy(g.id, g.n)
		}
		for _, g := range kit {
			if g.slot != 0 {
				s.equip(cl, p, g.id, g.slot)
			}
		}
	}
	if voc == "druid" {
		s.healers[p] = func() { s.input(cl, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "viridis cura")) }
	} else {
		win := s.packWindow(cl, p) // open now: the healer only sends the use
		s.healers[p] = func() {
			if s.w.CountItem(p, "seaweed_poultice") > 0 {
				s.input(cl, useItem(inContainer(win, s.packIndex(p, "seaweed_poultice")), s.num("seaweed_poultice"), 0))
			}
		}
	}
	cl.take()
	return cl, p
}

// TestSandboxPens: each pen of the hunting trail is hunted by a vocation with the level
// the instructor gives and the provisioner's gear, until one of its monsters dies and
// leaves loot (the bats of the cellar: TestSandboxPortals).
func TestSandboxPens(t *testing.T) {
	s := newSandbox(t)
	report := func(what string, loot []*pb.ItemStack) {
		var ids []string
		for _, l := range loot {
			for id, it := range s.items {
				if uint32(it.Numeric) == l.ItemId {
					ids = append(ids, id)
				}
			}
		}
		t.Logf("%s: loot %v", what, ids)
	}

	// Pen 1, bilge rats: a level 1 guardian with a hand axe.
	cl, p := s.hero(5101, "Ratera", "guardian", 0, 0, 1, gear{"hatchet", 1, slotRight})
	report("pen 1 (guardian 1)", s.huntForLoot("bilge_rat", penGap(1), penAway(1), 10, fighter{cl: cl, p: p}))

	// Pen 2, wolves: a level 8 ranger with a short bow and arrows.
	cl, p = s.hero(5102, "Arquera", "ranger", 0, 1, 1, gear{"short_bow", 1, slotRight}, gear{"arrow", 100, slotAmmo},
		gear{"patched_tunic", 1, slotArmor}, gear{"seaweed_poultice", 5, 0})
	report("pen 2 (ranger 8)", s.huntForLoot("wolf", penGap(2), penAway(2), 10, fighter{cl: cl, p: p}))

	// Pen 3, boars and a spider: a level 20 arcanist with a coral wand.
	cl, p = s.hero(5103, "Maga", "arcanist", 2, 0, 1, gear{"coral_wand", 1, slotRight},
		gear{"mossweave_robe", 1, slotArmor}, gear{"seaweed_poultice", 20, 0})
	report("pen 3 (arcanist 20)", s.huntForLoot("bristleback_boar", penGap(3), penAway(3), 10, fighter{cl: cl, p: p}))
	report("pen 3 (arcanist 20)", s.huntForLoot("moss_spider", penGap(3), penAway(3), 10, fighter{cl: cl, p: p}))

	// Pens 4 and 5, thornlings and the ember wyrmling: level 50 druids that cast
	// frost_lance (ice; spells grow with the level, while melee and bows grow with skills:
	// an untrained guardian dies in pen 4, TestSandboxTraining). One per pen: the druid
	// of pen 4 would bring the other thornling along to the wyrmling (monsters follow out
	// of their pen), and those two together kill a druid.
	druid := func(id int64, name string) fighter {
		cl, p := s.hero(id, name, "druid", 29, 0, 1, gear{"sapling_staff", 1, slotRight}, gear{"mossweave_robe", 1, slotArmor})
		s.casters[p] = func(target uint32) { s.input(cl, castAt("frost_lance", target)) }
		return fighter{cl: cl, p: p}
	}
	report("pen 4 (druid 50)", s.huntForLoot("thornling", penGap(4), penAway(4), 10, druid(5104, "Druida")))
	report("pen 5 (druid 50)", s.huntForLoot("ember_wyrmling", penGap(5), penAway(5), 5, druid(5105, "Druido")))
}

// monstersNear describes the monsters within 15 tiles of p (for failures).
func (s *sandbox) monstersNear(p world.Pos) string {
	out := ""
	for _, m := range s.w.Monsters() {
		if m.Pos().Z == p.Z && chebyshev(m.Pos(), p) <= 15 {
			hp, maxHP := m.Health()
			out += fmt.Sprintf("%s at %v (%d/%d) ", m.Kind(), m.Pos(), hp, maxHP)
		}
	}
	return out
}

// penGap is the gap in the south fence of pen n (1-5, west to east) of the hunting trail;
// penAway the tile south of it, out of view of the pen.
func penGap(n int) world.Pos  { return at3(2079+9*(n-1), 2079, 7) }
func penAway(n int) world.Pos { return at3(2079+9*(n-1), 2087, 7) }

// stepOnto walks p next to the tile `to` (stairs, a hole, a teleport) and steps on it; it
// returns where p lands.
func (s *sandbox) stepOnto(cl *fakeClient, p *session.Player, to world.Pos) world.Pos {
	s.t.Helper()
	s.walkNear(cl, p, to)
	from := p.Pos()
	d := -1
	for i := range 8 {
		if q, ok := from.Step(world.Direction(i)); ok && q == to {
			d = i
		}
	}
	s.input(cl, walk(pb.Direction(d+1)))
	s.sim.Step()
	s.sim.RunUntil(func() bool { return !p.Walking() }, sim.MaxSeconds(5))
	s.sim.RunTicks(20)
	cl.take()
	return p.Pos()
}

// useGround uses the ground of the tile at (a trapdoor, a ladder, a rope spot) from
// next to it and returns what the client heard.
func (s *sandbox) useGround(cl *fakeClient, p *session.Player, at world.Pos) []*pb.ServerMessage {
	s.t.Helper()
	s.walkNear(cl, p, at)
	s.sim.RunTicks(20) // the last step ends: a climb waits for it (portal.not_ready)
	ground, _, _ := s.m.Tile(at)
	evs := s.send(cl, useItem(onTile(at), uint32(ground), 0))
	s.sim.RunTicks(5)
	return append(evs, cl.take()...)
}

// arrivedBy fails unless p stands on floor z within radius tiles of `by`.
func (s *sandbox) arrivedBy(what string, p *session.Player, by world.Pos, radius int) {
	s.t.Helper()
	if p.Pos().Z != by.Z || chebyshev(p.Pos(), by) > radius || s.m.MovesOnStep(p.Pos()) {
		s.t.Fatalf("%s: at %v, want by %v", what, p.Pos(), by)
	}
}

// TestSandboxPortals: the yard of portals and the cellar (floor 8) of docs/16, on foot
// from the temple: the stairs down and up, the trapdoor and the ladder, the hole, the
// rope spot (bare it says it needs a rope; with the provisioner's rope it climbs), the way
// out of the pit through the stairs room, the teleport back to the square, and a biscuit
// thrown onto the stairs that lands below.
func TestSandboxPortals(t *testing.T) {
	s := newSandbox(t)
	// Level 20 with a hand axe: the bats of the cellar bite.
	cl, p := s.hero(5201, "Exploradora", "guardian", 2, 0, 1, gear{"rope", 1, 0}, gear{"ship_biscuit", 3, 0},
		gear{"hatchet", 1, slotRight})
	radius := 2 // travel.arrival_radius

	s.stepOnto(cl, p, sbStairsDown)
	s.arrivedBy("stairs down", p, at3(2121, 2091, 8), radius)
	s.stepOnto(cl, p, sbStairsUp)
	s.arrivedBy("stairs up", p, at3(2121, 2091, 7), radius)

	s.useGround(cl, p, sbTrapdoor)
	s.arrivedBy("trapdoor", p, at3(2116, 2091, 8), radius)
	s.useGround(cl, p, sbLadderUp)
	s.arrivedBy("ladder up", p, at3(2116, 2091, 7), radius)

	s.stepOnto(cl, p, sbHole)
	s.arrivedBy("hole", p, at3(2119, 2095, 8), radius)
	// The bats of the cave come to the pit: they die first (and leave loot).
	if loot := s.huntForLoot("gloom_bat", at3(2120, 2096, 8), at3(2111, 2103, 8), 12, fighter{cl: cl, p: p}); len(loot) == 0 {
		t.Fatal("no loot")
	}
	// The pit opens on the stairs room: out on foot.
	s.walkNear(cl, p, sbStairsUp)
	s.walkNear(cl, p, sbRopeSpot)
	if evs := s.useGround(cl, p, sbRopeSpot); p.Pos().Z != 8 || !hasKey(evs, "portal.need_rope") {
		t.Fatalf("a bare rope spot: at %v, %v", p.Pos(), systemKeys(evs))
	}
	win := s.packWindow(cl, p)
	evs := s.send(cl, &pb.ClientMessage{Message: &pb.ClientMessage_UseItemOn{UseItemOn: &pb.UseItemOn{
		From: inContainer(win, s.packIndex(p, "rope")), ItemId: s.num("rope"),
		To: &pb.ActionTarget{Target: &pb.ActionTarget_Pos{Pos: &pb.Position{X: uint32(sbRopeSpot.X), Y: uint32(sbRopeSpot.Y), Z: 8}}}}}})
	s.sim.RunTicks(5)
	s.arrivedBy(fmt.Sprintf("rope (%v)", systemKeys(evs)), p, at3(2119, 2095, 7), radius)
	if s.w.CountItem(p, "rope") != 1 {
		t.Fatal("climbing used the rope up")
	}

	// Down again, through the cave to the teleport at the back: it leaves at the square.
	s.stepOnto(cl, p, sbHole)
	s.stepOnto(cl, p, sbTeleport)
	s.arrivedBy("teleport", p, sbTeleportTo, radius)

	// A biscuit thrown onto the stairs lands below them.
	s.walkNear(cl, p, sbStairsDown)
	win = s.packWindow(cl, p)
	biscuits := s.w.CountItem(p, "ship_biscuit")
	evs = s.send(cl, moveItem(inContainer(win, s.packIndex(p, "ship_biscuit")), s.num("ship_biscuit"), 0, onTile(sbStairsDown), 1))
	if s.w.CountItem(p, "ship_biscuit") != biscuits-1 {
		t.Fatalf("threw a biscuit onto the stairs: %v", systemKeys(evs))
	}
	landed := false
	for dy := -radius; dy <= radius; dy++ {
		for dx := -radius; dx <= radius; dx++ {
			for _, it := range s.w.GroundAt(at3(2121+dx, 2091+dy, 8)) {
				landed = landed || it.Def().ID == "ship_biscuit"
			}
		}
	}
	if !landed || len(s.w.GroundAt(sbStairsDown)) != 0 {
		t.Fatal("the biscuit thrown onto the stairs did not land below them")
	}
}

// useOn uses the tool id from p's backpack on the tile at and returns what the client
// heard.
func (s *sandbox) useOn(cl *fakeClient, p *session.Player, id string, at world.Pos) []*pb.ServerMessage {
	s.t.Helper()
	win := s.packWindow(cl, p)
	return s.send(cl, &pb.ClientMessage{Message: &pb.ClientMessage_UseItemOn{UseItemOn: &pb.UseItemOn{
		From: inContainer(win, s.packIndex(p, id)), ItemId: s.num(id),
		To: &pb.ActionTarget{Target: &pb.ActionTarget_Pos{Pos: &pb.Position{X: uint32(at.X), Y: uint32(at.Y), Z: uint32(at.Z)}}}}}})
}

// spot is a resource tile and where to stand to use a tool on it.
type spot struct{ stand, at world.Pos }

// gather works the spots with tool until p carries n of item, each spot until it is
// spent, one attempt per gathering.use_interval_ms.
func (s *sandbox) gather(cl *fakeClient, p *session.Player, tool string, spots []spot, item string, n int) {
	s.t.Helper()
	for _, sp := range spots {
		if s.w.CountItem(p, item) >= n {
			return
		}
		s.walkTo(cl, p, sp.stand)
		for s.w.ResourceLeft(sp.at) != 0 && s.w.CountItem(p, item) < n {
			evs := s.useOn(cl, p, tool, sp.at)
			k := systemKeys(evs)
			if k["gather.got"]+k["gather.failed"]+k["gather.depleted"] == 0 {
				s.t.Fatalf("%s on %v from %v: %v", tool, sp.at, p.Pos(), k)
			}
			s.sim.RunTicks(30) // gathering.use_interval_ms
		}
	}
	if s.w.CountItem(p, item) < n {
		s.t.Fatalf("%s: %d %s of %d", tool, s.w.CountItem(p, item), item, n)
	}
}

// station uses the crafting station at `at` from next to it and returns its window.
func (s *sandbox) station(cl *fakeClient, p *session.Player, id string, at world.Pos) *pb.StationOpen {
	s.t.Helper()
	s.walkNear(cl, p, at)
	index := -1
	for i, it := range s.m.Stack(at) {
		if uint32(it) == s.num(id) {
			index = i + 1 // 0 is the ground
		}
	}
	evs := s.send(cl, useItem(onTile(at), s.num(id), uint32(index)))
	st := find(evs, (*pb.ServerMessage).GetStationOpen)
	if index < 0 || len(st) != 1 {
		s.t.Fatalf("no station window at %v: %v", at, systemKeys(evs))
	}
	return st[0]
}

// craftUntil tries recipe at the station until it makes one (each try spends the inputs:
// at most tries).
func (s *sandbox) craftUntil(cl *fakeClient, p *session.Player, recipe string, at world.Pos, tries int) {
	s.t.Helper()
	for range tries {
		evs := s.craft(cl, recipe, at)
		s.sim.RunFor(4 * time.Second) // the recipe's time_ms
		k := systemKeys(evs)
		if k["craft.done"] > 0 {
			return
		}
		if k["craft.failed"] == 0 {
			s.t.Fatalf("%s at %v: %v", recipe, at, k)
		}
	}
	s.t.Fatalf("%s failed %d times", recipe, tries)
}

// TestSandboxTrades: with the provisioner's tools a newcomer mines the iron veins of the
// quarry, chops the birches, fishes from the fishing dock, smelts an ingot at the forge
// and grills a fish at the hearth, and sells the provisioner what he buys of it. The
// anvil shows its recipes, but none is within reach of a newcomer (they ask for smithing
// 2 or more, and smithing starts at 1); trained in the trades by the instructor, the
// newcomer makes the lowest one there.
func TestSandboxTrades(t *testing.T) {
	s := newSandbox(t)
	cl, p := s.hero(5301, "Artesana", "guardian", 0, 0, 1, gear{"pickaxe", 1, 0}, gear{"felling_axe", 1, 0},
		gear{"fishing_rod", 1, 0}, gear{"smithing_hammer", 1, 0})

	var veins, birches []spot
	for _, v := range [][2]int{{2065, 2088}, {2068, 2088}, {2070, 2090}, {2065, 2091}, {2067, 2093}, {2070, 2093}} {
		veins = append(veins, spot{at3(v[0], v[1]+1, 7), at3(v[0], v[1], 7)})
	}
	for _, b := range [][2]int{{2077, 2086}, {2074, 2087}, {2080, 2088}, {2075, 2090}, {2078, 2091}, {2074, 2093}, {2079, 2094}} {
		birches = append(birches, spot{at3(b[0], b[1]+1, 7), at3(b[0], b[1], 7)})
	}
	for _, sp := range append(veins, birches...) {
		if !s.m.Walkable(sp.stand) {
			t.Fatalf("%v, below a resource, is not walkable", sp.stand)
		}
	}
	shoals := []spot{{at3(2053, 2097, 7), at3(2053, 2095, 7)}, {at3(2054, 2097, 7), at3(2054, 2094, 7)},
		{at3(2052, 2097, 7), at3(2051, 2095, 7)}, {at3(2052, 2098, 7), at3(2050, 2098, 7)},
		{at3(2054, 2098, 7), at3(2054, 2100, 7)}, {at3(2052, 2098, 7), at3(2052, 2101, 7)}}
	s.gather(cl, p, "pickaxe", veins, "iron_ore", 8)
	s.gather(cl, p, "felling_axe", birches, "birch_log", 5)
	s.gather(cl, p, "fishing_rod", shoals, "raw_fish", 2)

	// The forge: 2 ore and a log make an ingot (or fail and spend them).
	if st := s.station(cl, p, "smelting_forge", sbForge); len(st.Owned) == 0 {
		t.Fatalf("the forge window shows nothing owned: %v", st)
	}
	s.craftUntil(cl, p, "smelt_iron_ingot", sbForge, 4)
	// The hearth: a raw fish grills.
	s.station(cl, p, "cooking_hearth", sbHearth)
	s.craftUntil(cl, p, "cook_grilled_fish", sbHearth, 2)
	// The anvil, with the hammer: every recipe of it asks for more smithing than a newcomer
	// has, even with the inputs of its lowest one.
	st := s.station(cl, p, "anvil", sbAnvil)
	if len(st.Tools) == 0 {
		t.Fatalf("the anvil window does not see the hammer: %v", st)
	}
	recipes, err := content.LoadRecipes(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	var lowest *content.Recipe
	for _, id := range recipes.IDs() {
		if r := recipes[id]; r.Station == "anvil" && (lowest == nil || r.Level < lowest.Level) {
			lowest = r
		}
	}
	smithing := s.w.Skill(p, "smithing").Level
	if lowest == nil || lowest.Level <= smithing {
		t.Fatalf("an anvil recipe at smithing %d: %+v", smithing, lowest)
	}
	s.sim.Command(gameFunc(func() {
		for _, in := range lowest.Inputs {
			s.w.GiveForTest(p, in.Item, in.Count) // as if gathered and smelted
		}
	}))
	s.sim.Step()
	if evs := s.craft(cl, lowest.ID, sbAnvil); !hasKey(evs, "craft.level") {
		t.Fatalf("%s (smithing %d) at smithing %d: %v", lowest.ID, lowest.Level, smithing, systemKeys(evs))
	}
	t.Logf("the lowest anvil recipe, %s, asks for smithing %d; a newcomer has %d", lowest.ID, lowest.Level, smithing)

	// Trained in the trades by the instructor, the same newcomer makes it at the anvil.
	s.train(cl, p, "trades")
	if lvl := s.w.Skill(p, "smithing").Level; lvl < lowest.Level {
		t.Fatalf("trained to smithing %d", lvl)
	}
	made := s.w.CountItem(p, lowest.Output.Item)
	s.station(cl, p, "anvil", sbAnvil)
	s.craftUntil(cl, p, lowest.ID, sbAnvil, 3)
	if n := s.w.CountItem(p, lowest.Output.Item); n != made+lowest.Output.Count {
		t.Fatalf("%s at the anvil: %d %s, had %d", lowest.ID, n, lowest.Output.Item, made)
	}

	// The provisioner buys the catch, the ore, the ingot and the logs.
	shop := s.openShop(cl, p)
	for _, id := range []string{"grilled_fish", "iron_ingot", "raw_fish", "iron_ore", "birch_log"} {
		if n := s.w.CountItem(p, id); n > 0 {
			shop.sell(id, uint32(n))
		}
	}
}

// moreXP asks the instructor for small (5000) experience picks.
func (s *sandbox) moreXP(cl *fakeClient, p *session.Player, small int) {
	s.t.Helper()
	d := s.talk(cl, p, "pruebas_trainer")
	d, _ = s.say(cl, d, "npc.pruebas_trainer.opt_xp")
	for range small {
		d, _ = s.say(cl, d, "npc.pruebas_trainer.opt_xp_small")
	}
	s.say(cl, d, "dialog.back")
}

// train asks the instructor for her training, "combat" (the combat skills and magic level
// of p's vocation) or "trades", and returns what the client heard.
func (s *sandbox) train(cl *fakeClient, p *session.Player, what string) []*pb.ServerMessage {
	s.t.Helper()
	d := s.talk(cl, p, "pruebas_trainer")
	d, _ = s.say(cl, d, "npc.pruebas_trainer.opt_train")
	d, evs := s.say(cl, d, "npc.pruebas_trainer.opt_train_"+what)
	if d == nil || d.Text.Key != "npc.pruebas_trainer.trained" {
		s.t.Fatalf("training %s: %v %v", what, d, messageKeys(evs))
	}
	s.say(cl, d, "dialog.bye")
	return evs
}

// skillLevels is p's level in each of ids.
func (s *sandbox) skillLevels(p *session.Player, ids ...string) map[string]int {
	out := map[string]int{}
	for _, id := range ids {
		out[id] = s.w.Skill(p, id).Level
	}
	return out
}

// TestSandboxHouse: the Casa de Prueba south of the square asks for level 12; at level 12
// its door rents it for 200 coins, the owner walks in and leaves a biscuit on its floor
// (written with the house), and a stranger cannot follow until invited; a guest takes
// nothing out.
func TestSandboxHouse(t *testing.T) {
	s := newSandbox(t)
	cl, p := s.hero(5401, "Inquilina", "guardian", 0, 1, 1, gear{"ship_biscuit", 2, 0})
	door := func() *pb.HouseUpdate {
		s.walkTo(cl, p, sbHouseExit)
		ground, _, _ := s.m.Tile(sbHouseDoor)
		evs := s.send(cl, useItem(onTile(sbHouseDoor), uint32(ground), 0))
		u := lastHouse(evs)
		if !u.GetOpen() || u.GetHouseId() != "pruebas_house" {
			t.Fatalf("the house door: %v (%v)", u, systemKeys(evs))
		}
		return u
	}
	u := door()
	if u.GetRent() != 200 || u.GetMinLevel() != 12 || u.GetOwner() != "" {
		t.Fatalf("the free house: %v", u)
	}
	if evs := s.send(cl, houseCmd(&pb.HouseRent{})); !hasKey(evs, "house.level_required") || s.w.HouseOwnerOf(p.CharacterID()) != "" {
		t.Fatalf("rent at level %d: %v", s.w.Level(p), systemKeys(evs))
	}
	s.moreXP(cl, p, 3) // 20 000 experience: level 12
	if s.w.Level(p) != 12 {
		t.Fatalf("level %d after four small picks", s.w.Level(p))
	}
	door()
	money := s.w.Money(p)
	if u := lastHouse(s.send(cl, houseCmd(&pb.HouseRent{}))); !u.GetIsOwner() || s.w.Money(p) != money-200 {
		t.Fatalf("rent at level 12: %v, paid %d", u, money-s.w.Money(p))
	}
	if s.w.HouseOwnerOf(p.CharacterID()) != "pruebas_house" {
		t.Fatal("the owner index does not know the tenant")
	}

	// In through the door; a biscuit on the floor.
	inside := at3(2088, 2111, 7)
	s.walkTo(cl, p, inside)
	floor := at3(2089, 2111, 7)
	win := s.packWindow(cl, p)
	n := len(s.transfers)
	biscuits := s.w.CountItem(p, "ship_biscuit")
	evs := s.send(cl, moveItem(inContainer(win, s.packIndex(p, "ship_biscuit")), s.num("ship_biscuit"), 0, onTile(floor), 1))
	if g := s.w.GroundAt(floor); len(g) != 1 || g[0].Def().ID != "ship_biscuit" || s.w.CountItem(p, "ship_biscuit") != biscuits-1 {
		t.Fatalf("drop a biscuit in the house: %v", systemKeys(evs))
	}
	written := false
	for _, tr := range s.transfers[n:] {
		for _, op := range tr.Houses {
			written = written || op.Kind == session.HouseItems && op.House == "pruebas_house" && len(op.Items) == 1
		}
	}
	if !written {
		t.Fatal("the biscuit on the house floor was not written with the house")
	}

	// A stranger stays at the door.
	cs, st := s.newcomer(5402, "Curiosa", "ranger")
	s.walkTo(cs, st, sbHouseExit)
	s.input(cs, walk(N))
	s.sim.RunTicks(20)
	if evs := cs.take(); s.m.HouseAt(st.Pos()) != nil || !hasKey(evs, "house.no_access") {
		t.Fatalf("a stranger walked into the house to %v: %v", st.Pos(), systemKeys(evs))
	}
	// Invited, she walks in; she may not take the owner's biscuit out.
	if evs := s.send(cl, houseCmd(&pb.HouseGuestAdd{Name: "Curiosa"})); !hasKey(evs, "house.guest_added") {
		t.Fatalf("invite: %v", systemKeys(evs))
	}
	s.walkTo(cs, st, at3(2090, 2111, 7))
	win = s.packWindow(cs, st)
	if evs := s.send(cs, moveItem(onTile(floor), s.num("ship_biscuit"), uint32(len(s.m.Stack(floor))+1), inContainer(win, 0), 1)); !hasKey(evs, "house.owner_only") {
		t.Fatalf("the guest takes the biscuit: %v", systemKeys(evs))
	}
}

// TestSandboxVault: the practice gate of the yard shuts the vault: without the brass key
// it stays locked; with the provisioner's key it opens, the holder walks in and locks it
// behind; from inside it opens with the key, and also without it (nobody is locked in).
func TestSandboxVault(t *testing.T) {
	s := newSandbox(t)
	cl, p := s.hero(5501, "Llavera", "guardian", 0, 0, 1)
	shut, open := s.num("pruebas_gate"), s.num("pruebas_gate_open")
	outside, inside := at3(2117, 2100, 7), at3(2117, 2102, 7)
	gate := func(cl *fakeClient, id uint32) []*pb.ServerMessage {
		s.sim.RunFor(doorWait * time.Millisecond)
		cl.take()
		index := -1
		for i, it := range s.m.Stack(sbVault) {
			if uint32(it) == id {
				index = i + 1
			}
		}
		if index < 0 {
			t.Fatalf("no item %d at the gate: %v", id, s.m.Stack(sbVault))
		}
		return s.send(cl, useItem(onTile(sbVault), id, uint32(index)))
	}

	s.walkTo(cl, p, outside)
	if evs := gate(cl, shut); !hasKey(evs, "door.locked") || s.m.Walkable(sbVault) {
		t.Fatalf("the gate without the key: %v", systemKeys(evs))
	}
	shop := s.openShop(cl, p)
	shop.buy("pruebas_key", 1)
	s.walkTo(cl, p, outside)
	if evs := gate(cl, shut); !hasKey(evs, "door.unlocked") || !s.m.Walkable(sbVault) {
		t.Fatalf("the gate with the key: %v", systemKeys(evs))
	}
	s.walkTo(cl, p, inside)
	if !s.w.InDoorRoom(sbVault, p.Pos()) {
		t.Fatalf("%v is not in the vault", p.Pos())
	}
	if evs := gate(cl, open); !hasKey(evs, "door.relocked") || s.m.Walkable(sbVault) {
		t.Fatalf("lock the gate from inside: %v", systemKeys(evs))
	}
	if evs := gate(cl, shut); !hasKey(evs, "door.unlocked") || !s.m.Walkable(sbVault) {
		t.Fatalf("open the gate from inside with the key: %v", systemKeys(evs))
	}
	gate(cl, open)
	// Without the key (dropped on the vault floor), the one inside still gets out.
	win := s.packWindow(cl, p)
	s.send(cl, moveItem(inContainer(win, s.packIndex(p, "pruebas_key")), s.num("pruebas_key"), 0, onTile(at3(2116, 2103, 7)), 1))
	if s.w.CountItem(p, "pruebas_key") != 0 {
		t.Fatal("the key is still carried")
	}
	if evs := gate(cl, shut); !hasKey(evs, "door.unbarred") || !s.m.Walkable(sbVault) {
		t.Fatalf("open the gate from inside without the key: %v", systemKeys(evs))
	}
	s.walkTo(cl, p, outside)
}

// openBoard walks next to the market board of the square and opens the market.
func (s *sandbox) openBoard(cl *fakeClient, p *session.Player) {
	s.t.Helper()
	s.walkNear(cl, p, sbBoard)
	index := -1
	for i, it := range s.m.Stack(sbBoard) {
		if uint32(it) == s.num("market_board") {
			index = i + 1
		}
	}
	if u := lastMarket(s.send(cl, useItem(onTile(sbBoard), s.num("market_board"), uint32(index)))); !u.GetOpen() {
		s.t.Fatalf("the market board at %v did not open the market", sbBoard)
	}
}

// TestSandboxMarket: two players of the sandbox trade through the board of the square:
// one posts two ropes for sale (paying the posting fee), the other buys them, and the
// seller withdraws the coins from the mailbox.
func TestSandboxMarket(t *testing.T) {
	s := newSandbox(t)
	cs, seller := s.hero(5601, "Vendedora", "ranger", 0, 0, 1, gear{"rope", 2, 0})
	cb, buyer := s.hero(5602, "Compradora", "druid", 0, 0, 1)
	s.openBoard(cs, seller)
	s.openBoard(cb, buyer)

	money := s.w.Money(seller)
	evs := s.send(cs, createOffer(pb.MarketSide_MARKET_SIDE_SELL, s.num("rope"), 2, 40))
	ids := s.w.MarketOffers(seller.CharacterID())
	if !hasKey(evs, "market.created") || len(ids) != 1 || s.w.CountItem(seller, "rope") != 0 || s.w.Money(seller) != money-5 {
		t.Fatalf("post two ropes at 40 (fee 5): %v, offers %v, %d ropes, paid %d", systemKeys(evs), ids,
			s.w.CountItem(seller, "rope"), money-s.w.Money(seller))
	}
	s.sim.RunFor(time.Second) // the anti-flood of market actions
	u := lastMarket(s.send(cb, marketCmd(&pb.MarketCommand{Action: &pb.MarketCommand_Browse{Browse: &pb.MarketBrowse{ItemId: s.num("rope")}}})))
	if len(u.GetSells()) != 1 || u.GetSells()[0].GetOwnerName() != "Vendedora" || u.GetSells()[0].GetAmount() != 2 {
		t.Fatalf("the buyer's listing: %v", u.GetSells())
	}
	money = s.w.Money(buyer)
	if evs := s.send(cb, acceptOffer(ids[0], 2)); !hasKey(evs, "market.bought") || s.w.CountItem(buyer, "rope") != 2 ||
		s.w.Money(buyer) != money-80 {
		t.Fatalf("buy the ropes: %v, %d ropes, paid %d", systemKeys(evs), s.w.CountItem(buyer, "rope"), money-s.w.Money(buyer))
	}
	if gold, _ := s.w.Mailbox(seller.CharacterID()); gold != 80 {
		t.Fatalf("the seller's mailbox holds %d", gold)
	}
	s.sim.RunFor(time.Second)
	money = s.w.Money(seller)
	if evs := s.send(cs, withdraw); !hasKey(evs, "market.withdrawn") || s.w.Money(seller) != money+80 {
		t.Fatalf("withdraw: %v, %d", systemKeys(evs), s.w.Money(seller)-money)
	}
}

// TestSandboxArena: two level 20 characters (the instructor's experience) walk into the
// arena by its west entrance and duel: the loser wakes up at the sandbox temple without
// losing experience or anything it carried, and the winner gets no skull.
func TestSandboxArena(t *testing.T) {
	s := newSandbox(t)
	ca, a := s.hero(5701, "Retadora", "guardian", 2, 0, 1, gear{"iron_sword", 1, slotRight})
	cv, v := s.hero(5702, "Retada", "guardian", 2, 0, 1, gear{"rope", 1, 0})
	if s.w.Level(a) < 20 || s.w.Level(v) < 20 {
		t.Fatalf("levels %d and %d", s.w.Level(a), s.w.Level(v))
	}
	// Outside the arena a player in safe mode (the default) attacks nobody unmarked.
	s.walkTo(ca, a, at3(2099, 2114, 7))
	s.walkTo(cv, v, at3(2099, 2115, 7))
	if !a.SafeMode() {
		t.Fatal("a new character is not in safe mode")
	}
	s.send(ca, setTarget(v.ID()))
	s.sim.RunFor(5 * time.Second)
	if hp, maxHP := v.Health(); hp != maxHP {
		t.Fatalf("hurt outside the arena: %d of %d", hp, maxHP)
	}
	s.walkTo(ca, a, at3(2104, 2114, 7))
	s.walkTo(cv, v, at3(2105, 2115, 7))
	if s.m.Flags(a.Pos())&world.FlagPvP == 0 || s.m.Flags(v.Pos())&world.FlagPvP == 0 {
		t.Fatal("the duelists are not in the arena")
	}
	xp := v.Experience()
	s.input(ca, fightMode(pb.FightStance_FIGHT_STANCE_OFFENSIVE, true))
	s.send(ca, setTarget(v.ID()))
	defeated := false
	s.sim.RunUntil(func() bool {
		for _, b := range cv.batches {
			for _, e := range b.Events {
				defeated = defeated || e.GetChatMessage().GetLocalized().GetKey() == "pvp.arena_defeat"
			}
		}
		cv.batches = nil
		return defeated
	}, sim.MaxSeconds(1800))
	s.sim.Step()
	if v.Pos() != sbTemple && chebyshev(v.Pos(), sbTemple) > 2 {
		t.Fatalf("the loser is at %v, not at the sandbox temple", v.Pos())
	}
	if v.Experience() != xp || s.w.CountItem(v, "rope") != 1 || v.Equipped(slotBackpack) == nil {
		t.Fatalf("the loser lost something: %d experience, %d ropes", xp-v.Experience(), s.w.CountItem(v, "rope"))
	}
	if a.Skull() != pb.Skull_SKULL_UNSPECIFIED {
		t.Fatalf("the winner has skull %v", a.Skull())
	}
}

// TestSandboxDialogs: every window of the sandbox NPCs' dialogs (instructor, provisioner,
// ferryman) is reached by talking, and every option of every window leads somewhere: to
// another window, a shop, a trip, or a goodbye. Each try is a new character (some
// options change what the greeting offers). The instructor's quest_done needs the rats
// hunted, and quest_cooling the quest handed in (TestSandboxInstructor).
func TestSandboxDialogs(t *testing.T) {
	s := newSandbox(t)
	npcs, err := content.LoadNPCs(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	gated := map[string]bool{"pruebas_trainer/quest_done": true, "pruebas_trainer/quest_cooling": true}
	next := int64(5800)
	for _, id := range []string{"pruebas_trainer", "pruebas_merchant", "pruebas_ferryman"} {
		by := s.beside(s.npc(id).Pos())
		byText := map[string]string{}
		for node, n := range npcs[id].Dialog.Nodes {
			byText[n.Text] = node
		}
		// replay talks to the NPC as a new character with a gold coin (the fares) and
		// follows path; done sends it away.
		replay := func(path []string) (*fakeClient, *session.Player, *pb.DialogOpen) {
			next++
			cl, p := s.newcomer(next, fmt.Sprintf("Charla%d", next), "guardian")
			s.sim.Command(gameFunc(func() {
				s.w.GiveForTest(p, "gold_coin", 1)
				s.w.Teleport(p, by)
			}))
			s.sim.Step()
			d := s.talk(cl, p, id)
			for _, k := range path {
				if d, _ = s.say(cl, d, k); d == nil {
					t.Fatalf("%s: the path %v closed at %s", id, path, k)
				}
			}
			return cl, p, d
		}
		done := func(cl *fakeClient) {
			s.sim.Command(s.w.Leave(cl))
			s.sim.Step()
		}
		reached := map[string]bool{}
		queue := [][]string{nil}
		for len(queue) > 0 {
			path := queue[0]
			queue = queue[1:]
			cl, _, d := replay(path)
			done(cl)
			node := byText[d.Text.Key]
			if node == "" {
				t.Fatalf("%s: window %s is no node of its dialog", id, d.Text.Key)
			}
			if reached[node] {
				continue
			}
			reached[node] = true
			for _, o := range d.Options {
				cl, p, d := replay(path)
				before := p.Pos()
				win, evs := s.say(cl, d, o.Text.Key)
				switch {
				case win != nil:
					if !reached[byText[win.Text.Key]] {
						queue = append(queue, append(append([]string{}, path...), o.Text.Key))
					}
				case len(find(evs, (*pb.ServerMessage).GetDialogClose)) == 1 && (o.Text.Key == "dialog.bye" || p.Pos() != before):
				default:
					t.Errorf("%s: option %s of %s leads nowhere: %v %v", id, o.Text.Key, node, kinds(evs), messageKeys(evs))
				}
				done(cl)
			}
		}
		for node := range npcs[id].Dialog.Nodes {
			if !reached[node] && !gated[id+"/"+node] {
				t.Errorf("%s: no option leads to %s", id, node)
			}
		}
	}
}

// beside is a walkable tile next to at (no portal, house or creature on it).
func (s *sandbox) beside(at world.Pos) world.Pos {
	s.t.Helper()
	busy := map[world.Pos]bool{}
	for _, o := range s.w.Players() {
		busy[o.Pos()] = true
	}
	for _, n := range s.w.NPCs() {
		busy[n.Pos()] = true
	}
	for _, m := range s.w.Monsters() {
		busy[m.Pos()] = true
	}
	for i := range 8 {
		if q, ok := at.Step(world.Direction(i)); ok && s.m.Walkable(q) && !s.m.MovesOnStep(q) && s.m.HouseAt(q) == nil && !busy[q] {
			return q
		}
	}
	s.t.Fatalf("nothing free beside %v", at)
	return at
}

// TestSandboxArcRune: the provisioner's arc rune asks for magic level 1, and every
// character starts at magic level 0, whatever level the instructor gives. A newcomer
// arcanist cannot use it; trained by the instructor (magic level 30, without a single
// level of experience) the same arcanist kills a bilge rat with it at once.
func TestSandboxArcRune(t *testing.T) {
	s := newSandbox(t)
	cl, p := s.hero(5901, "Runera", "arcanist", 0, 0, 1, gear{"arc_rune", 1, 0})
	if s.w.Level(p) != 1 || s.w.Skill(p, "magic").Level != 0 {
		t.Fatalf("level %d, magic level %d", s.w.Level(p), s.w.Skill(p, "magic").Level)
	}
	// rune uses the arc rune on the nearest bilge rat of pen 1 and returns it.
	rune := func() (*session.Monster, []*pb.ServerMessage) {
		// The rats, home again (combat.monster_leash_tiles), come out to meet her: one of
		// them may stand in the gap.
		s.walkWithin(cl, p, penGap(1), 1)
		rat := s.nearest("bilge_rat", p.Pos(), 6)
		if rat == nil {
			t.Fatal("no bilge rat in pen 1")
		}
		win := s.packWindow(cl, p)
		return rat, s.send(cl, &pb.ClientMessage{Message: &pb.ClientMessage_UseItemOn{UseItemOn: &pb.UseItemOn{
			From: inContainer(win, s.packIndex(p, "arc_rune")), ItemId: s.num("arc_rune"),
			To: &pb.ActionTarget{Target: &pb.ActionTarget_CreatureId{CreatureId: rat.ID()}}}}})
	}
	// charges is what is left on the rune (4 when bought).
	charges := func() int {
		for _, it := range p.Equipped(slotBackpack).Items() {
			if it.Def().ID == "arc_rune" {
				return it.Count()
			}
		}
		return 0
	}
	if _, evs := rune(); !hasKey(evs, "magic.magic_level_required") || charges() != 4 {
		t.Fatalf("the arc rune at magic level 0: %d charges left, %v", charges(), systemKeys(evs))
	}
	evs := s.train(cl, p, "combat")
	if !hasKey(evs, "progress.skill_up") || s.w.Skill(p, "magic").Level != 30 || s.w.Level(p) != 1 {
		t.Fatalf("trained: level %d, magic level %d, %v", s.w.Level(p), s.w.Skill(p, "magic").Level, systemKeys(evs))
	}
	s.sim.RunFor(2 * time.Second) // the rune's spell group cooldown
	rat, evs := rune()
	if hasKey(evs, "magic.magic_level_required") || charges() != 3 {
		t.Fatalf("the arc rune at magic level 30: %d charges left, %v", charges(), systemKeys(evs))
	}
	for _, m := range s.w.Monsters() {
		if m == rat {
			hp, _ := rat.Health()
			t.Fatalf("the arc rune at magic level 30 left the rat at %d health: %v", hp, systemKeys(evs))
		}
	}
}

// TestSandboxEverythingReachable: from the temple, on foot and through the portals (the
// practice gate open: its key is sold on the square), a player reaches every walkable
// tile of the island, and from a reached tile it can use every NPC, gathering spot,
// crafting station, market board and reward chest (at inventory.reach, or the spot's own
// reach).
func TestSandboxEverythingReachable(t *testing.T) {
	s := newSandbox(t)
	recipes, err := content.LoadRecipes(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	stations := map[string]bool{}
	for _, r := range recipes {
		stations[r.Station] = true
	}
	is := s.m.Island("pruebas")
	inside := func(q world.Pos) bool { return is.Rect.Contains(int(q.X), int(q.Y)) }
	seen := map[world.Pos]bool{is.Temple: true}
	queue := []world.Pos{is.Temple}
	// The living world's objects (TestSandboxLivingWorld): vines break, boulders move and the
	// portcullis opens, so a player gets past each of them.
	living := map[world.Pos]bool{}
	for _, o := range s.w.LivingObjects() {
		living[o.Pos] = true
	}
	for len(queue) > 0 {
		q := queue[0]
		queue = queue[1:]
		var next []world.Pos
		if pt := s.m.PortalAt(q); pt != nil && s.m.MovesOnStep(q) {
			next = append(next, pt.To) // stairs, a hole, a teleport: stepping on it moves on
		}
		for d := range 8 {
			n, ok := q.Step(world.Direction(d))
			if !ok || !s.m.Walkable(n) && n != sbVault && !living[n] {
				continue
			}
			next = append(next, n)
			if pt := s.m.PortalAt(n); pt != nil && (pt.Kind == world.PortalLadder || pt.Kind == world.PortalRopeSpot) {
				next = append(next, pt.To) // used from next to it
			}
		}
		for _, n := range next {
			if !seen[n] && inside(n) {
				seen[n] = true
				queue = append(queue, n)
			}
		}
	}
	usable := func(at world.Pos, reach int) bool {
		for dy := -reach; dy <= reach; dy++ {
			for dx := -reach; dx <= reach; dx++ {
				q := at3(int(at.X)+dx, int(at.Y)+dy, int(at.Z))
				if seen[q] && (reach == 1 || s.m.LineOfSight(q, at)) {
					return true
				}
			}
		}
		return false
	}
	byNum := s.items.ByNumeric()
	for _, z := range is.Floors {
		for y := is.Rect.Y; y < is.Rect.Y+is.Rect.H; y++ {
			for x := is.Rect.X; x < is.Rect.X+is.Rect.W; x++ {
				at := at3(int(x), int(y), int(z))
				if s.m.Walkable(at) && !seen[at] {
					t.Errorf("%v is walkable and nobody gets there", at)
				}
				ground, _, ok := s.m.Tile(at)
				if !ok {
					continue
				}
				for _, n := range append([]uint16{ground}, s.m.Stack(at)...) {
					def := byNum[n]
					if def == nil || def.Resource == nil && !stations[def.ID] && !def.MarketBoard && def.Chest == nil {
						continue
					}
					reach := 1
					if def.Resource != nil && def.Resource.Reach > 0 {
						reach = def.Resource.Reach
					}
					if !usable(at, reach) {
						t.Errorf("the %s at %v cannot be used from anywhere a player gets", def.ID, at)
					}
				}
			}
		}
	}
	for _, n := range s.w.NPCs() {
		if inside(n.Pos()) && !usable(n.Pos(), session.TalkRange) {
			t.Errorf("nobody gets near enough to talk to %s at %v", n.Kind(), n.Pos())
		}
	}
}

// TestSandboxToolsHaveAUse: every tool the provisioner sells has something to work on the
// island: a resource tile for its tool.use (a vein, a tree, a shoal), a rope spot for a
// rope, or a recipe that asks for it at a station of the island.
func TestSandboxToolsHaveAUse(t *testing.T) {
	s := newSandbox(t)
	npcs, err := content.LoadNPCs(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	recipes, err := content.LoadRecipes(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	byNum := s.items.ByNumeric()
	is := s.m.Island("pruebas")
	uses := map[string]bool{}
	stations := map[string]bool{}
	for _, z := range is.Floors {
		for y := is.Rect.Y; y < is.Rect.Y+is.Rect.H; y++ {
			for x := is.Rect.X; x < is.Rect.X+is.Rect.W; x++ {
				at := at3(int(x), int(y), int(z))
				ground, _, ok := s.m.Tile(at)
				if !ok {
					continue
				}
				for _, n := range append([]uint16{ground}, s.m.Stack(at)...) {
					if def := byNum[n]; def != nil {
						if def.Resource != nil {
							uses[def.Resource.Tool] = true
						}
						stations[def.ID] = true
					}
				}
				if pt := s.m.PortalAt(at); pt != nil && pt.Kind == world.PortalRopeSpot {
					uses["rope"] = true
				}
			}
		}
	}
	for _, r := range recipes {
		if r.Tool != "" && stations[r.Station] {
			uses[r.Tool] = true
		}
	}
	for _, o := range npcs["pruebas_merchant"].Shop.Sells {
		if def := s.items[o.Item]; def.Tool != nil && !uses[def.Tool.Use] {
			t.Errorf("the provisioner sells %s (tool.use %s) and nothing on the island takes it", o.Item, def.Tool.Use)
		}
	}
}

// TestSandboxTraining: the instructor's experience raises the level, not the skills, and
// her training raises the skills. A guardian of level 21 with the provisioner's iron
// sword, plank shield, stag-leather coat, cap and 20 poultices dies in pen 4 with sword and shield
// at 10; the same guardian trained for combat (sword, axe and club 45, shield 40, magic
// level 2) kills a thornling and lives. Training never lowers a skill.
func TestSandboxTraining(t *testing.T) {
	combat := []string{"sword", "axe", "club", "shield", "magic"}
	for _, trained := range []bool{false, true} {
		s := newSandbox(t)
		s.mayDie = true
		cl, p := s.hero(5951, "Espada", "guardian", 2, 1, 1, gear{"iron_sword", 1, slotRight},
			gear{"plank_shield", 1, slotLeft}, gear{"stagleather_coat", 1, slotArmor}, gear{"sailcloth_cap", 1, slotHead},
			gear{"seaweed_poultice", 20, 0})
		if s.w.Level(p) != 21 {
			t.Fatalf("level %d, want 21", s.w.Level(p))
		}
		want := map[string]int{"sword": 10, "axe": 10, "club": 10, "shield": 10, "magic": 0}
		if trained {
			evs := s.train(cl, p, "combat")
			if n := systemKeys(evs)["progress.skill_up"]; n != len(combat) {
				t.Fatalf("training told %d skill ups, want %d: %v", n, len(combat), systemKeys(evs))
			}
			want = map[string]int{"sword": 45, "axe": 45, "club": 45, "shield": 40, "magic": 2}
		}
		if got := s.skillLevels(p, combat...); !maps.Equal(got, want) {
			t.Fatalf("trained %v: skills %v, want %v", trained, got, want)
		}
		loot := s.huntForLoot("thornling", penGap(4), penAway(4), 3, fighter{cl: cl, p: p})
		if died := len(s.deaths) > 0; died == trained {
			t.Fatalf("level 21 guardian (trained %v, skills %v): died %v (loot %v)", trained, want, died, loot)
		}
	}

	// Training never lowers a skill: a sword above the instructor's stays where it was,
	// and asking again changes nothing.
	s := newSandbox(t)
	cl, p := s.newcomer(5952, "Veterana", "guardian")
	s.sim.Command(gameFunc(func() { s.w.TrainForTest(p, "sword", 20000) }))
	s.sim.Step()
	sword := s.w.Skill(p, "sword").Level
	if sword <= 45 {
		t.Fatalf("20000 sword tries: level %d", sword)
	}
	s.train(cl, p, "combat")
	before := s.skillLevels(p, combat...)
	if before["sword"] != sword || before["shield"] != 40 {
		t.Fatalf("after training: %v (sword was %d)", before, sword)
	}
	if evs := s.train(cl, p, "combat"); hasKey(evs, "progress.skill_up") || !maps.Equal(s.skillLevels(p, combat...), before) {
		t.Fatalf("training twice: %v, %v", s.skillLevels(p, combat...), systemKeys(evs))
	}
}

// TestSandboxTrainingByVocation: each vocation trains its own combat skills and magic
// level, the one of its last spell (so every spell can be tried with the free
// experience), and a druid trained at level 8 casts mend_other (magic level 2) on a
// wounded guardian, which it could not do before.
func TestSandboxTrainingByVocation(t *testing.T) {
	s := newSandbox(t)
	for i, c := range []struct {
		vocation string
		want     map[string]int
	}{
		{"guardian", map[string]int{"sword": 45, "axe": 45, "club": 45, "shield": 40, "magic": 2}},
		{"ranger", map[string]int{"distance": 45, "sword": 30, "axe": 30, "club": 30, "shield": 35, "magic": 9}},
		{"arcanist", map[string]int{"magic": 30, "shield": 20, "sword": 10, "distance": 10}},
		{"druid", map[string]int{"magic": 30, "shield": 20, "sword": 10, "distance": 10}},
	} {
		cl, p := s.newcomer(int64(5960+i), fmt.Sprintf("Voc%d", i), c.vocation)
		s.train(cl, p, "combat")
		ids := make([]string, 0, len(c.want))
		for id := range c.want {
			ids = append(ids, id)
		}
		if got := s.skillLevels(p, ids...); !maps.Equal(got, c.want) {
			t.Errorf("%s trained: %v, want %v", c.vocation, got, c.want)
		}
		for _, id := range s.spells.IDs() {
			if sp := s.spells[id]; sp.CastBy(c.vocation) && sp.MagicLevel > c.want["magic"] {
				t.Errorf("%s trained to magic level %d cannot try %s (magic level %d)", c.vocation, c.want["magic"], id, sp.MagicLevel)
			}
		}
	}

	gcl, g := s.newcomer(5965, "Herido", "guardian")
	dcl, d := s.hero(5966, "Sanadora", "druid", 0, 1, 1)
	if s.w.Level(d) != 8 || s.w.Skill(d, "magic").Level != 0 {
		t.Fatalf("druid level %d, magic level %d", s.w.Level(d), s.w.Skill(d, "magic").Level)
	}
	near := s.beside(d.Pos())
	s.walkTo(gcl, g, near)
	mend := func() []*pb.ServerMessage {
		s.sim.Command(gameFunc(func() { g.SetHealthForTest(20); d.SetManaForTest(d.MaxMana()) }))
		s.sim.Step()
		return s.send(dcl, castAt("mend_other", g.ID()))
	}
	if evs := mend(); !hasKey(evs, "magic.magic_level_required") {
		t.Fatalf("mend_other at magic level 0: %v", systemKeys(evs))
	}
	s.train(dcl, d, "combat")
	if s.w.Skill(d, "magic").Level != 30 {
		t.Fatalf("druid trained to magic level %d", s.w.Skill(d, "magic").Level)
	}
	s.walkTo(gcl, g, s.beside(d.Pos()))
	s.sim.RunFor(2 * time.Second) // the healing group cooldown
	if evs := mend(); hasKey(evs, "magic.magic_level_required") {
		t.Fatalf("mend_other at magic level 30: %v", systemKeys(evs))
	}
	if hp, _ := g.Health(); hp <= 20 {
		t.Fatalf("mend_other left the guardian at %d health", hp)
	}
}

// TestSandboxTradesTraining: the instructor's trades training (every craft 25, fishing 40)
// puts every recipe of data/recipes.yaml within reach.
func TestSandboxTradesTraining(t *testing.T) {
	s := newSandbox(t)
	cl, p := s.newcomer(5970, "Oficios", "druid")
	s.train(cl, p, "trades")
	want := map[string]int{"mining": 25, "woodcutting": 25, "smithing": 25, "cooking": 25, "alchemy": 25, "fishing": 40}
	ids := make([]string, 0, len(want))
	for id := range want {
		ids = append(ids, id)
	}
	if got := s.skillLevels(p, ids...); !maps.Equal(got, want) {
		t.Fatalf("trades trained: %v, want %v", got, want)
	}
	recipes, err := content.LoadRecipes(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range recipes.IDs() {
		if r := recipes[id]; r.Level > s.w.Skill(p, r.Craft).Level {
			t.Errorf("recipe %s asks for %s %d, beyond the training", id, r.Craft, r.Level)
		}
	}
}

// TestSandboxDevOnlyOffTheSandbox: the instructor is dev_only. Were she on an island that
// is not dev-only (past the startup check, which refuses that:
// TestDevOnlyActionsRefusedOffDevIslands), the server would refuse every option of hers
// but "bye" with dialog.dev_only: her healing with mana, and also "Entréname", which only
// leads to her training (review of lote 5), so nothing of it is reached. Training itself
// is refused off the island too (dialog.TestDevOnlyActionsNeedADevIsland).
func TestSandboxDevOnlyOffTheSandbox(t *testing.T) {
	s := newSandbox(t)
	cl, p := s.newcomer(5980, "Lejos", "arcanist")
	trainer := s.npc("pruebas_trainer")
	s.sim.Command(gameFunc(func() {
		trainer.SetDevForTest(false)
		p.SetHealthForTest(10)
		p.SetManaForTest(0)
	}))
	s.sim.Step()
	d := s.talk(cl, p, "pruebas_trainer")
	d, evs := s.say(cl, d, "npc.pruebas_trainer.opt_heal")
	if !hasKey(evs, "dialog.dev_only") || d == nil || d.Text.Key != "npc.pruebas_trainer.greet" {
		t.Fatalf("heal off the sandbox: %v", systemKeys(evs))
	}
	if hp, _ := p.Health(); hp > 10 || p.Mana() > 1 {
		t.Fatalf("heal off the sandbox ran: health %d, mana %d", hp, p.Mana())
	}
	d, evs = s.say(cl, d, "npc.pruebas_trainer.opt_train")
	if !hasKey(evs, "dialog.dev_only") || d == nil || d.Text.Key != "npc.pruebas_trainer.greet" {
		t.Fatalf("Entréname off the sandbox: %v, dialog %v", systemKeys(evs), d)
	}
	if s.w.Skill(p, "magic").Level != 0 || s.w.Skill(p, "smithing").Level != 1 {
		t.Fatalf("training off the sandbox ran: magic %d, smithing %d", s.w.Skill(p, "magic").Level, s.w.Skill(p, "smithing").Level)
	}
}

// The living world's corner of Thimblewick (docs/16 "Mundo vivo"): the thorny vines that
// close the garden break with bare hands, and the two boulders pushed onto their plates
// open the portcullis; the crater of the volcano has its shortcuts too.
func TestSandboxLivingWorld(t *testing.T) {
	s := newSandbox(t)
	vines, gate := pos(2096, 2070), pos(2105, 2068)
	if s.m.Walkable(vines) || s.m.Walkable(gate) {
		t.Fatal("the vines and the portcullis start closed")
	}
	join := func(id int64, at world.Pos) *fakeClient {
		cl, _ := s.joinChar(session.Character{ID: id, AccountID: id, Name: fmt.Sprintf("Viva%d", id),
			Vocation: "guardian", Level: 8, Health: 200, Mana: 50, HasPos: true, Pos: at})
		s.sim.Step()
		cl.take()
		return cl
	}
	cutter := join(5301, pos(2096, 2071))
	vinesID := s.num("thorny_vines")
	for i := 0; i < 20 && !s.m.Walkable(vines); i++ {
		s.input(cutter, useItem(onTile(vines), vinesID, uint32(s.w.StaticCount(vines)-1)))
		s.sim.RunTicks(40)
	}
	if !s.m.Walkable(vines) {
		t.Fatalf("the vines did not break: %+v", s.w.LivingObjects())
	}
	a := join(5302, pos(2100, 2070))
	s.input(a, push(pos(2101, 2070), E))
	s.sim.Step()
	b := join(5303, pos(2105, 2072))
	s.input(b, push(pos(2105, 2071), N))
	s.sim.RunTicks(2)
	if !s.m.Walkable(gate) {
		t.Fatalf("both plates are held by boulders: the portcullis must be open (%+v)", s.w.LivingObjects())
	}
	// Someone goes into the vault; the boulders go home 180 s after the last push and the
	// portcullis closes behind it. The teleport inside takes it out.
	inside, vaultExit := pos(2105, 2067), pos(2104, 2071)
	in, inP := s.joinChar(session.Character{ID: 5304, AccountID: 5304, Name: "Viva5304",
		Vocation: "guardian", Level: 8, Health: 200, Mana: 50, HasPos: true, Pos: inside})
	if inP.Pos() != inside {
		t.Fatalf("joined at %v, want %v in the vault", inP.Pos(), inside)
	}
	s.sim.RunTicks(181 * 20)
	if s.m.Walkable(gate) {
		t.Fatalf("the boulders went home: the portcullis must be closed (%+v)", s.w.LivingObjects())
	}
	in.take()
	s.input(in, walkPath(N))
	s.sim.RunTicks(40)
	if inP.Pos() != vaultExit {
		t.Fatalf("shut in the vault at %v, want out by its teleport at %v", inP.Pos(), vaultExit)
	}
	// The volcano's crater: a cracked rock and a rotten barricade in its wall.
	if s.m.Walkable(pos3(3699, 5753, 7)) || s.m.Walkable(pos3(3714, 5746, 7)) {
		t.Fatal("the crater's shortcuts start closed")
	}

	// After a restart the portcullis is closed: a player saved in the vault logs in there
	// and leaves by its teleport.
	s = newSandbox(t)
	back, backP := s.joinChar(session.Character{ID: 5305, AccountID: 5305, Name: "Viva5305",
		Vocation: "guardian", Level: 8, Health: 200, Mana: 50, HasPos: true, Pos: inside})
	if s.m.Walkable(gate) || backP.Pos() != inside {
		t.Fatalf("after a restart: gate open %v, logged in at %v", s.m.Walkable(gate), backP.Pos())
	}
	s.input(back, walkPath(N))
	s.sim.RunTicks(40)
	if backP.Pos() != vaultExit {
		t.Fatalf("shut in the vault after a restart at %v", backP.Pos())
	}
}

func pos3(x, y int, z uint8) world.Pos { return world.Pos{X: uint16(x), Y: uint16(y), Z: z} }
