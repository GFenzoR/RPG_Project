package authtest

import (
	"strings"
	"sync"

	"github.com/GFenzoR/RPG_Project/server/internal/mail"
)

// Sent is one email the Mailbox received.
type Sent struct {
	Kind mail.Kind
	To   string
	Lang string
	Link string
}

// Token is the token of the link (after "#token=").
func (s Sent) Token() string {
	_, t, _ := strings.Cut(s.Link, "#token=")
	return t
}

// Mailbox is an in-memory auth.Emailer that keeps every email, in es and en.
type Mailbox struct {
	mu   sync.Mutex
	sent []Sent
	// Err, if set, is returned by Send (e.g. mail.ErrQueueFull).
	Err error
}

// Send implements auth.Emailer.
func (m *Mailbox) Send(kind mail.Kind, to, lang, link string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.Err != nil {
		return m.Err
	}
	m.sent = append(m.sent, Sent{Kind: kind, To: to, Lang: lang, Link: link})
	return nil
}

// Lang implements auth.Emailer.
func (m *Mailbox) Lang(lang string) string {
	if lang == "en" || lang == "es" {
		return lang
	}
	return mail.DefaultLang
}

// Sent returns every email so far.
func (m *Mailbox) Sent() []Sent {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]Sent(nil), m.sent...)
}

// Last returns the newest email, if any.
func (m *Mailbox) Last() (Sent, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.sent) == 0 {
		return Sent{}, false
	}
	return m.sent[len(m.sent)-1], true
}
