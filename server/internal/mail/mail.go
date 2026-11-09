// Package mail sends the account emails (T2.1: email verification and password reset).
// It never runs on the game loop: auth enqueues a rendered Message on a Queue, and the
// Queue's own goroutine delivers it through a Mailer with bounded retries.
//
// Message bodies carry single-use links: nothing in this package logs a body or a link.
package mail

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net"
	"net/mail"
	"net/smtp"
	"net/textproto"
	"strconv"
	"strings"
	"time"
)

// Message is a rendered email: a plain-text body and a simple HTML alternative.
type Message struct {
	To      string
	Subject string
	Text    string
	HTML    string
	// Date is set by the Queue (injected clock) when it is zero.
	Date time.Time
}

// Mailer delivers one message.
type Mailer interface {
	Send(ctx context.Context, m Message) error
}

// ErrPermanent wraps errors that retrying cannot fix (bad address, rejected message).
var ErrPermanent = errors.New("mail: permanent failure")

// Security is how the SMTP connection is protected.
type Security string

// Security modes.
const (
	// StartTLS connects in plain text and upgrades with STARTTLS (port 587). The upgrade
	// is required: a server that does not offer it is an error, never a silent downgrade.
	StartTLS Security = "starttls"
	// TLS connects with implicit TLS (port 465).
	TLS Security = "tls"
	// None sends in plain text. Only for a local catcher such as Mailpit; credentials
	// are refused in this mode.
	None Security = "none"
)

// SMTPConfig configures the SMTP mailer (docs/12 and docs/13: SMTP_* variables).
type SMTPConfig struct {
	Host     string
	Port     int
	Username string
	Password string
	// From is the sender, "Name <addr@example.com>" or a bare address.
	From     string
	Security Security
	// Timeout bounds one delivery (dial to QUIT). Default 30 s.
	Timeout time.Duration
	// TLSConfig overrides the TLS settings (tests). ServerName defaults to Host.
	TLSConfig *tls.Config
}

// SMTP sends through an SMTP server.
type SMTP struct {
	cfg  SMTPConfig
	from *mail.Address
	host string // the domain of From, for Message-ID
}

// NewSMTP validates cfg.
func NewSMTP(cfg SMTPConfig) (*SMTP, error) {
	if cfg.Host == "" || cfg.Port <= 0 || cfg.Port > 65535 {
		return nil, errors.New("mail: SMTP host and port are required")
	}
	switch cfg.Security {
	case StartTLS, TLS:
	case None:
		if cfg.Username != "" || cfg.Password != "" {
			return nil, errors.New("mail: SMTP credentials need starttls or tls")
		}
	default:
		return nil, fmt.Errorf("mail: SMTP security must be starttls, tls or none, not %q", cfg.Security)
	}
	if (cfg.Username == "") != (cfg.Password == "") {
		return nil, errors.New("mail: set both the SMTP username and password, or neither")
	}
	from, err := mail.ParseAddress(cfg.From)
	if err != nil {
		return nil, fmt.Errorf("mail: invalid sender %q: %w", cfg.From, err)
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 30 * time.Second
	}
	_, domain, _ := strings.Cut(from.Address, "@")
	return &SMTP{cfg: cfg, from: from, host: domain}, nil
}

func (s *SMTP) tlsConfig() *tls.Config {
	c := &tls.Config{MinVersion: tls.VersionTLS12}
	if s.cfg.TLSConfig != nil {
		c = s.cfg.TLSConfig.Clone()
	}
	if c.ServerName == "" {
		c.ServerName = s.cfg.Host
	}
	return c
}

// Send implements Mailer.
func (s *SMTP) Send(ctx context.Context, m Message) error {
	to, err := mail.ParseAddress(m.To)
	if err != nil {
		return fmt.Errorf("%w: invalid recipient: %w", ErrPermanent, err)
	}
	body, err := s.build(m, to)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, s.cfg.Timeout)
	defer cancel()
	addr := net.JoinHostPort(s.cfg.Host, strconv.Itoa(s.cfg.Port))
	d := &net.Dialer{}
	var conn net.Conn
	if s.cfg.Security == TLS {
		conn, err = (&tls.Dialer{NetDialer: d, Config: s.tlsConfig()}).DialContext(ctx, "tcp", addr)
	} else {
		conn, err = d.DialContext(ctx, "tcp", addr)
	}
	if err != nil {
		return fmt.Errorf("mail: dial: %w", err)
	}
	defer func() { _ = conn.Close() }()
	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	}
	c, err := smtp.NewClient(conn, s.cfg.Host)
	if err != nil {
		return fmt.Errorf("mail: hello: %w", err)
	}
	defer func() { _ = c.Close() }()
	helo := s.host
	if helo == "" {
		helo = "localhost"
	}
	if err := c.Hello(helo); err != nil {
		return classify("hello", err)
	}
	if s.cfg.Security == StartTLS {
		if ok, _ := c.Extension("STARTTLS"); !ok {
			return errors.New("mail: the SMTP server does not offer STARTTLS")
		}
		if err := c.StartTLS(s.tlsConfig()); err != nil {
			return fmt.Errorf("mail: starttls: %w", err)
		}
	}
	if s.cfg.Username != "" {
		// PlainAuth refuses to send credentials over an unencrypted connection.
		if err := c.Auth(smtp.PlainAuth("", s.cfg.Username, s.cfg.Password, s.cfg.Host)); err != nil {
			return classify("auth", err)
		}
	}
	if err := c.Mail(s.from.Address); err != nil {
		return classify("mail from", err)
	}
	if err := c.Rcpt(to.Address); err != nil {
		return classify("rcpt to", err)
	}
	w, err := c.Data()
	if err != nil {
		return classify("data", err)
	}
	if _, err := w.Write(body); err != nil {
		return fmt.Errorf("mail: write: %w", err)
	}
	if err := w.Close(); err != nil {
		return classify("data end", err)
	}
	if err := c.Quit(); err != nil {
		return nil //nolint:nilerr // the message was accepted; a failed QUIT does not undo it
	}
	return nil
}

// classify marks 5xx SMTP replies as permanent (retrying will not help).
func classify(step string, err error) error {
	var te *textproto.Error
	if errors.As(err, &te) && te.Code >= 500 {
		return fmt.Errorf("%w: %s: %w", ErrPermanent, step, err)
	}
	return fmt.Errorf("mail: %s: %w", step, err)
}

// build renders the RFC 5322 message: multipart/alternative, quoted-printable bodies.
// Header values come from fixed templates and a parsed address; any CR or LF is refused
// so a value can never start a new header.
func (s *SMTP) build(m Message, to *mail.Address) ([]byte, error) {
	if strings.ContainsAny(m.Subject, "\r\n") {
		return nil, fmt.Errorf("%w: newline in subject", ErrPermanent)
	}
	var id [12]byte
	if _, err := rand.Read(id[:]); err != nil {
		return nil, fmt.Errorf("mail: message id: %w", err)
	}
	var b bytes.Buffer
	mw := multipart.NewWriter(&b)
	hdr := func(k, v string) { b.WriteString(k + ": " + v + "\r\n") }
	hdr("From", s.from.String())
	hdr("To", to.String())
	hdr("Subject", mime.QEncoding.Encode("utf-8", m.Subject))
	hdr("Date", m.Date.Format(time.RFC1123Z))
	hdr("Message-ID", "<"+hex.EncodeToString(id[:])+"@"+s.host+">")
	hdr("MIME-Version", "1.0")
	hdr("Content-Type", `multipart/alternative; boundary="`+mw.Boundary()+`"`)
	b.WriteString("\r\n")
	for _, part := range []struct{ ctype, body string }{
		{"text/plain; charset=utf-8", m.Text},
		{"text/html; charset=utf-8", m.HTML},
	} {
		pw, err := mw.CreatePart(textproto.MIMEHeader{
			"Content-Type":              {part.ctype},
			"Content-Transfer-Encoding": {"quoted-printable"},
		})
		if err != nil {
			return nil, fmt.Errorf("mail: part: %w", err)
		}
		qp := quotedprintable.NewWriter(pw)
		if _, err := qp.Write([]byte(part.body)); err != nil {
			return nil, fmt.Errorf("mail: part: %w", err)
		}
		if err := qp.Close(); err != nil {
			return nil, fmt.Errorf("mail: part: %w", err)
		}
	}
	if err := mw.Close(); err != nil {
		return nil, fmt.Errorf("mail: close: %w", err)
	}
	return b.Bytes(), nil
}

// Log is the development mailer used when no SMTP server is configured: it records that
// an email would have been sent (recipient and subject only, never the body, which
// holds a single-use link) and sends nothing.
type Log struct{ Logger *slog.Logger }

// Send implements Mailer.
func (l Log) Send(_ context.Context, m Message) error {
	if l.Logger != nil {
		l.Logger.Info("mail: not sent (no SMTP configured)", "to", m.To, "subject", m.Subject)
	}
	return nil
}
