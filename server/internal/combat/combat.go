// Package combat holds the melee formulas (docs/02-game-design.md, "Combate"). Every
// constant comes from data/balance.yaml (content.Combat); randomness comes from the
// caller's seeded *rand.Rand, so fights are deterministic in tests.
//
//	max_hit = (skill × attack / skill_attack_divisor + level / level_divisor) × mode attack
//	hit     = random(0, max_hit) × (1 − physical resistance %)
//	monster target: − random(armor/2, armor) − random(0, defense/2)
//	player target:  − random(armor/2, armor) − random(0, shield × mode defense / shield_block_divisor)
//
// The result never goes below zero.
package combat

import (
	"math"
	"math/rand/v2"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
)

// Roll returns a uniform integer in [lo, hi] (lo when hi <= lo).
func Roll(r *rand.Rand, lo, hi int) int {
	if hi <= lo {
		return lo
	}
	return lo + r.IntN(hi-lo+1)
}

// MaxHit is the highest melee hit of an attacker with the given skill level, weapon
// attack value (content.Combat.FistAttack without a weapon), character level and stance
// attack factor.
func MaxHit(c content.Combat, skill, attack, level int, modeAttack float64) int {
	base := float64(skill*attack)/float64(c.SkillAttackDivisor) + float64(level)/float64(c.LevelDivisor)
	return int(math.Floor(base * modeAttack))
}

// MonsterTarget is what protects a monster from a hit.
type MonsterTarget struct {
	Armor, Defense int
	// PhysicalResistance is the monster's physical resistance in percent (may be negative).
	PhysicalResistance int
}

// HitMonster rolls one melee hit of up to maxHit against m and returns the damage.
func HitMonster(r *rand.Rand, maxHit int, m MonsterTarget) int {
	raw := float64(Roll(r, 0, maxHit)) * (1 - float64(m.PhysicalResistance)/100)
	dmg := int(math.Round(raw)) - Roll(r, m.Armor/2, m.Armor) - Roll(r, 0, m.Defense/2)
	return max(dmg, 0)
}

// PlayerTarget is what protects a player from a hit: total armor of the equipment, the
// shield's defense and the stance defense factor.
type PlayerTarget struct {
	Armor, ShieldDefense int
	ModeDefense          float64
}

// HitPlayer rolls one monster attack of [lo, hi] damage against p. Armor and shield
// only stop physical attacks.
func HitPlayer(r *rand.Rand, c content.Combat, lo, hi int, physical bool, p PlayerTarget) int {
	dmg := Roll(r, lo, hi)
	if physical {
		block := int(math.Floor(float64(p.ShieldDefense) * p.ModeDefense / float64(c.ShieldBlockDivisor)))
		dmg -= Roll(r, p.Armor/2, p.Armor) + Roll(r, 0, block)
	}
	return max(dmg, 0)
}

// Scaled rolls a spell amount (docs/02-game-design.md, "Daño mágico"):
// base + level × per_level + magic level × per_magic_level, then a uniform roll within
// ±spread of it. It never goes below zero.
func Scaled(r *rand.Rand, s content.Scaling, level, magicLevel int) int {
	v := s.Base + float64(level)*s.PerLevel + float64(magicLevel)*s.PerMagicLevel
	lo := int(math.Floor(v * (1 - s.Spread)))
	hi := int(math.Floor(v * (1 + s.Spread)))
	return max(Roll(r, max(lo, 0), max(hi, 0)), 0)
}

// Resist applies an elemental resistance in percent (negative = weakness) to dmg.
// Resistances of 100 or more make the target immune.
func Resist(dmg, resistance int) int {
	return max(int(math.Round(float64(dmg)*(1-float64(min(resistance, 100))/100))), 0)
}

// WandHit rolls one wand shot of attack value attack: random(attack × minFactor, attack).
func WandHit(r *rand.Rand, attack int, minFactor float64) int {
	return Roll(r, int(math.Floor(float64(attack)*minFactor)), attack)
}
