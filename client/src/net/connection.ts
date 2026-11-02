// Game WebSocket (docs/05, "Handshake"): opens /ws on the page's host, sends Hello with the
// one-use session token and hands every ServerBatch to the caller. One ClientMessage per
// binary frame out, one ServerBatch per frame in.
import { ClientMessageSchema, create, decodeServerBatch, encodeClientMessage } from "@rpg/protocol";
import type { DisconnectReason, MessageInitShape, ServerBatch } from "@rpg/protocol";

/** One intent, e.g. `{ case: "walk", value: { dir } }`. */
export type Intent = NonNullable<MessageInitShape<typeof ClientMessageSchema>["message"]>;

/** Sent in Hello; the server accepts the same major version, not older than its minimum. */
export const CLIENT_VERSION = "0.1.0";

export interface ConnectionHandlers {
  batch(batch: ServerBatch): void;
  /** The socket closed. `reason` comes from the server's Disconnect, if it sent one. */
  closed(reason: DisconnectReason | undefined): void;
}

export class Connection {
  private readonly ws: WebSocket;
  private reason: DisconnectReason | undefined;
  private closedOnce = false;

  constructor(sessionToken: string, locale: string, handlers: ConnectionHandlers) {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    this.ws = new WebSocket(`${scheme}://${location.host}/ws`);
    this.ws.binaryType = "arraybuffer";
    this.ws.onopen = () => {
      this.send({ case: "hello", value: { sessionToken, clientVersion: CLIENT_VERSION, locale } });
    };
    this.ws.onmessage = (ev: MessageEvent) => {
      if (!(ev.data instanceof ArrayBuffer)) return; // the server only sends binary frames
      let batch: ServerBatch;
      try {
        batch = decodeServerBatch(new Uint8Array(ev.data));
      } catch {
        this.ws.close();
        return;
      }
      for (const e of batch.events)
        if (e.message.case === "disconnect") this.reason = e.message.value.reason;
      handlers.batch(batch);
    };
    this.ws.onclose = () => {
      if (this.closedOnce) return;
      this.closedOnce = true;
      handlers.closed(this.reason);
    };
  }

  /** Sends one intent. Dropped silently if the socket is not open. */
  send(message: Intent): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    const frame = encodeClientMessage(create(ClientMessageSchema, { message }));
    this.ws.send(frame as Uint8Array<ArrayBuffer>);
  }

  /** Asks the server to log out; it answers with Disconnect{LOGGED_OUT} and closes. */
  logout(): void {
    this.send({ case: "logout", value: {} });
  }

  close(): void {
    this.ws.close();
  }
}
