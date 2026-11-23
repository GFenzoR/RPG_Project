package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// errInterrupted is a Ctrl+C while the launcher waited for something.
var errInterrupted = errors.New("interrumpido con Ctrl+C")

// interrupts turns Ctrl+C into a channel the waits can select on. A child process in the
// same console gets the Ctrl+C too and ends; the launcher then asks what to do.
type interrupts struct{ ch chan struct{} }

func watchInterrupts() *interrupts {
	in := &interrupts{ch: make(chan struct{}, 1)}
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	go func() {
		for range sig {
			select {
			case in.ch <- struct{}{}:
			default:
			}
		}
	}()
	return in
}

// take reports (and clears) a pending Ctrl+C.
func (in *interrupts) take() bool {
	select {
	case <-in.ch:
		return true
	default:
		return false
	}
}

type lineResult struct {
	line string
	err  error
}

// prompter reads lines from stdin in one goroutine, so a question can be cut by Ctrl+C.
// A read still pending after a Ctrl+C answers the next question.
type prompter struct {
	out     io.Writer
	req     chan struct{}
	res     chan lineResult
	pending bool
	stale   bool // the pending read was cut by Ctrl+C
	intr    *interrupts
}

func newPrompter(r io.Reader, out io.Writer, intr *interrupts) *prompter {
	p := &prompter{out: out, req: make(chan struct{}), res: make(chan lineResult), intr: intr}
	br := bufio.NewReader(r)
	go func() {
		for range p.req {
			line, err := br.ReadString('\n')
			p.res <- lineResult{strings.TrimRight(line, "\r\n"), err}
		}
	}()
	return p
}

// ask prints prompt and returns the answer, errInterrupted on Ctrl+C or io.EOF when
// stdin is closed.
func (p *prompter) ask(prompt string) (string, error) {
	fmt.Fprint(p.out, prompt)
	for {
		if !p.pending {
			p.req <- struct{}{}
			p.pending = true
		}
		select {
		case r := <-p.res:
			p.pending = false
			wasStale := p.stale
			p.stale = false
			if r.err == nil || r.line != "" {
				return r.line, nil
			}
			if wasStale {
				continue // the read the Ctrl+C cut short: read again
			}
			// On Windows a Ctrl+C can end the console read as EOF just before the signal.
			select {
			case <-p.intr.ch:
				fmt.Fprintln(p.out)
				return "", errInterrupted
			case <-time.After(300 * time.Millisecond):
				return "", io.EOF
			}
		case <-p.intr.ch:
			p.stale = p.pending
			fmt.Fprintln(p.out)
			return "", errInterrupted
		}
	}
}

// yesNo asks until the answer is yes or no; Enter takes def.
func (p *prompter) yesNo(question string, def bool) (bool, error) {
	hint := "[S/n]"
	if !def {
		hint = "[s/N]"
	}
	for {
		line, err := p.ask(question + " " + hint + " ")
		if errors.Is(err, io.EOF) {
			return def, nil
		}
		if err != nil {
			return false, err
		}
		if yes, ok := parseYesNo(line, def); ok {
			return yes, nil
		}
		fmt.Fprintln(p.out, "Responde s (sí) o n (no).")
	}
}

// session is the double-click flow.
type session struct {
	l    *launcher
	p    *prompter
	intr *interrupts
	url  string
}

func interactive() int {
	out := os.Stdout
	intr := watchInterrupts()
	p := newPrompter(os.Stdin, out, intr)
	fmt.Fprintln(out, "Neque's Realm: arrancando el servidor en este PC.")
	fmt.Fprintln(out, "No cierres esta ventana mientras arranca. Para apagarlo después, usa la opción 6 del menú.")

	l, err := prepare(out)
	if err != nil {
		report(out, err)
		pause(p)
		return 1
	}
	s := &session{l: l, p: p, intr: intr}
	s.url, err = l.up(false, intr.take)
	if errors.Is(err, errInterrupted) || intr.take() {
		return s.onCtrlC()
	}
	if err != nil {
		report(out, err)
		pause(p)
		return 1
	}
	openBrowser(s.url + "/")
	return s.menu()
}

func (s *session) menu() int {
	for {
		fmt.Fprint(s.l.out, menuText(s.url))
		line, err := s.p.ask("Elige una opción (1-6): ")
		if errors.Is(err, errInterrupted) {
			return s.onCtrlC()
		}
		if err != nil {
			fmt.Fprintln(s.l.out, "\nNo hay teclado (entrada cerrada): salgo y dejo el servidor encendido.")
			return 0
		}
		act := parseChoice(line)
		if act == actStop {
			return s.stopAndExit()
		}
		if err := s.do(act); errors.Is(err, errInterrupted) {
			return s.onCtrlC()
		} else if err != nil {
			report(s.l.out, err)
		}
		if s.intr.take() {
			return s.onCtrlC()
		}
	}
}

func (s *session) do(act action) error {
	l := s.l
	switch act {
	case actOpen:
		openBrowser(s.url + "/")
		fmt.Fprintf(l.out, "Abriendo %s/ (si no se abre, cópialo en el navegador).\n", s.url)
	case actAdmin:
		email, err := s.askEmail("Email de tu cuenta (créala antes en el sitio con Jugar): ")
		if err != nil || email == "" {
			return err
		}
		if err := l.script(nil, "deploy/home.sh", "admin", email, "admin"); err != nil {
			return &userError{
				what: "No pude darle el rol admin a " + email,
				next: "revisa que la cuenta exista (regístrate primero en " + s.url + "/ con Jugar) y que el email esté bien escrito",
				err:  err,
			}
		}
		fmt.Fprintf(l.out, "\nListo: %s es admin. Vale desde el próximo login de tu personaje.\n", email)
	case actTunnel:
		return s.tunnel()
	case actLogs:
		fmt.Fprintln(l.out, "\n---- Últimas líneas de los registros ----")
		if err := l.docker(composeArgs(true, "logs", "--no-color", "--tail=60")...); err != nil {
			return &userError{what: "No pude leer los registros", next: "revisa que Docker Desktop siga abierto", err: err}
		}
		fmt.Fprintln(l.out, "---- Fin. Para verlos en vivo, en Git Bash: make home-logs ----")
	case actResetPassword:
		email, err := s.askEmail("Email de la cuenta que olvidó su contraseña: ")
		if err != nil || email == "" {
			return err
		}
		if err := l.script(nil, "deploy/home.sh", "reset-password", email); err != nil {
			return &userError{
				what: "No pude crear el enlace para " + email,
				next: "revisa que la cuenta exista y que el email esté bien escrito",
				err:  err,
			}
		}
		fmt.Fprintln(l.out, "\nDale ese enlace a la persona por un canal de confianza: sirve una sola vez.")
	default:
		fmt.Fprintln(l.out, "Esa opción no existe: escribe un número del 1 al 6 y presiona Enter.")
	}
	return nil
}

func (s *session) askEmail(prompt string) (string, error) {
	for {
		line, err := s.p.ask(prompt)
		if errors.Is(err, io.EOF) {
			return "", nil
		}
		if err != nil {
			return "", err
		}
		email := strings.TrimSpace(line)
		if email == "" {
			fmt.Fprintln(s.l.out, "Cancelado.")
			return "", nil
		}
		if validEmail(email) {
			return email, nil
		}
		fmt.Fprintln(s.l.out, "Ese email no parece válido (ejemplo: tu@email.com). Enter vacío cancela.")
	}
}

func (s *session) tunnel() error {
	l := s.l
	fmt.Fprintln(l.out, "\n>> Abriendo un túnel de Cloudflare (gratis, sin cuenta). Tarda unos segundos...")
	urlFile := filepath.Join(l.root, "build", "tunnel-url.txt")
	_ = os.MkdirAll(filepath.Dir(urlFile), 0o755)
	_ = os.Remove(urlFile)
	env := []string{"COMPOSE=" + composeCommandLine(), "HOME_TUNNEL_URL_FILE=build/tunnel-url.txt"}
	if err := l.script(env, "deploy/home-tunnel.sh"); err != nil {
		return &userError{
			what: "No pude crear el link para invitar amigos",
			next: "revisa tu conexión a internet y vuelve a intentarlo en un minuto (Cloudflare a veces limita los túneles rápidos)",
			err:  err,
		}
	}
	if b, err := os.ReadFile(urlFile); err == nil {
		if u := strings.TrimSpace(string(b)); u != "" {
			fmt.Fprintf(l.out, "\n  Comparte este link con tus amigos:  %s\n", u)
			fmt.Fprintln(l.out, "  Cambia cada vez que arrancas el túnel y se apaga con la opción 6.")
		}
	}
	return nil
}

// onCtrlC asks whether to stop the server before leaving.
func (s *session) onCtrlC() int {
	if s.l == nil {
		return 1
	}
	stop, err := s.p.yesNo("\n¿Detener el servidor antes de salir?", true)
	if err != nil { // a second Ctrl+C: leave everything as it is
		fmt.Fprintln(s.l.out, "Salgo sin tocar nada.")
		return 0
	}
	if stop {
		return s.stopAndExit()
	}
	fmt.Fprintln(s.l.out, "El servidor sigue encendido. Para apagarlo, abre de nuevo el lanzador y elige la opción 6.")
	pause(s.p)
	return 0
}

func (s *session) stopAndExit() int {
	code := 0
	if err := s.l.down(); err != nil {
		report(s.l.out, err)
		code = 1
	}
	free, err := s.p.yesNo("\n¿Cerrar también Docker Desktop y WSL para liberar memoria?", true)
	if err == nil && free {
		s.l.stopDockerAndWSL()
	}
	pause(s.p)
	return code
}

// pause keeps a double-clicked window open until the owner has read it.
func pause(p *prompter) {
	_, _ = p.ask("\nPresiona Enter para cerrar esta ventana.")
}
