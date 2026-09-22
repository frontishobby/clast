/**
 * ICE setup and the two things worth knowing about a connection: what this
 * network looks like from outside, and which path a match actually took.
 *
 * There is no TURN server, so a match only connects when the two peers can
 * reach each other directly. IPv6 is the way around the NAT that blocks
 * that. Carrier networks here hand out global IPv6 addresses, and IPv6 has
 * no NAT, so two phones stuck behind symmetric IPv4 CGNAT can still connect
 * over v6. Browsers hide host addresses behind mDNS names, so a public v6
 * address only reaches the other side as a server-reflexive candidate. That
 * takes a STUN server we can reach over IPv6. Both of these publish AAAA
 * records, and the browser resolves each hostname per address family.
 */
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

export type Family = 'v4' | 'v6';

export interface Candidate {
  address: string;
  port: number;
  type: string;
  family: Family;
}

/** Parses an SDP `candidate:` line. Returns null for anything else, including mDNS hosts. */
export function parseCandidate(line: string): Candidate | null {
  const f = line.replace(/^a=/, '').split(' ');
  if (f.length < 8 || !f[0]!.startsWith('candidate:') || f[6] !== 'typ') return null;
  const address = f[4]!;
  if (address.endsWith('.local')) return null;
  return {
    address,
    port: Number(f[5]),
    type: f[7]!,
    family: address.includes(':') ? 'v6' : 'v4',
  };
}

export interface NetworkProbe {
  /** A public IPv6 address the other side can reach. */
  v6: boolean;
  /** How IPv4 is translated on the way out; 'none' when STUN got no IPv4 answer at all. */
  v4: 'none' | 'nat' | 'symmetric';
}

/**
 * Reads the NAT off the server-reflexive candidates from two STUN servers.
 * A cone NAT keeps one public port for a socket whatever it talks to, so
 * both servers report the same mapping. A symmetric one picks a new port per
 * destination, so the same public address shows up with different ports.
 * The ports are only compared within one public address, because a phone on
 * Wi-Fi and cellular at once has two unrelated mappings.
 */
export function summarize(candidates: Candidate[]): NetworkProbe {
  const reflexive = candidates.filter((c) => c.type === 'srflx');
  const ports = new Map<string, Set<number>>();
  for (const c of reflexive) {
    if (c.family !== 'v4') continue;
    const set = ports.get(c.address) ?? new Set<number>();
    set.add(c.port);
    ports.set(c.address, set);
  }
  return {
    v6: reflexive.some((c) => c.family === 'v6'),
    v4:
      ports.size === 0
        ? 'none'
        : [...ports.values()].some((set) => set.size > 1)
          ? 'symmetric'
          : 'nat',
  };
}

export function describeProbe(p: NetworkProbe): string {
  return `ipv6 ${p.v6 ? 'ok' : 'none'}  ·  ipv4 ${p.v4}`;
}

/**
 * Gathers candidates on a throwaway connection that never talks to anyone.
 * Resolves with whatever turned up once gathering ends or the time runs out.
 */
export function probeNetwork(timeoutMs = 4000): Promise<NetworkProbe> {
  return new Promise((resolve) => {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const found: Candidate[] = [];
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      pc.close();
      resolve(summarize(found));
    };

    pc.onicecandidate = (e) => {
      if (!e.candidate) return finish();
      const c = parseCandidate(e.candidate.candidate);
      if (c) found.push(c);
    };
    const timer = setTimeout(finish, timeoutMs);

    pc.createDataChannel('probe');
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .catch(finish);
  });
}

/**
 * Names the candidate pair a live connection settled on, e.g. "p2p ipv6".
 * Our own side of the pair is reported as its host candidate even when a NAT
 * sat in the way, since a reflexive candidate shares its host's socket. The
 * remote side is what tells a LAN apart: across the internet it can only be
 * reflexive, because the host addresses it offered were mDNS names.
 */
export async function describeRoute(pc: RTCPeerConnection): Promise<string | null> {
  const stats = await pc.getStats();
  let pair: RTCIceCandidatePairStats | undefined;
  stats.forEach((s) => {
    // Chrome and Safari point at the pair from the transport; Firefox flags the pair itself.
    if (s.type === 'transport' && s.selectedCandidatePairId) pair ??= stats.get(s.selectedCandidatePairId);
    else if (s.type === 'candidate-pair' && s.selected) pair ??= s;
  });
  if (!pair) return null;

  const local = stats.get(pair.localCandidateId);
  const remote = stats.get(pair.remoteCandidateId);
  if (!local?.candidateType || !remote?.candidateType) return null;
  const kind =
    local.candidateType === 'relay' || remote.candidateType === 'relay'
      ? 'relayed'
      : remote.candidateType === 'host'
        ? 'lan'
        : 'p2p';
  const address: string = local.address ?? local.ip ?? '';
  return `${kind} ${address.includes(':') ? 'ipv6' : 'ipv4'}`;
}
