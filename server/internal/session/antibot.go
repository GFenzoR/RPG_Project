package session

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/antibot"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// Bot detection (T4.1 2/2, docs/01-architecture.md "Trampas y anti-bot"). The loop feeds
// each character's antibot.Tracker at constant cost (real actions, steps, hits, heals)
// and, every antibot.eval_every_ms (staggered), updates its suspicion score. Crossing a
// threshold triggers the next graded response, once per episode:
//
//	log       → structured log and audit_log
//	notify    → a message to every online GM, audited
//	presence  → an in-game presence check (never in combat or on a no-logout tile)
//	suspend   → a temporary suspension, only after a failed presence check
//
// A failed check only adds points; the suspension still needs the score. A ban is always
// a GM's decision. Staff characters are not evaluated. The state lives in the World by
// character, so logging out and in neither resets the score nor a pending check.

// Message keys of the bot detection.
const (
	msgPresenceThanks = "presence.thanks"
	msgGMBotSuspect   = "gm.bot_suspect"
	msgGMPresenceFail = "gm.presence_failed"
	msgGMPresenceSent = "gm.presence_sent"
	antibotActor      = "system:antibot"
)

// presenceColors are the presence check's questions and answers: the question
// presence.question.<c> asks for the option presence.option.<c> (i18n).
var presenceColors = [...]string{"red", "blue", "green", "yellow"}

// suspect is the bot detection state of one character.
type suspect struct {
	cfg     *content.AntiBot
	tracker antibot.Tracker
	score   float64
	signals antibot.Signals // of the last evaluation
	// level is the highest response already given in this episode (it drops when the
	// score falls under half of its threshold).
	level    int
	lastEval game.Tick
	// failed: a presence check failed in this episode (needed to suspend).
	failed bool
	// askAt is when a presence check is due (0 = none); check is the one waiting for an
	// answer, with the ticks it has left while its character is online.
	askAt game.Tick
	check *presenceCheck
}

type presenceCheck struct {
	id       uint32
	answer   uint32
	question string
	options  []*pb.DialogOption
	deadline game.Tick // while online
	left     game.Tick // while offline
}

func (w *World) initAntiBot() {
	a := &w.cfg.Balance.AntiBot
	w.abCfg = a
	w.abEvalFor = game.TicksFor(time.Duration(a.EvalEveryMs) * time.Millisecond)
	w.suspects = map[int64]*suspect{}
}

// tickMs is the game time of tick in ms (what the tracker measures).
func tickMs(t game.Tick) int64 { return int64(t.Duration() / time.Millisecond) }

// antibotJoin attaches p to its detection state and resumes a pending presence check.
func (w *World) antibotJoin(tick game.Tick, p *Player) {
	if w.abEvalFor == 0 {
		return
	}
	s := w.suspects[p.charID]
	if s == nil {
		s = &suspect{cfg: w.abCfg, lastEval: tick}
		w.suspects[p.charID] = s
	}
	p.sus = s
	p.abNext = tick + 1 + game.Tick(p.id)%w.abEvalFor
	if c := s.check; c != nil {
		c.deadline = tick + c.left
		w.sendPresence(p, c)
	}
}

// antibotLeave keeps the time a pending check has left while p is offline.
func (w *World) antibotLeave(tick game.Tick, p *Player) {
	if s := p.sus; s != nil && s.check != nil {
		s.check.left = max(s.check.deadline-tick, game.TicksFor(time.Minute))
	}
}

// Feeding the tracker (constant cost; nothing when the detection is off or p is staff).

func (w *World) abStep(tick game.Tick, p *Player, d world.Direction) {
	if p.sus != nil {
		p.sus.tracker.Step(tickMs(tick), p.pos.X, p.pos.Y, p.pos.Z, uint8(d), w.abCfg)
	}
}

func (w *World) abHurt(tick game.Tick, p *Player) {
	if p.sus != nil {
		p.sus.tracker.Hurt(tickMs(tick))
	}
}

func (w *World) abHeal(tick game.Tick, p *Player) {
	if p.sus != nil {
		p.sus.tracker.Heal(tickMs(tick), w.abCfg)
	}
}

// checkAntiBot evaluates the scores that are due, asks presence checks when they can be
// asked and fails the expired ones (once per second for those two).
func (w *World) checkAntiBot(ctx *game.TickContext) {
	if w.abEvalFor == 0 {
		return
	}
	tick := ctx.Tick
	if tick >= w.abMedianNext {
		w.abMedianNext = tick + w.abEvalFor
		w.incomeMedians(tick)
		w.pruneSuspects(tick)
	}
	for _, p := range w.players {
		if p.sus == nil || p.role > RolePlayer {
			continue
		}
		if tick >= p.abNext {
			p.abNext = tick + w.abEvalFor
			w.evaluate(ctx, p)
		}
	}
	if tick%idleCheckEvery == 0 {
		for _, p := range w.players {
			if s := p.sus; s != nil {
				w.presenceDue(ctx, p, s)
			}
		}
	}
}

// evaluate updates p's score and gives the responses it reached.
func (w *World) evaluate(ctx *game.TickContext, p *Player) {
	s, a := p.sus, w.abCfg
	tick := ctx.Tick
	s.signals = s.tracker.Signals(tickMs(tick), w.incomeRatio(tick, p), a)
	s.score = s.score*antibot.Decay(tickMs(tick-s.lastEval), a) + antibot.Points(s.signals, a)
	s.lastEval = tick
	w.respond(ctx, p)
}

// respond gives every response p's score reached that this episode has not given yet,
// and lowers the level when the score fell under half of its threshold.
func (w *World) respond(ctx *game.TickContext, p *Player) {
	s, a := p.sus, w.abCfg
	for s.level > 0 && s.score < antibot.Threshold(s.level, a)/2 {
		s.level--
		if s.level < antibot.LevelPresence {
			s.failed = false
		}
	}
	target := antibot.Level(s.score, a)
	for s.level < target {
		next := s.level + 1
		if next == antibot.LevelSuspend && !s.failed {
			// Never suspended without a failed presence check: ask one if none is on.
			if s.check == nil && s.askAt == 0 {
				w.schedulePresence(ctx, s)
			}
			return
		}
		s.level = next
		switch next {
		case antibot.LevelLog:
			w.log.Warn("antibot: suspicious behaviour", "character", p.charID, "name", p.name,
				"score", int(s.score), "signals", signalArgs(s.signals))
			w.antibotAudit(ctx, p, "bot_suspect", "log", s)
		case antibot.LevelNotify:
			w.notifyGMs(p, systemMsg(msgGMBotSuspect, textParam("name", p.name), num("score", int(s.score))))
			w.antibotAudit(ctx, p, "bot_suspect", "notify", s)
		case antibot.LevelPresence:
			w.schedulePresence(ctx, s)
		case antibot.LevelSuspend:
			w.suspend(ctx, p)
		}
	}
}

// schedulePresence asks a check at a random moment of the next presence.delay_ms.
func (w *World) schedulePresence(ctx *game.TickContext, s *suspect) {
	if s.check != nil || s.askAt != 0 {
		return
	}
	delay := game.TicksFor(time.Duration(w.abCfg.Presence.DelayMs) * time.Millisecond)
	s.askAt = ctx.Tick + 1
	if delay > 0 {
		s.askAt += game.Tick(ctx.Rand.Uint64N(uint64(delay)))
	}
}

// presenceDue asks a due check when p can answer it safely and fails an expired one.
func (w *World) presenceDue(ctx *game.TickContext, p *Player, s *suspect) {
	tick := ctx.Tick
	if c := s.check; c != nil && tick >= c.deadline {
		s.check = nil
		w.presenceFailed(ctx, p, "timeout")
		return
	}
	if s.askAt == 0 || tick < s.askAt || s.check != nil {
		return
	}
	// Never in combat or on a no-logout tile: a question must not get anyone killed.
	if w.inCombat(tick, p) || w.m.Flags(p.pos)&world.FlagNoLogout != 0 {
		return
	}
	s.askAt = 0
	w.nextCheck++
	c := &presenceCheck{id: w.nextCheck,
		deadline: tick + game.TicksFor(time.Duration(w.abCfg.Presence.TimeoutMs)*time.Millisecond)}
	want := presenceColors[ctx.Rand.IntN(len(presenceColors))]
	c.question = "presence.question." + want
	ids := ctx.Rand.Perm(9) // option ids 1..9 in a random order: the id says nothing
	for i, k := range ctx.Rand.Perm(len(presenceColors)) {
		id := uint32(ids[i] + 1)
		color := presenceColors[k]
		if color == want {
			c.answer = id
		}
		c.options = append(c.options, &pb.DialogOption{OptionId: id,
			Text: &pb.LocalizedText{Key: "presence.option." + color}})
	}
	s.check = c
	w.sendPresence(p, c)
	w.antibotAudit(ctx, p, "presence_check", "sent", s)
}

func (w *World) sendPresence(p *Player, c *presenceCheck) {
	left := max(c.deadline-w.nowTick(), 0)
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PresenceCheck{PresenceCheck: &pb.PresenceCheck{
		CheckId: c.id, Question: &pb.LocalizedText{Key: c.question}, Options: c.options,
		TimeoutMs: uint32(left.Duration().Milliseconds()),
	}}})
}

// presenceAnswer runs a PresenceAnswer. Right or wrong, the reply is the same.
func (w *World) presenceAnswer(ctx *game.TickContext, p *Player, id, option uint32) {
	s := p.sus
	if s == nil || s.check == nil || s.check.id != id {
		return
	}
	c := s.check
	s.check = nil
	p.active(ctx.Tick, antibot.KindOther)
	p.emit(systemMsg(msgPresenceThanks))
	if option != c.answer {
		w.presenceFailed(ctx, p, "wrong")
		return
	}
	// Passed: the suspicion halves and the episode restarts from its new level.
	s.score /= 2
	s.failed = false
	s.level = min(s.level, antibot.Level(s.score, w.abCfg))
	w.antibotAudit(ctx, p, "presence_check", "passed", s)
}

// presenceFailed adds the failure points and tells the GMs; it never suspends by itself
// (the next evaluation does, if the score is past the threshold).
func (w *World) presenceFailed(ctx *game.TickContext, p *Player, why string) {
	s := p.sus
	s.failed = true
	s.score += w.abCfg.Presence.FailPoints
	w.notifyGMs(p, systemMsg(msgGMPresenceFail, textParam("name", p.name)))
	w.antibotAudit(ctx, p, "presence_check", "failed_"+why, s)
}

// suspend bans p's account for antibot.suspend_ms, through the admin goroutine like a
// GM's /ban (only player accounts: the actor ranks as a GM).
func (w *World) suspend(ctx *game.TickContext, p *Player) {
	if w.cfg.Admin == nil {
		return
	}
	dur := time.Duration(w.abCfg.SuspendMs) * time.Millisecond
	reason := fmt.Sprintf("automatic: suspected bot (score %d)", int(p.sus.score))
	w.nextJob++
	job := AdminJob{ID: w.nextJob, Kind: AdminBan, TargetName: p.name, ActorRole: RoleGM, Reason: reason,
		Until: ctx.Now.Add(dur)}
	job.Audit = AuditEntry{At: ctx.Now, ActorName: antibotActor, Action: "ban",
		Args: map[string]string{"duration": dur.String(), "reason": reason, "signals": signalArgs(p.sus.signals)}}
	w.jobs[job.ID] = pendingJob{kind: AdminBan, until: job.Until}
	w.queueAdmin(job)
	w.log.Warn("antibot: suspended", "character", p.charID, "name", p.name, "score", int(p.sus.score))
}

// cmdPresence: "/presence Name" asks an online player a presence check now (GM).
func (w *World) cmdPresence(ctx *game.TickContext, p *Player, args []string) bool {
	if len(args) == 0 {
		return false
	}
	name := strings.Join(args, " ")
	t := w.onlineByName(name)
	switch {
	case t == nil:
		p.emit(systemMsg(msgGMOffline, textParam("name", name)))
		w.audit(ctx, p, "presence_request", nil, map[string]string{"target": name}, auditOffline)
	case t.role >= p.role || t.sus == nil:
		p.emit(systemMsg(msgGMProtected, textParam("name", t.name)))
		w.audit(ctx, p, "presence_request", t, nil, AdminProtected)
	default:
		if t.sus.check == nil {
			t.sus.askAt = ctx.Tick // asked as soon as it is safe (out of combat)
		}
		p.emit(systemMsg(msgGMPresenceSent, textParam("name", t.name)))
		w.audit(ctx, p, "presence_request", t, nil, auditOK)
	}
	return true
}

func (w *World) notifyGMs(p *Player, m *pb.ServerMessage) {
	for _, o := range w.players {
		if o.role >= RoleGM && o != p {
			o.emit(m)
		}
	}
}

func (w *World) antibotAudit(ctx *game.TickContext, p *Player, action, result string, s *suspect) {
	if w.cfg.Admin == nil {
		return
	}
	w.queueAdmin(AdminJob{Kind: AdminAudit, Audit: AuditEntry{At: ctx.Now, ActorName: antibotActor, Action: action,
		TargetAccountID: p.accountID, TargetCharacterID: p.charID, TargetName: p.name, Result: result,
		Args: map[string]string{"score": strconv.Itoa(int(s.score)), "signals": signalArgs(s.signals)}}})
}

// signalArgs formats the signals for logs and audit entries ("regularity=0.95 ...").
func signalArgs(s antibot.Signals) string {
	out := ""
	for i, v := range s {
		if i > 0 {
			out += " "
		}
		out += antibot.Names[i] + "=" + strconv.FormatFloat(v, 'f', 2, 64)
	}
	return out
}

// incomeMedians computes, once per evaluation round, the median income per hour
// (experience and gold) of the online players of each level band.
func (w *World) incomeMedians(tick game.Tick) {
	clear(w.abMedians)
	if w.abMedians == nil {
		w.abMedians = map[int][2]float64{}
	}
	band := max(w.abCfg.Signals.Income.BandLevels, 1)
	byBand := map[int][2][]float64{}
	for _, p := range w.players {
		xp, gold, ok := w.incomeRates(tick, p)
		if !ok {
			continue
		}
		b := byBand[p.level/band]
		b[0], b[1] = append(b[0], xp), append(b[1], gold)
		byBand[p.level/band] = b
	}
	for k, b := range byBand {
		if len(b[0]) >= w.abCfg.Signals.Income.MinPeers {
			w.abMedians[k] = [2]float64{antibot.Median(b[0]), antibot.Median(b[1])}
		}
	}
}

// incomeRates is p's experience and gold per hour in its outlier window (at least 10
// minutes of it, else not yet comparable).
func (w *World) incomeRates(tick game.Tick, p *Player) (xp, gold float64, ok bool) {
	e := p.earn
	if e == nil || tick-e.start < game.TicksFor(10*time.Minute) {
		return 0, 0, false
	}
	h := (tick - e.start).Duration().Hours()
	return float64(e.xp) / h, float64(max(e.gold, 0)) / h, true
}

// incomeRatio is p's income over the median of its band (the larger of experience and
// gold), or 0 when there are too few peers.
func (w *World) incomeRatio(tick game.Tick, p *Player) float64 {
	m, ok := w.abMedians[p.level/max(w.abCfg.Signals.Income.BandLevels, 1)]
	xp, gold, ok2 := w.incomeRates(tick, p)
	if !ok || !ok2 {
		return 0
	}
	r := 0.0
	if m[0] > 0 {
		r = xp / m[0]
	}
	if m[1] > 0 {
		r = max(r, gold/m[1])
	}
	return r
}

// pruneSuspects forgets offline characters whose score has decayed to nothing (and that
// have no pending check), once per evaluation round.
func (w *World) pruneSuspects(tick game.Tick) {
	for id, s := range w.suspects {
		if w.byChar[id] == nil && s.check == nil && s.askAt == 0 &&
			s.score*antibot.Decay(tickMs(tick-s.lastEval), w.abCfg) < 1 {
			delete(w.suspects, id)
		}
	}
}
