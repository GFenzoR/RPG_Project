package session_test

import (
	"strings"
	"testing"

	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// chatMap is an open 50x20 field, all on floor 7.
func chatMap(t *testing.T) *harness {
	t.Helper()
	rows := make([]string, 20)
	for i := range rows {
		rows[i] = strings.Repeat(".", 50)
	}
	return newHarness(t, worldtest.Map(t, 0, 0, 7, rows...))
}

// heard returns the chat texts (not system messages) cl received since the last take.
func heard(cl *fakeClient) []string {
	var out []string
	for _, m := range find(cl.take(), (*pb.ServerMessage).GetChatMessage) {
		if m.GetKind() != pb.MessageKind_MESSAGE_KIND_SYSTEM {
			out = append(out, m.GetText())
		}
	}
	return out
}

// sysKeys lists the system message keys of evs.
func sysKeys(evs []*pb.ServerMessage) []string {
	var out []string
	for _, m := range find(evs, (*pb.ServerMessage).GetChatMessage) {
		if m.GetKind() == pb.MessageKind_MESSAGE_KIND_SYSTEM {
			out = append(out, m.GetLocalized().GetKey())
		}
	}
	return out
}

func (h *harness) speak(cl *fakeClient, ch pb.ChatChannel, text string) []*pb.ServerMessage {
	h.input(cl, say(ch, text))
	h.sim.Step()
	return cl.take()
}

// Each local mode reaches its balance.yaml range (x 1/7/18, y 1/5/14) on the same
// floor; the global channel reaches everyone.
func TestChatRanges(t *testing.T) {
	h := chatMap(t)
	spk, sp := h.join("Speaker", at(10, 10))
	near, _ := h.join("Near", at(11, 11))     // 1 tile away
	mid, _ := h.join("Mid", at(17, 5))        // x 7, y 5
	far, _ := h.join("Far", at(28, 10))       // x 18
	beyond, _ := h.join("Beyond", at(29, 10)) // x 19
	all := []*fakeClient{spk, near, mid, far, beyond}
	for _, c := range all {
		c.take()
	}
	cases := []struct {
		ch   pb.ChatChannel
		text string
		want []bool // spk, near, mid, far, beyond
	}{
		{pb.ChatChannel_CHAT_CHANNEL_WHISPER, "psst", []bool{true, true, false, false, false}},
		{pb.ChatChannel_CHAT_CHANNEL_SAY, "hello", []bool{true, true, true, false, false}},
		{pb.ChatChannel_CHAT_CHANNEL_YELL, "HEY", []bool{true, true, true, true, false}},
		{pb.ChatChannel_CHAT_CHANNEL_GLOBAL, "anyone?", []bool{true, true, true, true, true}},
	}
	for _, tc := range cases {
		h.input(spk, say(tc.ch, tc.text))
		h.sim.Step()
		for i, c := range all {
			got := heard(c)
			if hear := len(got) == 1 && got[0] == tc.text; hear != tc.want[i] {
				t.Errorf("%v %q: listener %d heard %v, want hearing=%v", tc.ch, tc.text, i, got, tc.want[i])
			}
		}
	}
	// The message names the speaker and, for local modes, where it was said.
	h.input(spk, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "again"))
	h.sim.Step()
	msgs := find(near.take(), (*pb.ServerMessage).GetChatMessage)
	if len(msgs) != 1 || msgs[0].GetSpeakerName() != "Speaker" || msgs[0].GetSpeakerId() != sp.ID() ||
		msgs[0].GetKind() != pb.MessageKind_MESSAGE_KIND_SAY || msgs[0].GetPos().GetX() != 10 {
		t.Fatalf("say message = %v", msgs)
	}
}

// Text is cleaned (controls and newlines become one space, ends trimmed), empty text
// is dropped and more than max_length characters is refused with chat.too_long.
func TestChatTextRules(t *testing.T) {
	h := chatMap(t)
	spk, _ := h.join("Speaker", at(10, 10))
	spk.take()
	h.input(spk, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "  hi\n\tthere\u202e  "))
	h.sim.Step()
	if got := heard(spk); len(got) != 1 || got[0] != "hi there" {
		t.Fatalf("cleaned text = %q", got)
	}
	if evs := h.speak(spk, pb.ChatChannel_CHAT_CHANNEL_SAY, " \n "); len(evs) != 0 {
		t.Fatalf("blank text produced %v", kinds(evs))
	}
	// 255 runes (multi-byte) pass, 256 do not.
	if got := find(h.speak(spk, pb.ChatChannel_CHAT_CHANNEL_SAY, strings.Repeat("ñ", 255)), (*pb.ServerMessage).GetChatMessage); len(got) != 1 || got[0].GetText() == "" {
		t.Fatalf("255 characters refused: %v", got)
	}
	if evs := h.speak(spk, pb.ChatChannel_CHAT_CHANNEL_SAY, strings.Repeat("a", 256)); !hasKey(evs, "chat.too_long") {
		t.Fatalf("256 characters: %v", sysKeys(evs))
	}
	// Markup travels as plain text: escaping it is the client's job.
	h.input(spk, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "<b>x</b>"))
	h.sim.Step()
	if got := heard(spk); len(got) != 1 || got[0] != "<b>x</b>" {
		t.Fatalf("markup = %q", got)
	}
}

// Anti-flood: 5 messages in a burst pass, the 6th mutes for 10 s (chat.flood); while
// muted every message is refused (chat.muted). The bucket refills one every 2 s.
func TestChatFlood(t *testing.T) {
	h := chatMap(t)
	spk, _ := h.join("Speaker", at(10, 10))
	lis, _ := h.join("Listener", at(11, 10))
	spk.take()
	lis.take()
	for range 5 {
		h.input(spk, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "spam"))
	}
	h.input(spk, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "spam"))
	h.sim.Step()
	evs := spk.take()
	if got := heard(lis); len(got) != 5 {
		t.Fatalf("listener heard %d messages, want 5", len(got))
	}
	if !hasKey(evs, "chat.flood") {
		t.Fatalf("6th message: %v", sysKeys(evs))
	}
	h.sim.RunTicks(10000/50 - 2)
	if evs := h.speak(spk, pb.ChatChannel_CHAT_CHANNEL_SAY, "still?"); !hasKey(evs, "chat.muted") {
		t.Fatalf("while muted: %v", sysKeys(evs))
	}
	h.sim.RunTicks(2)
	h.speak(spk, pb.ChatChannel_CHAT_CHANNEL_SAY, "back")
	if got := heard(lis); len(got) != 1 || got[0] != "back" {
		t.Fatalf("after the mute heard %v", got)
	}
	// Spaced out at the refill rate, any number of messages pass.
	for range 10 {
		h.sim.RunTicks(2000 / 50)
		if evs := h.speak(spk, pb.ChatChannel_CHAT_CHANNEL_SAY, "slow"); len(sysKeys(evs)) != 0 {
			t.Fatalf("paced message refused: %v", sysKeys(evs))
		}
	}
}

// The global channel has its own interval (10 s) between two messages of a player.
func TestChatGlobalInterval(t *testing.T) {
	h := chatMap(t)
	spk, _ := h.join("Speaker", at(10, 10))
	spk.take()
	h.speak(spk, pb.ChatChannel_CHAT_CHANNEL_GLOBAL, "first")
	if evs := h.speak(spk, pb.ChatChannel_CHAT_CHANNEL_GLOBAL, "second"); !hasKey(evs, "chat.global_wait") {
		t.Fatalf("second global: %v", sysKeys(evs))
	}
	// Local chat is not affected.
	if evs := h.speak(spk, pb.ChatChannel_CHAT_CHANNEL_SAY, "local"); len(sysKeys(evs)) != 0 {
		t.Fatalf("local after global: %v", sysKeys(evs))
	}
	h.sim.RunTicks(10000 / 50)
	if evs := h.speak(spk, pb.ChatChannel_CHAT_CHANNEL_GLOBAL, "third"); len(sysKeys(evs)) != 0 {
		t.Fatalf("global after the interval: %v", sysKeys(evs))
	}
}
