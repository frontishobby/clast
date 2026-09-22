import { joinRoom, selfId, type Room } from 'trystero/nostr';
import { Pairing, type PairTag } from './pairing.ts';
import type { Link, NetMessage } from './protocol.ts';

/**
 * Matchmaking over Trystero. No server of our own: peers find each other
 * through public relays and then talk directly over WebRTC.
 */

const APP_ID = 'clast-arena-v1';
const LOBBY_ROOM = 'lobby-v1';

/**
 * Signalling relays, pinned rather than left to trystero's defaults.
 *
 * The default list includes relays that come and go; one of them was returning
 * 502 during testing, which costs a failed WebSocket handshake on every single
 * connection attempt. These are the long-lived public nostr relays, and the
 * redundancy means a couple of them can be down without anyone noticing.
 *
 * Relays only carry the WebRTC offer/answer handshake. Once two peers are
 * connected, every byte of the match goes directly between them.
 */
const RELAY_URLS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.nostr.band',
  'wss://nostr.mom',
  'wss://relay.snort.social',
];
const RELAY_REDUNDANCY = 4;

export type MatchIntent =
  | { kind: 'random' }
  | { kind: 'create'; code: string }
  | { kind: 'join'; code: string };

export interface Match {
  link: Link;
  /** Lower peer id hosts, so both sides independently agree without asking. */
  isHost: boolean;
  peerId: string;
  leave(): void;
}

export interface MatchOptions {
  onStatus?: (status: string) => void;
  signal?: AbortSignal;
}

const roomIdFor = (intent: MatchIntent): string =>
  intent.kind === 'random' ? LOBBY_ROOM : `code-${intent.code}`;

class TrysteroLink implements Link {
  private handler: ((msg: NetMessage) => void) | null = null;
  private closer: ((reason: string) => void) | null = null;
  private closed = false;

  private readonly sendRaw: (msg: NetMessage, to: string) => void;
  private readonly peerId: string;
  private readonly onDispose: () => void;

  constructor(
    sendRaw: (msg: NetMessage, to: string) => void,
    peerId: string,
    onDispose: () => void,
  ) {
    this.sendRaw = sendRaw;
    this.peerId = peerId;
    this.onDispose = onDispose;
  }

  send(msg: NetMessage): void {
    if (this.closed) return;
    this.sendRaw(msg, this.peerId);
  }

  onMessage(cb: (msg: NetMessage) => void): void {
    this.handler = cb;
  }

  onClose(cb: (reason: string) => void): void {
    this.closer = cb;
  }

  /** Called by the room when something arrives from our partner. */
  deliver(msg: NetMessage): void {
    if (!this.closed) this.handler?.(msg);
  }

  fail(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closer?.(reason);
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closer?.(reason);
    this.onDispose();
  }
}

/**
 * Joins the right room and resolves once a partner is locked in.
 * The handshake itself lives in Pairing, which knows nothing about Trystero.
 */
export function findMatch(intent: MatchIntent, opts: MatchOptions = {}): Promise<Match> {
  return new Promise<Match>((resolve, reject) => {
    const { onStatus, signal } = opts;
    const room: Room = joinRoom(
      { appId: APP_ID, relayUrls: RELAY_URLS, relayRedundancy: RELAY_REDUNDANCY },
      roomIdFor(intent),
    );

    const pairAction = room.makeAction<PairTag>('pair');
    const gameAction = room.makeAction<NetMessage>('game');

    let link: TrysteroLink | null = null;
    let settled = false;

    const status = (text: string) => onStatus?.(text);

    const cleanup = () => {
      clearInterval(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    const leave = () => {
      cleanup();
      room.leave();
    };

    const fail = (reason: string) => {
      if (settled) return;
      settled = true;
      leave();
      reject(new Error(reason));
    };

    const onAbort = () => fail('cancelled');

    const pairing = new Pairing(
      selfId,
      (tag, to) => void pairAction.send(tag, { target: to }),
      (peerId) => {
        if (settled) return;
        settled = true;
        cleanup();
        link = new TrysteroLink(
          (msg, to) => void gameAction.send(msg, { target: to }),
          peerId,
          () => room.leave(),
        );
        status('connected');
        resolve({ link, isHost: pairing.isHost, peerId, leave });
      },
    );

    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }

    room.onPeerJoin = (peerId) => {
      status(intent.kind === 'random' ? 'opponent found, connecting' : 'connecting');
      pairing.addPeer(peerId);
    };

    room.onPeerLeave = (peerId) => {
      const wasPartner = pairing.matchedWith === peerId;
      pairing.removePeer(peerId);
      if (wasPartner) link?.fail('opponent disconnected');
    };

    pairAction.onMessage = (tag, ctx) => pairing.receive(tag, ctx.peerId);
    gameAction.onMessage = (msg, ctx) => {
      if (pairing.matchedWith === ctx.peerId) link?.deliver(msg);
    };

    const timer = setInterval(() => pairing.tick(), 1000);

    status(
      intent.kind === 'random'
        ? 'looking for an opponent'
        : intent.kind === 'create'
          ? 'waiting for someone to join'
          : 'joining',
    );
  });
}

export { selfId };
