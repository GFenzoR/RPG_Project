package session_test

import (
	"math"
	"strings"
	"testing"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"

	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// FuzzInputDispatch (lote 16) feeds arbitrary ClientMessage bytes to the session's input
// dispatch, as the gateway would after decoding them: a world with the real data/ (items,
// NPCs, quests, monsters), two fresh characters next to the port NPCs and a wolf spawn.
// Bytes the gateway would kick for (no protobuf, no oneof) are skipped. Whatever the
// message, no command, event or system may panic (the loop would recover and count it),
// the economy ledger must reconcile (dataHarness fails the test on a mismatch) and the
// AOI must stay consistent.
//
// The seeds (f.Add plus testdata/fuzz/FuzzInputDispatch) run in make test; make fuzz
// mutates them (docs/08).
func FuzzInputDispatch(f *testing.F) {
	for _, m := range inputSeeds() {
		raw, err := proto.Marshal(m)
		if err != nil {
			f.Fatal(err)
		}
		f.Add(raw)
	}
	f.Fuzz(func(t *testing.T, raw []byte) {
		msg := &pb.ClientMessage{}
		if proto.Unmarshal(raw, msg) != nil || msg.GetMessage() == nil {
			t.Skip("the gateway kicks for this frame before the session sees it")
		}
		h := dataHarness(t, world.Spawn{ID: "wolves", Center: pos(20, 20), Radius: 2, RespawnSeconds: 60,
			Monsters: []world.SpawnMonster{{Monster: "wolf", Count: 2}}})
		a := session.Character{ID: 9101, AccountID: 9101, Name: "Fuzzer", Vocation: "guardian", Level: 20, Health: 1000, Mana: 100}
		b := session.Character{ID: 9102, AccountID: 9102, Name: "Bystander", Vocation: "guardian", Level: 20, Health: 1000, Mana: 100}
		ca, _ := h.joinFresh(a, pos(10, 11))
		cb, _ := h.joinFresh(b, pos(11, 11))
		step := func() {
			t.Helper()
			if st := h.sim.Step(); st.Panics != 0 {
				t.Fatalf("tick %d: %d panics dispatching %v", h.sim.Tick(), st.Panics, msg)
			}
		}
		// Twice from the fuzzer (a second identical message hits the state the first one
		// left: an open dialog, a trade, a queued walk), then once from the bystander.
		h.input(ca, msg)
		step()
		h.input(ca, msg)
		step()
		h.input(cb, msg)
		for range 40 { // 2 s: walks, attacks, cooldowns and trades run on
			step()
		}
		for i, cl := range []*fakeClient{ca, cb} {
			if cl.closes > 1 {
				t.Fatalf("client %d closed %d times", i, cl.closes)
			}
		}
	})
}

// inputSeeds is one message per ClientMessage oneof with every field at its zero value,
// one with every field at an extreme (max and min integers, an out-of-range enum, a long
// string, nested messages filled the same way) and a few plausible ones that reach
// deeper: the creature ids of a fresh world (players 1-2, NPCs, wolves), the first
// inventory slots and the port NPCs' dialogs and shops.
func inputSeeds() []*pb.ClientMessage {
	var out []*pb.ClientMessage
	oneof := (&pb.ClientMessage{}).ProtoReflect().Descriptor().Oneofs().ByName("message")
	for i := range oneof.Fields().Len() {
		fd := oneof.Fields().Get(i)
		for _, fill := range []bool{false, true} {
			m := &pb.ClientMessage{}
			sub := m.ProtoReflect().Mutable(fd).Message()
			if fill {
				extremes(sub, 2)
			}
			out = append(out, m)
		}
	}
	for id := uint32(1); id <= 12; id++ {
		out = append(out,
			&pb.ClientMessage{Message: &pb.ClientMessage_SetTarget{SetTarget: &pb.SetTarget{CreatureId: id}}},
			&pb.ClientMessage{Message: &pb.ClientMessage_NpcTalk{NpcTalk: &pb.NpcTalk{CreatureId: id}}},
			&pb.ClientMessage{Message: &pb.ClientMessage_TradeRequest{TradeRequest: &pb.TradeRequest{CreatureId: id}}},
			&pb.ClientMessage{Message: &pb.ClientMessage_LookAt{LookAt: &pb.LookAt{CreatureId: id}}},
			&pb.ClientMessage{Message: &pb.ClientMessage_CastSpell{CastSpell: &pb.CastSpell{Spell: &pb.CastSpell_SpellId{SpellId: "conjure_arrows"},
				Target: &pb.ActionTarget{Target: &pb.ActionTarget_CreatureId{CreatureId: id}}}}},
		)
	}
	for slot := uint32(0); slot < 4; slot++ {
		from := &pb.ItemLocation{Location: &pb.ItemLocation_Container{Container: &pb.ContainerSlot{Index: slot}}}
		pocket := &pb.ItemLocation{Location: &pb.ItemLocation_Pocket{Pocket: slot}}
		out = append(out,
			&pb.ClientMessage{Message: &pb.ClientMessage_UseItem{UseItem: &pb.UseItem{From: from}}},
			&pb.ClientMessage{Message: &pb.ClientMessage_MoveItem{MoveItem: &pb.MoveItem{From: from, Count: math.MaxUint32,
				To: &pb.ItemLocation{Location: &pb.ItemLocation_Pos{Pos: &pb.Position{X: 11, Y: 10, Z: 7}}}}}},
			&pb.ClientMessage{Message: &pb.ClientMessage_MoveItem{MoveItem: &pb.MoveItem{From: pocket, Count: 1, To: from}}},
			&pb.ClientMessage{Message: &pb.ClientMessage_LookAt{LookAt: &pb.LookAt{From: pocket}}},
			&pb.ClientMessage{Message: &pb.ClientMessage_ShopSell{ShopSell: &pb.ShopSell{DialogId: slot, ItemId: slot, Count: 101}}},
		)
	}
	out = append(out,
		&pb.ClientMessage{Message: &pb.ClientMessage_Say{Say: &pb.Say{Text: "hola " + rlo + string(rune(0)) + strings.Repeat("ñ", 300)}}},
		&pb.ClientMessage{Message: &pb.ClientMessage_WalkPath{WalkPath: &pb.WalkPath{Steps: make([]pb.Direction, 500)}}},
		&pb.ClientMessage{Message: &pb.ClientMessage_CastSpell{CastSpell: &pb.CastSpell{Spell: &pb.CastSpell_Words{Words: "exura"}}}},
	)
	return out
}

// extremes sets every scalar field of m to an edge value and fills its message fields
// (oneof members included, the first of each oneof) down to depth levels.
func extremes(m protoreflect.Message, depth int) {
	fields := m.Descriptor().Fields()
	for i := range fields.Len() {
		fd := fields.Get(i)
		if o := fd.ContainingOneof(); o != nil && !o.IsSynthetic() && o.Fields().Get(0) != fd {
			continue
		}
		if fd.IsMap() {
			continue
		}
		if fd.Kind() == protoreflect.MessageKind || fd.Kind() == protoreflect.GroupKind {
			if depth == 0 {
				continue
			}
			if fd.IsList() {
				l := m.Mutable(fd).List()
				for range 3 {
					extremes(l.AppendMutable().Message(), depth-1)
				}
				continue
			}
			extremes(m.Mutable(fd).Message(), depth-1)
			continue
		}
		v := edge(fd)
		if fd.IsList() {
			l := m.Mutable(fd).List()
			for range 3 {
				l.Append(v)
			}
			continue
		}
		m.Set(fd, v)
	}
}

// rlo is U+202E RIGHT-TO-LEFT OVERRIDE, which chat must strip (cleanChat).
var rlo = string(rune(0x202e))

func edge(fd protoreflect.FieldDescriptor) protoreflect.Value {
	switch fd.Kind() {
	case protoreflect.BoolKind:
		return protoreflect.ValueOfBool(true)
	case protoreflect.EnumKind:
		return protoreflect.ValueOfEnum(protoreflect.EnumNumber(math.MaxInt32))
	case protoreflect.Int32Kind, protoreflect.Sint32Kind, protoreflect.Sfixed32Kind:
		return protoreflect.ValueOfInt32(math.MinInt32)
	case protoreflect.Int64Kind, protoreflect.Sint64Kind, protoreflect.Sfixed64Kind:
		return protoreflect.ValueOfInt64(math.MinInt64)
	case protoreflect.Uint32Kind, protoreflect.Fixed32Kind:
		return protoreflect.ValueOfUint32(math.MaxUint32)
	case protoreflect.Uint64Kind, protoreflect.Fixed64Kind:
		return protoreflect.ValueOfUint64(math.MaxUint64)
	case protoreflect.FloatKind:
		return protoreflect.ValueOfFloat32(float32(math.NaN()))
	case protoreflect.DoubleKind:
		return protoreflect.ValueOfFloat64(math.Inf(-1))
	case protoreflect.StringKind:
		return protoreflect.ValueOfString(strings.Repeat(rlo+"éx", 400))
	case protoreflect.BytesKind:
		return protoreflect.ValueOfBytes([]byte{0, 0xff, 0x80})
	}
	return fd.Default()
}
