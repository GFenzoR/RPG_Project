package mail

import (
	"bufio"
	"context"
	"errors"
	"io"
	"log/slog"
	"mime"
	"mime/multipart"
	"net"
	"net/mail"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
)

// smtpSink is a minimal SMTP server for tests: it accepts one message per connection
// and records its envelope and data. starttls says whether it advertises STARTTLS
// (it cannot actually do TLS).
type smtpSink struct {
	ln       net.Listener
	starttls bool
	rcptCode string // reply to RCPT TO; default 250

	mu   sync.Mutex
	got  []sunk
	done chan struct{}
}

type sunk struct{ from, to, data string }

func newSink(t *testing.T) *smtpSink {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &smtpSink{ln: ln, done: make(chan struct{}, 16)}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go s.serve(c)
		}
	}()
	return s
}

func (s *smtpSink) port() int { return s.ln.Addr().(*net.TCPAddr).Port }

func (s *smtpSink) serve(c net.Conn) {
	defer func() { _ = c.Close() }()
	r := bufio.NewReader(c)
	say := func(l string) { _, _ = io.WriteString(c, l+"\r\n") }
	say("220 sink")
	var cur sunk
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return
		}
		cmd := strings.ToUpper(strings.TrimSpace(line))
		switch {
		case strings.HasPrefix(cmd, "EHLO"):
			if s.starttls {
				say("250-sink")
				say("250 STARTTLS")
			} else {
				say("250 sink")
			}
		case strings.HasPrefix(cmd, "MAIL FROM:"):
			cur.from = strings.TrimSpace(line[10:])
			say("250 ok")
		case strings.HasPrefix(cmd, "RCPT TO:"):
			cur.to = strings.TrimSpace(line[8:])
			if s.rcptCode != "" {
				say(s.rcptCode + " no")
				continue
			}
			say("250 ok")
		case cmd == "DATA":
			say("354 go")
			var b strings.Builder
			for {
				l, err := r.ReadString('\n')
				if err != nil {
					return
				}
				if l == ".\r\n" {
					break
				}
				b.WriteString(l)
			}
			cur.data = b.String()
			s.mu.Lock()
			s.got = append(s.got, cur)
			s.mu.Unlock()
			say("250 queued")
			s.done <- struct{}{}
		case cmd == "QUIT":
			say("221 bye")
			return
		default:
			say("502 no")
		}
	}
}

func testTemplates(t *testing.T) *Templates {
	t.Helper()
	tpl, err := LoadTemplates(filepath.Join("..", "..", "..", "i18n"))
	if err != nil {
		t.Fatal(err)
	}
	return tpl
}

func TestSMTPSendsMultipartMessage(t *testing.T) {
	sink := newSink(t)
	m, err := NewSMTP(SMTPConfig{Host: "127.0.0.1", Port: sink.port(), From: "RPG <noreply@game.example>", Security: None})
	if err != nil {
		t.Fatal(err)
	}
	msg, err := testTemplates(t).Render(KindVerify, "en", "ana@example.org", "https://game.example/verify?lang=en#token=abc")
	if err != nil {
		t.Fatal(err)
	}
	msg.Date = time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	if err := m.Send(context.Background(), msg); err != nil {
		t.Fatal(err)
	}
	got := sink.got[0]
	if got.from != "<noreply@game.example>" || got.to != "<ana@example.org>" {
		t.Fatalf("envelope %q -> %q", got.from, got.to)
	}
	parsed, err := mail.ReadMessage(strings.NewReader(got.data))
	if err != nil {
		t.Fatal(err)
	}
	subject, _ := new(mime.WordDecoder).DecodeHeader(parsed.Header.Get("Subject"))
	if subject != "Confirm your email on RPG Project" {
		t.Fatalf("subject %q", subject)
	}
	_, params, err := mime.ParseMediaType(parsed.Header.Get("Content-Type"))
	if err != nil {
		t.Fatal(err)
	}
	mr := multipart.NewReader(parsed.Body, params["boundary"])
	var types []string
	for {
		p, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(p) // quoted-printable is decoded by NextPart
		types = append(types, p.Header.Get("Content-Type"))
		if !strings.Contains(string(body), "https://game.example/verify?lang=en#token=abc") {
			t.Errorf("%s part has no link: %s", p.Header.Get("Content-Type"), body)
		}
	}
	if len(types) != 2 || !strings.HasPrefix(types[0], "text/plain") || !strings.HasPrefix(types[1], "text/html") {
		t.Fatalf("parts %v", types)
	}
}

func TestSMTPRequiresStartTLSAndRefusesPlainCredentials(t *testing.T) {
	sink := newSink(t) // does not offer STARTTLS
	m, err := NewSMTP(SMTPConfig{Host: "127.0.0.1", Port: sink.port(), From: "a@b.example", Security: StartTLS})
	if err != nil {
		t.Fatal(err)
	}
	err = m.Send(context.Background(), Message{To: "x@y.example", Subject: "s"})
	if err == nil || !strings.Contains(err.Error(), "STARTTLS") {
		t.Fatalf("want a STARTTLS error, got %v", err)
	}
	if _, err := NewSMTP(SMTPConfig{Host: "h", Port: 25, From: "a@b.example", Security: None, Username: "u", Password: "p"}); err == nil {
		t.Fatal("credentials over plain text accepted")
	}
	if _, err := NewSMTP(SMTPConfig{Host: "h", Port: 25, From: "a@b.example", Security: "ssl"}); err == nil {
		t.Fatal("unknown security accepted")
	}
}

func TestSMTPPermanentAndHeaderInjection(t *testing.T) {
	sink := newSink(t)
	sink.rcptCode = "550"
	m, _ := NewSMTP(SMTPConfig{Host: "127.0.0.1", Port: sink.port(), From: "a@b.example", Security: None})
	if err := m.Send(context.Background(), Message{To: "x@y.example", Subject: "s"}); !errors.Is(err, ErrPermanent) {
		t.Fatalf("550 should be permanent, got %v", err)
	}
	if err := m.Send(context.Background(), Message{To: "x@y.example", Subject: "s\r\nBcc: evil@example.org"}); !errors.Is(err, ErrPermanent) {
		t.Fatalf("newline in subject: %v", err)
	}
	if err := m.Send(context.Background(), Message{To: "x@y.example\r\nBcc: e@x", Subject: "s"}); !errors.Is(err, ErrPermanent) {
		t.Fatalf("newline in recipient: %v", err)
	}
}

func TestRenderEscapesAndChecksTheLink(t *testing.T) {
	tpl := testTemplates(t)
	m, err := tpl.Render(KindReset, "es", "a@b.example", `https://x.example/reset-password#token=a"><script>`)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(m.HTML, "<script>") || !strings.Contains(m.HTML, "&lt;script&gt;") {
		t.Fatalf("link not escaped: %s", m.HTML)
	}
	if !strings.Contains(m.Subject, "contraseña") || !strings.Contains(m.HTML, `lang="es"`) {
		t.Fatalf("not Spanish: %q", m.Subject)
	}
	if fr, _ := tpl.Render(KindReset, "fr", "a@b.example", "https://x.example/r"); !strings.Contains(fr.HTML, `lang="es"`) {
		t.Fatal("an unknown language must fall back to the default")
	}
	for _, bad := range []string{"javascript:alert(1)", "/relative", "https://"} {
		if _, err := tpl.Render(KindReset, "es", "a@b.example", bad); err == nil {
			t.Errorf("link %q accepted", bad)
		}
	}
}

func TestLoadTemplatesNeedsEveryKey(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "es"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "es", "email.yaml"), []byte(`email.verify.subject: "x"`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadTemplates(dir); err == nil {
		t.Fatal("incomplete templates accepted")
	}
}

// flaky fails the first n sends.
type flaky struct {
	mu    sync.Mutex
	fails int
	err   error
	sends int
}

func (f *flaky) Send(context.Context, Message) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sends++
	if f.sends <= f.fails {
		return f.err
	}
	return nil
}

func TestQueueRetriesWithBackoff(t *testing.T) {
	clk := clock.NewFake(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	f := &flaky{fails: 2, err: errors.New("temporary")}
	q, err := NewQueue(QueueConfig{Mailer: f, Clock: clk, Backoff: []time.Duration{time.Minute, time.Minute}})
	if err != nil {
		t.Fatal(err)
	}
	results := make(chan error, 1)
	q.sent = func(_ Message, err error) { results <- err }
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go q.Run(ctx)
	if err := q.Enqueue(Message{To: "a@b.example"}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		clk.BlockUntil(1)
		clk.Advance(time.Minute)
	}
	if err := <-results; err != nil {
		t.Fatalf("third attempt should succeed: %v", err)
	}
	if f.sends != 3 {
		t.Fatalf("sends %d", f.sends)
	}
}

func TestQueueGivesUpOnPermanentErrorsAndWhenFull(t *testing.T) {
	clk := clock.NewFake(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	f := &flaky{fails: 10, err: ErrPermanent}
	q, _ := NewQueue(QueueConfig{Mailer: f, Clock: clk, Size: 1, Logger: slog.New(slog.DiscardHandler)})
	if err := q.Enqueue(Message{}); err != nil {
		t.Fatal(err)
	}
	if err := q.Enqueue(Message{}); !errors.Is(err, ErrQueueFull) {
		t.Fatalf("full queue: %v", err)
	}
	results := make(chan error, 1)
	q.sent = func(_ Message, err error) { results <- err }
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go q.Run(ctx)
	if err := <-results; !errors.Is(err, ErrPermanent) || f.sends != 1 {
		t.Fatalf("err %v after %d sends", err, f.sends)
	}
}

// byAddress fails every send to bad@ and records the others.
type byAddress struct {
	mu   sync.Mutex
	good []string
}

func (b *byAddress) Send(_ context.Context, m Message) error {
	if m.To == "bad@example.org" {
		return errors.New("451 try later")
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.good = append(b.good, m.To)
	return nil
}

func TestQueueRetryDoesNotBlockOthers(t *testing.T) {
	clk := clock.NewFake(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	m := &byAddress{}
	q, _ := NewQueue(QueueConfig{Mailer: m, Clock: clk, Backoff: []time.Duration{time.Hour}})
	results := make(chan Message, 4)
	q.sent = func(m Message, _ error) { results <- m }
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go q.Run(ctx)
	_ = q.Enqueue(Message{To: "bad@example.org"})
	_ = q.Enqueue(Message{To: "ana@example.org"})
	// The good one is delivered while the bad one waits an hour for its retry.
	if got := <-results; got.To != "ana@example.org" {
		t.Fatalf("first finished %q", got.To)
	}
	clk.BlockUntil(1)
	clk.Advance(time.Hour)
	if got := <-results; got.To != "bad@example.org" {
		t.Fatalf("then %q", got.To)
	}
}

// failFast fails every send at once with a temporary error (a relay refusing connections).
type failFast struct{ sends atomic.Int64 }

func (f *failFast) Send(context.Context, Message) error {
	f.sends.Add(1)
	return errors.New("421 try later")
}

func TestQueueSizeBoundsWaitingRetries(t *testing.T) {
	clk := clock.NewFake(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	f := &failFast{}
	q, _ := NewQueue(QueueConfig{Mailer: f, Clock: clk, Size: 4})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go q.Run(ctx)
	accepted := 0
	for i := 0; i < 5000; i++ {
		if q.Enqueue(Message{To: "a@b.example"}) == nil {
			accepted++
		}
		if i == 10 {
			clk.BlockUntil(4) // the first 4 are parked on their retry timer
		}
	}
	if accepted != 4 {
		t.Fatalf("accepted %d messages with Size 4", accepted)
	}
	if w := clk.Waiters(); w > 4 {
		t.Fatalf("%d retry timers with Size 4", w)
	}
}
