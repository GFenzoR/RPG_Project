package session_test

import (
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// A corpse per direction (docs/17 "Un cadáver por dirección", docs/05 "Restos"): the remains
// carry the way the creature faced when it died, reduced to the four facings a corpse is
// drawn in, and a player's body its owner's sex.

// topMods is the mods of the topmost item the last TileUpdate of evs put on p (nil: none).
func topMods(evs []*pb.ServerMessage, p world.Pos) *pb.ItemMods {
	var out *pb.ItemMods
	for _, u := range find(evs, (*pb.ServerMessage).GetTileUpdate) {
		q := u.GetPos()
		items := u.GetTile().GetItems()
		if q.GetX() != uint32(p.X) || q.GetY() != uint32(p.Y) || len(items) == 0 {
			continue
		}
		out = items[len(items)-1].GetMods()
	}
	return out
}

func TestFallFacingIsOneOfFour(t *testing.T) {
	for d, want := range map[world.Direction]pb.Direction{
		world.North:     N,
		world.NorthEast: E,
		world.East:      E,
		world.SouthEast: E,
		world.South:     S,
		world.SouthWest: W,
		world.West:      W,
		world.NorthWest: W,
	} {
		if got := session.FallFacing(d); got != want {
			t.Errorf("a creature facing %d falls %v, want %v", d, got, want)
		}
	}
}

// Each monster's remains say the way it faced, on the server and to who watches, and keep
// saying it when they are dragged to another tile.
func TestMonsterRemainsCarryItsFacing(t *testing.T) {
	m := worldtest.Map(t, 0, 0, 7,
		"############",
		"#T.........#",
		"#..........#",
		"#..........#",
		"#..........#",
		"############",
	)
	h := dragHarness(t, m, testItems(),
		spawnAt("rat", 2, 2, 0, 600), spawnAt("rat", 4, 2, 0, 600),
		spawnAt("rat", 6, 2, 0, 600), spawnAt("rat", 8, 2, 0, 600))
	cl, _ := h.join("Witness", at(4, 3))
	h.sim.Step()
	// Each one turns its own way and dies in the same tick: nothing moves it in between.
	ways := map[world.Pos]struct {
		look world.Pos
		want pb.Direction
	}{}
	h.sim.Command(ctxFunc(func(ctx *game.TickContext) {
		turns := []struct {
			dx, dy int
			want   pb.Direction
		}{{0, -1, N}, {1, 0, E}, {0, 1, S}, {-1, 0, W}}
		for i, mon := range h.w.Monsters() {
			p := mon.Pos()
			turn := turns[i%len(turns)]
			look := world.Pos{X: uint16(int(p.X) + turn.dx), Y: uint16(int(p.Y) + turn.dy), Z: p.Z}
			h.w.FaceForTest(mon, look)
			ways[p] = struct {
				look world.Pos
				want pb.Direction
			}{look, turn.want}
		}
	}))
	cl.take()
	killAll(h) // queued behind the turns: the same tick runs both
	if len(ways) != 4 {
		t.Fatalf("monsters at %v", ways)
	}
	evs := cl.take()
	seen := map[pb.Direction]bool{}
	for p, way := range ways {
		cs := h.w.CorpsesAt(p)
		if len(cs) != 1 {
			t.Fatalf("remains at %v: %v", p, cs)
		}
		if got := cs[0].Item.Mods().Facing; got != way.want {
			t.Errorf("the rat at %v fell facing %v, want %v", p, got, way.want)
		}
		mods := topMods(evs, p)
		if mods.GetRemainsOf() != "rat" || mods.GetFacing() != way.want {
			t.Errorf("the clients saw %v on %v, want the remains of a rat facing %v", mods, p, way.want)
		}
		if mods.GetBodySex() != "" {
			t.Errorf("a monster's remains carry a sex: %v", mods)
		}
		seen[way.want] = true
	}
	if len(seen) != 4 {
		t.Fatalf("the four facings were not all tried: %v", seen)
	}

	// Dragged a tile away, the remains still lie the way the monster fell: the tile they
	// land on is sent with the same facing, and the window that opens says it too.
	var from world.Pos
	var want pb.Direction
	for p, way := range ways {
		if p == pos(4, 2) {
			from, want = p, way.want
		}
	}
	if want == S {
		t.Fatalf("the dragged remains face south, the default: the test proves nothing")
	}
	cl.take()
	h.input(cl, moveItem(onTile(from), corpseID, 1, onTile(pos(5, 3)), 1))
	h.sim.Step()
	evs = cl.take()
	if msgs := find(evs, (*pb.ServerMessage).GetChatMessage); len(msgs) != 0 {
		t.Fatalf("drag refused: %v", msgs)
	}
	if mods := topMods(evs, pos(5, 3)); mods.GetRemainsOf() != "rat" || mods.GetFacing() != want {
		t.Errorf("the dragged remains arrived as %v, want facing %v", mods, want)
	}
	if cs := h.w.CorpsesAt(pos(5, 3)); len(cs) != 1 || cs[0].Item.Mods().Facing != want {
		t.Errorf("the dragged remains on the server: %v", cs)
	}
	h.input(cl, useItem(onTile(pos(5, 3)), corpseID, 1))
	h.sim.Step()
	opens := find(cl.take(), (*pb.ServerMessage).GetContainerOpen)
	if len(opens) != 1 || opens[0].GetMods().GetFacing() != want {
		t.Errorf("the window of the dragged remains: %v", opens)
	}
}

// A player's body says the way the player faced and its sex, and keeps both when dragged.
func TestPlayerBodyCarriesFacingAndSex(t *testing.T) {
	for _, c := range []struct {
		name string
		sex  string
		turn pb.Direction
	}{
		{"a woman facing west", "female", W},
		{"a man facing north", "male", N},
		{"a look from before the sexes, facing east", "", E},
	} {
		t.Run(c.name, func(t *testing.T) {
			h := deathHarness(t)
			nextChar++
			owner, p := h.joinChar(session.Character{ID: nextChar, AccountID: nextChar, Name: "Owner",
				Vocation: "guardian", Level: 20, Health: 100, Mana: 0, Pos: pos(40, 40), HasPos: true,
				Look: content.Look{Sex: c.sex, Body: "sturdy", Skin: "fair", Hair: "short", HairColor: "brown", Beard: "none"}})
			other, _ := h.join("Other", at(41, 40))
			h.input(owner, &pb.ClientMessage{Message: &pb.ClientMessage_Turn{Turn: &pb.Turn{Dir: c.turn}}})
			h.sim.Step()
			sex := p.LookForTest().Sex // what the server kept of the look
			other.take()
			h.kill(p)
			body := pos(40, 40)
			cs := h.w.CorpsesAt(body)
			if len(cs) != 1 {
				t.Fatalf("bodies: %v", cs)
			}
			if m := cs[0].Item.Mods(); m.BodyOf != "Owner" || m.Facing != c.turn || m.BodySex != sex {
				t.Errorf("the body's mods %+v, want Owner's, facing %v, sex %q", m, c.turn, sex)
			}
			mods := topMods(other.take(), body)
			if mods.GetBodyOf() != "Owner" || mods.GetFacing() != c.turn || mods.GetBodySex() != sex {
				t.Errorf("who stood by saw %v, want Owner's body facing %v, sex %q", mods, c.turn, sex)
			}
			if c.sex != "" && sex != c.sex {
				t.Errorf("the server kept sex %q of a %q look", sex, c.sex)
			}

			// Its owner comes back and drags it: the same body, lying the same way.
			h.sim.Command(gameFunc(func() { h.w.Teleport(p, pos(39, 40)) }))
			h.sim.Step()
			owner.take()
			h.input(owner, moveItem(onTile(body), corpseID, 1, onTile(pos(40, 41)), 1))
			h.sim.Step()
			evs := owner.take()
			if msgs := find(evs, (*pb.ServerMessage).GetChatMessage); len(msgs) != 0 {
				t.Fatalf("drag refused: %v", msgs)
			}
			moved := topMods(evs, pos(40, 41))
			if moved.GetBodyOf() != "Owner" || moved.GetFacing() != c.turn || moved.GetBodySex() != sex {
				t.Errorf("the dragged body arrived as %v, want facing %v, sex %q", moved, c.turn, sex)
			}
		})
	}
}
