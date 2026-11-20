package session

import (
	"fmt"

	"github.com/GFenzoR/RPG_Project/server/internal/antibot"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
)

// Reward chests (docs/02 "Libros y cofres"): a map item with a chest block gives its
// rewards once per character. The character's storage remembers it (content.ChestKey),
// so the flag and the items are in the same snapshot: a save, a logout or a disconnect in
// the same tick never keeps one without the other. Nothing is given unless all of it fits
// (capacity, backpack and pockets, as canReceive): the player frees room and uses it again.

const (
	msgChestFound  = "chest.found"
	msgChestEmpty  = "chest.empty"
	msgChestNoRoom = "chest.no_room"
)

// initChests checks the chests of the items (content.CheckChests) against this world's
// forge: no chest gives its protection (only monsters drop the warding amber).
func (w *World) initChests() error {
	protection := ""
	if f := w.cfg.Balance.Forge; f.Enabled {
		protection = f.Protection
	}
	if err := content.CheckChests(w.cfg.Items, protection); err != nil {
		return fmt.Errorf("session: %w", err)
	}
	return nil
}

// useChest opens the chest m points at, if it is one of the map that p sees. It reports
// whether m was about a chest (like useMarketBoard).
func (w *World) useChest(ctx *game.TickContext, p *Player, m *pb.UseItem) bool {
	pos, ok := posFromMsg(m.GetFrom().GetPos())
	if !ok || pos.Z != p.pos.Z || !Sees(p.pos, pos) || int(m.GetStackIndex()) >= w.staticCount(pos) {
		return false
	}
	id := w.staticAt(pos, int(m.GetStackIndex()))
	def := w.byNum[id]
	if id == 0 || uint32(id) != m.GetItemId() || def == nil || def.Chest == nil {
		return false
	}
	if !w.near(p, pos) {
		p.emit(systemMsg(msgTooFar))
		return true
	}
	p.active(ctx.Tick, antibot.KindOther)
	w.openChest(p, def.Chest)
	return true
}

// openChest gives p the rewards of c, once: nothing if p opened it before or if they do
// not all fit (then p can retry). Equipables are created by giveItem (they roll their
// attribute) and every unit is logged under EconChest.
func (w *World) openChest(p *Player, c *content.Chest) {
	key := content.ChestKey(c.ID)
	switch {
	case p.storage.Get(key) != 0:
		p.emit(systemMsg(msgChestEmpty))
		return
	case !w.roomForAll(p, c.Rewards):
		p.emit(systemMsg(msgChestNoRoom))
		return
	}
	p.storage.Set(key, 1)
	params := make([]*pb.TextParam, 0, len(c.Rewards))
	for _, r := range c.Rewards {
		def := w.cfg.Items[r.Item]
		w.econMade(p, EconChest, c.ID, 0, def, r.Count, w.giveItem(p, def, r.Count))
		params = append(params, itemParam(def, r.Count))
	}
	p.emit(systemMsg(msgChestFound, params...))
}

// roomForAll reports whether every reward fits in p's capacity and packs (backpack and
// pockets, pockets.go) at once: the weight of all of them, and the free cells for the
// stacks that do not merge into the ones there (room, for several items).
func (w *World) roomForAll(p *Player, rewards []content.ChestReward) bool {
	weight, stacks := 0, 0
	counted := map[*content.Item]bool{}
	for _, r := range rewards {
		def := w.cfg.Items[r.Item]
		if def == nil {
			return false
		}
		weight += def.Weight * r.Count
		if counted[def] {
			continue
		}
		counted[def] = true
		n := 0
		for _, o := range rewards {
			if o.Item == r.Item {
				n += o.Count
			}
		}
		if !def.Stackable {
			stacks += n
			continue
		}
		n -= min(n, p.mergeRoom(def))
		stacks += (n + def.StackLimit() - 1) / def.StackLimit()
	}
	return weight <= p.capacity-p.carried() && stacks <= p.freeCells()
}
