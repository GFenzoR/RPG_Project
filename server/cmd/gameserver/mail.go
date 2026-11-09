package main

import (
	"errors"
	"fmt"
	"log/slog"
	"strconv"

	"github.com/GFenzoR/RPG_Project/server/internal/auth"
	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/mail"
)

// Mail modes (-mail, T2.1).
const (
	// mailAuto: SMTP when SMTP_HOST is set, otherwise off.
	mailAuto = "auto"
	mailSMTP = "smtp"
	// mailLog: development only. Emails are "sent" to the log (recipient and subject,
	// never the link): the flows are on but nobody receives a link. Use Mailpit to see them.
	mailLog = "log"
	mailOff = "off"
)

// mailSetup is the account email configuration taken from the environment.
type mailSetup struct {
	mailer mail.Mailer // nil = email flows off
	// what is a short description for the startup log (never a secret).
	what string
}

// mailFromEnv builds the mailer for mode from the SMTP_* variables (getenv). The
// password is only passed to the SMTP client, never logged.
func mailFromEnv(mode string, getenv func(string) string, logger *slog.Logger) (mailSetup, error) {
	host := getenv("SMTP_HOST")
	if mode == mailAuto {
		mode = mailOff
		if host != "" {
			mode = mailSMTP
		}
	}
	switch mode {
	case mailOff:
		return mailSetup{what: "off"}, nil
	case mailLog:
		return mailSetup{mailer: mail.Log{Logger: logger}, what: "log (development: nothing is delivered)"}, nil
	case mailSMTP:
	default:
		return mailSetup{}, fmt.Errorf("-mail must be auto, smtp, log or off, not %q", mode)
	}
	if host == "" {
		return mailSetup{}, errors.New("-mail smtp needs SMTP_HOST")
	}
	port := 587
	if p := getenv("SMTP_PORT"); p != "" {
		n, err := strconv.Atoi(p)
		if err != nil {
			return mailSetup{}, fmt.Errorf("SMTP_PORT %q is not a number", p)
		}
		port = n
	}
	security := mail.Security(getenv("SMTP_SECURITY"))
	if security == "" {
		security = mail.StartTLS
		if port == 465 {
			security = mail.TLS
		}
	}
	m, err := mail.NewSMTP(mail.SMTPConfig{
		Host: host, Port: port, Username: getenv("SMTP_USERNAME"), Password: getenv("SMTP_PASSWORD"),
		From: getenv("SMTP_FROM"), Security: security,
	})
	if err != nil {
		return mailSetup{}, err
	}
	return mailSetup{mailer: m, what: fmt.Sprintf("smtp %s:%d (%s)", host, port, security)}, nil
}

// newSender loads the templates and builds the queue of the account emails. The queue
// runs in its own goroutine (Queue.Run), never in the game loop.
func newSender(m mail.Mailer, i18nDir string, clk clock.Clock, logger *slog.Logger) (auth.Emailer, *mail.Queue, error) {
	tpl, err := mail.LoadTemplates(i18nDir)
	if err != nil {
		return nil, nil, err
	}
	q, err := mail.NewQueue(mail.QueueConfig{Mailer: m, Clock: clk, Logger: logger})
	if err != nil {
		return nil, nil, err
	}
	return &mail.Sender{Templates: tpl, Queue: q}, q, nil
}
