package session

import pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"

// Saved game options (owner decision 2026-11-26, docs/02 "Opciones guardadas"): what a
// player picks for a character lasts between logins. The loop is their only owner: they
// change with SetFightMode and SetSafeMode (validated there), travel in every snapshot
// (the persistence goroutine writes characters.opt_*, migration 00029), come back in
// Character at the next login, and the Welcome tells the client the ones in force, so it
// never has to send them again. Dying does not touch them.

// GameOptions are the game options of a character. The zero value is a character that
// never changed them: balanced, not chasing, safe mode on.
type GameOptions struct {
	// Stance is the fight stance; UNSPECIFIED or a value the protocol does not have is
	// balanced.
	Stance pb.FightStance
	// Chase: the player follows its target.
	Chase bool
	// Unsafe: the PvP safe mode is off.
	Unsafe bool
}

// validStance reports whether s is a stance a player can fight in.
func validStance(s pb.FightStance) bool {
	return s >= pb.FightStance_FIGHT_STANCE_OFFENSIVE && s <= pb.FightStance_FIGHT_STANCE_DEFENSIVE
}

// stance is the stance to fight in: a saved one that is not valid is balanced (mode
// indexes content.Stances with it).
func (o GameOptions) stance() pb.FightStance {
	if !validStance(o.Stance) {
		return pb.FightStance_FIGHT_STANCE_BALANCED
	}
	return o.Stance
}

func (o GameOptions) msg() *pb.GameOptions {
	return &pb.GameOptions{Stance: o.stance(), Chase: o.Chase, SafeMode: !o.Unsafe}
}

// gameOptions are p's options as saved.
func (p *Player) gameOptions() GameOptions {
	return GameOptions{Stance: p.stance, Chase: p.chase, Unsafe: !p.safe}
}
