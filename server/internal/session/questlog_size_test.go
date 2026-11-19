package session_test

import (
	"path/filepath"
	"testing"

	"google.golang.org/protobuf/proto"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/quest"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
)

// maxQuestLogBytes bounds the whole QuestLog of data/quests (docs/07 "Diario de misiones"):
// it goes in full with every kill a kill step counts, so at a kill every 3 s it costs a
// third of it per second, against the 4 KB/s of a player. A catalog that outgrows it
// sends only the entry that changed (a delta) instead of the whole log.
const maxQuestLogBytes = 4096

// The QuestLog of a character with every quest of data/ started, each at its biggest
// step (the longest id and text, a kill step's counts one short of done), stays within
// maxQuestLogBytes.
func TestQuestLogSize(t *testing.T) {
	quests, err := content.LoadQuests(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	h := dataHarness(t)
	storage := map[string]int64{}
	for id, q := range quests {
		best, size := 0, -1
		for i, s := range q.Steps {
			n := len(s.ID) + len(s.Description)
			if s.CompleteWhen.Kill != nil {
				n += 4 // kills and kills_needed
			}
			if n > size {
				best, size = i, n
			}
		}
		storage["quest."+id] = int64(quest.InProgress)
		storage["quest."+id+".step"] = int64(best)
		if k := q.Steps[best].CompleteWhen.Kill; k != nil {
			storage["quest."+id+".kills"] = int64(k.Count - 1)
		}
	}
	c := session.Character{ID: 7301, AccountID: 7301, Name: "Diarist", Vocation: "guardian", Level: 50, Health: 1000,
		Mana: 100, Storage: storage}
	cl, _ := h.joinChar(c)
	logs := questLogs(cl.take())
	if len(logs) != 1 {
		t.Fatalf("%d QuestLogs in the login tick, want 1", len(logs))
	}
	l := logs[0]
	if len(l.GetEntries()) != len(quests) {
		t.Fatalf("%d entries for %d quests", len(l.GetEntries()), len(quests))
	}
	for _, e := range l.GetEntries() {
		if e.GetState() != pb.QuestLogState_QUEST_LOG_STATE_ACTIVE || e.GetStepText() == "" {
			t.Fatalf("entry %v, want an active step", e)
		}
	}
	n := proto.Size(l)
	t.Logf("%d quests, QuestLog %d B (%d B per entry)", len(quests), n, n/len(quests))
	if n > maxQuestLogBytes {
		t.Fatalf("QuestLog of %d B > %d B: send only the entry that changed (docs/07 \"Diario de misiones\")", n,
			maxQuestLogBytes)
	}
}
