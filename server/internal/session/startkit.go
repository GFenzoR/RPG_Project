package session

import (
	"fmt"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
)

// Starting kit (docs/02 "Equipo inicial", owner's request of 2026-11-23): what a new
// character of each vocation gets (data/vocations.yaml start_kit). It is given once, at the
// same moment as the starting backpack: the first login of a character that never played
// (loadInventory with fresh). After that the character has a position, so neither a death
// (which never reloads the inventory) nor a relog (the saved row or the unsaved snapshot)
// gives it again. The join saves the character at once (rolled), so a crash right after
// the first login keeps it too; one before that first save loses the kit with the
// position, and the next login, fresh again, gives it once more: never twice in one save.

// kitPiece is one entry of a start_kit with its definition.
type kitPiece struct {
	def   *content.Item
	count int
}

// initStartKits resolves every vocation's start_kit against the items: a missing item,
// a count on a piece that does not stack or more than a stack refuses to start (make
// validate checks the same and more, packages/content-schema checkStartKits).
func (w *World) initStartKits() error {
	w.startKits = map[string][]kitPiece{}
	for _, id := range sortedKeys(w.cfg.Vocations) {
		for i, k := range w.cfg.Vocations[id].StartKit {
			def := w.cfg.Items[k.Item]
			if def == nil {
				return fmt.Errorf("session: vocation %q start_kit #%d: unknown item %q", id, i, k.Item)
			}
			if n := k.Units(); n > def.StackLimit() || n > 1 && !def.Stackable {
				return fmt.Errorf("session: vocation %q start_kit #%d: %d %s do not fit one stack", id, i, n, k.Item)
			}
			w.startKits[id] = append(w.startKits[id], kitPiece{def: def, count: k.Units()})
		}
	}
	return nil
}

// giveStartKit puts p's vocation kit on a character that never played, silently (the
// join sends the whole inventory after it): each piece in its equipment slot when that is
// free and p may wear it there (canEquip: level, vocation, hands), the rest in the backpack
// and then the pockets, merging stacks. What does not fit is not given (logged: the kit
// is data, make validate keeps it small). It returns the new items, for the economy log:
// call econStartKit after the whole kit, a later entry may have grown an earlier pile.
func (w *World) giveStartKit(p *Player) []*Item {
	var made []*Item
	for _, k := range w.startKits[p.vocation.ID] {
		slot := slotFor(k.def)
		if slot != pb.EquipmentSlot_EQUIPMENT_SLOT_UNSPECIFIED && p.equip[slot] == nil {
			if refusal, _ := w.canEquip(p, k.def, slot); refusal == "" {
				it := w.created(k.def, k.count)
				it.owner, it.slot = p, int(slot)
				p.equip[slot] = it
				made = append(made, it)
				continue
			}
		}
		if merge := p.packStack(k.def); merge != nil && merge.count+k.count <= k.def.StackLimit() {
			// A new character carries nothing but the kit, so merge is a pile of made:
			// econStartKit reads its final count, these units included.
			merge.count += k.count
			continue
		}
		pack := p.packWithRoom()
		if pack == nil {
			w.log.Warn("session: start_kit piece does not fit", "character", p.charID, "item", k.def.ID)
			continue
		}
		it := w.created(k.def, k.count)
		it.parent = pack
		pack.items = append(pack.items, it)
		made = append(made, it)
	}
	return made
}

// econStartKit records the kit given at this join (EconStartKit) once the ledger has
// started: the ledger's base counted it as held, so it moves to the delta.
func (w *World) econStartKit(p *Player, made []*Item) {
	for _, it := range made {
		h := measure(it, it.count)
		p.econBase.units -= h.units
		p.econBase.gold -= h.gold
		w.econInstance(p, EconStartKit, p.vocation.ID, 0, it, 1)
	}
}

// EconStartKit is the source of the economy log of the starting kit given at a
// character's first login (ref: the vocation).
const EconStartKit = "start_kit"
