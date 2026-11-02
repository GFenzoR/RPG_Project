import { describe, expect, it } from "vitest";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  ClientMessageSchema,
  Direction,
  ServerBatchSchema,
  create,
  decodeServerBatch,
  encodeClientMessage,
} from "./index.ts";

describe("@rpg/protocol codecs", () => {
  it("encodes a ClientMessage that decodes back", () => {
    const msg = create(ClientMessageSchema, {
      message: { case: "walk", value: { dir: Direction.EAST } },
    });
    const decoded = fromBinary(ClientMessageSchema, encodeClientMessage(msg));
    expect(decoded.message.case).toBe("walk");
    expect(decoded.message.value).toMatchObject({ dir: Direction.EAST });
  });

  it("decodes a ServerBatch", () => {
    const batch = create(ServerBatchSchema, {
      tick: 42n,
      events: [{ message: { case: "pong", value: { clientTime: 1n, serverTime: 2n } } }],
    });
    const decoded = decodeServerBatch(toBinary(ServerBatchSchema, batch));
    expect(decoded.tick).toBe(42n);
    expect(decoded.events[0]?.message.case).toBe("pong");
  });
});
