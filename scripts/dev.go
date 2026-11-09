package main

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"syscall"

	"github.com/joho/godotenv"
)

func main() {
	_ = godotenv.Load(".env")

	requestedFrontend := configuredPort("FRONTEND_PORT", 3000)
	requestedBackend := configuredPort("BACKEND_PORT", 8000)
	frontendPort := requestedFrontend
	publicOrigin := ""

	if strings.EqualFold(env("AUTH_MODE", "bypass"), "sso") &&
		strings.TrimSpace(os.Getenv("AGORA_SSO_REDIRECT_URI")) != "" {
		redirect, err := url.Parse(os.Getenv("AGORA_SSO_REDIRECT_URI"))
		if err != nil || redirect.Scheme == "" || redirect.Hostname() == "" {
			fail("AGORA_SSO_REDIRECT_URI must be an absolute URL.")
		}
		frontendPort = redirectPort(redirect)
		publicOrigin = redirect.Scheme + "://" + redirect.Host
		if !portAvailable(frontendPort) {
			fail("SSO requires frontend port %d, but it is already in use. Free that port or update and register AGORA_SSO_REDIRECT_URI.", frontendPort)
		}
	} else {
		frontendPort = availablePort(requestedFrontend, nil)
		publicOrigin = fmt.Sprintf("http://localhost:%d", frontendPort)
	}

	backendPort := availablePort(requestedBackend, map[int]bool{frontendPort: true})
	if frontendPort != requestedFrontend {
		fmt.Printf("Frontend port %d is busy; using %d.\n", requestedFrontend, frontendPort)
	}
	if backendPort != requestedBackend {
		fmt.Printf("Backend port %d is busy; using %d.\n", requestedBackend, backendPort)
	}

	childEnv := append(
		os.Environ(),
		"APP_PUBLIC_URL="+publicOrigin,
		fmt.Sprintf("API_PROXY_TARGET=http://127.0.0.1:%d", backendPort),
	)
	backend := exec.Command("go", "run", "./server")
	backend.Env = append(childEnv, fmt.Sprintf("PORT=%d", backendPort))
	frontend := frontendCommand(frontendPort)
	frontend.Env = childEnv

	processes := []*exec.Cmd{backend, frontend}
	for _, process := range processes {
		process.Stdout, process.Stderr = os.Stdout, os.Stderr
		process.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		if err := process.Start(); err != nil {
			stopProcesses(processes)
			fail("start development process: %v", err)
		}
	}

	fmt.Printf(
		"Frontend: %s\nBackend:  http://127.0.0.1:%d\nPress Ctrl+C to stop both processes.\n",
		publicOrigin,
		backendPort,
	)
	done := make(chan error, len(processes))
	for _, process := range processes {
		go func(command *exec.Cmd) { done <- command.Wait() }(process)
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	select {
	case <-signals:
	case err := <-done:
		if err != nil {
			fmt.Fprintf(os.Stderr, "Development process exited: %v\n", err)
		}
	}
	stopProcesses(processes)
}

func configuredPort(name string, fallback int) int {
	raw := env(name, strconv.Itoa(fallback))
	port, err := strconv.Atoi(raw)
	if err != nil || port < 1 || port > 65535 {
		fail("%s must be between 1 and 65535.", name)
	}
	return port
}

func redirectPort(value *url.URL) int {
	if value.Port() != "" {
		port, err := strconv.Atoi(value.Port())
		if err != nil || port < 1 || port > 65535 {
			fail("AGORA_SSO_REDIRECT_URI contains an invalid port.")
		}
		return port
	}
	if value.Scheme == "https" {
		return 443
	}
	return 80
}

func availablePort(preferred int, reserved map[int]bool) int {
	for port := preferred; port <= preferred+99 && port <= 65535; port++ {
		if !reserved[port] && portAvailable(port) {
			return port
		}
	}
	fail("Could not find an available port between %d and %d.", preferred, min(preferred+99, 65535))
	return 0
}

func portAvailable(port int) bool {
	addresses := []struct {
		network string
		address string
	}{
		{"tcp4", fmt.Sprintf("127.0.0.1:%d", port)},
		{"tcp6", fmt.Sprintf("[::1]:%d", port)},
	}
	listeners := make([]net.Listener, 0, len(addresses))
	for _, candidate := range addresses {
		listener, err := net.Listen(candidate.network, candidate.address)
		if err != nil {
			for _, opened := range listeners {
				_ = opened.Close()
			}
			return false
		}
		listeners = append(listeners, listener)
	}
	for _, listener := range listeners {
		_ = listener.Close()
	}
	return true
}

func frontendCommand(port int) *exec.Cmd {
	return exec.Command(
		"pnpm", "--dir", "client", "dev",
		"--port", strconv.Itoa(port), "--strictPort",
	)
}

func stopProcesses(processes []*exec.Cmd) {
	for index := len(processes) - 1; index >= 0; index-- {
		process := processes[index]
		if process.Process != nil {
			_ = syscall.Kill(-process.Process.Pid, syscall.SIGTERM)
		}
	}
}

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func fail(format string, values ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", values...)
	os.Exit(1)
}
