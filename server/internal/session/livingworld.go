package session

// Glue of the living world (livingworld/README.md): the one file of server/ that imports
// the module github.com/GFenzoR/RPG_Project/livingworld/server. It turns the game's
// commands into the module's calls (a strike, a tool, a fire spell, a push, a step, the
// tick) and implements its Host: the map's blocking flags, the tile updates, the events,
// and the loot, created on the ground with the economy log like a monster's.

import (
	"errors"
	"path/filepath"

	lw "github.com/GFenzoR/RPG_Project/livingworld/server"
	"github.com/GFenzoR/RPG_Project/server/internal/antibot"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// LivingDefs is data/livingworld as the module reads it (Config.LivingWorld).
type LivingDefs = lw.Defs

// livingWorld is the module's World (World.living): only this file names the module.
type livingWorld = lw.World

// LoadLivingWorld reads <dataDir>/livingworld/*.yaml (none: no living objects).
func LoadLivingWorld(dataDir string) (LivingDefs, error) {
	return lw.LoadDir(filepath.Join(dataDir, "livingworld"))
}

// i18n keys of the living world's messages (i18n/*/client.yaml).
const (
	msgLivingWrongWay = "living.wrong_way"
	msgLivingBroken   = "living.already_broken"
	msgLivingPushHint = "living.push_hint"
	msgLivingBlocked  = "living.push_blocked"
	msgLivingGate     = "living.gate_closed"
)

// The ways of each kind of strike, shared by every strike (the module only reads them).
var (
	waysMelee    = []string{lw.ByMelee, lw.ByAnyAttack}
	waysAxe      = []string{lw.ByMelee, lw.ByAnyAttack, lw.ByAxe}
	waysShot     = []string{lw.ByAnyAttack}
	waysFireShot = []string{lw.ByAnyAttack, lw.ByFire}
	waysChop     = []string{lw.ByAxe}
	waysPick     = []string{lw.ByPick}
	waysFire     = []string{lw.ByFire}
)

// livingHost is the World as the module's Host.
type livingHost struct{ w *World }

func toLW(p world.Pos) lw.Pos   { return lw.Pos{X: p.X, Y: p.Y, Z: p.Z} }
func fromLW(p lw.Pos) world.Pos { return world.Pos{X: p.X, Y: p.Y, Z: p.Z} }

// initLivingWorld resolves Config.LivingWorld against the items and takes every living
// object out of the map's own stacks: the module owns them from now on.
func (w *World) initLivingWorld() error {
	if len(w.cfg.LivingWorld) == 0 {
		return nil
	}
	items := func(id string) (lw.ItemInfo, bool) {
		def := w.cfg.Items[id]
		if def == nil {
			return lw.ItemInfo{}, false
		}
		return lw.ItemInfo{
			Num: def.Numeric, Kind: def.Kind, BlocksMove: def.BlocksMovement(), BlocksSight: def.BlocksSight(),
			Door: def.Door != nil,
		}, true
	}
	cat, err := lw.Resolve(w.cfg.LivingWorld, items, nil, uint64(game.TicksFor(1e9)))
	if err != nil {
		return err
	}
	lb := w.cfg.Balance.Living
	if lb.FistDamage <= 0 || lb.ToolDamage <= 0 || lb.PushCooldownMs <= 0 {
		return errors.New("session: data/livingworld needs balance.living (fist_damage, tool_damage, push_cooldown_ms)")
	}
	w.living = lw.New(cat, livingHost{w})
	w.livingPushFor = ticksFor(lb.PushCooldownMs)
	for _, is := range w.m.Islands() {
		for _, s := range is.Sectors() {
			for k := 0; k < len(s.Stacks); k++ {
				t := s.Stacks[k]
				pos := world.Pos{
					X: s.CX*world.SectorSize + t.Index%world.SectorSize,
					Y: s.CY*world.SectorSize + t.Index/world.SectorSize,
					Z: s.Z,
				}
				// A protection zone or a house never holds one (the map validator refuses
				// it): there it stays a plain map item.
				if w.m.Flags(pos)&(world.FlagProtection|world.FlagHouse) != 0 {
					continue
				}
				for i := 0; i < len(t.Items); i++ {
					num := t.Items[i]
					if !cat.IsObject(num) && !cat.IsPlate(num) {
						continue
					}
					if !w.living.Place(toLW(pos), num) {
						continue
					}
					w.m.TakeItem(pos, i)
					// TakeItem may drop the tile's stack: read it again.
					if k >= len(s.Stacks) || s.Stacks[k].Index != t.Index {
						k--
						break
					}
					t = s.Stacks[k]
					i--
				}
			}
		}
	}
	w.living.Link()
	return nil
}

// livingGates returns the tiles of the living world's gates (checkEscapes).
func (w *World) livingGates() []world.Pos {
	if w.living == nil {
		return nil
	}
	var out []world.Pos
	for _, g := range w.living.Gates() {
		out = append(out, fromLW(g))
	}
	return out
}

// livingAt is the item the object layer shows on pos (0: none).
func (w *World) livingAt(pos world.Pos) uint16 {
	if w.living == nil {
		return 0
	}
	return w.living.ItemAt(toLW(pos))
}

// staticBlock is what the map's own items of pos block (the rule of world/compile; a
// ground without its ground block, as in some test drawings, counts as walkable: an
// object only ever stands on walkable ground).
func (w *World) staticBlock(pos world.Pos) world.Flags {
	ground, _, _ := w.m.Tile(pos)
	var block world.Flags
	if g := w.byNum[ground]; g == nil || g.Ground != nil && !g.Ground.Walkable {
		block |= world.FlagBlocksMovement
	}
	for _, n := range w.m.Stack(pos) {
		if def := w.byNum[n]; def != nil {
			if def.BlocksMovement() {
				block |= world.FlagBlocksMovement
			}
			if def.BlocksSight() {
				block |= world.FlagBlocksSight
			}
		}
	}
	return block
}

// ---- Host ------------------------------------------------------------------------------

// Free also refuses a door's tile, even open: a door would close on the object (closeDoor
// checks it too), and a boulder in a locked door's way could shut a room.
func (h livingHost) Free(p lw.Pos) bool {
	w, pos := h.w, fromLW(p)
	_, f, ok := w.m.Tile(pos)
	if !ok || f&(world.FlagBlocksMovement|world.FlagProtection|world.FlagHouse|world.FlagPortalStep) != 0 {
		return false
	}
	if w.doors[pos] != nil {
		return false
	}
	for _, n := range w.m.Stack(pos) {
		if def := w.byNum[n]; def != nil && def.Door != nil {
			return false
		}
	}
	return !w.occupied(pos) && len(w.ground[pos]) == 0
}

func (h livingHost) Occupied(p lw.Pos) bool { return h.w.occupied(fromLW(p)) }

func (h livingHost) SetBlock(p lw.Pos, move, sight bool) {
	pos := fromLW(p)
	block := h.w.staticBlock(pos)
	if move {
		block |= world.FlagBlocksMovement
	}
	if sight {
		block |= world.FlagBlocksSight
	}
	h.w.m.SetBlockFlags(pos, block)
}

func (h livingHost) TileChanged(p lw.Pos) { h.w.tileChanged(fromLW(p)) }

func (h livingHost) Event(e lw.Event) {
	m := &pb.LivingObjectEvent{
		Kind: pb.LivingObjectKind(e.Kind), Pos: posMsg(fromLW(e.Pos)), ItemId: uint32(e.Item),
		Effect: e.Effect, Sound: e.Sound, HpPermille: e.HPPermille,
	}
	if e.Kind == lw.EventPush || e.Kind == lw.EventReset {
		m.To = posMsg(fromLW(e.To))
	}
	msg := &pb.ServerMessage{Message: &pb.ServerMessage_LivingObject{LivingObject: m}}
	h.w.eachObserver(nil, fromLW(e.Pos), func(o *Player) { o.emit(msg) })
}

// DropLoot creates the rolled loot on the object's tile, like a monster's (an equipable
// rolls its attribute), logged as loot for who broke it.
func (h livingHost) DropLoot(p lw.Pos, actor int64, object string, drops []lw.Drop) {
	w, pos := h.w, fromLW(p)
	owner := w.byChar[actor]
	for _, d := range drops {
		def := w.cfg.Items[d.Item]
		if def == nil {
			continue // Resolve checked every loot item against Config.Items
		}
		put := func(it *Item) {
			w.econLoot(owner, object, it)
			w.drop(it, pos)
		}
		if !def.Stackable {
			for range d.Count {
				put(w.created(def, def.StackLimit()))
			}
			continue
		}
		for n := d.Count; n > 0; {
			c := min(n, def.StackLimit())
			put(newItem(def, c))
			n -= c
		}
	}
	w.tileChanged(pos)
}

// ---- commands --------------------------------------------------------------------------

// useLiving answers a UseItem on a living object: a strike with what p holds (a breakable
// one), or why nothing happens. It reports whether the UseItem was about one.
func (w *World) useLiving(ctx *game.TickContext, p *Player, m *pb.UseItem) bool {
	if w.living == nil {
		return false
	}
	pos, ok := posFromMsg(m.GetFrom().GetPos())
	if !ok || pos.Z != p.pos.Z || !Sees(p.pos, pos) {
		return false
	}
	num := w.livingAt(pos)
	if num == 0 || int(m.GetStackIndex()) != 1+len(w.m.Stack(pos)) || uint32(num) != m.GetItemId() {
		return false
	}
	lp := toLW(pos)
	switch {
	case w.living.Pushable(lp):
		p.emit(systemMsg(msgLivingPushHint))
	case w.living.Breakable(lp):
		w.strikeObject(ctx, p, pos)
	case w.living.Broken(lp):
		p.emit(systemMsg(msgLivingBroken)) // its debris
	case w.byNum[num] != nil && w.byNum[num].BlocksMovement():
		p.emit(systemMsg(msgLivingGate)) // a closed gate
	default:
		p.emit(systemMsg(msgCannotUse)) // debris, an open gate
	}
	return true
}

// strikeObject is a strike of p's weapon (or bare hands) on the breakable object of pos:
// melee from a tile next to it, a distance weapon (one ammo of its kind spent, as in a
// fight) or a wand within its range.
func (w *World) strikeObject(ctx *game.TickContext, p *Player, pos world.Pos) {
	ways, dmg, reach := waysMelee, w.cfg.Balance.Living.FistDamage, 1
	var ammo *Item
	if wp := p.weapon; wp != nil && wp.Weapon != nil {
		dmg = max(wp.Weapon.Attack, 1)
		switch {
		case wp.Weapon.Range > 0:
			ways, reach = waysShot, wp.Weapon.Range
			if wp.Weapon.Element == "fire" {
				ways = waysFireShot
			}
			if wp.Weapon.Ammo != "" {
				ammo = p.equip[pb.EquipmentSlot_EQUIPMENT_SLOT_AMMO]
				if ammo == nil || ammo.def.Ammo == nil || ammo.def.Ammo.Type != wp.Weapon.Ammo {
					p.emit(systemMsg(msgNoAmmo))
					return
				}
				dmg = max(wp.Weapon.Attack+ammo.def.Ammo.Attack, 1) // weapon + ammo, as in a fight
			}
		case wp.Weapon.Type == "axe":
			ways = waysAxe
		}
	}
	if w.hitObject(ctx, p, pos, ways, dmg, reach) && ammo != nil {
		w.useUp(p, ammo)
		p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PlayerStats{PlayerStats: w.stats(p)}}) // capacity
	}
}

// hitObject runs one strike of p on the object of pos after the checks every strike
// shares: the way, reach, sight and the pace of the trades (nextGather). It reports
// whether the strike landed.
func (w *World) hitObject(ctx *game.TickContext, p *Player, pos world.Pos, methods []string, dmg, reach int) bool {
	lp := toLW(pos)
	if !w.living.Breakable(lp) {
		p.emit(systemMsg(msgLivingBroken))
		return false
	}
	if !w.living.Breaks(lp, methods) {
		p.emit(systemMsg(msgLivingWrongWay))
		return false
	}
	if chebyshev(p.pos, pos) > reach {
		p.emit(systemMsg(msgTooFar))
		return false
	}
	if !w.m.LineOfSight(p.pos, pos) {
		p.emit(systemMsg(msgNoSight))
		return false
	}
	if ctx.Tick < p.nextGather {
		p.tooEarly(ctx.Tick, antibot.KindItem)
		p.emit(systemMsg(msgGatherNotReady))
		return false
	}
	p.activePaced(ctx.Tick, antibot.KindItem, p.nextGather)
	p.nextGather = ctx.Tick + w.gatherFor
	w.living.OnAttackObject(lp, lw.Hit{Methods: methods, Damage: dmg, Actor: p.charID}, ctx.Rand)
	return true
}

// toolOnLiving runs a tool p carries used on a tile with a breakable object (an axe on
// vines, a pickaxe on a cracked rock). It reports whether the tile had one.
func (w *World) toolOnLiving(ctx *game.TickContext, p *Player, tool *Item, pos world.Pos) bool {
	if w.living == nil || !w.living.Breakable(toLW(pos)) {
		return false
	}
	var methods []string
	switch tool.def.Tool.Use {
	case "woodcutting":
		methods = waysChop
	case "mining":
		methods = waysPick
	}
	w.hitObject(ctx, p, pos, methods, w.cfg.Balance.Living.ToolDamage, w.reach)
	return true
}

// fireOnLiving burns the breakable objects that break by fire on the tiles of a fire area
// spell of p (each in p's line of sight), with the spell's damage.
func (w *World) fireOnLiving(ctx *game.TickContext, p *Player, tiles []world.Pos, d *content.SpellDamage) {
	if w.living == nil || d.Element != "fire" {
		return
	}
	for _, t := range tiles {
		lp := toLW(t)
		if !w.living.Breaks(lp, waysFire) || !w.living.Breakable(lp) || !w.m.LineOfSight(p.pos, t) {
			continue
		}
		dmg := max(w.scaled(ctx, d.Scaling, p), 1)
		w.living.OnAttackObject(lp, lw.Hit{Methods: waysFire, Damage: dmg, Actor: p.charID}, ctx.Rand)
	}
}

// pushObject runs a PushObject: p, on the tile next to the object on the side opposite
// dir, pushes it one tile (straight only), at most once per livingPushMs.
func (w *World) pushObject(ctx *game.TickContext, p *Player, m *pb.PushObject) {
	if w.living == nil {
		return
	}
	pos, ok := posFromMsg(m.GetPos())
	d, okDir := dirFromMsg(m.GetDir())
	if !ok || !okDir || d.Diagonal() || pos.Z != p.pos.Z {
		p.emit(systemMsg(msgNotPossible))
		return
	}
	dx, dy := d.Delta()
	if int(p.pos.X)+dx != int(pos.X) || int(p.pos.Y)+dy != int(pos.Y) {
		p.emit(systemMsg(msgTooFar))
		return
	}
	if ctx.Tick < p.nextPush {
		return // a held key asks again; the next one counts
	}
	switch w.living.Push(toLW(pos), dx, dy) {
	case lw.PushNoObject:
		p.emit(systemMsg(msgNotPossible))
	case lw.PushBlocked:
		p.nextPush = ctx.Tick + w.livingPushFor
		p.emit(systemMsg(msgLivingBlocked))
	case lw.PushMoved:
		p.nextPush = ctx.Tick + w.livingPushFor
	}
}

// livingStep tells the module a creature stepped (pressure plates).
func (w *World) livingStep(from, to world.Pos) {
	if w.living != nil {
		w.living.OnStep(toLW(from), toLW(to))
	}
}

// livingTick runs the module's timers.
func (w *World) livingTick(ctx *game.TickContext) {
	if w.living != nil {
		w.living.OnTick(uint64(ctx.Tick))
	}
}

// LivingObject is the state of one living object (LivingObjects).
type LivingObject struct {
	Item string
	Pos  world.Pos
	HP   int
	// State is intact, debris, gone or open.
	State string
}

// LivingObjects returns the state of every living object, in map order (tests, staff
// tools). Loop goroutine only.
func (w *World) LivingObjects() []LivingObject {
	if w.living == nil {
		return nil
	}
	var out []LivingObject
	for _, o := range w.living.Snapshot() {
		out = append(out, LivingObject{Item: o.Item, Pos: fromLW(o.Pos), HP: o.HP, State: o.State})
	}
	return out
}
