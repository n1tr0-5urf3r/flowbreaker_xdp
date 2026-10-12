// SPDX-License-Identifier: GPL-2.0
// Flowbreaker: XDP ingress program.
//
// Every packet is parsed into a flow key. Flows the player has shot live in
// the blocklist map and are dropped here. A rate-limited sample of all other
// packets is pushed to user space through a ring buffer so the game can
// render them as enemies.

#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/ipv6.h>
#include <linux/in.h>
#include <linux/tcp.h>
#include <linux/udp.h>
#include <bpf_helpers.h>
#include <bpf_endian.h>

char LICENSE[] SEC("license") = "GPL";

#define ETH_P_8021Q_ 0x8100
#define ETH_P_8021AD_ 0x88A8

// Ports are stored in host byte order. For ICMP/ICMPv6, sport is 0 and dport
// is the ICMP type, so "shooting" an echo reply blocks echo replies from that
// host. IPv4 addresses are stored v4-mapped (::ffff:a.b.c.d).
struct flow_key {
	__u8 saddr[16];
	__u8 daddr[16];
	__u16 sport;
	__u16 dport;
	__u8 proto;
	__u8 family; // 4 or 6
	__u8 pad[2];
};

struct block_val {
	__u64 expires_ns; // CLOCK_MONOTONIC; 0 = never
	__u64 drops;
};

struct prot_key {
	__u8 proto;
	__u8 pad;
	__u16 port; // 0 = whole protocol
};

// LPM key for protected networks. IPv4 is v4-mapped, so an IPv4 /n is
// stored as prefixlen 96 + n.
struct lpm_key {
	__u32 prefixlen;
	__u8 addr[16];
};

struct config {
	__u64 sample_ns;   // min interval between two events of the same flow
	__u32 per_cpu_eps; // events per second budget per CPU
	__u32 enabled;     // 0 = pass everything, emit nothing
};

struct rate_state {
	__u64 window_start;
	__u32 count;
	__u32 pad;
};

struct event {
	struct flow_key key;
	__u64 ts;
	__u32 len;
	__u8 tcp_flags;
	__u8 protected;
	__u8 pad[2];
};

enum {
	STAT_SEEN = 0,
	STAT_SAMPLED,
	STAT_DROPPED,
	STAT_PROTECTED,
	STAT_RB_FULL,
	STAT_MAX,
};

struct {
	__uint(type, BPF_MAP_TYPE_LRU_HASH);
	__uint(max_entries, 4096);
	__type(key, struct flow_key);
	__type(value, struct block_val);
} blocklist SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 1024);
	__type(key, struct prot_key);
	__type(value, __u8);
} protected_ports SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_LPM_TRIE);
	__uint(max_entries, 4096);
	__uint(map_flags, BPF_F_NO_PREALLOC);
	__type(key, struct lpm_key);
	__type(value, __u8);
} protected_nets SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_LRU_HASH);
	__uint(max_entries, 16384);
	__type(key, struct flow_key);
	__type(value, __u64);
} flow_seen SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_ARRAY);
	__uint(max_entries, 1);
	__type(key, __u32);
	__type(value, struct config);
} cfg SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
	__uint(max_entries, 1);
	__type(key, __u32);
	__type(value, struct rate_state);
} rate SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
	__uint(max_entries, STAT_MAX);
	__type(key, __u32);
	__type(value, __u64);
} stats SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_RINGBUF);
	__uint(max_entries, 1 << 20);
} events SEC(".maps");

// Force BTF emission for types only used from user space.
const struct event *unused_event __attribute__((unused));

static __always_inline void stat_inc(__u32 idx)
{
	__u64 *v = bpf_map_lookup_elem(&stats, &idx);
	if (v)
		*v += 1;
}

static __always_inline int addr_protected(const __u8 *addr)
{
	struct lpm_key lk = { .prefixlen = 128 };

	__builtin_memcpy(lk.addr, addr, 16);
	return bpf_map_lookup_elem(&protected_nets, &lk) != NULL;
}

static __always_inline int is_protected(struct flow_key *k)
{
	__u8 proto = k->proto;
	__u16 sport = k->sport, dport = k->dport;
	struct prot_key pk = { .proto = proto };

	if (addr_protected(k->saddr) || addr_protected(k->daddr))
		return 1;

	if (bpf_map_lookup_elem(&protected_ports, &pk)) // wildcard
		return 1;
	if (sport) {
		pk.port = sport;
		if (bpf_map_lookup_elem(&protected_ports, &pk))
			return 1;
	}
	if (dport) {
		pk.port = dport;
		if (bpf_map_lookup_elem(&protected_ports, &pk))
			return 1;
	}
	return 0;
}

static __always_inline int rate_allow(struct config *c, __u64 now)
{
	__u32 zero = 0;
	struct rate_state *r = bpf_map_lookup_elem(&rate, &zero);

	if (!r)
		return 0;
	if (now - r->window_start > 1000000000ULL) {
		r->window_start = now;
		r->count = 0;
	}
	if (r->count >= c->per_cpu_eps)
		return 0;
	r->count++;
	return 1;
}

SEC("xdp")
int xdp_shooter(struct xdp_md *ctx)
{
	void *data = (void *)(long)ctx->data;
	void *data_end = (void *)(long)ctx->data_end;
	struct flow_key key = {};
	__u8 tcp_flags = 0;
	__u8 proto;
	void *l4;
	__u32 zero = 0;

	struct config *c = bpf_map_lookup_elem(&cfg, &zero);
	if (!c || !c->enabled)
		return XDP_PASS;

	struct ethhdr *eth = data;
	if ((void *)(eth + 1) > data_end)
		return XDP_PASS;

	__u16 h_proto = eth->h_proto;
	void *l3 = eth + 1;

	if (h_proto == bpf_htons(ETH_P_8021Q_) || h_proto == bpf_htons(ETH_P_8021AD_)) {
		// struct vlan_hdr { __be16 tci; __be16 encapsulated_proto; }
		__be16 *vlan = l3;
		if ((void *)(vlan + 2) > data_end)
			return XDP_PASS;
		h_proto = vlan[1];
		l3 = vlan + 2;
	}

	if (h_proto == bpf_htons(ETH_P_IP)) {
		struct iphdr *ip = l3;
		if ((void *)(ip + 1) > data_end)
			return XDP_PASS;
		if (ip->ihl < 5)
			return XDP_PASS;
		key.family = 4;
		key.saddr[10] = 0xff;
		key.saddr[11] = 0xff;
		key.daddr[10] = 0xff;
		key.daddr[11] = 0xff;
		__builtin_memcpy(&key.saddr[12], &ip->saddr, 4);
		__builtin_memcpy(&key.daddr[12], &ip->daddr, 4);
		proto = ip->protocol;
		// Non-first fragments carry no L4 header.
		if (ip->frag_off & bpf_htons(0x1fff))
			l4 = NULL;
		else
			l4 = (void *)ip + ip->ihl * 4;
	} else if (h_proto == bpf_htons(ETH_P_IPV6)) {
		struct ipv6hdr *ip6 = l3;
		if ((void *)(ip6 + 1) > data_end)
			return XDP_PASS;
		key.family = 6;
		__builtin_memcpy(key.saddr, &ip6->saddr, 16);
		__builtin_memcpy(key.daddr, &ip6->daddr, 16);
		proto = ip6->nexthdr; // extension headers are not walked
		l4 = ip6 + 1;
	} else {
		return XDP_PASS; // ARP and friends are never touched
	}
	key.proto = proto;

	if (l4) {
		if (proto == IPPROTO_TCP) {
			struct tcphdr *th = l4;
			if ((void *)(th + 1) > data_end)
				return XDP_PASS;
			key.sport = bpf_ntohs(th->source);
			key.dport = bpf_ntohs(th->dest);
			tcp_flags = ((__u8 *)th)[13];
		} else if (proto == IPPROTO_UDP) {
			struct udphdr *uh = l4;
			if ((void *)(uh + 1) > data_end)
				return XDP_PASS;
			key.sport = bpf_ntohs(uh->source);
			key.dport = bpf_ntohs(uh->dest);
		} else if (proto == IPPROTO_ICMP || proto == IPPROTO_ICMPV6) {
			__u8 *icmp = l4;
			if ((void *)(icmp + 1) > data_end)
				return XDP_PASS;
			key.dport = icmp[0];
		}
	}

	stat_inc(STAT_SEEN);

	__u8 prot = is_protected(&key);
	if (prot) {
		stat_inc(STAT_PROTECTED);
	} else {
		struct block_val *bv = bpf_map_lookup_elem(&blocklist, &key);
		if (bv) {
			__u64 now = bpf_ktime_get_ns();
			if (bv->expires_ns && now > bv->expires_ns) {
				bpf_map_delete_elem(&blocklist, &key);
			} else {
				__sync_fetch_and_add(&bv->drops, 1);
				stat_inc(STAT_DROPPED);
				return XDP_DROP;
			}
		}
	}

	// Sampling: at most one event per flow per sample_ns, plus a per-CPU budget.
	__u64 now = bpf_ktime_get_ns();
	__u64 *last = bpf_map_lookup_elem(&flow_seen, &key);
	if (last && now - *last < c->sample_ns)
		return XDP_PASS;
	if (!rate_allow(c, now))
		return XDP_PASS;
	bpf_map_update_elem(&flow_seen, &key, &now, BPF_ANY);

	struct event *e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
	if (!e) {
		stat_inc(STAT_RB_FULL);
		return XDP_PASS;
	}
	__builtin_memcpy(&e->key, &key, sizeof(key));
	e->ts = now;
	e->len = (__u32)(data_end - data);
	e->tcp_flags = tcp_flags;
	e->protected = prot;
	e->pad[0] = 0;
	e->pad[1] = 0;
	bpf_ringbuf_submit(e, 0);
	stat_inc(STAT_SAMPLED);

	return XDP_PASS;
}
