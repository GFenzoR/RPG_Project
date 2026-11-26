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

// IsNovice reports whether a character of level is under the novice protection
// (death.novice_max_level): its death costs no equipment or backpack.
func IsNovice(d content.Death, level int) bool {
	return d.NoviceMaxLevel > 0 && level <= d.NoviceMaxLevel
}

// NoviceNotice is the warning a level change owes the player about the novice protection.
type NoviceNotice int

const (
	NoticeNone      NoviceNotice = iota
	NoticeLastLevel              // reached the last protected level (novice_max_level)
	NoticeEnded                  // went past it: the protection is over
	NoticeRegained               // a lost level brought the character back under it
)

// NoviceNoticeFor returns the notice for a level change from -> to: the last protected
// level when a gain reaches novice_max_level, the end when a gain crosses it (a jump over
// the last level gives only the end), and the protection regained when a loss (a death)
// comes back to novice_max_level or below.
func NoviceNoticeFor(d content.Death, from, to int) NoviceNotice {
	switch {
	case d.NoviceMaxLevel <= 0 || to == from:
		return NoticeNone
	case to < from:
		if from > d.NoviceMaxLevel && to <= d.NoviceMaxLevel {
			return NoticeRegained
		}
		return NoticeNone
	case from <= d.NoviceMaxLevel && to > d.NoviceMaxLevel:
		return NoticeEnded
	case from < d.NoviceMaxLevel && to == d.NoviceMaxLevel:
		return NoticeLastLevel
	}
	return NoticeNone
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
