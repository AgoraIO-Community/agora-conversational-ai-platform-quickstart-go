SHELL := /bin/sh

FRONTEND_PORT ?= 3000
BACKEND_PORT ?= 8000

.PHONY: install dev build test clean

install:
	go mod download
	cd client && pnpm install --frozen-lockfile

dev:
	FRONTEND_PORT=$(FRONTEND_PORT) BACKEND_PORT=$(BACKEND_PORT) go run ./scripts/dev.go

build:
	cd client && pnpm build

test:
	go test ./...

clean:
	rm -rf client/dist
