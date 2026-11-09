package main

import (
	"reflect"
	"testing"
)

func TestFrontendCommandForwardsViteFlags(t *testing.T) {
	command := frontendCommand(3001)
	expected := []string{
		"pnpm",
		"--dir",
		"client",
		"dev",
		"--port",
		"3001",
		"--strictPort",
	}
	if !reflect.DeepEqual(command.Args, expected) {
		t.Fatalf("unexpected frontend command: %#v", command.Args)
	}
}
