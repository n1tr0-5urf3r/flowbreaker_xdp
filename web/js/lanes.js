// Traffic classification: which lane a packet runs in, and whether it looks
// suspicious enough to hurt the host when it gets through.

export const PROTO = { ICMP: 1, TCP: 6, UDP: 17, ICMPV6: 58 };

export const LANES = [
  { key: 'https', name: 'HTTPS', color: 0x4f9dff },
  { key: 'quic', name: 'QUIC', color: 0x9b7bff },
  { key: 'http', name: 'HTTP', color: 0x3fd0c9 },
  { key: 'dns', name: 'DNS', color: 0xf5c542 },
  { key: 'ssh', name: 'SSH', color: 0x5fd068 },
  { key: 'icmp', name: 'ICMP', color: 0xff8a3d },
  { key: 'lan', name: 'LAN', color: 0xe86bd0 },
  { key: 'other', name: 'OTHER', color: 0xff5468 },
];

const LAN_PORTS = new Set([67, 68, 137, 138, 139, 546, 547, 1900, 5353, 5355]);
const WELL_KNOWN = new Set([
  20, 21, 22, 25, 53, 67, 68, 80, 110, 123, 137, 138, 139, 143, 443, 465, 546,
  547, 587, 853, 993, 995, 1900, 3478, 5228, 5353, 5355, 8080, 8443,
]);

const isTCP = (p) => p.proto === PROTO.TCP;
const isUDP = (p) => p.proto === PROTO.UDP;
const isICMP = (p) => p.proto === PROTO.ICMP || p.proto === PROTO.ICMPV6;

// The remote "service" port of an ingress packet: usually the source port of
// a reply, or the destination port of an inbound connection attempt.
export function servicePort(p) {
  if (WELL_KNOWN.has(p.sp)) return p.sp;
  if (WELL_KNOWN.has(p.dp)) return p.dp;
  return Math.min(p.sp, p.dp);
}

export function classify(p) {
  if (isICMP(p)) return LANES.findIndex((l) => l.key === 'icmp');
  const port = servicePort(p);
  let key = 'other';
  if (LAN_PORTS.has(p.sp) || LAN_PORTS.has(p.dp)) key = 'lan';
  else if (port === 53 || port === 853) key = 'dns';
  else if (port === 22) key = 'ssh';
  else if (isTCP(p) && (port === 443 || port === 8443)) key = 'https';
  else if (isUDP(p) && port === 443) key = 'quic';
  else if (isTCP(p) && (port === 80 || port === 8080)) key = 'http';
  return LANES.findIndex((l) => l.key === key);
}

const TCP_SYN = 0x02;
const TCP_ACK = 0x10;

export const isSyn = (p) => isTCP(p) && (p.flags & TCP_SYN) && !(p.flags & TCP_ACK);

// Heuristic "threat": unsolicited inbound connection attempts, pings, and
// UDP to ports nobody advertises.
export function isSuspicious(p) {
  if (p.prot) return false;
  if (isSyn(p)) return !WELL_KNOWN.has(p.dp) || p.dp === 23;
  if (p.proto === PROTO.ICMP) return p.dp === 8; // echo request
  if (p.proto === PROTO.ICMPV6) return p.dp === 128;
  if (isUDP(p)) return !WELL_KNOWN.has(p.sp) && !WELL_KNOWN.has(p.dp) && p.dp < 1024;
  return false;
}

export function protoName(p) {
  switch (p.proto) {
    case PROTO.TCP: return 'TCP';
    case PROTO.UDP: return 'UDP';
    case PROTO.ICMP: return 'ICMP';
    case PROTO.ICMPV6: return 'ICMPv6';
  }
  return `IP${p.proto}`;
}

export function tcpFlags(f) {
  const names = [[0x01, 'F'], [0x02, 'S'], [0x04, 'R'], [0x08, 'P'], [0x10, 'A'], [0x20, 'U']];
  return names.filter(([b]) => f & b).map(([, n]) => n).join('') || '·';
}

export const hostPort = (a, port) => (a.includes(':') ? `[${a}]:${port}` : `${a}:${port}`);

export function shortLabel(p) {
  if (isICMP(p)) return `${p.src} t${p.dp}`;
  return hostPort(p.src, p.sp);
}

// Stable per-flow hue so sprites of the same flow are recognisable.
export function flowTint(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return hslToHex(hue, 85, 65);
}

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return (f(0) << 16) | (f(8) << 8) | f(4);
}
