package session

import (
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
	msgPresenceThanks  = "presence.thanks"
	msgGMBotSuspect    = "gm.bot_suspect"
	msgGMPresenceFail  = "gm.presence_failed"
	msgGMPresenceSent  = "gm.presence_sent"
	msgGMPresenceDefer = "gm.presence_deferred"
	antibotActor       = "system:antibot"
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
	// failed: a presence check failed in this episode; askedAt: when this episode's check
	// was asked (0 = none). A suspension needs one of them (see respond).
	failed  bool
	askedAt game.Tick
	// askAt is when a presence check is due (0 = none), askRandom whether it is a random
	// one (not a response to the score), and check the one waiting for an answer.
	askAt     game.Tick
	askRandom bool
	check     *presenceCheck
	// deferredSince: since when a due check could not be asked (combat, no-logout tile,
	// idle); deferWarned: the GMs were told it is being dodged.
	deferredSince game.Tick
	deferWarned   bool
}

type presenceCheck struct {
	id       uint32
	answer   uint32
	question string
	options  []*pb.DialogOption
	// left is the time to answer that is left; it only runs while the character is
	// online and active, so being away is never a failure by itself.
	left   game.Tick
	random bool
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
	if w.abEvalFor == 0 || p.role > RolePlayer { // staff is not evaluated
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
		w.sendPresence(p, c)
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
	// Random checks for anyone who plays, suspected or not: a check alone tells nothing
	// about the score, and failing a random one has no effect.
	pr := w.abCfg.Presence
	if pr.RandomPerHour > 0 && s.level < antibot.LevelPresence && s.check == nil && s.askAt == 0 &&
		s.tracker.Active(tickMs(tick), w.abCfg) &&
		ctx.Rand.Float64() < pr.RandomPerHour*float64(w.abCfg.EvalEveryMs)/3_600_000 {
		w.schedulePresence(ctx, s, true)
	}
}

// respond gives every response p's score reached that this episode has not given yet,
// and lowers the level when the score fell under half of its threshold.
func (w *World) respond(ctx *game.TickContext, p *Player) {
	s, a := p.sus, w.abCfg
	for s.level > 0 && s.score < antibot.Threshold(s.level, a)/2 {
		s.level--
		if s.level < antibot.LevelPresence {
			s.failed, s.askedAt, s.deferredSince, s.deferWarned = false, 0, 0, false
		}
	}
	target := antibot.Level(s.score, a)
	for s.level < target {
		next := s.level + 1
		// A suspension needs, in this episode, a failed presence check or one asked at
		// least presence.confirm_ms ago with the score still this high: answering a check
		// proves someone (or something) answered, not that nobody is botting.
		confirm := game.TicksFor(time.Duration(a.Presence.ConfirmMs) * time.Millisecond)
		if next == antibot.LevelSuspend && !s.failed && (s.askedAt == 0 || ctx.Tick-s.askedAt < confirm) {
			if s.askedAt == 0 && s.check == nil && (s.askAt == 0 || s.askRandom) {
				s.askAt = 0
				w.schedulePresence(ctx, s, false)
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
			if s.askAt != 0 && s.askRandom { // a due random check becomes this one
				s.askAt = 0
			}
			w.schedulePresence(ctx, s, false)
		case antibot.LevelSuspend:
			w.suspend(ctx, p)
		}
	}
}

// schedulePresence asks a check at a random moment of the next presence.delay_ms.
func (w *World) schedulePresence(ctx *game.TickContext, s *suspect, random bool) {
	if s.check != nil || s.askAt != 0 {
		return
	}
	s.askRandom = random
	delay := game.TicksFor(time.Duration(w.abCfg.Presence.DelayMs) * time.Millisecond)
	s.askAt = ctx.Tick + 1
	if delay > 0 {
		s.askAt += game.Tick(ctx.Rand.Uint64N(uint64(delay)))
	}
}

// presenceDue (once a second) runs the clock of a pending check while p is active, fails
// it when it runs out, and asks a due check when p can answer it safely.
func (w *World) presenceDue(ctx *game.TickContext, p *Player, s *suspect) {
	tick := ctx.Tick
	active := s.tracker.Active(tickMs(tick), w.abCfg)
	if c := s.check; c != nil {
		if active {
			c.left -= min(c.left, idleCheckEvery)
		}
		if c.left == 0 {
			s.check = nil
			w.presenceFailed(ctx, p, c.random, "timeout")
		}
		return
	}
	if s.askAt == 0 || tick < s.askAt {
		return
	}
	// Never in combat or on a no-logout tile (a question must not get anyone killed), and
	// only to someone who is playing (it would be answered by nobody).
	if w.inCombat(tick, p) || w.m.Flags(p.pos)&world.FlagNoLogout != 0 || !active {
		if s.askRandom {
			return
		}
		if s.deferredSince == 0 {
			s.deferredSince = tick
		}
		// Dodged for long (always fighting, or living on a no-logout tile): a GM decides.
		if !s.deferWarned && tick-s.deferredSince >= game.TicksFor(time.Duration(w.abCfg.Presence.DeferAlertMs)*time.Millisecond) {
			s.deferWarned = true
			w.notifyGMs(p, systemMsg(msgGMPresenceDefer, textParam("name", p.name)))
			w.antibotAudit(ctx, p, "presence_check", "deferred", s)
		}
		return
	}
	s.askAt = 0
	w.nextCheck++
	c := &presenceCheck{id: w.nextCheck, random: s.askRandom,
		left: game.TicksFor(time.Duration(w.abCfg.Presence.TimeoutMs) * time.Millisecond)}
	if !c.random {
		s.askedAt, s.deferredSince = tick, 0
	}
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
	w.antibotAudit(ctx, p, "presence_check", checkResult(c.random, "sent"), s)
}

// checkResult is the audit result of a check event: random checks are marked apart.
func checkResult(random bool, r string) string {
	if random {
		return "random_" + r
	}
	return r
}

func (w *World) sendPresence(p *Player, c *presenceCheck) {
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PresenceCheck{PresenceCheck: &pb.PresenceCheck{
		CheckId: c.id, Question: &pb.LocalizedText{Key: c.question}, Options: c.options,
		TimeoutMs: uint32(c.left.Duration().Milliseconds()),
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
		w.presenceFailed(ctx, p, c.random, "wrong")
		return
	}
	// Passed: it is recorded, and nothing else changes. A script can answer a question
	// too (the texts are public), so a right answer never clears the suspicion.
	w.antibotAudit(ctx, p, "presence_check", checkResult(c.random, "passed"), s)
}

// presenceFailed records a failure. A random check's failure has no effect. A response
// check's adds presence.fail_points and tells the GMs, but never past the suspension
// threshold by itself: only a score that was already there suspends.
func (w *World) presenceFailed(ctx *game.TickContext, p *Player, random bool, why string) {
	s := p.sus
	if random {
		w.antibotAudit(ctx, p, "presence_check", checkResult(true, "failed_"+why), s)
		return
	}
	s.failed = true
	if sus := w.abCfg.Thresholds.Suspend; s.score < sus {
		s.score = min(s.score+w.abCfg.Presence.FailPoints, sus-1)
	} else {
		s.score += w.abCfg.Presence.FailPoints
	}
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
	reason := "antibot" // shown as is at login: a neutral code, the details are in the audit log
	w.nextJob++
	job := AdminJob{ID: w.nextJob, Kind: AdminBan, TargetName: p.name, ActorRole: RoleGM, Reason: reason,
		Until: ctx.Now.Add(dur)}
	job.Audit = AuditEntry{At: ctx.Now, ActorName: antibotActor, Action: "ban",
		Args: map[string]string{"duration": dur.String(), "reason": reason, "score": strconv.Itoa(int(p.sus.score)),
			"signals": signalArgs(p.sus.signals)}}
	w.jobs[job.ID] = pendingJob{kind: AdminBan, until: job.Until, system: true}
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
	if t != nil && t.invisible && !p.Knows(t.id) {
		t = nil // like /report: an unseen invisible player is not online for this
	}
	switch {
	case t == nil:
		p.emit(systemMsg(msgGMOffline, textParam("name", name)))
		w.audit(ctx, p, "presence_request", nil, map[string]string{"target": name}, auditOffline)
	case t.role >= p.role || t.sus == nil:
		p.emit(systemMsg(msgGMProtected, textParam("name", t.name)))
		w.audit(ctx, p, "presence_request", t, nil, AdminProtected)
	default:
		if t.sus.check == nil {
			t.sus.askAt, t.sus.askRandom = ctx.Tick, true // as soon as it is safe; no effect on the score
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
		if p.sus == nil { // staff is not a peer
			continue
		}
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
		if w.byChar[id] == nil && s.check == nil &&
			s.score*antibot.Decay(tickMs(tick-s.lastEval), w.abCfg) < 1 {
			delete(w.suspects, id)
		}
	}
}
