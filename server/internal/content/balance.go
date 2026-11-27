package content

import (
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"

	"go.yaml.in/yaml/v3"
)

// Balance is the part of data/balance.yaml the server uses so far.
type Balance struct {
	Movement   Movement   `yaml:"movement"`
	Experience Experience `yaml:"experience"`
	Skills     Skills     `yaml:"skills"`
	Combat     Combat     `yaml:"combat"`
	Inventory  Inventory  `yaml:"inventory"`
	Gathering  Gathering  `yaml:"gathering"`
	Chat       Chat       `yaml:"chat"`
	Death      Death      `yaml:"death"`
	Party      Party      `yaml:"party"`
	Guild      Guild      `yaml:"guild"`
	// PvP is player versus player (T5.2); absent or enabled: false turns it off.
	PvP PvP `yaml:"pvp"`
	// Market and Trade are the global market and the trade window (T5.3); absent or
	// enabled: false turns each off.
	Market Market `yaml:"market"`
	Trade  Trade  `yaml:"trade"`
	// Stash is the account stash (docs/02 "Baúl de la cuenta"); absent or enabled: false
	// turns it off.
	Stash Stash `yaml:"stash"`
	// Living holds the living world's rules that belong to no object (data/livingworld);
	// the server needs it whenever there are living objects.
	Living Living `yaml:"living"`
	// Forge is the refine of equipables at an anvil (docs/02 "Forja"); absent or enabled:
	// false turns it off.
	Forge Forge `yaml:"forge"`
	// Houses are the player houses (T5.4); absent or enabled: false turns them off.
	Houses  Houses  `yaml:"houses"`
	Travel  Travel  `yaml:"travel"`
	Economy Economy `yaml:"economy"`
	// Reports and Idle are the player reports and the idle disconnect (T4.1).
	Reports Reports `yaml:"reports"`
	Idle    Idle    `yaml:"idle"`
	// AntiBot is the bot detection (T4.1 2/2): signals, score and responses.
	AntiBot AntiBot `yaml:"antibot"`
	// Conditions are the condition definitions by id (T3.2).
	Conditions ConditionDefs `yaml:"conditions"`
}

// Death holds the death rules (docs/02-game-design.md, "Muerte", T1.11).
type Death struct {
	XPLossPct             float64 `yaml:"xp_loss_pct"`
	SkillLossPct          float64 `yaml:"skill_loss_pct"`
	EquipmentDropPct      float64 `yaml:"equipment_drop_pct"`
	BackpackDropPct       float64 `yaml:"backpack_drop_pct"`
	MaxBlessings          int     `yaml:"max_blessings"`
	XPLossPctAllBlessings float64 `yaml:"xp_loss_pct_all_blessings"`
	// NoviceMaxLevel: up to this level a death costs the minimum and drops nothing.
	NoviceMaxLevel    int `yaml:"novice_max_level"`
	CorpseMs          int `yaml:"corpse_ms"`
	CorpseOwnerOnlyMs int `yaml:"corpse_owner_only_ms"`
}

func (d Death) check() error {
	pct := func(v float64) bool { return v >= 0 && v <= 100 }
	if !pct(d.XPLossPct) || !pct(d.SkillLossPct) || !pct(d.EquipmentDropPct) || !pct(d.BackpackDropPct) ||
		!pct(d.XPLossPctAllBlessings) || d.XPLossPctAllBlessings > d.XPLossPct {
		return errors.New("death: percentages must be in 0..100 and xp_loss_pct_all_blessings <= xp_loss_pct")
	}
	if d.MaxBlessings < 0 || d.NoviceMaxLevel < 0 || d.CorpseMs <= 0 || d.CorpseOwnerOnlyMs < 0 || d.CorpseOwnerOnlyMs > d.CorpseMs {
		return errors.New("death: max_blessings and novice_max_level must be >= 0, corpse_ms > 0, corpse_owner_only_ms in 0..corpse_ms")
	}
	return nil
}

// MaxChatLength is the protocol limit of a Say text (docs/05-network-protocol.md).
const MaxChatLength = 255

// Chat holds the chat rules (T1.13): message length, who hears each local mode and
// the anti-flood limits.
type Chat struct {
	// MaxLength is the most characters (runes) a message may have.
	MaxLength int `yaml:"max_length"`
	Ranges    struct {
		Whisper ChatRange `yaml:"whisper"`
		Say     ChatRange `yaml:"say"`
		Yell    ChatRange `yaml:"yell"`
	} `yaml:"ranges"`
	// Flood is a bucket of Burst messages refilled one every RefillMs; sending with it
	// empty mutes the player for MuteMs.
	Flood struct {
		Burst    int `yaml:"burst"`
		RefillMs int `yaml:"refill_ms"`
		MuteMs   int `yaml:"mute_ms"`
	} `yaml:"flood"`
	// GlobalIntervalMs is the minimum time between two global messages of a player.
	GlobalIntervalMs int `yaml:"global_interval_ms"`
}

// ChatRange is how far (tiles on each axis, same floor) a local message reaches.
type ChatRange struct {
	X int `yaml:"x"`
	Y int `yaml:"y"`
}

func (c Chat) check() error {
	if c.MaxLength <= 0 || c.MaxLength > MaxChatLength {
		return fmt.Errorf("chat.max_length must be in 1..%d", MaxChatLength)
	}
	for i, r := range [...]ChatRange{c.Ranges.Whisper, c.Ranges.Say, c.Ranges.Yell} {
		if r.X <= 0 || r.Y <= 0 {
			return fmt.Errorf("chat.ranges.%s: x and y must be > 0", [...]string{"whisper", "say", "yell"}[i])
		}
	}
	if c.Flood.Burst <= 0 || c.Flood.RefillMs <= 0 || c.Flood.MuteMs <= 0 || c.GlobalIntervalMs < 0 {
		return errors.New("chat: flood.burst, flood.refill_ms and flood.mute_ms must be > 0, global_interval_ms >= 0")
	}
	return nil
}

// Party holds the party and shared experience rules (T3.3, docs/02-game-design.md
// "Grupos").
type Party struct {
	MaxMembers int `yaml:"max_members"`
	InviteMs   int `yaml:"invite_ms"`
	// InvitesPerMinute caps the invitation attempts of one player (anti-spam, and no way
	// to probe many names for who is online): that many at once, then one every
	// 60000 / InvitesPerMinute ms.
	InvitesPerMinute int `yaml:"invites_per_minute"`
	UpdateMs         int `yaml:"update_ms"`
	// A kill is shared by the members on its floor within ShareDistance tiles of it that
	// contributed within ContributionMs and whose level is at least LevelRangePct % of
	// the highest of them, or at most LevelGapAlways levels below it.
	ShareDistance  int `yaml:"share_distance"`
	ContributionMs int `yaml:"contribution_ms"`
	LevelRangePct  int `yaml:"level_range_pct"`
	LevelGapAlways int `yaml:"level_gap_always"`
	// SharedByDefault: a new party starts with shared experience on (the leader can
	// still turn it off).
	SharedByDefault bool `yaml:"shared_by_default"`
	// BonusPctBySharers is the bonus % of the shared pot by the number of sharers: the
	// first entry is for 2 sharers, the next for 3 and so on; a count past the end takes
	// the last entry, which is the cap. Only the count matters (distinct accounts: two
	// characters of one account are one sharer).
	BonusPctBySharers []int `yaml:"bonus_pct_by_sharers"`
}

// BonusPct is the bonus % of the shared pot for n sharers (0 below 2).
func (p Party) BonusPct(n int) int {
	if n < 2 || len(p.BonusPctBySharers) == 0 {
		return 0
	}
	return p.BonusPctBySharers[min(n-2, len(p.BonusPctBySharers)-1)]
}

// SharedEach splits a shared pot of xp among n sharers: each gets pot × (100 + bonus) /
// 100 / n, and extra is the bonus part of it (each minus an even split of the pot). It
// is the whole formula of a shared kill (session.shareExperience) and of the party sim.
func (p Party) SharedEach(pot int64, n int) (each, extra int64) {
	if pot <= 0 || n < 2 {
		return 0, 0
	}
	each = pot * int64(100+p.BonusPct(n)) / 100 / int64(n)
	return each, each - pot/int64(n)
}

// InLevelRange reports whether a member of that level shares with a highest sharer of
// level top: at most LevelGapAlways levels below it, or at least LevelRangePct % of it.
func (p Party) InLevelRange(level, top int) bool {
	return top-level <= p.LevelGapAlways || level*100 >= top*p.LevelRangePct
}

// MaxBonusPct is the highest bonus % of the shared pot: the last step.
func (p Party) MaxBonusPct() int { return p.BonusPct(p.MaxMembers) }

func (p Party) check() error {
	if p.MaxMembers < 2 || p.MaxMembers > 32 {
		return errors.New("party.max_members must be in 2..32")
	}
	if p.InviteMs > 600_000 {
		return errors.New("party.invite_ms must be at most 600000")
	}
	if p.InvitesPerMinute < 1 || p.InvitesPerMinute > 60 {
		return errors.New("party.invites_per_minute must be in 1..60")
	}
	if p.InviteMs <= 0 || p.UpdateMs <= 0 || p.ShareDistance <= 0 || p.ContributionMs <= 0 {
		return errors.New("party: invite_ms, update_ms, share_distance and contribution_ms must be > 0")
	}
	if p.LevelRangePct < 1 || p.LevelRangePct > 100 || p.LevelGapAlways < 0 || p.LevelGapAlways > 100 {
		return errors.New("party: level_range_pct must be in 1..100, level_gap_always in 0..100")
	}
	if n := len(p.BonusPctBySharers); n < 1 || n > p.MaxMembers-1 {
		return fmt.Errorf("party.bonus_pct_by_sharers must have 1..%d steps (2 sharers to max_members)", p.MaxMembers-1)
	}
	for i, b := range p.BonusPctBySharers {
		if b < 0 || b > 100 || i > 0 && b < p.BonusPctBySharers[i-1] {
			return errors.New("party.bonus_pct_by_sharers: each step in 0..100, never below the one before")
		}
	}
	return nil
}

// Guild holds the guild rules (T5.1, docs/02-game-design.md "Gremios").
type Guild struct {
	FoundCost      int `yaml:"found_cost"`
	FoundMinLevel  int `yaml:"found_min_level"`
	MaxMembers     int `yaml:"max_members"`
	MaxViceLeaders int `yaml:"max_vice_leaders"`
	MaxInvites     int `yaml:"max_invites"`
	InviteHours    int `yaml:"invite_hours"`
	NameMin        int `yaml:"name_min"`
	NameMax        int `yaml:"name_max"`
	NameMaxWords   int `yaml:"name_max_words"`
	MotdMax        int `yaml:"motd_max"`
	// ReservedParts are refused as substrings of the lowercased name without spaces;
	// ReservedWords as whole words.
	ReservedParts []string `yaml:"reserved_parts"`
	ReservedWords []string `yaml:"reserved_words"`
}

// MaxGuildName is the longest guild name the database stores (guilds.name).
const MaxGuildName = 32

func (g Guild) check() error {
	if g.FoundCost < 0 || g.FoundMinLevel < 1 || g.MaxMembers < 2 || g.MaxMembers > 500 || g.MaxViceLeaders < 0 ||
		g.MaxInvites < 1 || g.MaxInvites > 100 || g.InviteHours < 1 || g.InviteHours > 720 {
		return errors.New("guild: found_cost >= 0, found_min_level >= 1, max_members in 2..500, max_vice_leaders >= 0, max_invites in 1..100, invite_hours in 1..720")
	}
	if g.NameMin < 2 || g.NameMax < g.NameMin || g.NameMax > MaxGuildName || g.NameMaxWords < 1 || g.MotdMax < 1 || g.MotdMax > MaxChatLength {
		return fmt.Errorf("guild: name_min >= 2, name_max in name_min..%d, name_max_words >= 1, motd_max in 1..%d", MaxGuildName, MaxChatLength)
	}
	return nil
}

// PvP holds the player versus player rules (T5.2, docs/02-game-design.md "PvP"). The
// zero value (no pvp block) is PvP off: the game plays as PvE only.
type PvP struct {
	Enabled bool `yaml:"enabled"`
	// MinLevel: below it a character neither attacks players nor is attacked by them.
	MinLevel int `yaml:"min_level"`
	// DamagePct scales every hit of a player on a player (melee, distance, spells,
	// conditions).
	DamagePct int `yaml:"damage_pct"`
	// AggressorMs: the aggressor skull lasts this long after the last unjustified attack,
	// and so does the right of its victims to defend themselves.
	AggressorMs int `yaml:"aggressor_ms"`
	// LockMs: after a player attacks a player it cannot log out or enter a protection
	// zone this long; the victim cannot log out. KillLockMs replaces it after an
	// unjustified kill.
	LockMs     int `yaml:"lock_ms"`
	KillLockMs int `yaml:"kill_lock_ms"`
	// KillCreditMs: a death counts as a kill of every player that hurt the victim this
	// long before it.
	KillCreditMs int     `yaml:"kill_credit_ms"`
	Murderer     PvPMark `yaml:"murderer"`
	Outlaw       PvPMark `yaml:"outlaw"`
	War          PvPWar  `yaml:"war"`
}

// PvPMark is a skull earned by unjustified kills: it is reached when any window holds
// at least its kills, lasts Hours since the last unjustified kill, and dying with it
// drops at least these percentages (blessings do not lower them).
type PvPMark struct {
	Hours            int         `yaml:"hours"`
	Windows          []PvPWindow `yaml:"windows"`
	EquipmentDropPct float64     `yaml:"equipment_drop_pct"`
	BackpackDropPct  float64     `yaml:"backpack_drop_pct"`
}

// PvPWindow counts the unjustified kills of the last Hours.
type PvPWindow struct {
	Hours int `yaml:"hours"`
	Kills int `yaml:"kills"`
}

// PvPWar holds the guild war rules.
type PvPWar struct {
	// KillLimit: the first side to reach it wins. Hours: an active war ends after this
	// (most kills wins, or a draw). AnswerHours: a declaration nobody answers expires.
	KillLimit   int `yaml:"kill_limit"`
	Hours       int `yaml:"hours"`
	AnswerHours int `yaml:"answer_hours"`
	// MaxWars: pending and active wars a guild may have at once.
	MaxWars int `yaml:"max_wars"`
}

// MaxUnjustKills is how many unjustified kills of a character the server keeps (the
// newest): a window cannot ask for more.
const MaxUnjustKills = 256

// MaxWindowHours is the longest window of m.
func (m PvPMark) MaxWindowHours() int {
	h := 0
	for _, w := range m.Windows {
		h = max(h, w.Hours)
	}
	return h
}

func (m PvPMark) check(name string) error {
	pct := func(v float64) bool { return v >= 0 && v <= 100 }
	if m.Hours < 1 || m.Hours > 24*365 || len(m.Windows) == 0 || len(m.Windows) > 4 ||
		!pct(m.EquipmentDropPct) || !pct(m.BackpackDropPct) {
		return fmt.Errorf("pvp.%s: hours in 1..8760, 1..4 windows, drop percentages in 0..100", name)
	}
	for _, w := range m.Windows {
		if w.Hours < 1 || w.Hours > 24*60 || w.Kills < 1 || w.Kills > MaxUnjustKills {
			return fmt.Errorf("pvp.%s.windows: hours in 1..1440, kills in 1..%d", name, MaxUnjustKills)
		}
	}
	return nil
}

func (p PvP) check() error {
	if !p.Enabled {
		return nil
	}
	if p.MinLevel < 1 || p.DamagePct < 1 || p.DamagePct > 100 || p.AggressorMs < 1000 || p.LockMs < 1000 ||
		p.KillLockMs < p.LockMs || p.KillLockMs > 3_600_000 || p.KillCreditMs < 1000 || p.KillCreditMs > p.AggressorMs || p.KillCreditMs > p.LockMs {
		return errors.New("pvp: min_level >= 1, damage_pct in 1..100, aggressor_ms and lock_ms >= 1000, kill_lock_ms in lock_ms..3600000, kill_credit_ms in 1000..min(aggressor_ms, lock_ms)")
	}
	if err := p.Murderer.check("murderer"); err != nil {
		return err
	}
	if err := p.Outlaw.check("outlaw"); err != nil {
		return err
	}
	if w := p.War; w.KillLimit < 1 || w.KillLimit > 10000 || w.Hours < 1 || w.Hours > 24*60 || w.AnswerHours < 1 ||
		w.AnswerHours > 24*14 || w.MaxWars < 1 || w.MaxWars > 20 {
		return errors.New("pvp.war: kill_limit in 1..10000, hours in 1..1440, answer_hours in 1..336, max_wars in 1..20")
	}
	return nil
}

// Travel holds the boat travel rules (T3.5, docs/02-game-design.md "Viajes en barco").
type Travel struct {
	// CombatBlockMs: how long a player stays in combat after a monster attacked it, it
	// took damage or it hit a monster or a player: no sailing and no logout (a closed
	// connection leaves it link-dead, session/linkdead.go).
	CombatBlockMs int `yaml:"combat_block_ms"`
	// LinkDeadMaxMs: the longest a player that lost its connection in a fight stays in the
	// world link-dead while monsters keep the fight going (0: no cap); a PvP lock still
	// holds it until the lock ends.
	LinkDeadMaxMs int `yaml:"link_dead_max_ms"`
	// ArrivalRadius: a taken arrival tile falls back to the nearest free one this far.
	ArrivalRadius int `yaml:"arrival_radius"`
}

// Economy holds the economy rules and the economy log (T4.1, docs/01-architecture.md
// "Trampas y anti-bot").
type Economy struct {
	CoinRatio int `yaml:"coin_ratio"`
	// Log: the persistence goroutine writes the economy log in batches of up to
	// BatchSize rows, at least every FlushMs.
	Log struct {
		FlushMs   int `yaml:"flush_ms"`
		BatchSize int `yaml:"batch_size"`
	} `yaml:"log"`
	// CheckEveryMs is how often each online character's gold and items are reconciled
	// with what the log says it gained and lost (0 = never).
	CheckEveryMs int `yaml:"check_every_ms"`
	// Outlier: a character that creates more than these, per hour of play within a
	// window of WindowMs, raises an alert (once per window).
	Outlier struct {
		WindowMs     int      `yaml:"window_ms"`
		GoldPerHour  PerLevel `yaml:"gold_per_hour"`
		ItemsPerHour PerLevel `yaml:"items_per_hour"`
	} `yaml:"outlier"`
}

// PerLevel is a threshold that grows with the level: Base + PerLevel × level.
type PerLevel struct {
	Base     int64 `yaml:"base"`
	PerLevel int64 `yaml:"per_level"`
}

// At returns the threshold at level.
func (p PerLevel) At(level int) int64 { return p.Base + p.PerLevel*int64(level) }

func (e Economy) check() error {
	if e.Log.FlushMs <= 0 || e.Log.FlushMs > 60_000 || e.Log.BatchSize <= 0 || e.Log.BatchSize > 10_000 {
		return errors.New("economy.log: flush_ms must be in 1..60000 and batch_size in 1..10000")
	}
	o := e.Outlier
	if e.CheckEveryMs < 0 || o.WindowMs < 60_000 || o.GoldPerHour.Base <= 0 || o.GoldPerHour.PerLevel < 0 ||
		o.ItemsPerHour.Base <= 0 || o.ItemsPerHour.PerLevel < 0 {
		return errors.New("economy: check_every_ms >= 0, outlier.window_ms >= 60000, outlier bases > 0 and per_level >= 0")
	}
	return nil
}

// MaxReportReason is the longest report reason, in characters (player_reports.reason).
const MaxReportReason = 200

// MaxReportEvents is how many recent events of a character the server keeps for the
// context of a report.
const MaxReportEvents = 32

// Reports holds the player report rules (T4.1): per account, a bucket of Burst
// reports refilled one every RefillMs, and one report of the same character every
// SameTargetMs. Events is how many recent events of the reported one go with it.
type Reports struct {
	Burst        int `yaml:"burst"`
	RefillMs     int `yaml:"refill_ms"`
	SameTargetMs int `yaml:"same_target_ms"`
	MaxReason    int `yaml:"max_reason"`
	Events       int `yaml:"events"`
}

func (r Reports) check() error {
	if r.Burst <= 0 || r.RefillMs <= 0 || r.SameTargetMs < 0 || r.MaxReason <= 0 || r.MaxReason > MaxReportReason ||
		r.Events < 0 || r.Events > MaxReportEvents {
		return fmt.Errorf("reports: burst and refill_ms > 0, same_target_ms >= 0, max_reason in 1..%d, events in 0..%d",
			MaxReportReason, MaxReportEvents)
	}
	return nil
}

// Idle holds the idle disconnect (T4.1): a player without a real action (walking,
// attacking, using, talking) for KickAfterMs is disconnected, warned WarnBeforeMs
// before. Never in combat or on a no-logout tile. KickAfterMs 0 turns it off.
type Idle struct {
	KickAfterMs  int `yaml:"kick_after_ms"`
	WarnBeforeMs int `yaml:"warn_before_ms"`
}

func (i Idle) check() error {
	if i.KickAfterMs < 0 || i.WarnBeforeMs < 0 || (i.KickAfterMs > 0 && (i.KickAfterMs < 60_000 || i.WarnBeforeMs >= i.KickAfterMs)) {
		return errors.New("idle: kick_after_ms 0 or >= 60000, warn_before_ms in 0..kick_after_ms")
	}
	return nil
}

// AntiBot holds the behaviour signals, the suspicion score and its graded responses
// (T4.1, docs/01-architecture.md "Trampas y anti-bot"). Times are in ms of game time.
type AntiBot struct {
	// EvalEveryMs is how often each online character's score is updated (0 = off).
	EvalEveryMs int `yaml:"eval_every_ms"`
	// HalfLifeMs: the score halves over this long without new points.
	HalfLifeMs int `yaml:"half_life_ms"`
	// PauseMs: a gap between actions this long is a pause (not an interval, and it ends
	// a continuous session).
	PauseMs int `yaml:"pause_ms"`
	Signals struct {
		Regularity struct {
			Weight     float64 `yaml:"weight"`
			MinSamples int     `yaml:"min_samples"`
			// CVLow and CVHigh: the coefficient of variation of the intervals at which
			// the signal is 1 and 0.
			CVLow  float64 `yaml:"cv_low"`
			CVHigh float64 `yaml:"cv_high"`
			// StdMs: the standard deviation of the intervals must also be this small
			// (0 at twice it): a person's timing error does not shrink as the interval
			// grows, so a long, server-paced interval (a full mana bar) has a low CV.
			StdMs int `yaml:"std_ms"`
		} `yaml:"regularity"`
		Reaction struct {
			Weight     float64 `yaml:"weight"`
			MinSamples int     `yaml:"min_samples"`
			// A heal within WindowMs of a hit answers it; FastMs or less is inhuman, and
			// a standard deviation of StdMs or less is constant.
			WindowMs int `yaml:"window_ms"`
			FastMs   int `yaml:"fast_ms"`
			StdMs    int `yaml:"std_ms"`
		} `yaml:"reaction"`
		Route struct {
			Weight float64 `yaml:"weight"`
			// Segment is how many steps make a route segment; MinSteps the steps needed.
			Segment  int `yaml:"segment"`
			MinSteps int `yaml:"min_steps"`
			// RepeatLow and RepeatHigh: the share of repeated segments at 0 and 1.
			RepeatLow  float64 `yaml:"repeat_low"`
			RepeatHigh float64 `yaml:"repeat_high"`
		} `yaml:"route"`
		Session struct {
			Weight float64 `yaml:"weight"`
			LowMs  int     `yaml:"low_ms"`
			HighMs int     `yaml:"high_ms"`
		} `yaml:"session"`
		Income struct {
			Weight float64 `yaml:"weight"`
			// Peers: characters of the same band of BandLevels levels online, at least
			// MinPeers, whose median income per hour is compared.
			MinPeers   int     `yaml:"min_peers"`
			BandLevels int     `yaml:"band_levels"`
			RatioLow   float64 `yaml:"ratio_low"`
			RatioHigh  float64 `yaml:"ratio_high"`
		} `yaml:"income"`
	} `yaml:"signals"`
	// Thresholds of the graded responses, in score points.
	Thresholds struct {
		Log      float64 `yaml:"log"`
		Notify   float64 `yaml:"notify"`
		Presence float64 `yaml:"presence"`
		Suspend  float64 `yaml:"suspend"`
	} `yaml:"thresholds"`
	// Presence is the in-game presence check: answered within TimeoutMs of active play; a
	// failure adds FailPoints (never past the suspension threshold by itself). It is asked
	// after a random delay of up to DelayMs. A suspension needs a failed check or one asked
	// ConfirmMs ago. A due check dodged for DeferAlertMs (combat, no-logout tile) alerts
	// the GMs. RandomPerHour: chance per hour of play of a random check for anyone (no
	// effect if failed), so a check says nothing about the score.
	Presence struct {
		TimeoutMs     int     `yaml:"timeout_ms"`
		DelayMs       int     `yaml:"delay_ms"`
		FailPoints    float64 `yaml:"fail_points"`
		ConfirmMs     int     `yaml:"confirm_ms"`
		DeferAlertMs  int     `yaml:"defer_alert_ms"`
		RandomPerHour float64 `yaml:"random_per_hour"`
	} `yaml:"presence"`
	// SuspendMs is the length of an automatic suspension (at most 30 days).
	SuspendMs int64 `yaml:"suspend_ms"`
}

func (a AntiBot) check() error {
	if a.EvalEveryMs < 0 || (a.EvalEveryMs > 0 && (a.HalfLifeMs < 60_000 || a.PauseMs < 1000)) {
		return errors.New("antibot: eval_every_ms >= 0; when on, half_life_ms >= 60000 and pause_ms >= 1000")
	}
	if a.EvalEveryMs == 0 {
		return nil
	}
	s := a.Signals
	for name, w := range map[string]float64{"regularity": s.Regularity.Weight, "reaction": s.Reaction.Weight,
		"route": s.Route.Weight, "session": s.Session.Weight, "income": s.Income.Weight} {
		if w < 0 {
			return fmt.Errorf("antibot.signals.%s.weight must be >= 0", name)
		}
	}
	if s.Regularity.CVLow < 0 || s.Regularity.CVHigh <= s.Regularity.CVLow || s.Regularity.StdMs <= 0 || s.Reaction.FastMs <= 0 ||
		s.Reaction.WindowMs < s.Reaction.FastMs || s.Reaction.StdMs <= 0 || s.Route.Segment < 2 || s.Route.Segment > 32 ||
		s.Route.RepeatHigh <= s.Route.RepeatLow || s.Session.HighMs <= s.Session.LowMs || s.Income.BandLevels < 1 ||
		s.Income.MinPeers < 2 || s.Income.RatioHigh <= s.Income.RatioLow {
		return errors.New("antibot.signals: cv_low < cv_high, regularity.std_ms > 0, 0 < fast_ms <= window_ms, std_ms > 0, segment in 2..32, " +
			"repeat_low < repeat_high, low_ms < high_ms, band_levels >= 1, min_peers >= 2, ratio_low < ratio_high")
	}
	t := a.Thresholds
	if !(0 < t.Log && t.Log < t.Notify && t.Notify < t.Presence && t.Presence < t.Suspend) {
		return errors.New("antibot.thresholds: 0 < log < notify < presence < suspend")
	}
	// A signal held forever settles at weight / (1 − 0.5^(eval/half_life)): one signal
	// alone (a habit of a real player) must never tell the GMs.
	settle := 1 / (1 - math.Pow(0.5, float64(a.EvalEveryMs)/float64(a.HalfLifeMs)))
	for _, w := range []float64{s.Regularity.Weight, s.Reaction.Weight, s.Route.Weight, s.Session.Weight, s.Income.Weight} {
		if w*settle >= t.Notify {
			return fmt.Errorf("antibot: a weight of %v alone settles at %.0f points, not under notify", w, w*settle)
		}
	}
	if pr := a.Presence; pr.TimeoutMs < 60_000 || pr.DelayMs < 0 || pr.FailPoints < 0 || pr.ConfirmMs < 0 ||
		pr.DeferAlertMs < 60_000 || pr.RandomPerHour < 0 || pr.RandomPerHour > 1 {
		return errors.New("antibot.presence: timeout_ms and defer_alert_ms >= 60000, delay_ms, fail_points and " +
			"confirm_ms >= 0, random_per_hour in 0..1")
	}
	if a.SuspendMs < 60_000 || a.SuspendMs > 30*24*3600*1000 {
		return errors.New("antibot.suspend_ms must be in 60000..30 days (longer bans are a GM's decision)")
	}
	return nil
}

// Inventory holds the item and container rules (T1.8).
type Inventory struct {
	// StartContainer is the container item a character that never played starts with.
	StartContainer    string `yaml:"start_container"`
	MaxOpenContainers int    `yaml:"max_open_containers"`
	UseCooldownMs     int    `yaml:"use_cooldown_ms"`
	// DoorCooldownMs is how long a player waits between two uses of a door of the map,
	// refused or not (docs/02 "Puertas con llave"): a door's tile goes to everyone around.
	DoorCooldownMs int `yaml:"door_cooldown_ms"`
	// Reach is the Chebyshev distance (same floor) for actions on ground items, 1 to
	// MaxReach.
	Reach int `yaml:"reach"`
	// PocketSlots is how many cells the pockets every character has built in hold
	// (docs/02 "Bolsillos"), 1 to MaxPocketSlots.
	PocketSlots int `yaml:"pocket_slots"`
}

// MaxPocketSlots bounds inventory.pocket_slots: one row of cells under the figure of the
// client's inventory.
const MaxPocketSlots = 8

// MaxReach bounds inventory.reach and resource.reach: the half-height of the classic 15x11
// window with its margin (session.SightHalfH), what a monster notices. The wide view
// (31x21, docs/00) did not stretch it: hands reach as far as before. It must stay within
// the view (session.ViewHalfH): the server answers nothing about a tile out of the
// player's view (gathering, crafting stations: not_possible).
const MaxReach = 6

// MaxRange bounds every aimed range of the content: weapon.range, the range of a damage or
// heal spell, the radius of an area spell and a condition's range. It is what a monster
// notices (session.InSight, the half-height of the classic 15x11 window): a monster hit
// from as far as a player can aim, or by an area spell, always notices who hit it and
// fights back. The wide view (31x21) shows targets farther
// away; it must not let a player hit one that never answers.
const MaxRange = 6

// check verifies the inventory numbers: max_open_containers, door_cooldown_ms and reach
// above 0 (reach at most MaxReach), use_cooldown_ms not negative, pocket_slots 1 to
// MaxPocketSlots.
func (i Inventory) check() error {
	if i.MaxOpenContainers <= 0 || i.UseCooldownMs < 0 || i.DoorCooldownMs <= 0 || i.Reach <= 0 || i.Reach > MaxReach {
		return fmt.Errorf("inventory: max_open_containers, door_cooldown_ms and reach must be > 0 (reach at most %d), use_cooldown_ms >= 0", MaxReach)
	}
	if i.PocketSlots < 1 || i.PocketSlots > MaxPocketSlots {
		return fmt.Errorf("inventory: pocket_slots must be 1 to %d", MaxPocketSlots)
	}
	return nil
}

// Gathering holds the fishing and mining rules shared by every spot (T1.12); the
// numbers of each spot are its item's resource block.
type Gathering struct {
	// UseIntervalMs is the minimum time between two gathering attempts (rate limit).
	UseIntervalMs int `yaml:"use_interval_ms"`
	AFK           struct {
		// AfterMs: gathering without leaving the tile for this long...
		AfterMs int `yaml:"after_ms"`
		// Factor: ...earns skill tries at this rate (0-1).
		Factor float64 `yaml:"factor"`
	} `yaml:"afk"`
}

// Combat holds the melee constants (docs/02-game-design.md, "Combate").
type Combat struct {
	AttackIntervalMs   int                   `yaml:"attack_interval_ms"`
	FistAttack         int                   `yaml:"fist_attack"`
	SkillAttackDivisor int                   `yaml:"skill_attack_divisor"`
	LevelDivisor       int                   `yaml:"level_divisor"`
	ShieldBlockDivisor int                   `yaml:"shield_block_divisor"`
	MonsterCorpseMs    int                   `yaml:"monster_corpse_ms"`
	WandMinFactor      float64               `yaml:"wand_min_factor"`
	Modes              map[string]CombatMode `yaml:"modes"`
	// MonsterLeashTiles is how far (Chebyshev) beyond its spawn's radius a monster
	// follows a target; it gives up beyond that and walks home (docs/02-game-design.md,
	// monsters section). 0 or absent: no leash.
	MonsterLeashTiles int `yaml:"monster_leash_tiles"`
	// MonsterPathRetryMs is how long a monster whose search for a way (home, or to its
	// target) found none waits before it steps or searches again, and how often a chase
	// with a leash checks the way to a target out of its reach.
	MonsterPathRetryMs int `yaml:"monster_path_retry_ms"`
	// MonsterStuckMs: with a leash, a target out of reach that no way within the leash
	// area reaches around creatures for this long is given up (or, with only creatures
	// in the way, swapped for a player within reach).
	MonsterStuckMs int `yaml:"monster_stuck_ms"`
	// MonsterShunMs is how long a player given up that way stays beyond the leash for
	// that monster while it stands on the same tile.
	MonsterShunMs int `yaml:"monster_shun_ms"`
	// MonsterPursuit is how monsters follow a target beyond their leash area, and
	// MonsterRegen how they heal out of combat; data/monsters may override each field
	// (docs/02-game-design.md, monsters section). Zero: no pursuit beyond the leash area, a
	// target out of sight lost at once, no regeneration and attackers forgotten on giving
	// up (the behaviour before them).
	MonsterPursuit Pursuit          `yaml:"monster_pursuit"`
	MonsterRegen   MonsterRegenRate `yaml:"monster_regen"`
	// MonsterStrayMs: an idle monster that has stood out of its home area this long
	// without finding its way home, and that no player sees, goes back to its spawn
	// (despawn + respawn). 0: never.
	MonsterStrayMs int `yaml:"monster_stray_ms"`
}

// MaxChaseTiles bounds Pursuit.MaxChaseTiles: nobody drags a monster across the world.
const MaxChaseTiles = 40

// Pursuit is how a monster follows a target beyond its leash area (its comfort zone).
type Pursuit struct {
	// Persistence (0-1) is the chance that it keeps chasing, checked every RollMs while
	// its target is beyond the leash area; it falls with the target's distance from home.
	Persistence float64 `yaml:"persistence"`
	// MaxChaseTiles is the hard cap (Chebyshev from its spawn's center) of a chase.
	MaxChaseTiles int `yaml:"max_chase_tiles"`
	// LoseSightMs: a target out of its sight this long is given up (0: at once).
	LoseSightMs int `yaml:"lose_sight_ms"`
	// RollMs is how often the decision is rolled again (balance only).
	RollMs int `yaml:"roll_ms"`
	// GiveUpBelowHpPct: with less health than this, it does not chase beyond the leash.
	GiveUpBelowHpPct int `yaml:"give_up_below_hp_pct"`
	// InsistTargetHpPct: a target with less health than this halves the chance of
	// giving up.
	InsistTargetHpPct int `yaml:"insist_target_hp_pct"`
	// DistanceExponent is how fast the chance falls with the target's distance from home:
	// persistence ^ (1 + DistanceExponent x the fraction of the way from the leash area to
	// MaxChaseTiles). 0: the persistence everywhere (balance only).
	DistanceExponent float64 `yaml:"distance_exponent"`
	// InsistBoost is how much of the way to 1 the chance goes against a target below
	// InsistTargetHpPct (0.5: halfway; 0: none; balance only).
	InsistBoost float64 `yaml:"insist_boost"`
	// MemoryMs is how long it remembers who hurt it after their last hit, once it gave their
	// fight up (balance only): it re-aggroes them first and their damage still counts for
	// the experience and the loot. 0: forgotten on giving up.
	MemoryMs int `yaml:"memory_ms"`
}

// MinPeriodMs is the shortest roll_ms or interval_ms (one tick), as the schemas ask.
const MinPeriodMs = 50

// MaxDistanceExponent bounds Pursuit.DistanceExponent.
const MaxDistanceExponent = 10

// Check validates p: the balance's numbers, or a monster's resolved against them. It
// rejects what balance.schema.json and monster.schema.json reject.
func (p Pursuit) Check() error {
	if p.Persistence < 0 || p.Persistence > 1 || p.MaxChaseTiles < 0 || p.MaxChaseTiles > MaxChaseTiles ||
		p.LoseSightMs < 0 || p.MemoryMs < 0 ||
		p.GiveUpBelowHpPct < 0 || p.GiveUpBelowHpPct > 100 || p.InsistTargetHpPct < 0 || p.InsistTargetHpPct > 100 {
		return fmt.Errorf("persistence in 0..1, max_chase_tiles in 0..%d, times >= 0, percents in 0..100", MaxChaseTiles)
	}
	if p.DistanceExponent < 0 || p.DistanceExponent > MaxDistanceExponent || p.InsistBoost < 0 || p.InsistBoost > 1 {
		return fmt.Errorf("distance_exponent in 0..%d, insist_boost in 0..1", MaxDistanceExponent)
	}
	if p.RollMs != 0 && p.RollMs < MinPeriodMs {
		return fmt.Errorf("roll_ms must be >= %d", MinPeriodMs)
	}
	if p.Persistence > 0 && p.RollMs == 0 {
		return errors.New("a persistence needs roll_ms")
	}
	return nil
}

// MonsterRegenRate is a monster's out-of-combat regeneration: Pct % of its maximum health every
// IntervalMs, once DelayMs went by without dealing or taking damage and without a target.
type MonsterRegenRate struct {
	DelayMs    int     `yaml:"delay_ms"`
	IntervalMs int     `yaml:"interval_ms"`
	Pct        float64 `yaml:"pct"`
}

// Check validates r: the balance's numbers, or a monster's resolved against them. It
// rejects what balance.schema.json and monster.schema.json reject.
func (r MonsterRegenRate) Check() error {
	if r.DelayMs < 0 || r.Pct < 0 || r.Pct > 100 {
		return errors.New("delay_ms >= 0, pct in 0..100")
	}
	if r.IntervalMs != 0 && r.IntervalMs < MinPeriodMs {
		return fmt.Errorf("interval_ms must be >= %d", MinPeriodMs)
	}
	if r.Pct > 0 && r.IntervalMs == 0 {
		return errors.New("a pct needs interval_ms")
	}
	return nil
}

// CombatMode scales attack and shield defense for a fight stance.
type CombatMode struct {
	Attack  float64 `yaml:"attack"`
	Defense float64 `yaml:"defense"`
}

// Stances are the fight stances of balance.yaml, in protocol order (FightStance 1..3).
var Stances = [...]string{"offensive", "balanced", "defensive"}

// MaxDiagonalCost caps movement.diagonal_cost (world.MaxDiagonalCost): a diagonal step is
// two straight ones at most, and past it a path's cost could overflow.
const MaxDiagonalCost = 2

// MaxQueuedSteps caps movement.max_queued_steps: a deeper queue would only let a client
// run further ahead of what the server confirmed.
const MaxQueuedSteps = 8

// Movement holds the walking constants (docs/02-game-design.md, "Movimiento").
type Movement struct {
	// BaseStepMs is the step duration on 100 % terrain at speed 100:
	// step_ms = base_step_ms * terrain% / speed (diagonals × DiagonalCost). Every
	// creature walks by it: lowering it speeds up players, monsters and NPCs alike.
	BaseStepMs   int     `yaml:"base_step_ms"`
	DiagonalCost float64 `yaml:"diagonal_cost"`
	// SpeedPerLevelPct is how much faster a player walks per level over the first, in
	// percent of its vocation's speed (LevelSpeed). No cap but experience.max_level.
	SpeedPerLevelPct float64 `yaml:"speed_per_level_pct"`
	MaxPathTiles     int     `yaml:"max_path_tiles"`
	// MaxQueuedSteps is how many keyboard steps (Walk) may wait in a player's queue: the
	// client predicts that many ahead so a held key walks without a stop between tiles,
	// and one more resets the walk (docs/05 "Caminar").
	MaxQueuedSteps int `yaml:"max_queued_steps"`
}

// MaxSpeedPerLevelPct caps movement.speed_per_level_pct.
const MaxSpeedPerLevelPct = 5

// LevelSpeed returns the speed of a player of level whose vocation's speed at that level
// is base (Vocation.AtLevel, with the vocation's own points per level): base × (100 +
// speed_per_level_pct × (level − 1)) / 100, rounded to the nearest point (halves up) and
// at least 1. Level 1 is the vocation's speed. Whole numbers like the step timer: the
// percent is read in thousandths, so a half is a half on every machine.
func (m Movement) LevelSpeed(base, level int) int {
	n := int64(max(level, 1) - 1)
	milli := int64(math.Round(m.SpeedPerLevelPct * 1000)) // thousandths of a percent
	return int(max((int64(max(base, 0))*(100_000+milli*n)+50_000)/100_000, 1))
}

// Experience is the level curve: total XP for level n is a*n^3 + b*n^2 + c*n + d.
type Experience struct {
	Curve struct {
		A, B, C, D float64
	} `yaml:"curve"`
	MaxLevel int `yaml:"max_level"`
	// Pace is the leveling pace target: hours of play to reach each level, at least two
	// anchors with increasing levels and hours. Between anchors (and beyond them) it is a
	// power law in level, so the pace keeps slowing down as the curve does.
	Pace []PaceAnchor `yaml:"pace"`
}

// PaceAnchor says that reaching Level takes about Hours of play.
type PaceAnchor struct {
	Level int     `yaml:"level"`
	Hours float64 `yaml:"hours"`
}

func (e Experience) check() error {
	for i, a := range e.Pace {
		if a.Level < 2 || a.Hours <= 0 || i > 0 && (a.Level <= e.Pace[i-1].Level || a.Hours <= e.Pace[i-1].Hours) {
			return errors.New("experience.pace: levels >= 2 and hours > 0, both increasing")
		}
	}
	if len(e.Pace) < 2 {
		return errors.New("experience.pace needs at least two anchors")
	}
	return nil
}

// LevelsPerHour is the target pace at level: hours(L) = h_i × (L / L_i)^k between the
// anchors around L (the first or last pair beyond them), so its rate is
// 1 / (k × hours(L) / L) levels per hour.
func (e Experience) LevelsPerHour(level int) float64 {
	if len(e.Pace) < 2 {
		return 0
	}
	i := 1
	for i < len(e.Pace)-1 && level > e.Pace[i].Level {
		i++
	}
	a, b := e.Pace[i-1], e.Pace[i]
	k := math.Log(b.Hours/a.Hours) / math.Log(float64(b.Level)/float64(a.Level))
	l := float64(max(level, 1))
	hours := a.Hours * math.Pow(l/float64(a.Level), k)
	return l / (k * hours)
}

// TotalFor returns the total experience needed to reach level n (0 for n <= 1).
func (e Experience) TotalFor(n int) int64 {
	if n <= 1 {
		return 0
	}
	f := float64(n)
	c := e.Curve
	return int64(c.A*f*f*f + c.B*f*f + c.C*f + c.D)
}

// LevelPercent returns the progress (0-99) from level to level+1 with xp total experience.
func (e Experience) LevelPercent(level int, xp int64) int {
	lo, hi := e.TotalFor(level), e.TotalFor(level+1)
	if hi <= lo || xp <= lo {
		return 0
	}
	p := int((xp - lo) * 100 / (hi - lo))
	return min(max(p, 0), 99)
}

// Skills holds the use-based skill constants (docs/02-game-design.md, "Skills que
// suben con el uso").
type Skills struct {
	Base map[string]SkillBase `yaml:"base"`
	// ShieldMaxTriesPerRound caps the shield tries a player earns per attack round
	// (combat.attack_interval_ms), however many attackers it has.
	ShieldMaxTriesPerRound int `yaml:"shield_max_tries_per_round"`
	AFK                    struct {
		// AfterMs: training against a target that has not fought back for this long...
		AfterMs int `yaml:"after_ms"`
		// Factor: ...earns tries at this rate (0-1).
		Factor float64 `yaml:"factor"`
	} `yaml:"afk"`
}

// SkillBase is the starting level of a skill or craft.
type SkillBase struct {
	StartLevel int `yaml:"start_level"`
	BaseTries  int `yaml:"base_tries"`
}

// SkillIDs returns the skill ids of Skills.Base, sorted (deterministic order).
func (b Balance) SkillIDs() []string {
	ids := make([]string, 0, len(b.Skills.Base))
	for id := range b.Skills.Base {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// LoadBalance reads <dataDir>/balance.yaml.
func LoadBalance(dataDir string) (Balance, error) {
	path := filepath.Join(dataDir, "balance.yaml")
	raw, err := os.ReadFile(path)
	if err != nil {
		return Balance{}, fmt.Errorf("read balance: %w", err)
	}
	b, err := ParseBalance(raw)
	if err != nil {
		return Balance{}, fmt.Errorf("%s: %w", path, err)
	}
	return b, nil
}

// ParseBalance decodes balance.yaml and checks the invariants the server relies on.
func ParseBalance(raw []byte) (Balance, error) {
	var b Balance
	if err := yaml.Unmarshal(raw, &b); err != nil {
		return Balance{}, fmt.Errorf("decode balance: %w", err)
	}
	m := b.Movement
	if m.BaseStepMs <= 0 || m.BaseStepMs > 60_000 {
		return Balance{}, errors.New("movement.base_step_ms must be in 1..60000")
	}
	if m.DiagonalCost < 1 || m.DiagonalCost > MaxDiagonalCost {
		return Balance{}, errors.New("movement.diagonal_cost must be in 1..2 (world.MaxDiagonalCost)")
	}
	if m.SpeedPerLevelPct < 0 || m.SpeedPerLevelPct > MaxSpeedPerLevelPct {
		return Balance{}, fmt.Errorf("movement.speed_per_level_pct must be in 0..%d", MaxSpeedPerLevelPct)
	}
	if m.MaxPathTiles <= 0 || m.MaxPathTiles > 100 {
		return Balance{}, errors.New("movement.max_path_tiles must be in 1..100 (world.MaxPathLength)")
	}
	if m.MaxQueuedSteps <= 0 || m.MaxQueuedSteps > MaxQueuedSteps {
		return Balance{}, fmt.Errorf("movement.max_queued_steps must be in 1..%d", MaxQueuedSteps)
	}
	if err := b.Experience.check(); err != nil {
		return Balance{}, err
	}
	if err := b.Combat.check(); err != nil {
		return Balance{}, err
	}
	if err := b.Skills.check(); err != nil {
		return Balance{}, err
	}
	if err := b.Death.check(); err != nil {
		return Balance{}, err
	}
	if err := b.Inventory.check(); err != nil {
		return Balance{}, err
	}
	if err := b.Chat.check(); err != nil {
		return Balance{}, err
	}
	if err := b.Conditions.check(); err != nil {
		return Balance{}, err
	}
	if err := b.Party.check(); err != nil {
		return Balance{}, err
	}
	if err := b.Guild.check(); err != nil {
		return Balance{}, err
	}
	if err := b.PvP.check(); err != nil {
		return Balance{}, err
	}
	if err := b.Market.check(); err != nil {
		return Balance{}, err
	}
	if err := b.Trade.check(); err != nil {
		return Balance{}, err
	}
	if err := b.Stash.check(); err != nil {
		return Balance{}, err
	}
	if err := b.Living.check(); err != nil {
		return Balance{}, err
	}
	if err := b.Forge.check(); err != nil {
		return Balance{}, err
	}
	if err := b.Houses.check(); err != nil {
		return Balance{}, err
	}
	if b.Houses.Enabled && !b.Market.Enabled {
		return Balance{}, errors.New("houses: they need the market (rent from and items to the market mailbox)")
	}
	if t := b.Travel; t.CombatBlockMs < 0 || t.CombatBlockMs > 600_000 || t.ArrivalRadius < 0 || t.ArrivalRadius > 5 {
		return Balance{}, errors.New("travel: combat_block_ms must be in 0..600000 and arrival_radius in 0..5")
	}
	if t := b.Travel; t.LinkDeadMaxMs != 0 && (t.LinkDeadMaxMs < t.CombatBlockMs || t.LinkDeadMaxMs > 3_600_000) {
		return Balance{}, errors.New("travel: link_dead_max_ms must be 0 (no cap) or in combat_block_ms..3600000")
	}
	if err := b.Economy.check(); err != nil {
		return Balance{}, err
	}
	if err := b.Reports.check(); err != nil {
		return Balance{}, err
	}
	if err := b.Idle.check(); err != nil {
		return Balance{}, err
	}
	if err := b.AntiBot.check(); err != nil {
		return Balance{}, err
	}
	if g := b.Gathering; g.UseIntervalMs < 0 || g.AFK.AfterMs < 0 || g.AFK.Factor < 0 || g.AFK.Factor > 1 {
		return Balance{}, errors.New("gathering: use_interval_ms and afk.after_ms must be >= 0, afk.factor in 0..1")
	}
	return b, nil
}

func (s Skills) check() error {
	for id, b := range s.Base {
		if b.StartLevel < 0 || b.BaseTries < 0 {
			return fmt.Errorf("skills.base.%s: start_level and base_tries must be >= 0", id)
		}
	}
	if s.ShieldMaxTriesPerRound < 0 || s.AFK.AfterMs < 0 || s.AFK.Factor < 0 || s.AFK.Factor > 1 {
		return errors.New("skills: shield_max_tries_per_round and afk.after_ms must be >= 0, afk.factor in 0..1")
	}
	return nil
}

func (c Combat) check() error {
	if c.AttackIntervalMs <= 0 || c.FistAttack <= 0 || c.SkillAttackDivisor <= 0 ||
		c.LevelDivisor <= 0 || c.ShieldBlockDivisor <= 0 || c.MonsterCorpseMs <= 0 {
		return errors.New("combat: attack_interval_ms, fist_attack, divisors and monster_corpse_ms must be > 0")
	}
	if c.MonsterLeashTiles < 0 {
		return errors.New("combat: monster_leash_tiles must be >= 0")
	}
	if c.MonsterPathRetryMs <= 0 || c.MonsterStuckMs <= 0 || c.MonsterShunMs <= 0 {
		return errors.New("combat: monster_path_retry_ms, monster_stuck_ms and monster_shun_ms must be > 0")
	}
	if err := c.MonsterPursuit.Check(); err != nil {
		return fmt.Errorf("combat.monster_pursuit: %w", err)
	}
	if err := c.MonsterRegen.Check(); err != nil {
		return fmt.Errorf("combat.monster_regen: %w", err)
	}
	if c.MonsterStrayMs < 0 {
		return errors.New("combat: monster_stray_ms must be >= 0")
	}
	for _, s := range Stances {
		m, ok := c.Modes[s]
		if !ok || m.Attack < 0 || m.Defense < 0 {
			return fmt.Errorf("combat.modes.%s missing or negative", s)
		}
	}
	return nil
}

// Living is balance.living: the living world's numbers that belong to no object
// (livingworld/README.md); the objects' own live in data/livingworld.
type Living struct {
	// FistDamage is a bare-handed strike's damage on a breakable object.
	FistDamage int `yaml:"fist_damage"`
	// ToolDamage is the damage of one use of a tool (an axe, a pickaxe) on one.
	ToolDamage int `yaml:"tool_damage"`
	// PushCooldownMs is how often one player may push an object.
	PushCooldownMs int `yaml:"push_cooldown_ms"`
}

// MaxLivingDamage bounds Living's damages (an object has at most livingworld.MaxHP).
const MaxLivingDamage = 10000

func (l Living) check() error {
	if l.FistDamage < 0 || l.FistDamage > MaxLivingDamage || l.ToolDamage < 0 || l.ToolDamage > MaxLivingDamage ||
		l.PushCooldownMs < 0 || l.PushCooldownMs > 60_000 {
		return fmt.Errorf("living: fist_damage and tool_damage in 0..%d, push_cooldown_ms in 0..60000", MaxLivingDamage)
	}
	return nil
}
