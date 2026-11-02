package skills

import "github.com/GFenzoR/RPG_Project/server/internal/content"

// Penalty is what one death costs (docs/02-game-design.md, "Muerte"). Percentages are
// 0-100.
type Penalty struct {
	XPPct    float64 // of the total experience
	SkillPct float64 // of the tries each skill earned above its base level
	// EquipmentDropPct is the chance of each equipped piece (but the backpack) to fall
	// into the corpse; BackpackDropPct, the chance of the backpack slot.
	EquipmentDropPct float64
	BackpackDropPct  float64
}

// DeathPenalty returns the penalty of a death with blessings (capped at
// death.max_blessings) at level. Each blessing moves the losses linearly from the
// base percentages to the all-blessings ones: experience from xp_loss_pct down to
// xp_loss_pct_all_blessings, skills by the same factor, and item drops down to zero.
// A novice (level <= novice_max_level) pays as if it held every blessing.
func DeathPenalty(d content.Death, blessings, level int) Penalty {
	frac := 1.0
	if d.MaxBlessings > 0 && level > d.NoviceMaxLevel {
		frac = float64(min(max(blessings, 0), d.MaxBlessings)) / float64(d.MaxBlessings)
	}
	xp := d.XPLossPct - (d.XPLossPct-d.XPLossPctAllBlessings)*frac
	skill := 0.0
	if d.XPLossPct > 0 {
		skill = d.SkillLossPct * xp / d.XPLossPct
	}
	return Penalty{
		XPPct:            xp,
		SkillPct:         skill,
		EquipmentDropPct: d.EquipmentDropPct * (1 - frac),
		BackpackDropPct:  d.BackpackDropPct * (1 - frac),
	}
}

// LoseExperience returns xp after losing pct % of it (never below 0, so never below
// level 1).
func LoseExperience(xp int64, pct float64) int64 {
	if xp <= 0 || pct <= 0 {
		return max(xp, 0)
	}
	return max(xp-int64(float64(xp)*min(pct, 100)/100), 0)
}

// Lose takes pct % of the tries p earned above the base level b.StartLevel, going down
// levels when needed but never below the base.
func (p *Progress) Lose(b content.SkillBase, factor float64, pct float64) {
	if pct <= 0 || p.Level < b.StartLevel {
		return
	}
	total := p.Tries
	for l := b.StartLevel; l < p.Level; l++ {
		total += TriesFor(b, factor, l)
	}
	lose := int64(float64(total) * min(pct, 100) / 100)
	for lose > 0 {
		if lose <= p.Tries {
			p.Tries -= lose
			return
		}
		lose -= p.Tries
		if p.Level <= b.StartLevel {
			p.Tries = 0
			return
		}
		p.Level--
		p.Tries = TriesFor(b, factor, p.Level)
	}
}
