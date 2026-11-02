package session

import (
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
)

// Chat (T1.13, docs/02-game-design.md "Chat"): local modes heard within a range on the
// same floor, a global channel heard by everyone online, and an anti-flood limit. The
// player's own text travels as is (Message.text); everything the server says is an
// i18n key.
const (
	msgChatTooLong    = "chat.too_long"
	msgChatFlood      = "chat.flood"
	msgChatMuted      = "chat.muted"
	msgChatGlobalWait = "chat.global_wait"
)

// initChat converts balance.yaml chat to ticks.
func (w *World) initChat() {
	c := w.cfg.Balance.Chat
	w.chatRefill = ticksFor(c.Flood.RefillMs)
	w.chatBurst = w.chatRefill * game.Tick(max(c.Flood.Burst-1, 0))
	w.chatMute = ticksFor(c.Flood.MuteMs) // at least one tick
	if c.GlobalIntervalMs > 0 {
		w.chatGlobal = ticksFor(c.GlobalIntervalMs)
	}
}

// say runs a Say. On the say channel, text that matches a spell's words casts it
// instead of being said (T1.9): it skips the chat limits on purpose, since casting has
// its own cooldowns and the gateway rate limit still applies. Otherwise the text is cleaned, checked against the
// length and flood limits and delivered to whoever hears that channel.
func (w *World) say(ctx *game.TickContext, p *Player, m *pb.Say) {
	ch := m.GetChannel()
	if ch == pb.ChatChannel_CHAT_CHANNEL_SAY {
		if s := w.spellWords[content.NormalizeWords(m.GetText())]; s != nil {
			w.cast(ctx, p, s, nil)
			return
		}
	}
	kind, ok := chatKinds[ch]
	if !ok {
		return
	}
	text := cleanChat(m.GetText())
	if text == "" {
		return
	}
	limit := w.cfg.Balance.Chat.MaxLength
	if limit <= 0 || limit > content.MaxChatLength {
		limit = content.MaxChatLength
	}
	if utf8.RuneCountInString(text) > limit {
		p.emit(systemMsg(msgChatTooLong, num("max", limit)))
		return
	}
	now := ctx.Tick
	if now < p.mutedUntil {
		p.emit(systemMsg(msgChatMuted, num("seconds", seconds(p.mutedUntil-now))))
		return
	}
	if ch == pb.ChatChannel_CHAT_CHANNEL_GLOBAL && now < p.globalReady {
		p.emit(systemMsg(msgChatGlobalWait, num("seconds", seconds(p.globalReady-now))))
		return
	}
	// GCRA: each message pushes the theoretical arrival time one refill ahead; more
	// than burst messages ahead of now is flooding.
	tat := max(p.chatTAT, now)
	if tat-now > w.chatBurst {
		p.mutedUntil = now + w.chatMute
		p.emit(systemMsg(msgChatFlood, num("seconds", seconds(w.chatMute))))
		return
	}
	p.chatTAT = tat + w.chatRefill

	msg := &pb.Message{Kind: kind, SpeakerId: p.id, SpeakerName: p.name, Body: &pb.Message_Text{Text: text}}
	out := &pb.ServerMessage{Message: &pb.ServerMessage_ChatMessage{ChatMessage: msg}}
	if ch == pb.ChatChannel_CHAT_CHANNEL_GLOBAL {
		p.globalReady = now + w.chatGlobal
		for _, o := range w.players {
			o.emit(out)
		}
		return
	}
	msg.Pos = posMsg(p.pos)
	r := w.chatRange(ch)
	w.eachInRect(int(p.pos.X)-r.X, int(p.pos.Y)-r.Y, int(p.pos.X)+r.X, int(p.pos.Y)+r.Y, p.pos.Z, func(o *Player) {
		o.emit(out)
	})
}

// chatKinds maps the channels a player can speak on to the kind listeners receive.
var chatKinds = map[pb.ChatChannel]pb.MessageKind{
	pb.ChatChannel_CHAT_CHANNEL_SAY:     pb.MessageKind_MESSAGE_KIND_SAY,
	pb.ChatChannel_CHAT_CHANNEL_YELL:    pb.MessageKind_MESSAGE_KIND_YELL,
	pb.ChatChannel_CHAT_CHANNEL_WHISPER: pb.MessageKind_MESSAGE_KIND_WHISPER,
	pb.ChatChannel_CHAT_CHANNEL_GLOBAL:  pb.MessageKind_MESSAGE_KIND_GLOBAL,
}

func (w *World) chatRange(ch pb.ChatChannel) content.ChatRange {
	r := w.cfg.Balance.Chat.Ranges
	switch ch {
	case pb.ChatChannel_CHAT_CHANNEL_WHISPER:
		return r.Whisper
	case pb.ChatChannel_CHAT_CHANNEL_YELL:
		return r.Yell
	default:
		return r.Say
	}
}

// cleanChat replaces control and invisible format characters (newlines, bidi
// overrides...) with spaces, collapses runs of spaces and trims the ends. Escaping
// markup is the client's job: it renders chat as text, never as HTML.
func cleanChat(s string) string {
	var b strings.Builder
	space := true // drops leading spaces
	for _, r := range s {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) || unicode.IsSpace(r) || r == utf8.RuneError {
			if !space {
				b.WriteByte(' ')
				space = true
			}
			continue
		}
		b.WriteRune(r)
		space = false
	}
	return strings.TrimRight(b.String(), " ")
}

// seconds rounds a tick count up to whole seconds (at least 1) for messages.
func seconds(t game.Tick) int {
	ms := int64(t) * game.TickDuration.Milliseconds()
	return int(max((ms+999)/1000, 1))
}
