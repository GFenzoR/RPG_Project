package antibot

import (
	"math"
	"path/filepath"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
)

func repoConfig(t *testing.T) *content.AntiBot {
	t.Helper()
	b, err := content.LoadBalance(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	return &b.AntiBot
}

// A metronome of one kind of action is regular even with other actions in between; a
// varied pace is not.
func TestRegularity(t *testing.T) {
	cfg := repoConfig(t)
	var bot, person Tracker
	ms := int64(1000)
	jitter := []int64{0, 900, 2500, 400, 1700, 3100, 600}
	for i := range 400 {
		at := 1000 + int64(i)*2000
		bot.Action(at, KindSpell, false, cfg)
		bot.Action(at+jitter[i%len(jitter)]/3, KindItem, false, cfg) // irregular other actions
		ms += 2000 + jitter[i%len(jitter)]
		person.Action(ms, KindSpell, false, cfg)
	}
	if s := bot.Signals(1000+399*2000+1000, 0, cfg); s[Regularity] != 1 {
		t.Errorf("metronome regularity %.2f", s[Regularity])
	}
	if s := person.Signals(ms, 0, cfg); s[Regularity] != 0 {
		t.Errorf("varied pace regularity %.2f", s[Regularity])
	}
	var few Tracker
	few.Action(10, KindSpell, false, cfg)
	few.Action(20, KindSpell, false, cfg)
	if s := few.Signals(20, 0, cfg); s[Regularity] != 0 {
		t.Error("regularity before min_samples")
	}
}

// Heals always 100 ms after a hit are inhuman; slow or varied ones are not; a heal
// without a hit or outside the window is no sample.
func TestReaction(t *testing.T) {
	cfg := repoConfig(t)
	var bot, person Tracker
	for i := range 40 {
		at := int64(10_000 * (i + 1))
		bot.Hurt(at)
		bot.Heal(at+100, cfg)
		person.Hurt(at)
		person.Heal(at+700+int64(i%5)*300, cfg)
	}
	bot.Action(499_000, KindOther, false, cfg) // active (idle characters have no signals)
	person.Action(499_000, KindOther, false, cfg)
	if s := bot.Signals(500_000, 0, cfg); s[Reaction] < 0.99 {
		t.Errorf("bot reaction %.2f", s[Reaction])
	}
	if s := person.Signals(500_000, 0, cfg); s[Reaction] != 0 {
		t.Errorf("person reaction %.2f", s[Reaction])
	}
	var lone Tracker
	lone.Heal(100, cfg)
	lone.Hurt(1000)
	lone.Heal(1000+int64(cfg.Signals.Reaction.WindowMs)+1, cfg)
	if lone.reaction.n != 0 {
		t.Error("a heal without a recent hit counted")
	}
}

// The same loop of tiles again and again is a repeated route; a random walk is not.
func TestRoute(t *testing.T) {
	cfg := repoConfig(t)
	var loop, walk Tracker
	x, y := uint16(100), uint16(100)
	seed := uint32(7)
	for i := range 1000 {
		side := (i / 6) % 4
		lx := uint16(100 + []int{i % 6, 6, 6 - i%6, 0}[side])
		ly := uint16(100 + []int{0, i % 6, 6, 6 - i%6}[side])
		loop.Step(int64(i)*600, lx, ly, 7, uint8(side), cfg)
		seed = seed*1664525 + 1013904223
		switch seed >> 30 {
		case 0:
			x++
		case 1:
			x--
		case 2:
			y++
		default:
			y--
		}
		walk.Step(int64(i)*600, x, y, 7, uint8(seed>>30), cfg)
	}
	loop.Action(599_000, KindOther, false, cfg)
	walk.Action(599_000, KindOther, false, cfg)
	if s := loop.Signals(600_000, 0, cfg); s[Route] != 1 {
		t.Errorf("loop route %.2f", s[Route])
	}
	if s := walk.Signals(600_000, 0, cfg); s[Route] != 0 {
		t.Errorf("random walk route %.2f", s[Route])
	}
}

// Play without a pause counts from low_ms; a pause restarts it; the income ramps.
func TestSessionAndIncome(t *testing.T) {
	cfg := repoConfig(t)
	var tr Tracker
	step := int64(60_000)
	end := int64(cfg.Signals.Session.HighMs) + step
	for ms := step; ms <= end; ms += step {
		tr.Action(ms, KindOther, false, cfg)
	}
	if s := tr.Signals(end, 0, cfg); s[Session] != 1 {
		t.Errorf("16 h without a pause: %.2f", s[Session])
	}
	tr.Action(end+int64(cfg.PauseMs), KindOther, false, cfg) // a pause
	if s := tr.Signals(end+int64(cfg.PauseMs), 0, cfg); s[Session] != 0 {
		t.Errorf("after a pause: %.2f", s[Session])
	}
	in := cfg.Signals.Income
	if s := tr.Signals(end, in.RatioLow, cfg); s[Income] != 0 {
		t.Errorf("income at ratio_low %.2f", s[Income])
	}
	if s := tr.Signals(end, (in.RatioLow+in.RatioHigh)/2, cfg); math.Abs(s[Income]-0.5) > 1e-9 {
		t.Errorf("income halfway %.2f", s[Income])
	}
}

func TestScoreHelpers(t *testing.T) {
	cfg := repoConfig(t)
	if d := Decay(int64(cfg.HalfLifeMs), cfg); math.Abs(d-0.5) > 1e-9 {
		t.Errorf("decay over a half-life %.3f", d)
	}
	th := cfg.Thresholds
	for score, want := range map[float64]int{0: 0, th.Log: LevelLog, th.Notify: LevelNotify, th.Presence - 1: LevelNotify,
		th.Presence: LevelPresence, th.Suspend: LevelSuspend} {
		if got := Level(score, cfg); got != want {
			t.Errorf("Level(%v) = %d, want %d", score, got, want)
		}
	}
	if Points(Signals{1, 1, 1, 1, 1}, cfg) != Weights(cfg)[0]+Weights(cfg)[1]+Weights(cfg)[2]+Weights(cfg)[3]+Weights(cfg)[4] {
		t.Error("points of all ones")
	}
	if Median([]float64{5, 1, 3}) != 3 || Median([]float64{4, 1, 3, 2}) != 2.5 || Median(nil) != 0 {
		t.Error("median")
	}
}

// A held hotkey fires as soon as the cooldown allows: those actions are not intervals.
// And an idle character has no signals, however machine-like it was before.
func TestPacedAndIdle(t *testing.T) {
	cfg := repoConfig(t)
	var held Tracker
	for i := range 400 {
		held.Action(int64(1000+i*1000), KindItem, true, cfg)
	}
	if held.interval[KindItem].n != 0 {
		t.Errorf("%d paced intervals counted", held.interval[KindItem].n)
	}
	var bot Tracker
	for i := range 400 {
		bot.Action(int64(1000+i*2000), KindSpell, false, cfg)
	}
	last := int64(1000 + 399*2000)
	if s := bot.Signals(last+1000, 0, cfg); s[Regularity] != 1 {
		t.Fatalf("active metronome %.2f", s[Regularity])
	}
	if s := bot.Signals(last+int64(cfg.PauseMs), 0, cfg); s != (Signals{}) {
		t.Errorf("idle signals %v", s)
	}
}

// Each signal ages with its own evidence: after a hunt, chatting alone keeps the
// character active but scores nothing, and a new burst starts from zero.
func TestSignalsAgeWithTheirEvidence(t *testing.T) {
	cfg := repoConfig(t)
	var tr Tracker
	ms := int64(0)
	for i := range 600 { // a scripted hunt: metronome casts, instant heals, one loop
		ms = int64(i) * 1000
		tr.Action(ms, KindSpell, false, cfg)
		side := (i / 6) % 4
		tr.Step(ms, uint16(100+[]int{i % 6, 6, 6 - i%6, 0}[side]), uint16(100+[]int{0, i % 6, 6, 6 - i%6}[side]), 7, uint8(side), cfg)
		if i%10 == 0 {
			tr.Hurt(ms)
			tr.Heal(ms+100, cfg)
		}
	}
	if s := tr.Signals(ms+500, 0, cfg); s[Regularity] != 1 || s[Reaction] < 0.99 || s[Route] != 1 {
		t.Fatalf("during the hunt %v", s)
	}
	for k := 1; k <= 10; k++ { // then only a chat line every two minutes, for 20 min
		tr.Action(ms+int64(k)*120_000, KindChat, false, cfg)
	}
	if s := tr.Signals(ms+10*120_000+1000, 0, cfg); s != (Signals{}) {
		t.Fatalf("chatting after the hunt: %v", s)
	}
}

// One quick first reaction does not dominate the reaction signal at min_samples.
func TestReactionFirstSampleDoesNotDominate(t *testing.T) {
	cfg := repoConfig(t)
	var tr Tracker
	reactions := []int64{260, 420, 300, 560, 410, 380, 520, 450, 330, 600, 470, 390, 510, 440, 360}
	for i, r := range reactions {
		at := int64(i+1) * 10_000
		tr.Hurt(at)
		tr.Heal(at+r, cfg)
	}
	end := int64(len(reactions)+1) * 10_000
	tr.Action(end, KindOther, false, cfg) // playing (an idle character has no signals)
	if s := tr.Signals(end, 0, cfg); s[Reaction] >= 0.2 {
		t.Fatalf("reaction %.2f after a quick first heal", s[Reaction])
	}
}
