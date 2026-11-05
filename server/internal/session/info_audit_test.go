package session_test

import (
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/reflect/protoreflect"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// Information audit (T4.1, docs/01-architecture.md "Trampas y anti-bot"): everything the
// server sends can be read by a modified client, so these tests read every message an
// observer receives and check that nothing it may not see is in it. TestInvisibility-
// IsFilteredByServer (condition_test.go) and TestPartyInfoAudit (party_test.go) cover
// invisibility and parties.

// seen is what a batch of messages tells about the world, found by walking every field.
type seen struct {
	positions []world.Pos // every Position (creatures, tiles, effects, chat...)
	ids       map[uint32]bool
	floors    map[uint32]bool // MapFloor.z of the map areas
	areas     []world.Rect    // MapArea rects
	kinds     map[string]int  // top-level message kinds
	private   map[string]int  // kinds that only ever describe the receiver
}

// idFields are the uint32 fields that hold a creature id.
var idFields = map[protoreflect.Name]bool{"id": true, "creature_id": true, "speaker_id": true, "inviter_id": true,
	"leader_id": true, "npc_creature_id": true, "partner_creature_id": true}

// privateKinds are the messages that describe the receiver itself: exact health and
// mana, skills, inventory, containers and conditions.
var privateKinds = map[string]bool{"player_stats": true, "player_skills": true, "inventory": true,
	"container_open": true, "container_update": true, "player_conditions": true}

func scan(evs []*pb.ServerMessage) seen {
	s := seen{ids: map[uint32]bool{}, floors: map[uint32]bool{}, kinds: map[string]int{}, private: map[string]int{}}
	var walk func(m protoreflect.Message)
	walk = func(m protoreflect.Message) {
		d := m.Descriptor()
		switch d.Name() {
		case "Position":
			f := d.Fields()
			s.positions = append(s.positions, world.Pos{X: uint16(m.Get(f.ByName("x")).Uint()),
				Y: uint16(m.Get(f.ByName("y")).Uint()), Z: uint8(m.Get(f.ByName("z")).Uint())})
		case "MapFloor":
			s.floors[uint32(m.Get(d.Fields().ByName("z")).Uint())] = true
		case "MapArea":
			f := d.Fields()
			s.areas = append(s.areas, world.Rect{X: uint32(m.Get(f.ByName("x")).Uint()), Y: uint32(m.Get(f.ByName("y")).Uint()),
				W: uint32(m.Get(f.ByName("width")).Uint()), H: uint32(m.Get(f.ByName("height")).Uint())})
		}
		m.Range(func(fd protoreflect.FieldDescriptor, v protoreflect.Value) bool {
			switch {
			case fd.Kind() == protoreflect.Uint32Kind && !fd.IsList() && idFields[fd.Name()]:
				s.ids[uint32(v.Uint())] = true
			case fd.Kind() == protoreflect.MessageKind && fd.IsList():
				for i := range v.List().Len() {
					walk(v.List().Get(i).Message())
				}
			case fd.Kind() == protoreflect.MessageKind && !fd.IsMap():
				walk(v.Message())
			}
			return true
		})
	}
	for _, e := range evs {
		r := e.ProtoReflect()
		if f := r.WhichOneof(r.Descriptor().Oneofs().Get(0)); f != nil {
			k := string(f.Name())
			s.kinds[k]++
			if privateKinds[k] {
				s.private[k]++
			}
		}
		walk(r)
	}
	return s
}

// checkWindow fails if anything in s lies outside what a viewer at v sees: positions,
// map areas (the visible window) and map floors (underground only its own floor).
func checkWindow(t *testing.T, what string, v world.Pos, s seen) {
	t.Helper()
	for _, p := range s.positions {
		if !session.Sees(v, p) {
			t.Errorf("%s: a viewer at %v got position %v", what, v, p)
		}
	}
	for _, a := range s.areas {
		if int(a.X) < int(v.X)-session.ViewHalfW || int(a.Y) < int(v.Y)-session.ViewHalfH ||
			int(a.X+a.W)-1 > int(v.X)+session.ViewHalfW || int(a.Y+a.H)-1 > int(v.Y)+session.ViewHalfH {
			t.Errorf("%s: a viewer at %v got map area %+v", what, v, a)
		}
	}
	for z := range s.floors {
		if !session.Sees(v, world.Pos{X: v.X, Y: v.Y, Z: uint8(z)}) {
			t.Errorf("%s: a viewer on floor %d got floor %d", what, v.Z, z)
		}
	}
}

// Nothing outside the window travels: another player, a monster, an item dropped on
// the ground, a player's remains, its speech. When the viewer walks up to them, they
// arrive (the scan itself is checked).
func TestInfoAuditOutsideWindow(t *testing.T) {
	m := worldtest.Open(t, 0, 0, 96, 32)
	wolf := wolfDef()
	wolf.Behavior.Aggressive = false
	m.Islands()[0].Spawns = []world.Spawn{spawnAt("wolf", 60, 12, 0, 600)}
	h := newHarness(t, m, func(c *session.Config) {
		c.Monsters = content.Monsters{"wolf": wolf}
		c.Items = testItems()
		c.Balance.Death.BackpackDropPct = 100
	})
	vcl, viewer := h.join("Viewer", at(10, 10))
	ocl, other := h.joinChar(withPack(980, pos(58, 10), stack(coinID, 30, 0), stack(swordID, 1, 1)))
	h.sim.RunTicks(5)
	vcl.take()
	open := openPack(t, h, ocl)
	h.input(ocl, moveItem(inContainer(open, 1), swordID, 0, onTile(pos(58, 11)), 1)) // an item on the ground
	h.input(ocl, say(pb.ChatChannel_CHAT_CHANNEL_YELL, "secret"))
	h.input(ocl, walkPath(E, E, S))
	h.sim.RunFor(5 * time.Second)
	h.sim.Command(ctxFunc(func(ctx *game.TickContext) { h.w.DieForTest(ctx, other) })) // remains at its tile
	h.sim.RunFor(3 * time.Second)
	if len(h.w.Monsters()) != 1 || len(h.w.CorpsesAt(pos(60, 11))) == 0 {
		t.Fatalf("setup: monsters %d, remains %v", len(h.w.Monsters()), h.w.CorpsesAt(pos(60, 11)))
	}

	s := scan(vcl.take())
	checkWindow(t, "far away", viewer.Pos(), s)
	if s.ids[other.ID()] || s.ids[h.w.Monsters()[0].ID()] {
		t.Errorf("the viewer got the ids of creatures outside its window: %v", s.ids)
	}
	if len(s.private) > 0 || s.kinds["chat_message"] > 0 {
		t.Errorf("the viewer got %v", s.kinds)
	}

	// Positive control: walking up to the remains shows them, and the wolf.
	h.input(vcl, walkPath(repeat(E, 45)...))
	h.sim.RunFor(60 * time.Second)
	s = scan(vcl.take()) // its own path is in it: no window check here
	if !s.ids[h.w.Monsters()[0].ID()] {
		t.Errorf("the scan missed the wolf after walking up to it (viewer at %v)", viewer.Pos())
	}
}

// Underground, only the current floor travels: not the floor above (a player standing
// right over the viewer) nor the one below. Above ground the lower floors are not sent.
func TestInfoAuditHiddenFloors(t *testing.T) {
	open := func(w, hgt int) []string {
		rows := make([]string, hgt)
		for i := range rows {
			rows[i] = strings.Repeat(".", w)
		}
		return rows
	}
	m := worldtest.Floors(t, 0, 0, worldtest.Layer{Z: 7, Rows: open(40, 30)}, worldtest.Layer{Z: 8, Rows: open(40, 30)},
		worldtest.Layer{Z: 9, Rows: open(40, 30)})
	h := newHarness(t, m)
	cave, caver := h.join("Caver", &world.Pos{X: 10, Y: 10, Z: 8})
	topCl, top := h.join("Top", &world.Pos{X: 10, Y: 10, Z: 7})
	deep, deeper := h.join("Deep", &world.Pos{X: 11, Y: 10, Z: 9})
	h.sim.RunTicks(3)
	for _, c := range []struct {
		cl *fakeClient
		p  *session.Player
	}{{cave, caver}, {deep, deeper}} {
		s := scan(c.cl.take()) // their logins and the others' arrivals
		checkWindow(t, "login underground", c.p.Pos(), s)
		for _, o := range []*session.Player{caver, top, deeper} {
			if o != c.p && s.ids[o.ID()] {
				t.Errorf("%s got the id of a player on floor %d", c.p.Pos(), o.Pos().Z)
			}
		}
	}
	// Everyone moves and talks; the cave dwellers must learn nothing of the others.
	h.input(topCl, walkPath(E, E))
	h.input(topCl, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "up here"))
	h.input(deep, walkPath(W))
	h.sim.RunFor(5 * time.Second)
	for _, c := range []struct {
		cl *fakeClient
		p  *session.Player
	}{{cave, caver}, {deep, deeper}} {
		s := scan(c.cl.take())
		checkWindow(t, "underground", c.p.Pos(), s)
		for _, o := range []*session.Player{caver, top, deeper} {
			if o != c.p && s.ids[o.ID()] {
				t.Errorf("%v got the id of the player at %v", c.p.Pos(), o.Pos())
			}
		}
		if s.kinds["chat_message"] > 0 {
			t.Errorf("%v heard the speech of another floor", c.p.Pos())
		}
	}
	// A fresh login underground (full view) has only its floor.
	cl2, p2 := h.join("Late", &world.Pos{X: 12, Y: 12, Z: 8})
	s := scan(cl2.take())
	checkWindow(t, "login underground", p2.Pos(), s)
	if len(s.floors) != 1 || !s.floors[8] {
		t.Errorf("login underground got floors %v", s.floors)
	}
	// Above ground the floors below are never sent.
	cl3, p3 := h.join("Sky", &world.Pos{X: 14, Y: 12, Z: 7})
	s = scan(cl3.take())
	checkWindow(t, "login above ground", p3.Pos(), s)
	if s.floors[8] || s.floors[9] {
		t.Errorf("login above ground got underground floors %v", s.floors)
	}
}

// Of other creatures only the public part travels: what the viewer gets while another
// player fights, heals, levels, trades items and drinks is never private, and the
// messages about creatures have no field for exact health, mana, skills or inventory.
func TestInfoAuditOthersArePublicOnly(t *testing.T) {
	forbidden := []string{"health", "max_health", "mana", "max_mana", "skills", "inventory", "items", "capacity",
		"experience", "level", "conditions"}
	sm := (&pb.ServerMessage{}).ProtoReflect().Descriptor()
	about := []protoreflect.MessageDescriptor{(&pb.Creature{}).ProtoReflect().Descriptor()}
	for i := range sm.Fields().Len() {
		if f := sm.Fields().Get(i); strings.HasPrefix(string(f.Name()), "creature_") {
			about = append(about, f.Message())
		}
	}
	if len(about) < 5 {
		t.Fatalf("found only %d creature messages", len(about))
	}
	for _, d := range about {
		for _, name := range forbidden {
			if d.Fields().ByName(protoreflect.Name(name)) != nil {
				t.Errorf("%s has a %s field: other players would read it", d.FullName(), name)
			}
		}
	}

	h := deathHarness(t)
	vcl, viewer := h.join("Viewer", at(36, 40))
	ocl, other := h.geared("Fighter", 30, 0)
	h.sim.Step()
	vcl.take()
	h.sim.Command(ctxFunc(func(ctx *game.TickContext) { h.w.HurtForTest(ctx, other, 40) }))
	h.sim.Command(gameFunc(func() { h.w.GiveForTest(other, "copper_coin", 7) }))
	h.sim.Command(gameFunc(func() { h.w.TrainForTest(other, "sword", 5000) }))
	h.sim.Command(gameFunc(func() { h.w.SetLevelForTest(other, 31) }))
	h.input(ocl, walk(S))
	h.sim.RunFor(3 * time.Second)
	s := scan(vcl.take())
	checkWindow(t, "in view", viewer.Pos(), s)
	if len(s.private) > 0 {
		t.Errorf("the viewer got private messages %v about another player", s.private)
	}
	if s.kinds["creature_health"] == 0 || !s.ids[other.ID()] {
		t.Errorf("the viewer did not get the public health percent: %v", s.kinds)
	}
}

func repeat(d pb.Direction, n int) []pb.Direction {
	out := make([]pb.Direction, n)
	for i := range out {
		out[i] = d
	}
	return out
}

// A yell reaches farther than the window: a listener that does not see the speaker
// hears it by name, without its position (T4.1 found this leak).
func TestInfoAuditYellFromOutsideWindow(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 64, 32))
	lcl, listener := h.join("Listener", at(10, 10))
	ycl, yeller := h.join("Yeller", at(25, 10)) // 15 tiles away: out of view, within yell range
	h.sim.Step()
	lcl.take()
	h.input(ycl, say(pb.ChatChannel_CHAT_CHANNEL_YELL, "over here"))
	h.sim.Step()
	evs := lcl.take()
	chats := find(evs, (*pb.ServerMessage).GetChatMessage)
	if len(chats) != 1 || chats[0].GetSpeakerName() != "Yeller" {
		t.Fatalf("the listener did not hear the yell: %v", kinds(evs))
	}
	checkWindow(t, "yell", listener.Pos(), scan(evs))
	if chats[0].GetPos() != nil {
		t.Errorf("the yell of %v carries its position to a listener at %v", yeller.Pos(), listener.Pos())
	}
}

// A shot from beyond the window that lands inside it comes from the window's edge: the
// shooter's tile is not sent (T4.1).
func TestInfoAuditProjectileFromOutsideWindow(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 64, 32))
	cl, p := h.join("Target", at(20, 10))
	h.sim.Step()
	cl.take()
	h.sim.Command(gameFunc(func() { h.w.ProjectileForTest(pos(20, 18), pos(20, 11)) })) // 8 rows below: out of view
	h.sim.Step()
	evs := cl.take()
	shots := find(evs, (*pb.ServerMessage).GetProjectile)
	if len(shots) != 1 {
		t.Fatalf("got %v", kinds(evs))
	}
	checkWindow(t, "projectile", p.Pos(), scan(evs))
	if f := shots[0].GetFrom(); f.GetX() != 20 || f.GetY() != 10+session.ViewHalfH || shots[0].GetTo().GetY() != 11 {
		t.Errorf("projectile from %v", f)
	}
}
