// Package bpfobj holds the compiled XDP program and its generated Go bindings.
package bpfobj

//go:generate go run github.com/cilium/ebpf/cmd/bpf2go -target bpfel -type flow_key -type block_val -type prot_key -type lpm_key -type config -type event Shooter ../../bpf/shooter.bpf.c -- -O2 -g -Wall -I../../bpf/headers -I/usr/include/x86_64-linux-gnu
