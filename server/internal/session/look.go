package session

import (
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
)

// Appearance (docs/02 "Apariencia", docs/05 "Apariencia y equipo visible"): every
// player, NPC and humanoid monster is an engine humanoid, a body (content.Look, ids of
// data/looks.yaml) with what it wears drawn over it. A player chooses its body when it
// creates the character and changes it for free with SetLook; what it shows it wears are
// the items of its visible slots (VisibleEquipment, item ids). Both go in its Creature and,
// when they change, in a CreatureLook to everyone who knows it. NPCs and monsters send the
// look of their data, built once per definition. Looks are only looks: no game rule reads
// Player.look.

// Message keys of SetLook.
const (
	msgLookInvalid     = "appearance.invalid"
	msgLookUnavailable = "appearance.unavailable"
)

// shownSlots are the equipment slots that show on the figure, in VisibleEquipment order:
// head, torso, legs, feet, left hand, right hand. Never the amulet, the ring, the backpack
// nor the ammo, nor anything inside a container.
var shownSlots = [...]pb.EquipmentSlot{
	pb.EquipmentSlot_EQUIPMENT_SLOT_HEAD,
	pb.EquipmentSlot_EQUIPMENT_SLOT_ARMOR,
	pb.EquipmentSlot_EQUIPMENT_SLOT_LEGS,
	pb.EquipmentSlot_EQUIPMENT_SLOT_FEET,
	pb.EquipmentSlot_EQUIPMENT_SLOT_LEFT_HAND,
	pb.EquipmentSlot_EQUIPMENT_SLOT_RIGHT_HAND,
}

// shownItems are the item ids of a player's visible slots (shownSlots order; 0 = empty).
type shownItems [len(shownSlots)]uint32

// bodyLookMsg is the protocol form of l.
func bodyLookMsg(l content.Look) *pb.BodyLook {
	return &pb.BodyLook{Sex: l.Sex, Body: l.Body, Skin: l.Skin, Hair: l.Hair, HairColor: l.HairColor, Beard: l.Beard}
}

// lookFromMsg is the look a client sent (nil fields are empty ids).
func lookFromMsg(m *pb.BodyLook) content.Look {
	return content.Look{Sex: m.GetSex(), Body: m.GetBody(), Skin: m.GetSkin(), Hair: m.GetHair(), HairColor: m.GetHairColor(), Beard: m.GetBeard()}
}

// equipmentMsg is the protocol form of s; nil when nothing shows.
func equipmentMsg(s shownItems) *pb.VisibleEquipment {
	if s == (shownItems{}) {
		return nil
	}
	return &pb.VisibleEquipment{Head: s[0], Torso: s[1], Legs: s[2], Feet: s[3], LeftHand: s[4], RightHand: s[5]}
}

// creatureLookMsgs is the look of an NPC or a monster as sent in every Creature of it:
// built once per definition at start and shared (a message is never changed after it is
// emitted, so every Creature may point at the same one).
type creatureLookMsgs struct {
	look *pb.BodyLook
	worn *pb.Worn
}

// creatureLook builds the messages of a definition's look; zero without one, or without
// data/looks.yaml.
func (w *World) creatureLook(c *content.CreatureLook) creatureLookMsgs {
	if c == nil || w.cfg.Looks == nil {
		return creatureLookMsgs{}
	}
	piece := func(slot string) *pb.WornPiece {
		p, ok := c.Worn[slot]
		if !ok {
			return nil
		}
		return &pb.WornPiece{Shape: p.Shape, Tint: p.Tint}
	}
	out := creatureLookMsgs{look: bodyLookMsg(c.Look)}
	if len(c.Worn) > 0 {
		out.worn = &pb.Worn{Head: piece("head"), Torso: piece("torso"), Legs: piece("legs"), Feet: piece("feet"),
			Shield: piece("shield"), Weapon: piece("weapon")}
	}
	return out
}

// loadLook sets p's look at login: the saved one if a player may wear it, else the one
// picked from its id (a character created before looks, or a choice that left
// data/looks.yaml); one saved before the sex keeps its other fields and gets the sex
// picked from its id (content.Looks.SavedLook). The next snapshot saves it.
func (w *World) loadLook(p *Player, c Character) {
	l := w.cfg.Looks
	if l == nil {
		// No data/looks.yaml: no look is sent, but the saved one is kept so the next
		// snapshot does not erase it.
		p.look = c.Look
		return
	}
	look := l.SavedLook(c.ID, c.Look)
	p.look, p.lookMsg = look, bodyLookMsg(look)
}

// showEquipment works out what p's visible slots show and, if it changed while p is in
// the world, marks p's look to be told (lookChanged). equipmentChanged calls it, so
// every path that changes p's equipment (equipping, taking off, an item used up or
// broken at the forge, what falls at a death, a trade or a sale) is covered.
func (w *World) showEquipment(p *Player) {
	var s shownItems
	for i, slot := range shownSlots {
		if it := p.equip[slot]; it != nil {
			s[i] = uint32(it.def.Numeric)
		}
	}
	if s == p.shown {
		return
	}
	p.shown, p.equipMsg = s, equipmentMsg(s)
	w.lookChanged(p)
}

// lookChanged marks p's look and visible equipment to be told once at the end of the
// tick (flushLooks), however many changes the tick had: moving a weapon between the hand
// and the backpack over and over costs its watchers one CreatureLook a tick, not one a
// MoveItem, and a SetLook and an equipment change of the same tick go in one message.
// Before p is in the world (its join) nothing is marked: its Creature carries it.
func (w *World) lookChanged(p *Player) {
	if p.lookDirty || w.byChar[p.charID] != p {
		return
	}
	p.lookDirty = true
	w.lookDirty = append(w.lookDirty, p)
}

// flushLooks sends each marked player's look and visible equipment to everyone whose
// client knows it, the player included (an invisible one only to itself). A player that
// left the world since it was marked is skipped (a relogin is another *Player). Marks
// made after it runs (later in the same flushSystem) go out with the next tick.
func (w *World) flushLooks() {
	for i, p := range w.lookDirty {
		w.lookDirty[i] = nil
		p.lookDirty = false
		if w.byChar[p.charID] == p {
			w.sendLook(p)
		}
	}
	w.lookDirty = w.lookDirty[:0]
}

// sendLook sends p's CreatureLook now (flushLooks).
func (w *World) sendLook(p *Player) {
	msg := &pb.ServerMessage{Message: &pb.ServerMessage_CreatureLook{CreatureLook: &pb.CreatureLook{
		Id: p.id, Look: p.lookMsg, Equipment: p.equipMsg,
	}}}
	w.eachWatcher(p, func(o *Player) {
		if o != p {
			o.emit(msg)
		}
	})
	p.emit(msg)
}

// setLook handles SetLook: a body a player may choose (data/looks.yaml), free. An invalid
// one is refused with appearance.invalid and p gets its look back; too many changes in a row
// are dropped (lookFlood). Without data/looks.yaml it is unavailable, said once a session:
// a client sending SetLook over and over gets no answer for each one.
func (w *World) setLook(ctx *game.TickContext, p *Player, m *pb.SetLook) {
	l := w.cfg.Looks
	if l == nil {
		if !p.lookOff {
			p.lookOff = true
			p.emit(systemMsg(msgLookUnavailable))
		}
		return
	}
	if !w.lookFlood(ctx, p) {
		return
	}
	look := lookFromMsg(m.GetLook())
	if !l.PlayerLook(look) {
		p.emit(systemMsg(msgLookInvalid))
		p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_CreatureLook{CreatureLook: &pb.CreatureLook{
			Id: p.id, Look: p.lookMsg, Equipment: p.equipMsg,
		}}})
		return
	}
	if look == p.look {
		return
	}
	p.look, p.lookMsg = look, bodyLookMsg(look)
	w.lookChanged(p)
}

// lookFlood counts one look change (GCRA: a burst of limits.change_burst, then one every
// limits.change_refill_ms of data/looks.yaml); over the limit it is dropped silently.
func (w *World) lookFlood(ctx *game.TickContext, p *Player) bool {
	lim := w.cfg.Looks.Limits
	refill := ticksFor(lim.ChangeRefillMs)
	now := ctx.Tick
	tat := max(p.lookTAT, now)
	if tat-now > refill*game.Tick(lim.ChangeBurst-1) {
		return false
	}
	p.lookTAT = tat + refill
	return true
}
