// Command launcher starts the home stack of Neque's Realm (docs/13-hosting-de-pruebas.md)
// with a double click: it finds the repo, makes sure Docker runs, calls
// `deploy/home.sh up` (the same logic as `make home-up`) and shows a small menu in Spanish.
// The subcommands up, down and status do the same without questions, for scripts and tests.
//
// `make launcher` builds it as NequesRealm-Servidor.exe at the repo root. It only uses the
// standard library, so the build needs nothing but Go.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
)

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	restore := setupConsole()
	defer restore()
	if len(args) == 0 {
		return interactive()
	}
	switch args[0] {
	case "up":
		return cmdUp(args[1:])
	case "down":
		return cmdDown(args[1:])
	case "status":
		return cmdStatus(args[1:])
	case "help", "-h", "--help", "-help", "/?":
		printHelp(os.Stdout)
		return 0
	default:
		fmt.Fprintf(os.Stderr, "Comando desconocido: %q\n\n", args[0])
		printHelp(os.Stderr)
		return 2
	}
}

func printHelp(w io.Writer) {
	fmt.Fprint(w, `NequesRealm-Servidor: arranca el servidor de Neque's Realm en este PC (docs/13).

Uso:
  NequesRealm-Servidor              doble clic: arranca todo, abre el juego y muestra un menú
  NequesRealm-Servidor up           arranca el servidor sin preguntas
      --rebuild                     reconstruye las imágenes aunque el código no haya cambiado
      --open                        abre el juego en el navegador al terminar
  NequesRealm-Servidor down         detiene el servidor (los datos se conservan)
      --stop-docker                 además cierra Docker Desktop y WSL para liberar memoria
  NequesRealm-Servidor status       dice si el servidor está corriendo y responde
  NequesRealm-Servidor --help       esta ayuda

Códigos de salida: 0 bien, 1 algo falló (el mensaje dice qué hacer), 2 uso incorrecto.
`)
}

func newFlags(name string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	return fs
}

func cmdUp(args []string) int {
	fs := newFlags("up")
	rebuild := fs.Bool("rebuild", false, "rebuild the images even when the code did not change")
	open := fs.Bool("open", false, "open the game in the browser when it is ready")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	l, err := prepare(os.Stdout)
	if err != nil {
		report(os.Stderr, err)
		return 1
	}
	url, err := l.up(*rebuild, nil)
	if err != nil {
		report(os.Stderr, err)
		return 1
	}
	if *open {
		openBrowser(url)
	}
	return 0
}

func cmdDown(args []string) int {
	fs := newFlags("down")
	stopDocker := fs.Bool("stop-docker", false, "also stop Docker Desktop and WSL")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	l, err := prepare(os.Stdout)
	if err != nil {
		report(os.Stderr, err)
		return 1
	}
	if err := l.down(); err != nil {
		report(os.Stderr, err)
		return 1
	}
	if *stopDocker {
		l.stopDockerAndWSL()
	}
	return 0
}

func cmdStatus(args []string) int {
	fs := newFlags("status")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	l, err := prepare(os.Stdout)
	if err != nil {
		report(os.Stderr, err)
		return 1
	}
	if l.status() {
		return 0
	}
	return 1
}
