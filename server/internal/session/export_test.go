package session

import (
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// SetHealth sets a monster's health (tests only).
func (m *Monster) SetHealth(h int) { m.health = h }

// EquipForTest gives p a weapon and a shield until equipment exists (T1.8).
func (p *Player) EquipForTest(weapon, shield *content.Item) { p.weapon, p.shield = weapon, shield }

// Level returns p's level (tests only).
func (w *World) Level(p *Player) int { return p.level }

// Mana returns p's mana (tests only).
func (w *World) Mana(p *Player) int { return p.mana }

// MonsterHealth returns m's health (tests only).
func (w *World) MonsterHealth(m *Monster) int { return m.health }

// DropForTest puts count units of def on the ground at pos (tests only, loop goroutine).
func (w *World) DropForTest(def *content.Item, count int, pos world.Pos) {
	w.drop(newItem(def, count), pos)
	w.tileChanged(pos)
}

// Viewers returns how many players have container it open (tests only).
func (it *Item) Viewers() int { return len(it.viewers) }

// GroundAt returns the runtime items on pos, bottom first (tests only).
func (w *World) GroundAt(pos world.Pos) []*Item { return w.ground[pos] }

// CountItem returns how many units of item id p carries, equipment included (tests).
func (w *World) CountItem(p *Player, id string) int { return w.countItem(p, w.cfg.Items[id], true) }

// Money returns the money p carries (tests only).
func (w *World) Money(p *Player) int64 { return w.money(p) }

// GiveForTest puts n units of item id in p's backpack (tests only, loop goroutine).
func (w *World) GiveForTest(p *Player, id string, n int) { w.giveItem(p, w.cfg.Items[id], n) }

// RestoreForTest refills p's health (tests only, loop goroutine).
func (w *World) RestoreForTest(p *Player) { p.health = p.maxHealth }
