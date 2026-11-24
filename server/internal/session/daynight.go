package session

import (
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/GFenzoR/RPG_Project/livingworld/server/daynight"

	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
)

// Glue to the living world's clock (livingworld/README.md "Día y noche"): the one place of
// the server that imports livingworld/server/daynight. The game loop owns the clock; the
// world time goes to a player at login (join, right after the Welcome), to everyone every
// sync_seconds and at once after a staff /time. It is purely visual: no rule reads it.

// DayNightCycle is the `cycle` block of data/livingworld/daynight.yaml.
type DayNightCycle = daynight.Cycle

// LoadDayNight reads <dataDir>/livingworld/daynight.yaml; nil, nil when there is none (no
// WorldClock is sent: the client stays at noon).
func LoadDayNight(dataDir string) (*DayNightCycle, error) {
	c, err := daynight.LoadConfig(filepath.Join(dataDir, "livingworld", "daynight.yaml"))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("living world: %w", err)
	}
	return &c, nil
}

// dayNight is the World's part of the day and night: the clock, nil without one.
type dayNight struct{ *daynight.Clock }

func (w *World) initDayNight() {
	if w.cfg.DayNight == nil {
		return
	}
	w.sky.Clock = daynight.New(*w.cfg.DayNight, int(game.TickDuration.Milliseconds()), w.cfg.DayNightEpochMs)
}

// worldClockMsg is the WorldClock at tick.
func (w *World) worldClockMsg(tick game.Tick) *pb.ServerMessage {
	t := w.sky.At(int64(tick))
	return &pb.ServerMessage{Message: &pb.ServerMessage_WorldClock{WorldClock: &pb.WorldClock{
		Day:     uint32(t.Day),
		CycleMs: uint32(t.CycleMs),
		Rate:    uint32(t.Rate),
	}}}
}

// dayNightJoin sends a player that just joined the world time.
func (w *World) dayNightJoin(tick game.Tick, p *Player) {
	if w.sky.Clock != nil {
		p.emit(w.worldClockMsg(tick))
	}
}

// flushDayNight sends everyone the world time when it is due (flushSystem).
func (w *World) flushDayNight(tick game.Tick) {
	if w.sky.Clock == nil || !w.sky.SyncDue(int64(tick)) {
		return
	}
	msg := w.worldClockMsg(tick)
	for _, p := range w.players {
		p.emit(msg)
	}
}

// WorldTime is the world's time at tick (tests and staff tools); ok is false without a
// day and night.
func (w *World) WorldTime(tick game.Tick) (t daynight.Time, phase string, ok bool) {
	if w.sky.Clock == nil {
		return daynight.Time{}, "", false
	}
	t = w.sky.At(int64(tick))
	return t, w.sky.Cycle().Phase(t).String(), true
}

// Message keys of /time, by phase.
var msgGMTime = map[daynight.Phase]string{
	daynight.Dawn:  "gm.time_dawn",
	daynight.Day:   "gm.time_day",
	daynight.Dusk:  "gm.time_dusk",
	daynight.Night: "gm.time_night",
}

// cmdTime is the staff's /time (docs/16 "Día y noche"):
//
//	/time                        tells the world time
//	/time dawn|morning|noon|afternoon|dusk|night|midnight
//	/time <minute>               minute of the cycle (0 = start of dawn)
//	/time moon <phase>           0 new moon .. lunar_days/2 full moon
//	/time speed <rate>           world minutes per real minute (0 stops it, up to 600)
//
// Every player gets the new time at once.
func (w *World) cmdTime(ctx *game.TickContext, p *Player, args []string) bool {
	if w.sky.Clock == nil {
		return false
	}
	c := w.sky.Cycle()
	tick := int64(ctx.Tick)
	switch {
	case len(args) == 0:
	case len(args) == 1:
		word := strings.ToLower(args[0])
		if ms, ok := c.PhaseStart(word); ok {
			w.sky.Set(tick, ms)
		} else if m, err := strconv.Atoi(word); err == nil && m >= 0 && int64(m)*60_000 < c.CycleMs() {
			w.sky.Set(tick, int64(m)*60_000)
		} else {
			return false
		}
	case len(args) == 2 && strings.EqualFold(args[0], "moon"):
		ph, err := strconv.Atoi(args[1])
		if err != nil || ph < 0 || ph >= c.LunarDays {
			return false
		}
		w.sky.SetMoon(tick, ph)
	case len(args) == 2 && strings.EqualFold(args[0], "speed"):
		r, err := strconv.Atoi(args[1])
		if err != nil || r < 0 || r > daynight.MaxRate {
			return false
		}
		w.sky.SetRate(tick, int64(r))
	default:
		return false
	}
	t := w.sky.At(tick)
	p.emit(systemMsg(msgGMTime[c.Phase(t)],
		num("minute", int(t.CycleMs/60_000)), num("cycle", int(c.CycleMs()/60_000)),
		num("moon", c.MoonPhase(t)), num("lunar", c.LunarDays), num("rate", int(t.Rate))))
	if len(args) > 0 {
		w.audit(ctx, p, "set_time", nil, map[string]string{"args": strings.Join(args, " ")}, auditOK)
	}
	return true
}
