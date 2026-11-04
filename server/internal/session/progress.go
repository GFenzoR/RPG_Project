package session

import (
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/skills"
)

// Progress (T1.7): use-based skills, experience levels and regeneration
// (docs/02-game-design.md). Numbers come from balance.yaml and vocations.yaml.

// Skill ids the combat code trains directly.
const (
	SkillFist   = "fist"
	SkillShield = "shield"
)

// i18n keys of the progress system messages (i18n/*/client.yaml).
const (
	msgLevelUp = "progress.level_up"
	msgSkillUp = "progress.skill_up"
)

// SkillState is one skill of a character as it is loaded and saved: its level and the
// tries made toward the next one.
type SkillState struct {
	ID    string
	Level int
	Tries int64
}

// skillSlot is a player's skill at index i of World.skillIDs.
type skillSlot struct {
	skills.Progress
	// carry accumulates fractional tries (anti-AFK factor); it is not persisted.
	carry float64
}

func (w *World) initProgress() {
	w.skillIDs = w.cfg.Balance.SkillIDs()
	w.skillIdx = make(map[string]int, len(w.skillIDs))
	for i, id := range w.skillIDs {
		w.skillIdx[id] = i
	}
	if ms := w.cfg.Balance.Skills.AFK.AfterMs; ms > 0 {
		w.afkAfter = ticksFor(ms)
	}
}

// loadSkills sets p's skills from saved, or the base level of balance.yaml for the
// skills it lacks. Unknown skill ids are ignored; a level below the base is raised.
func (w *World) loadSkills(p *Player, saved []SkillState) {
	p.skills = make([]skillSlot, len(w.skillIDs))
	for i, id := range w.skillIDs {
		p.skills[i].Level = max(w.cfg.Balance.Skills.Base[id].StartLevel, 0)
	}
	for _, s := range saved {
		i, ok := w.skillIdx[s.ID]
		if !ok || s.Level < p.skills[i].Level {
			continue
		}
		p.skills[i].Level = min(s.Level, skills.MaxLevel)
		// Clamp in case balance.yaml made the level cheaper since the save.
		need := skills.TriesFor(w.cfg.Balance.Skills.Base[s.ID], p.vocation.SkillFactor(s.ID), p.skills[i].Level)
		p.skills[i].Tries = min(max(s.Tries, 0), max(need-1, 0))
	}
}

// skillStates returns a copy of p's skills for a snapshot.
func (p *Player) skillStates(ids []string) []SkillState {
	out := make([]SkillState, len(p.skills))
	for i, s := range p.skills {
		out[i] = SkillState{ID: ids[i], Level: s.Level, Tries: s.Tries}
	}
	return out
}

// skillLevel returns p's level in skill id (0 if the skill does not exist).
func (w *World) skillLevel(p *Player, id string) int {
	if i, ok := w.skillIdx[id]; ok {
		return p.skills[i].Level
	}
	return 0
}

// Skill returns the player's level and tries in skill id (tests and tools).
func (w *World) Skill(p *Player, id string) SkillState {
	if i, ok := w.skillIdx[id]; ok {
		return SkillState{ID: id, Level: p.skills[i].Level, Tries: p.skills[i].Tries}
	}
	return SkillState{ID: id}
}

// meleeSkill returns the skill and attack value of p's melee attack: its weapon's, or
// fists without a weapon (equipment arrives with T1.8).
func (w *World) meleeSkill(p *Player) (id string, attack int) {
	if wp := p.weapon; wp != nil && wp.Weapon != nil {
		if _, ok := w.skillIdx[wp.Weapon.Type]; ok {
			return wp.Weapon.Type, wp.Weapon.Attack
		}
	}
	return SkillFist, w.cfg.Balance.Combat.FistAttack
}

// train adds one try of skill id to p. Training against a target that has not fought
// back for skills.afk.after_ms earns tries at skills.afk.factor.
func (w *World) train(p *Player, id string, afk bool) {
	factor := 1.0
	if afk {
		factor = w.cfg.Balance.Skills.AFK.Factor
	}
	w.trainBy(p, id, factor)
}

// trainBy adds factor (0-1) of a try of skill id to p; fractions accumulate.
func (w *World) trainBy(p *Player, id string, factor float64) {
	i, ok := w.skillIdx[id]
	if !ok {
		return
	}
	s := &p.skills[i]
	n := int64(1)
	if factor < 1 {
		s.carry += factor
		n = int64(s.carry)
		s.carry -= float64(n)
		if n == 0 {
			return
		}
	}
	w.addTries(p, i, n)
}

// addTries adds n tries to p's skill at index i and tells the client when its level or
// percent changed.
func (w *World) addTries(p *Player, i int, n int64) {
	id, s := w.skillIDs[i], &p.skills[i]
	base, factor := w.cfg.Balance.Skills.Base[id], p.vocation.SkillFactor(id)
	before := s.Percent(base, factor)
	gained := s.Add(base, factor, n)
	if gained == 0 && s.Percent(base, factor) == before {
		return
	}
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PlayerSkills{PlayerSkills: &pb.PlayerSkills{Skills: w.skillList(p)}}})
	if gained > 0 {
		p.emit(systemMsg(msgSkillUp,
			&pb.TextParam{Name: "skill", Value: &pb.TextParam_ContentId{ContentId: id}},
			&pb.TextParam{Name: "level", Value: &pb.TextParam_Number{Number: int64(s.Level)}}))
	}
}

// afk reports whether p's training against its target earns reduced tries: the target
// has not fought back for skills.afk.after_ms.
func (w *World) afk(ctx *game.TickContext, p *Player) bool {
	if p.answeredAt == 0 {
		p.answeredAt = max(ctx.Tick, 1) // the fight starts now (0 means not started)
	}
	return w.afkAfter > 0 && ctx.Tick-p.answeredAt >= w.afkAfter
}

// trainShield counts a shield try for an attack p received, at most
// skills.shield_max_tries_per_round per attack round.
func (w *World) trainShield(ctx *game.TickContext, p *Player) {
	if p.shield == nil || p.shield.Shield == nil {
		return
	}
	round := ctx.Tick / w.attackFor
	if round != p.shieldRound {
		p.shieldRound, p.shieldTries = round, 0
	}
	if p.shieldTries >= w.cfg.Balance.Skills.ShieldMaxTriesPerRound {
		return
	}
	p.shieldTries++
	w.train(p, SkillShield, false)
}

// skillList returns p's skills for PlayerSkills.
func (w *World) skillList(p *Player) []*pb.SkillProgress {
	out := make([]*pb.SkillProgress, len(w.skillIDs))
	for i, id := range w.skillIDs {
		s := p.skills[i]
		out[i] = &pb.SkillProgress{
			SkillId: id,
			Level:   uint32(max(s.Level, 0)),
			Percent: uint32(s.Percent(w.cfg.Balance.Skills.Base[id], p.vocation.SkillFactor(id))),
		}
	}
	return out
}

// ---- experience and levels -------------------------------------------------------------

// gainExperience adds xp to p and raises its level along the curve of balance.yaml,
// with the vocation's stats of each new level.
func (w *World) gainExperience(p *Player, xp int64) {
	p.experience += xp
	w.eachWatcher(p, func(o *Player) { // not to who cannot see an invisible p (T3.2)
		o.emit(&pb.ServerMessage{Message: &pb.ServerMessage_FloatingText{FloatingText: &pb.FloatingText{
			Pos: posMsg(p.pos), Kind: pb.FloatingTextKind_FLOATING_TEXT_KIND_EXPERIENCE, Amount: uint64(xp),
		}}})
	})
	if level := skills.LevelFor(w.cfg.Balance.Experience, p.experience, p.level); level > p.level {
		w.setLevel(p, level)
	}
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PlayerStats{PlayerStats: w.stats(p)}})
}

// setLevel moves p to a higher level: maximums, capacity and speed follow the vocation,
// and current health and mana grow by what the maximums grew.
func (w *World) setLevel(p *Player, level int) {
	from := p.level
	pct := healthPercent(p.health, p.maxHealth)
	old, now := p.vocation.AtLevel(from), p.vocation.AtLevel(level)
	p.level = level
	p.maxHealth, p.maxMana, p.capacity = now.Health, now.Mana, now.Capacity
	p.health = min(max(p.health+now.Health-old.Health, 1), p.maxHealth)
	p.mana = min(max(p.mana+now.Mana-old.Mana, 0), p.maxMana)
	p.baseSpeed = max(now.Speed, 1)
	w.refreshSpeed(holder{p: p}) // with its speed conditions (T3.2)
	w.healthBar(p, pct)
	p.emit(systemMsg(msgLevelUp,
		&pb.TextParam{Name: "from", Value: &pb.TextParam_Number{Number: int64(from)}},
		&pb.TextParam{Name: "level", Value: &pb.TextParam_Number{Number: int64(level)}}))
}

// healthBar tells p's observers its new health percent if it changed from before.
func (w *World) healthBar(p *Player, before uint32) {
	pct := healthPercent(p.health, p.maxHealth)
	if pct == before {
		return
	}
	w.eachWatcher(p, func(o *Player) {
		o.emit(&pb.ServerMessage{Message: &pb.ServerMessage_CreatureHealth{CreatureHealth: &pb.CreatureHealth{Id: p.id, HealthPercent: pct}}})
	})
}

// ---- regeneration ----------------------------------------------------------------------

// scheduleRegen schedules p's next regeneration after the vocation's interval.
func (w *World) scheduleRegen(ctx *game.TickContext, p *Player) {
	r := p.vocation.Regen
	if r.IntervalMs <= 0 || (r.Health <= 0 && r.Mana <= 0) {
		return
	}
	p.regen = ctx.Sched.After(ticksFor(r.IntervalMs), func(ctx *game.TickContext) {
		if w.byChar[p.charID] != p {
			return
		}
		w.regenerate(p)
		w.scheduleRegen(ctx, p)
	})
}

func (w *World) regenerate(p *Player) {
	r := p.vocation.Regen
	if p.health >= p.maxHealth && p.mana >= p.maxMana {
		return
	}
	pct := healthPercent(p.health, p.maxHealth)
	p.health = min(p.health+r.Health, p.maxHealth)
	p.mana = min(p.mana+r.Mana, p.maxMana)
	w.healthBar(p, pct)
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PlayerStats{PlayerStats: w.stats(p)}})
}
