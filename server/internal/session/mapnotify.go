package session

import (
	"strconv"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/game"
)

// GM notices of the map submission portal (T4.5, docs/04 "Moderación"): when a player
// sends a patch, the online gm and admin characters get a system message with its number
// and its title (already cleaned by the HTTP API). Nothing else about the author goes in
// it. The HTTP handler never touches the world: it enqueues MapSubmitted.
//
// A burst is grouped: after a notice, the next mapNoticeEvery only counts, and then one
// message says how many arrived and the number of the latest.

// Message keys of the map notices.
const (
	msgGMMapSubmission  = "gm.map_submission"  // {id} {title}
	msgGMMapSubmissions = "gm.map_submissions" // {count} {id}: grouped, id is the latest
)

// mapNoticeEvery is the least time between two map notices.
const mapNoticeEvery = time.Minute

// mapTitleMax bounds the title of a notice: keep it equal to httpapi.MapTitleMax (the
// API rejects longer titles; this is only a second guard).
const mapTitleMax = 80

// mapNotice is the grouping state: when the next notice may go and what it holds.
type mapNotice struct {
	next   game.Tick
	count  int
	lastID int64
}

// MapSubmitted returns the command the HTTP API enqueues after storing submission id.
func (w *World) MapSubmitted(id int64, title string) game.Command {
	if r := []rune(title); len(r) > mapTitleMax {
		title = string(r[:mapTitleMax])
	}
	return game.CommandFunc(func(ctx *game.TickContext) { w.mapSubmitted(ctx.Tick, id, title) })
}

func (w *World) mapSubmitted(tick game.Tick, id int64, title string) {
	n := &w.mapNote
	if n.count == 0 && tick >= n.next {
		w.notifyGMs(nil, systemMsg(msgGMMapSubmission, textParam("id", strconv.FormatInt(id, 10)), textParam("title", title)))
		n.next = tick + game.TicksFor(mapNoticeEvery)
		return
	}
	n.count++
	n.lastID = max(n.lastID, id)
}

// flushMapNotices sends the grouped notice when it is due (a comparison per tick).
func (w *World) flushMapNotices(tick game.Tick) {
	n := &w.mapNote
	if n.count == 0 || tick < n.next {
		return
	}
	w.notifyGMs(nil, systemMsg(msgGMMapSubmissions, num("count", n.count), textParam("id", strconv.FormatInt(n.lastID, 10))))
	n.next, n.count, n.lastID = tick+game.TicksFor(mapNoticeEvery), 0, 0
}
