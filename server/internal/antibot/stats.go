package antibot

import "sync/atomic"

// LevelNames are the label values of the response levels (LevelLog..LevelSuspend), as
// the metrics and docs/01 name them.
var LevelNames = [...]string{LevelLog: "log", LevelNotify: "notify", LevelPresence: "presence", LevelSuspend: "suspend"}

// Stats are the aggregate numbers of the bot detection for /metrics (T4.1, docs/01):
// no character in them. The game loop writes them (atomic stores and adds, constant
// cost); any goroutine may read them.
type Stats struct {
	// Suspects is how many tracked characters (online or not) are at each response
	// level (index LevelLog..LevelSuspend), recounted once per evaluation round.
	Suspects [LevelSuspend + 1]atomic.Int64
	// Presence checks: asked, answered right, answered wrong, and run out of time
	// (random ones and GM requests included).
	ChecksSent, ChecksPassed, ChecksFailed, ChecksExpired atomic.Int64
	// Suspensions is how many automatic suspensions were sent to the admin goroutine.
	Suspensions atomic.Int64
}
