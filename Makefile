GO      ?= go
export GOTOOLCHAIN ?= local
IFACE   ?= $(shell ip route show default | awk '{print $$5; exit}')
BIN     := flowbreaker
GODOT   ?= godot

.PHONY: all generate build run demo test test-bpf setcap clean godot godot-demo godot-test

all: generate build

generate: ## compile bpf/shooter.bpf.c and regenerate Go bindings (needs clang)
	$(GO) generate ./internal/bpfobj/

build:
	$(GO) build -o $(BIN) ./cmd/flowbreaker

run: build ## sudo-run against IFACE (default: interface of the default route)
	sudo ./$(BIN) -iface $(IFACE) $(ARGS)

demo: ## UI only, simulated traffic, no root needed
	@echo "open http://127.0.0.1:8099/?demo=1"
	cd web && python3 -m http.server 8099 --bind 127.0.0.1

test:
	$(GO) vet ./...
	$(GO) test ./...

test-bpf: ## run the verifier + BPF_PROG_TEST_RUN tests as root
	$(GO) test -c -o engine.test ./internal/engine/
	sudo ./engine.test -test.v -test.run XDP
	rm -f engine.test

setcap: build ## allow running without sudo
	sudo setcap cap_bpf,cap_net_admin,cap_perfmon+ep ./$(BIN)

godot: ## native client; finds a running daemon via its session file
	$(GODOT) --path godot

godot-demo: ## native client with simulated traffic, no daemon needed
	$(GODOT) --path godot -- --demo

godot-test: ## headless smoke test of the native client (demo traffic)
	$(GODOT) --headless --path godot --import
	$(GODOT) --headless --path godot -- --demo --selftest

clean:
	rm -f $(BIN) engine.test
