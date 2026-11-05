package session

import (
	"cmp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// Player reports (T4.1, docs/02-game-design.md "Moderación"). A player reports another
// with "/report Name reason" or the report button (ReportPlayer). The server attaches
// the context itself (both positions and the reported player's last events, from a
// fixed ring per player), rate limits it per account and hands it to the admin
// goroutine, which stores it in the report queue (player_reports) and the audit log in
// one transaction. GMs list and close the queue with /reports and /closereport.

// Message keys of the reports.
const (
	msgReportSent      = "report.sent"
	msgReportUsage     = "report.usage"
	msgReportSelf      = "report.self"
	msgReportOffline   = "report.offline"
	msgReportUnseen    = "report.not_visible"
	msgReportReason    = "report.reason"
	msgReportTooFast   = "report.too_fast"
	msgReportSame      = "report.same_target"
	msgReportFailed    = "report.unavailable"
	msgReportNew       = "gm.report_new"
	msgReportsNone     = "gm.reports_none"
	msgReportsHeader   = "gm.reports"
	msgReportEntry     = "gm.report_entry"
	msgReportClosed    = "gm.report_closed"
	msgReportNotFound  = "gm.report_not_found"
	msgReportNotOpen   = "gm.report_not_open"
	maxReportsListed   = 10
	maxReportNoteRunes = 200
)

// AdminNotOpen is the result of an AdminCloseReport whose report was already closed
// (besides AdminOK and AdminNotFound).
const AdminNotOpen = "not_open"

// Recent event kinds (ReportEvent.Kind).
const (
	eventChat    = "chat"
	eventAttack  = "attack"
	eventKill    = "kill"
	eventDied    = "died"
	eventEconomy = "economy"
)

// recentEvent is one entry of a player's ring of recent events. Its strings are static
// or already allocated (chat text), so recording one does not allocate.
type recentEvent struct {
	tick game.Tick
	pos  world.Pos
	kind string
	ref  string
	item uint16
	n    int64
	seq  uint64 // order among events of the same tick, across both rings
}

// eventRing keeps the last content.MaxReportEvents events (ev[head] is the next slot).
type eventRing struct {
	ev   [content.MaxReportEvents]recentEvent
	head int
	n    int
}

func (r *eventRing) add(e recentEvent) {
	r.ev[r.head] = e
	r.head = (r.head + 1) % len(r.ev)
	r.n = min(r.n+1, len(r.ev))
}

// last returns the i-th newest event (1 = the newest), i in 1..r.n.
func (r *eventRing) last(i int) recentEvent { return r.ev[(r.head-i+len(r.ev))%len(r.ev)] }

// recordEvent adds an event to p's rings (constant cost, no allocation).
func (p *Player) recordEvent(tick game.Tick, kind, ref string, item uint16, n int64) {
	p.eventSeq++
	e := recentEvent{tick: tick, pos: p.pos, kind: kind, ref: ref, item: item, n: n, seq: p.eventSeq}
	if kind == eventChat {
		p.chats.add(e)
		return
	}
	p.recent.add(e)
}

// recentEvents returns up to n of p's newest events, oldest first: up to half of them
// chat lines (more if there are fewer other events), the rest the newest others.
func (p *Player) recentEvents(n int) []recentEvent {
	chats := min(p.chats.n, max(n/2, n-p.recent.n))
	others := min(p.recent.n, n-chats)
	out := make([]recentEvent, 0, chats+others)
	for i := chats; i >= 1; i-- {
		out = append(out, p.chats.last(i))
	}
	for i := others; i >= 1; i-- {
		out = append(out, p.recent.last(i))
	}
	slices.SortFunc(out, func(a, b recentEvent) int { return cmp.Compare(a.seq, b.seq) })
	return out
}

func (p *Player) recordEconomy(tick game.Tick, e *EconomyEntry) {
	n := int64(e.Count)
	if e.ItemID == 0 {
		n = e.Amount
	}
	p.recordEvent(tick, eventEconomy, e.Kind, e.ItemID, n)
}

// ReportPos is a position in a report's context.
type ReportPos struct {
	X int `json:"x"`
	Y int `json:"y"`
	Z int `json:"z"`
}

func reportPos(p world.Pos) ReportPos { return ReportPos{int(p.X), int(p.Y), int(p.Z)} }

// ReportEvent is one recent event of the reported player: AgoMs before the report.
// Kind chat: Ref is the text and N the chat channel; attack and kill: Ref is the
// monster; economy: Ref is the source, Item the item (0 = money) and N the signed count
// or amount.
type ReportEvent struct {
	AgoMs int64     `json:"ago_ms"`
	Kind  string    `json:"kind"`
	Ref   string    `json:"ref,omitempty"`
	Item  uint16    `json:"item,omitempty"`
	N     int64     `json:"n,omitempty"`
	Pos   ReportPos `json:"pos"`
}

// ReportContext is what the server attaches to a report (player_reports.context).
type ReportContext struct {
	ReporterPos ReportPos     `json:"reporter_pos"`
	TargetPos   ReportPos     `json:"target_pos"`
	TargetLevel int           `json:"target_level"`
	Events      []ReportEvent `json:"events"`
}

// ReportJob is a new report (AdminReport). The reporter and the reported player are
// the actor and the target of the job's audit entry.
type ReportJob struct {
	Reason  string
	Context ReportContext
}

// ReportSummary is an open report as /reports lists it.
type ReportSummary struct {
	ID       int64
	At       time.Time
	Reporter string
	Target   string
	Reason   string
}

// reportKey is one account reporting one character (balance reports.same_target_ms).
type reportKey struct {
	account int64
	target  int64
}

func (w *World) initReports() {
	r := w.cfg.Balance.Reports
	w.reportRefill = game.TicksFor(time.Duration(r.RefillMs) * time.Millisecond)
	w.reportBurst = game.Tick(max(r.Burst-1, 0)) * w.reportRefill
	w.reportSame = game.TicksFor(time.Duration(r.SameTargetMs) * time.Millisecond)
	w.reportTAT = map[int64]game.Tick{}
	w.reportLast = map[reportKey]game.Tick{}
}

// cmdReport: "/report Name reason". The name is the longest run of leading words that
// names an online player (names may have spaces).
//
// Every attempt past the usage check spends the account's report quota before the name
// is resolved, so asking whether names are online costs reports: past the burst,
// report.too_fast answers the same for anyone (T4.1). An invisible player p does not see
// is offline for this.
func (w *World) cmdReport(ctx *game.TickContext, p *Player, args []string) {
	if !w.chatAllowed(ctx, p) { // like a chat line, usage answers included
		return
	}
	if len(args) < 2 {
		p.emit(systemMsg(msgReportUsage))
		return
	}
	if !w.reportCharge(ctx, p) {
		return
	}
	for k := len(args) - 1; k >= 1; k-- {
		if t := w.onlineByName(strings.Join(args[:k], " ")); t != nil && (!t.invisible || p.Knows(t.id) || t == p) {
			w.report(ctx, p, t, strings.Join(args[k:], " "), false)
			return
		}
	}
	p.emit(systemMsg(msgReportOffline, textParam("name", args[0])))
}

// reportReasonMax is balance reports.max_reason, within the protocol's limit.
func (w *World) reportReasonMax() int {
	limit := w.cfg.Balance.Reports.MaxReason
	if limit <= 0 || limit > content.MaxReportReason {
		limit = content.MaxReportReason
	}
	return limit
}

// reportCharge spends one report of p's account (GCRA, like the chat flood limit); a
// spent quota answers report.too_fast and returns false.
func (w *World) reportCharge(ctx *game.TickContext, p *Player) bool {
	now := ctx.Tick
	tat := max(w.reportTAT[p.accountID], now)
	if tat-now > w.reportBurst {
		p.emit(systemMsg(msgReportTooFast, num("minutes", int((tat-now-w.reportBurst).Duration().Minutes())+1)))
		return false
	}
	w.reportTAT[p.accountID] = tat + w.reportRefill
	return true
}

// reportPlayer runs a ReportPlayer intent: only a player p sees.
func (w *World) reportPlayer(ctx *game.TickContext, p *Player, id uint32, reason string) {
	// Nothing here reveals anything (an unknown id is always not_visible, a known one is
	// a player the client sees): the quota is spent only when the report is filed.
	t := w.playerByID(id)
	if t == nil || !p.Knows(id) {
		p.emit(systemMsg(msgReportUnseen))
		return
	}
	w.report(ctx, p, t, reason, true)
}

// report files a report of t by p. With charge, the quota is spent here, once every
// check passed (the button); the command charged it before resolving the name.
func (w *World) report(ctx *game.TickContext, p, t *Player, reason string, charge bool) {
	reason = cleanChat(reason)
	limit := w.reportReasonMax()
	switch {
	case t == p:
		p.emit(systemMsg(msgReportSelf))
		return
	case reason == "" || utf8.RuneCountInString(reason) > limit:
		p.emit(systemMsg(msgReportReason, num("max", limit)))
		return
	case w.cfg.Admin == nil:
		p.emit(systemMsg(msgReportFailed))
		return
	}
	now := ctx.Tick
	key := reportKey{p.accountID, t.charID}
	if last, ok := w.reportLast[key]; ok && w.reportSame > 0 && now-last < w.reportSame {
		p.emit(systemMsg(msgReportSame, textParam("name", t.name)))
		return
	}
	if charge && !w.reportCharge(ctx, p) {
		return
	}
	w.reportLast[key] = now
	w.pruneReports(now)

	rc := ReportContext{ReporterPos: reportPos(p.pos), TargetPos: reportPos(t.pos), TargetLevel: t.level}
	evs := t.recentEvents(w.cfg.Balance.Reports.Events)
	rc.Events = make([]ReportEvent, 0, len(evs))
	for _, e := range evs { // oldest first
		rc.Events = append(rc.Events, ReportEvent{AgoMs: (now - e.tick).Duration().Milliseconds(), Kind: e.kind,
			Ref: e.ref, Item: e.item, N: e.n, Pos: reportPos(e.pos)})
	}
	a := w.auditEntry(ctx, p, "report", map[string]string{"reason": reason})
	a.TargetAccountID, a.TargetCharacterID, a.TargetName, a.Result = t.accountID, t.charID, t.name, auditOK
	w.queueAdmin(AdminJob{Kind: AdminReport, Audit: a, TargetName: t.name, Report: &ReportJob{Reason: reason, Context: rc}})
	p.emit(systemMsg(msgReportSent, textParam("name", t.name)))
	for _, o := range w.players {
		if o.role >= RoleGM && o != p {
			o.emit(systemMsg(msgReportNew, textParam("name", t.name), textParam("reporter", p.name), textParam("reason", reason)))
		}
	}
}

// pruneReports forgets rate limit entries that no longer limit anything, so the maps
// stay as small as the reports of the last same_target_ms.
func (w *World) pruneReports(now game.Tick) {
	if now < w.reportPrune {
		return
	}
	w.reportPrune = now + w.reportRefill
	for k, last := range w.reportLast {
		if now-last >= w.reportSame {
			delete(w.reportLast, k)
		}
	}
	for k, tat := range w.reportTAT {
		if tat <= now {
			delete(w.reportTAT, k)
		}
	}
}

// cmdReports: "/reports" lists the oldest open reports (up to maxReportsListed).
func (w *World) cmdReports(ctx *game.TickContext, p *Player, args []string) bool {
	if len(args) > 0 {
		return false
	}
	w.submitAdmin(ctx, p, AdminJob{Kind: AdminListReports, ActorRole: p.role}, "list_reports", nil)
	return true
}

// cmdCloseReport: "/closereport id resolution" closes an open report.
func (w *World) cmdCloseReport(ctx *game.TickContext, p *Player, args []string) bool {
	if len(args) < 2 {
		return false
	}
	id, err := strconv.ParseInt(args[0], 10, 64)
	note := cleanChat(strings.Join(args[1:], " "))
	if err != nil || id <= 0 || note == "" || utf8.RuneCountInString(note) > maxReportNoteRunes {
		return false
	}
	w.submitAdmin(ctx, p, AdminJob{Kind: AdminCloseReport, ActorRole: p.role, ReportID: id, Reason: note},
		"close_report", map[string]string{"id": args[0], "resolution": note})
	return true
}

// reportsDone answers a GM's /reports or /closereport.
func (w *World) reportsDone(ctx *game.TickContext, gm *Player, kind AdminJobKind, r AdminResult) {
	switch {
	case kind == AdminListReports && r.Result == AdminOK && len(r.Reports) == 0:
		gm.emit(systemMsg(msgReportsNone))
	case kind == AdminListReports && r.Result == AdminOK:
		gm.emit(systemMsg(msgReportsHeader, num("count", len(r.Reports))))
		for _, s := range r.Reports {
			gm.emit(systemMsg(msgReportEntry, num("id", int(s.ID)), textParam("name", s.Target),
				textParam("reporter", s.Reporter), textParam("reason", s.Reason),
				num("minutes", int(ctx.Now.Sub(s.At).Minutes()))))
		}
	case kind == AdminCloseReport && r.Result == AdminOK:
		gm.emit(systemMsg(msgReportClosed, num("id", int(r.ReportID))))
	case kind == AdminCloseReport && r.Result == AdminNotFound:
		gm.emit(systemMsg(msgReportNotFound, num("id", int(r.ReportID))))
	case kind == AdminCloseReport && r.Result == AdminNotOpen:
		gm.emit(systemMsg(msgReportNotOpen, num("id", int(r.ReportID))))
	default:
		gm.emit(systemMsg(msgGMFailed))
	}
}
