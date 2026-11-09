package mail

import (
	"bytes"
	"errors"
	"fmt"
	"html/template"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"go.yaml.in/yaml/v3"
)

// Kind is an account email.
type Kind string

// Kinds of account email; each has the keys email.<kind>.{subject,intro,action,expires,
// ignore} in i18n/<lang>/email.yaml.
const (
	KindVerify Kind = "verify"
	KindReset  Kind = "reset"
)

var kinds = []Kind{KindVerify, KindReset}

// DefaultLang is the language of an account without a stored one.
const DefaultLang = "es"

// Templates renders the account emails in every language of i18n/.
type Templates struct {
	texts map[string]map[string]string // lang → key → text
}

// LoadTemplates reads i18n/<lang>/email.yaml for every language directory of dir and
// checks that each has every key the emails need.
func LoadTemplates(dir string) (*Templates, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("mail templates: %w", err)
	}
	t := &Templates{texts: map[string]map[string]string{}}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, e.Name(), "email.yaml"))
		if err != nil {
			return nil, fmt.Errorf("mail templates: %w", err)
		}
		texts := map[string]string{}
		if err := yaml.Unmarshal(raw, &texts); err != nil {
			return nil, fmt.Errorf("mail templates %s: %w", e.Name(), err)
		}
		for _, k := range kinds {
			for _, part := range []string{"subject", "intro", "action", "expires", "ignore"} {
				if texts[fmt.Sprintf("email.%s.%s", k, part)] == "" {
					return nil, fmt.Errorf("mail templates %s: missing email.%s.%s", e.Name(), k, part)
				}
			}
		}
		for _, key := range []string{"email.footer", "email.link_hint"} {
			if texts[key] == "" {
				return nil, fmt.Errorf("mail templates %s: missing %s", e.Name(), key)
			}
		}
		t.texts[e.Name()] = texts
	}
	if t.texts[DefaultLang] == nil {
		return nil, fmt.Errorf("mail templates: no %s/email.yaml in %s", DefaultLang, dir)
	}
	return t, nil
}

// Lang returns lang if there are templates for it, else DefaultLang.
func (t *Templates) Lang(lang string) string {
	if _, ok := t.texts[lang]; ok {
		return lang
	}
	return DefaultLang
}

// html/template escapes every value (and checks the link's scheme), so no text or link
// can inject markup.
var htmlBody = template.Must(template.New("email").Parse(`<!doctype html>
<html lang="{{.Lang}}"><head><meta charset="utf-8"><title>{{.Subject}}</title></head>
<body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1d1d1f;max-width:560px;margin:0 auto;padding:16px">
<p>{{.Intro}}</p>
<p><a href="{{.Link}}" style="display:inline-block;background:#2f6f4f;color:#ffffff;padding:10px 18px;border-radius:6px;text-decoration:none">{{.Action}}</a></p>
<p>{{.Expires}}</p>
<p>{{.Ignore}}</p>
<p style="font-size:13px;color:#555">{{.LinkHint}}<br><span style="word-break:break-all">{{.Link}}</span></p>
<p style="font-size:12px;color:#777">{{.Footer}}</p>
</body></html>
`))

type view struct {
	Lang, Subject, Intro, Action, Expires, Ignore, LinkHint, Footer string
	Link                                                            string
}

// Render builds the email of kind for to in lang (DefaultLang if unknown) with link,
// which must be an absolute http(s) URL.
func (t *Templates) Render(kind Kind, lang, to, link string) (Message, error) {
	u, err := url.Parse(link)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return Message{}, errors.New("mail: the link must be an absolute http(s) URL")
	}
	lang = t.Lang(lang)
	tx := t.texts[lang]
	get := func(part string) string { return tx[fmt.Sprintf("email.%s.%s", kind, part)] }
	if get("subject") == "" {
		return Message{}, fmt.Errorf("mail: unknown email kind %q", kind)
	}
	v := view{
		Lang: lang, Subject: get("subject"), Intro: get("intro"), Action: get("action"),
		Expires: get("expires"), Ignore: get("ignore"), LinkHint: tx["email.link_hint"],
		Footer: tx["email.footer"], Link: link,
	}
	var h bytes.Buffer
	if err := htmlBody.Execute(&h, v); err != nil {
		return Message{}, fmt.Errorf("mail: render: %w", err)
	}
	text := strings.Join([]string{
		v.Intro, "", v.Action + ":", link, "", v.Expires, "", v.Ignore, "", "-- ", v.Footer, "",
	}, "\n")
	return Message{To: to, Subject: v.Subject, Text: text, HTML: h.String()}, nil
}

// Sender renders an account email and queues it.
type Sender struct {
	Templates *Templates
	Queue     interface{ Enqueue(Message) error }
}

// Send renders and enqueues; it does not wait for the delivery.
func (s *Sender) Send(kind Kind, to, lang, link string) error {
	m, err := s.Templates.Render(kind, lang, to, link)
	if err != nil {
		return err
	}
	return s.Queue.Enqueue(m)
}

// Lang implements the language choice of the account flows.
func (s *Sender) Lang(lang string) string { return s.Templates.Lang(lang) }
