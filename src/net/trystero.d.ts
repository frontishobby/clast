/**
 * Hand-written types for trystero, which ships none.
 *
 * These were originally written from memory of the pre-0.25 tuple API
 * (`const [send, recv] = room.makeAction(...)`, `room.onPeerJoin(cb)`), which
 * typechecked perfectly against itself and blew up at runtime. They are now
 * transcribed from node_modules/@trystero-p2p/core/dist -- if trystero is
 * upgraded, re-read that source rather than trusting these.
 */
declare module 'trystero/nostr' {
  export interface MessageContext {
    peerId: string;
    metadata?: Record<string, unknown>;
  }

  export interface SendOptions {
    /** Omit to broadcast to every peer in the room. */
    target?: string | string[];
    metadata?: Record<string, unknown>;
    signal?: AbortSignal;
  }

  export interface Action<T> {
    send(data: T, options?: SendOptions): Promise<void>;
    onMessage: ((data: T, context: MessageContext) => void) | null;
  }

  export interface Room {
    makeAction<T>(type: string): Action<T>;
    leave(): void;
    ping(peerId: string): Promise<number>;
    getPeers(): Record<string, RTCPeerConnection>;
    onPeerJoin: ((peerId: string) => void) | null;
    onPeerLeave: ((peerId: string) => void) | null;
  }

  export interface RoomConfig {
    appId: string;
    password?: string;
    relayUrls?: string[];
    relayRedundancy?: number;
    rtcConfig?: RTCConfiguration;
  }

  export function joinRoom(config: RoomConfig, roomId: string): Room;
  export const selfId: string;
  export const defaultRelayUrls: string[];
}
