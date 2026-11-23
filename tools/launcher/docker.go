package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
)

// dockerWait is how long ensureDocker waits for Docker Desktop to start.
const dockerWait = 3 * time.Minute

func (l *launcher) dockerRunning() bool {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, "docker", "info").Run() == nil
}

func dockerDesktopExe() string {
	pf := os.Getenv("ProgramFiles")
	if pf == "" {
		return ""
	}
	return filepath.Join(pf, "Docker", "Docker", "Docker Desktop.exe")
}

var errDockerMissing = &userError{
	what: "Docker no está instalado en este PC",
	next: "instala Docker Desktop (https://www.docker.com/products/docker-desktop/, o en PowerShell: " +
		"winget install Docker.DockerDesktop), ábrelo una vez hasta que diga \"Engine running\" y vuelve a abrir " +
		"el lanzador. Detalle en docs/13-hosting-de-pruebas.md",
}

// ensureDocker makes sure the Docker engine answers, starting Docker Desktop when needed.
func (l *launcher) ensureDocker(stop func() bool) error {
	if _, err := exec.LookPath("docker"); err != nil {
		return errDockerMissing
	}
	if l.dockerRunning() {
		return nil
	}
	fmt.Fprintln(l.out, ">> Docker no está corriendo: abriendo Docker Desktop...")
	if err := startDockerDesktop(l.origEnv); err != nil {
		return err
	}
	start := time.Now()
	for {
		if stop != nil && stop() {
			fmt.Fprintln(l.out)
			return errInterrupted
		}
		waited := time.Since(start)
		fmt.Fprintf(l.out, "\r   Esperando a que Docker esté listo... %3d s (máximo %d s)", int(waited.Seconds()), int(dockerWait.Seconds()))
		if l.dockerRunning() {
			fmt.Fprintln(l.out, "\n>> Docker está listo.")
			return nil
		}
		if waited > dockerWait {
			fmt.Fprintln(l.out)
			return &userError{
				what: "Docker Desktop no terminó de arrancar en 3 minutos",
				next: "abre Docker Desktop, acepta lo que te pida (licencia, actualización de WSL) y espera a que " +
					"diga \"Engine running\"; después vuelve a abrir el lanzador",
			}
		}
		time.Sleep(3 * time.Second)
	}
}

// startDockerDesktop opens Docker Desktop with env (nil: this process's environment).
func startDockerDesktop(env []string) error {
	var c *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		exe := dockerDesktopExe()
		if !isFile(exe) {
			return errDockerMissing
		}
		c = exec.Command(exe)
	case "darwin":
		c = exec.Command("open", "-a", "Docker")
	default:
		return &userError{
			what: "Docker no está corriendo",
			next: "inícialo con: sudo systemctl start docker (o abre Docker Desktop) y vuelve a intentarlo",
		}
	}
	c.Env = env
	if err := c.Start(); err != nil {
		return &userError{what: "No pude abrir Docker Desktop", next: "ábrelo a mano y vuelve a abrir el lanzador", err: err}
	}
	go func() { _ = c.Wait() }()
	return nil
}

// containers lists the running containers: the home stack's (compose project homeProject)
// and every other one. ok is false when docker could not tell (not running, timeout).
func (l *launcher) containers() (home, others []string, ok bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "docker", "ps", "--format",
		"{{.Names}}\t{{.Label \"com.docker.compose.project\"}}").Output()
	if err != nil {
		return nil, nil, false
	}
	home, others = splitContainers(string(out), homeProject)
	return home, others, true
}

// stopDockerAndWSL closes Docker Desktop and, on Windows, shuts WSL down so its memory
// goes back to Windows. Failures are reported, never fatal.
func (l *launcher) stopDockerAndWSL() {
	fmt.Fprintln(l.out, "\n>> Cerrando Docker Desktop...")
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	c := exec.CommandContext(ctx, "docker", "desktop", "stop")
	c.Stdout, c.Stderr = os.Stdout, os.Stderr
	if err := c.Run(); err != nil {
		fmt.Fprintf(l.out, "   (docker desktop stop falló: %v; ciérralo desde su ícono junto al reloj si sigue abierto)\n", err)
	}
	if runtime.GOOS != "windows" {
		return
	}
	fmt.Fprintln(l.out, ">> Apagando WSL para liberar memoria...")
	w := exec.Command("wsl", "--shutdown")
	w.Stdout, w.Stderr = os.Stdout, os.Stderr
	if err := w.Run(); err != nil {
		fmt.Fprintf(l.out, "   (wsl --shutdown falló: %v)\n", err)
		return
	}
	fmt.Fprintln(l.out, ">> Docker y WSL cerrados.")
}
