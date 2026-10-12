// Connection to flowbreaker. Messages are dispatched to handlers by their "t"
// field. With ?demo=1 a local simulator stands in for the daemon so the UI
// can be developed without root.

export class Connection {
  constructor(handlers) {
    this.handlers = handlers;
    this.ws = null;
    this.backoff = 500;
    this.hbTimer = null;
  }

  connect() {
    const params = new URLSearchParams(location.search);
    if (params.has('demo')) {
      this.sim = new Simulator((m) => this.dispatch(m));
      this.handlers.status?.('demo');
      return;
    }
    const token = params.get('token');
    if (!token) {
      this.handlers.status?.('notoken');
      return;
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);
    this.ws.onopen = () => {
      this.backoff = 500;
      this.handlers.status?.('online');
      clearInterval(this.hbTimer);
      this.hbTimer = setInterval(() => this.send({ t: 'hb' }), 3000);
    };
    this.ws.onmessage = (ev) => {
      try { this.dispatch(JSON.parse(ev.data)); } catch (e) { console.error(e); }
    };
    this.ws.onclose = () => {
      clearInterval(this.hbTimer);
      this.handlers.status?.('offline');
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 8000);
    };
  }

  dispatch(m) {
    this.handlers[m.t]?.(m);
  }

  send(m) {
    if (this.sim) return this.sim.handle(m);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }
}

// ---------------------------------------------------------------- simulator

class Simulator {
  constructor(emit) {
    this.emit = emit;
    this.flows = [];
    this.all = new Map(); // every flow ever emitted, like the daemon's registry
    this.blocked = new Map(); // id -> {label, drops, expires}
    this.stats = { seen: 0, sampled: 0, dropped: 0, protected: 0, rbFull: 0 };
    this.ttl = 60;
    emit({ t: 'hello', hello: { iface: 'demo0', mode: 'simulated', protect: ['tcp:22', 'tcp:53', 'udp:53', 'udp:67-68', 'udp:546-547', 'icmpv6:133-137'], protectHosts: ['api.anthropic.com', 'claude.ai'], ttl: this.ttl, maxEps: 150 } });
    for (let i = 0; i < 14; i++) this.flows.push(this.randomFlow());
    setInterval(() => this.tick(), 100);
    setInterval(() => this.slow(), 500);
  }

  randomFlow() {
    const r = Math.random();
    const ip = () => `${1 + ((Math.random() * 222) | 0)}.${(Math.random() * 255) | 0}.${(Math.random() * 255) | 0}.${1 + ((Math.random() * 253) | 0)}`;
    const eph = () => 32768 + ((Math.random() * 28000) | 0);
    let f;
    if (r < 0.35) f = { proto: 6, sp: 443, dp: eph(), flags: 0x18 };
    else if (r < 0.5) f = { proto: 17, sp: 443, dp: eph(), flags: 0 };
    else if (r < 0.58) f = { proto: 6, sp: 80, dp: eph(), flags: 0x10 };
    else if (r < 0.68) f = { proto: 17, sp: 53, dp: eph(), flags: 0, prot: true };
    else if (r < 0.72) f = { proto: 6, sp: eph(), dp: 22, flags: 0x10, prot: true };
    else if (r < 0.8) f = { proto: 1, sp: 0, dp: Math.random() < 0.5 ? 0 : 8, flags: 0 };
    else if (r < 0.87) f = { proto: 17, sp: 5353, dp: 5353, flags: 0, src: `192.168.1.${(Math.random() * 250) | 0}` };
    else if (r < 0.94) f = { proto: 6, sp: eph(), dp: [23, 445, 3389, 8081][(Math.random() * 4) | 0], flags: 0x02 };
    else f = { proto: 17, sp: eph(), dp: [111, 161, 500][(Math.random() * 3) | 0], flags: 0 };
    f.src = f.src || ip();
    f.dst = '192.168.1.42';
    f.id = Math.random().toString(16).slice(2, 14);
    f.prot = !!f.prot;
    f.rate = 0.3 + Math.random() * 3; // samples per second
    f.life = 5 + Math.random() * 40;
    f.len = f.proto === 6 && f.sp === 443 ? 1500 : 60 + ((Math.random() * 400) | 0);
    this.all.set(f.id, f);
    return f;
  }

  label(f) {
    const p = { 1: 'icmp', 6: 'tcp', 17: 'udp' }[f.proto];
    return f.proto === 1 ? `icmp type ${f.dp} ${f.src} → ${f.dst}` : `${p} ${f.src}:${f.sp} → ${f.dst}:${f.dp}`;
  }

  tick() {
    const pkts = [];
    for (const f of this.flows) {
      f.life -= 0.1;
      const n = Math.random() < f.rate * 0.1 ? 1 : 0;
      this.stats.seen += 1 + ((Math.random() * 20) | 0);
      if (!n) continue;
      const b = this.blocked.get(f.id);
      if (b && !f.prot) {
        b.drops += 1 + ((Math.random() * 8) | 0);
        this.stats.dropped++;
        continue;
      }
      this.stats.sampled++;
      pkts.push({ id: f.id, src: f.src, dst: f.dst, sp: f.sp, dp: f.dp, proto: f.proto, len: f.len, flags: f.flags, prot: f.prot });
    }
    this.flows = this.flows.filter((f) => f.life > 0);
    while (this.flows.length < 14) this.flows.push(this.randomFlow());
    if (pkts.length) this.emit({ t: 'batch', pkts });
  }

  slow() {
    const now = performance.now() / 1000;
    const rules = [];
    for (const [id, b] of this.blocked) {
      const left = b.expires - now;
      if (left <= 0) { this.blocked.delete(id); continue; }
      rules.push({ id, label: b.label, drops: b.drops, expiresIn: left });
    }
    this.emit({ t: 'stats', stats: { ...this.stats } });
    this.emit({ t: 'rules', rules });
  }

  handle(m) {
    const f = this.all.get(m.id);
    switch (m.t) {
      case 'kill':
        if (!f) return this.emit({ t: 'error', id: m.id, msg: 'unknown flow' });
        if (f.prot) return this.emit({ t: 'deflect', id: m.id, label: this.label(f) });
        this.blocked.set(m.id, { label: this.label(f), drops: this.blocked.get(m.id)?.drops ?? 0, expires: performance.now() / 1000 + this.ttl });
        return this.emit({ t: 'killed', id: m.id, label: this.label(f) });
      case 'unblock':
        this.blocked.delete(m.id);
        return;
      case 'panic': {
        const n = this.blocked.size;
        this.blocked.clear();
        return this.emit({ t: 'panicked', n });
      }
    }
  }
}
