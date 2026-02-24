// deno-lint-ignore-file no-explicit-any

/**
 * Test suite for ReconnectingWebSocket.
 *
 * Run:
 * - Deno: `deno test -A mod.test.ts`
 * - Node.js: `node --test mod.test.ts`
 * - Bun: `bun test --timeout 30000 mod.test.ts`
 */

import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { Buffer } from "node:buffer";
import process from "node:process";
import { describe, it } from "node:test";
import { ReconnectingWebSocket, ReconnectingWebSocketError } from "./mod.ts";

// ============================================================
// Test infrastructure
// ============================================================

type ReconnectingWebSocketWithInternals = DisposableReconnectingWebSocket & {
  _messageBuffer: ReconnectingWebSocket["_messageBuffer"];
  _socket: ReconnectingWebSocket["_socket"];
};

class DisposableReconnectingWebSocket extends ReconnectingWebSocket implements Disposable {
  [Symbol.dispose](): void {
    if (!this.isTerminated) this.close();
  }
}

// ============================================================
// Echo server
// ============================================================

interface EchoServer {
  port: number;
  shutdown(): Promise<void>;
}

// Platform-specific WebSocket echo server
async function createEchoServer(): Promise<EchoServer> {
  // Deno — Deno.serve + Deno.upgradeWebSocket (no types in shared context)
  if ("Deno" in globalThis) {
    const Deno = (globalThis as any).Deno;

    const server = Deno.serve({ port: 0 }, async (req: Request) => {
      if (req.headers.get("upgrade") !== "websocket") {
        return new Response(null, { status: 501 });
      }

      const url = new URL(req.url);
      const protocol = req.headers.get("sec-websocket-protocol") ?? undefined;

      const delay = url.searchParams.has("delay") ? parseInt(url.searchParams.get("delay")!) : 0;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));

      const { socket, response } = Deno.upgradeWebSocket(req, { protocol });
      socket.onmessage = (e: MessageEvent) => socket.send(e.data);

      return response;
    });
    return {
      port: server.addr.port,
      shutdown: () => server.shutdown(),
    };
  }

  // Bun — Bun.serve with websocket handler (no types in shared context)
  if ("Bun" in globalThis) {
    const Bun = (globalThis as any).Bun;

    const server = Bun.serve({
      port: 0,
      fetch(req: Request, server: { upgrade(req: Request): boolean }): Response | undefined {
        if (req.headers.get("upgrade") !== "websocket") {
          return new Response(null, { status: 501 });
        }
        server.upgrade(req);
      },
      websocket: {
        message(ws: { send(msg: string | ArrayBuffer): void }, msg: string | ArrayBuffer): void {
          ws.send(msg);
        },
      },
    });

    return {
      port: server.port,
      shutdown: () => server.stop(true),
    };
  }

  // Node.js — node:http + manual WebSocket handshake
  const http = await import("node:http");
  const crypto = await import("node:crypto");

  const httpServer = http.createServer((_req, res) => {
    res.writeHead(501);
    res.end();
  });

  httpServer.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }

    const url = new URL(req.url!, `http://${req.headers.host}`);
    const delay = url.searchParams.has("delay") ? parseInt(url.searchParams.get("delay")!) : 0;

    const completeHandshake = (): void => {
      const protocol = req.headers["sec-websocket-protocol"];
      const acceptKey = crypto.createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");

      let responseHeaders = "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${acceptKey}\r\n`;

      if (protocol) {
        const chosen = protocol.split(",")[0]!.trim();
        responseHeaders += `Sec-WebSocket-Protocol: ${chosen}\r\n`;
      }
      responseHeaders += "\r\n";
      socket.write(responseHeaders);

      // Minimal WebSocket frame parser for echo
      socket.on("data", (data: Buffer) => {
        let offset = 0;
        while (offset < data.length) {
          const firstByte = data[offset]!;
          const opcode = firstByte & 0x0f;
          const secondByte = data[offset + 1]!;
          const isMasked = (secondByte & 0x80) !== 0;
          let payloadLength = secondByte & 0x7f;
          offset += 2;

          if (payloadLength === 126) {
            payloadLength = data.readUInt16BE(offset);
            offset += 2;
          } else if (payloadLength === 127) {
            payloadLength = Number(data.readBigUInt64BE(offset));
            offset += 8;
          }

          let maskKey: Buffer | null = null;
          if (isMasked) {
            maskKey = data.subarray(offset, offset + 4);
            offset += 4;
          }

          const payload = Buffer.from(data.subarray(offset, offset + payloadLength));
          offset += payloadLength;

          if (isMasked && maskKey) {
            for (let i = 0; i < payload.length; i++) {
              payload[i] = payload[i]! ^ maskKey[i % 4]!;
            }
          }

          // 0x8 = Close frame
          if (opcode === 0x8) {
            socket.write(Buffer.from([0x88, 0x00]));
            socket.end();
            return;
          }

          // Echo text (0x1) and binary (0x2) frames
          if (opcode === 0x1 || opcode === 0x2) {
            const frameHeader: number[] = [];
            frameHeader.push(0x80 | opcode); // FIN + opcode
            if (payload.length < 126) {
              frameHeader.push(payload.length);
            } else if (payload.length < 65536) {
              frameHeader.push(126);
              frameHeader.push((payload.length >> 8) & 0xff);
              frameHeader.push(payload.length & 0xff);
            }
            socket.write(Buffer.concat([Buffer.from(frameHeader), payload]));
          }
        }
      });
    };

    if (delay > 0) setTimeout(completeHandshake, delay);
    else completeHandshake();
  });

  const port = await new Promise<number>((resolve) => {
    httpServer.listen(0, () => {
      resolve((httpServer.address() as { port: number }).port);
    });
  });
  httpServer.unref();

  return {
    port,
    shutdown: () =>
      new Promise((resolve) => {
        httpServer.close(() => resolve());
      }),
  };
}

// TCP server that accepts connections but never sends a response — for connectionTimeout tests
async function createHangingServer(): Promise<{ port: number; shutdown(): void }> {
  const net = await import("node:net");
  const server = net.createServer((socket) => {
    // Accept connection but never respond — WebSocket handshake will hang
    socket.unref();
    socket.on("error", () => {}); // Ignore client disconnects
  });
  server.unref();

  const port = await new Promise<number>((resolve) => {
    server.listen(0, () => {
      resolve((server.address() as { port: number }).port);
    });
  });

  return {
    port,
    shutdown: () => server.close(),
  };
}

const echoServer = await createEchoServer();
const WS_URL = `ws://localhost:${echoServer.port}`;
const INVALID_WS_URL = "ws://invalid4567t7281.com";

// TCP server that accepts connections but never responds — for connectionTimeout tests
const hangingServer = await createHangingServer();
const HANGING_URL = `ws://localhost:${hangingServer.port}`;

process.on("exit", () => {
  echoServer.shutdown();
  hangingServer.shutdown();
});

// ============================================================
// Tests
// ============================================================

describe("ReconnectingWebSocket", () => {
  // --- Constructor ------------------------------------------------------------

  describe("Constructor", () => {
    it("on* handlers default to null and round-trip correctly", () => {
      using rws = new DisposableReconnectingWebSocket(WS_URL);

      for (const prop of ["onopen", "onclose", "onerror", "onmessage"] as const) {
        strictEqual(rws[prop], null, `${prop} should default to null`);

        const handler = () => {};
        rws[prop] = handler;
        strictEqual(rws[prop], handler, `${prop} getter should return the assigned handler`);

        rws[prop] = null;
        strictEqual(rws[prop], null, `${prop} should be null after reset`);
      }
    });

    it("uses custom WebSocket implementation", () => {
      class CustomWebSocket extends WebSocket {}
      using rws = new DisposableReconnectingWebSocket(WS_URL, {
        WebSocket: CustomWebSocket,
      }) as ReconnectingWebSocketWithInternals;

      ok(rws._socket instanceof CustomWebSocket);
    });

    it("throws when no WebSocket implementation is available", () => {
      const original = globalThis.WebSocket;
      // @ts-expect-error — Intentionally removing global constructor for test
      globalThis.WebSocket = undefined;

      try {
        throws(
          () => new DisposableReconnectingWebSocket(WS_URL),
          TypeError,
        );
      } finally {
        globalThis.WebSocket = original;
      }
    });
  });

  // --- Reconnection ------------------------------------------------------------

  describe("Reconnection", () => {
    describe("url", () => {
      it("supports dynamic URL via function", async () => {
        let callCount = 0;
        using rws = new DisposableReconnectingWebSocket(() => {
          callCount++;
          return WS_URL;
        }, { maxRetries: 2, reconnectionDelay: 0 });

        strictEqual(callCount, 1);

        await new Promise((r) => rws.addEventListener("open", r, { once: true }));
        rws.close(undefined, undefined, false);
        await new Promise((r) => rws.addEventListener("open", r, { once: true }));

        strictEqual(callCount, 2);
      });
    });

    describe("protocols", () => {
      it("retains chosen protocol across reconnect", async () => {
        using rws = new DisposableReconnectingWebSocket(WS_URL, "superchat");

        await new Promise((r) => rws.addEventListener("open", r, { once: true }));
        strictEqual(rws.protocol, "superchat");

        rws.close(undefined, undefined, false);

        await new Promise((r) => rws.addEventListener("open", r, { once: true }));
        strictEqual(rws.protocol, "superchat");
      });

      it("supports dynamic protocols via function", async () => {
        let callCount = 0;
        using rws = new DisposableReconnectingWebSocket(
          WS_URL,
          () => {
            callCount++;
            return "superchat";
          },
          { maxRetries: 2, reconnectionDelay: 0 },
        );

        strictEqual(callCount, 1);

        await new Promise((r) => rws.addEventListener("open", r, { once: true }));
        strictEqual(rws.protocol, "superchat");

        rws.close(undefined, undefined, false);
        await new Promise((r) => rws.addEventListener("open", r, { once: true }));

        strictEqual(callCount, 2);
        strictEqual(rws.protocol, "superchat");
      });
    });

    describe("binaryType", () => {
      it("preserves binaryType across reconnection", async () => {
        using rws = new DisposableReconnectingWebSocket(WS_URL, {
          maxRetries: 1,
          reconnectionDelay: 0,
        });

        rws.binaryType = "arraybuffer";

        await new Promise((r) => rws.addEventListener("open", r, { once: true }));
        rws.close(undefined, undefined, false);
        await new Promise((r) => rws.addEventListener("open", r, { once: true }));

        strictEqual(rws.binaryType, "arraybuffer");
      });
    });

    describe("maxRetries", () => {
      it("respects maxRetries limit", async () => {
        using rws = new DisposableReconnectingWebSocket(INVALID_WS_URL, {
          maxRetries: 2,
          reconnectionDelay: 0,
        });

        let closeCount = 0;
        rws.addEventListener("close", () => closeCount++);

        await new Promise((r) => rws.addEventListener("terminate", r, { once: true }));

        ok(rws.isTerminated);
        // 1 initial + 2 retries = 3 close events
        strictEqual(closeCount, 3);
      });
    });

    describe("connectionTimeout", () => {
      it("disabled when set to null", async () => {
        const defaultTimeout = (() => {
          using probe = new DisposableReconnectingWebSocket("ws://example.com");
          return probe.reconnectOptions.connectionTimeout!;
        })();

        using rws = new DisposableReconnectingWebSocket(HANGING_URL, {
          connectionTimeout: null,
        });

        await new Promise((r) => setTimeout(r, defaultTimeout + 2000));

        strictEqual(rws.readyState, WebSocket.CONNECTING);
      });

      it("fires if not opened in time", async () => {
        using rws = new DisposableReconnectingWebSocket(HANGING_URL, {
          maxRetries: 0,
          connectionTimeout: 100,
        });

        await new Promise((r) => rws.addEventListener("terminate", r, { once: true }));

        ok(rws.isTerminated);
      });
    });

    describe("reconnectionDelay", () => {
      it("custom delay (number)", async () => {
        const customDelay = 500;
        using rws = new DisposableReconnectingWebSocket(INVALID_WS_URL, {
          maxRetries: 2,
          reconnectionDelay: customDelay,
        });

        const closeTimes: number[] = [];
        rws.addEventListener("close", () => closeTimes.push(performance.now()));

        await new Promise((r) => rws.addEventListener("terminate", r, { once: true }));

        for (let i = 1; i < closeTimes.length; i++) {
          const diff = closeTimes[i]! - closeTimes[i - 1]!;
          ok(diff >= customDelay - 5, `Gap #${i}: expected >= ${customDelay}ms, got ${diff}ms`);
        }
      });

      it("custom delay (function)", async () => {
        const delays = [200, 500];
        using rws = new DisposableReconnectingWebSocket(INVALID_WS_URL, {
          maxRetries: delays.length,
          reconnectionDelay: (attempt) => delays[attempt] ?? delays[delays.length - 1]!,
        });

        const closeTimes: number[] = [];
        rws.addEventListener("close", () => closeTimes.push(performance.now()));

        await new Promise((r) => rws.addEventListener("terminate", r, { once: true }));

        for (let i = 1; i < closeTimes.length; i++) {
          const diff = closeTimes[i]! - closeTimes[i - 1]!;
          const expected = delays[i - 1] ?? delays[delays.length - 1]!;
          ok(diff >= expected - 5, `Gap #${i}: expected >= ${expected}ms, got ${diff}ms`);
        }
      });

      it("errors thrown by reconnectionDelay terminate the instance", async () => {
        const delayError = new Error("boom");
        using rws = new DisposableReconnectingWebSocket(INVALID_WS_URL, {
          maxRetries: 1,
          reconnectionDelay: () => {
            throw delayError;
          },
        });

        await new Promise((r) => rws.addEventListener("terminate", r, { once: true }));

        ok(rws.isTerminated);
        ok(rws.terminationReason instanceof ReconnectingWebSocketError);
        strictEqual(rws.terminationReason.code, "UNKNOWN_ERROR");
        strictEqual(rws.terminationReason.cause, delayError);
      });
    });
  });

  // --- send() ------------------------------------------------------------

  describe("send()", () => {
    it("buffers messages when not open and replays on reconnect", async () => {
      using rws = new DisposableReconnectingWebSocket(WS_URL, {
        maxRetries: 1,
        reconnectionDelay: 0,
      }) as ReconnectingWebSocketWithInternals;

      await new Promise((r) => rws.addEventListener("open", r, { once: true }));

      rws.close(undefined, undefined, false);
      rws.send("msg1");
      rws.send("msg2");

      strictEqual(rws._messageBuffer.length, 2);

      const received: string[] = [];
      rws.addEventListener("message", (e) => received.push(e.data));

      await new Promise((r) => rws.addEventListener("open", r, { once: true }));
      // Wait for echo messages to arrive
      await new Promise((r) => setTimeout(r, 500));

      deepStrictEqual(received.sort(), ["msg1", "msg2"]);
      strictEqual(rws._messageBuffer.length, 0);
    });
  });

  // --- close() ------------------------------------------------------------

  describe("close()", () => {
    it("prevents reconnection", async () => {
      using rws = new DisposableReconnectingWebSocket(INVALID_WS_URL, {
        maxRetries: 3,
        reconnectionDelay: 0,
      });

      rws.close();

      // Wait to confirm no reconnection happens
      await new Promise((r) => setTimeout(r, 1000));

      ok(rws.isTerminated);
    });

    it("close(permanently=false) does not stop reconnection", async () => {
      using rws = new DisposableReconnectingWebSocket(INVALID_WS_URL, {
        maxRetries: 3,
        reconnectionDelay: 0,
      });

      rws.close(undefined, undefined, false);

      await new Promise((r) => rws.addEventListener("terminate", r, { once: true }));

      ok(rws.isTerminated);
      ok(rws.terminationReason instanceof ReconnectingWebSocketError);
      strictEqual(rws.terminationReason.code, "RECONNECTION_LIMIT");
    });
  });

  // --- Event listeners ------------------------------------------------------------

  describe("Event listeners", () => {
    it("addEventListener persists after reconnection", async () => {
      using rws = new DisposableReconnectingWebSocket(WS_URL, {
        maxRetries: 1,
        reconnectionDelay: 0,
      });

      let openCount = 0;
      rws.addEventListener("open", () => openCount++);

      await new Promise((r) => rws.addEventListener("open", r, { once: true }));
      strictEqual(openCount, 1);

      rws.close(undefined, undefined, false);

      await new Promise((r) => rws.addEventListener("open", r, { once: true }));
      strictEqual(openCount, 2);
    });

    it("{ once: true } fires only once across reconnections", async () => {
      using rws = new DisposableReconnectingWebSocket(INVALID_WS_URL, {
        maxRetries: 3,
        reconnectionDelay: 0,
      });

      let closeOnceCalls = 0;
      rws.addEventListener("close", () => closeOnceCalls++, { once: true });

      await new Promise((r) => rws.addEventListener("terminate", r, { once: true }));

      strictEqual(closeOnceCalls, 1);
    });

    it("on* handler fires after reconnection", async () => {
      using rws = new DisposableReconnectingWebSocket(WS_URL, {
        maxRetries: 1,
        reconnectionDelay: 0,
      });

      let openCount = 0;
      rws.onopen = () => openCount++;

      await new Promise((r) => rws.addEventListener("open", r, { once: true }));
      strictEqual(openCount, 1);

      rws.close(undefined, undefined, false);

      await new Promise((r) => rws.addEventListener("open", r, { once: true }));
      strictEqual(openCount, 2);
    });
  });

  // --- Termination ------------------------------------------------------------

  describe("Termination", () => {
    it("dispatches terminate event when maxRetries exceeded", async () => {
      using rws = new DisposableReconnectingWebSocket(INVALID_WS_URL, {
        maxRetries: 0,
        reconnectionDelay: 0,
      });

      const event = await new Promise<CustomEvent<ReconnectingWebSocketError>>((r) =>
        rws.addEventListener("terminate", r, { once: true })
      );

      ok(event instanceof CustomEvent);
      ok(event.detail instanceof ReconnectingWebSocketError);
      strictEqual(event.detail.code, "RECONNECTION_LIMIT");
      ok(rws.isTerminated);
    });

    it("dispatches terminate event on close()", () => {
      using rws = new DisposableReconnectingWebSocket(WS_URL);

      let terminateEvent: CustomEvent<ReconnectingWebSocketError> | undefined;
      rws.addEventListener("terminate", (e) => terminateEvent = e);

      rws.close();

      ok(terminateEvent instanceof CustomEvent);
      ok(terminateEvent.detail instanceof ReconnectingWebSocketError);
      strictEqual(terminateEvent.detail.code, "TERMINATED_BY_USER");
      ok(rws.isTerminated);
    });

    it("no terminate event on temporary close", async () => {
      using rws = new DisposableReconnectingWebSocket(WS_URL, {
        maxRetries: 1,
        reconnectionDelay: 100,
      });

      let terminateCalled = false;
      rws.addEventListener("terminate", () => terminateCalled = true);

      await new Promise((r) => rws.addEventListener("open", r, { once: true }));
      rws.close(undefined, undefined, false);
      await new Promise((r) => rws.addEventListener("open", r, { once: true }));

      strictEqual(terminateCalled, false);
      ok(!rws.isTerminated);
    });
  });
});
