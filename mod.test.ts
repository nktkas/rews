// deno-lint-ignore-file no-explicit-any

/**
 * Test suite for ReconnectingWebSocket.
 *
 * Run:
 * - Deno: deno test -A mod.test.ts
 * - Node.js: node --test mod.test.ts
 * - Bun: bun test --timeout 30000 mod.test.ts
 *
 * With custom WebSocket library:
 * - WS_LIB=ws node --test mod.test.ts
 */

import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { Buffer } from "node:buffer";
import process from "node:process";
import { describe, it } from "node:test";
import { ReconnectingWebSocket, ReconnectingWebSocketError } from "./mod.ts";

// ============================================================
// WebSocket constructor (native or library via WS_LIB env)
// ============================================================

const WS: typeof WebSocket = process.env.WS_LIB
  ? (await import(process.env.WS_LIB)).default
  : (globalThis as any).WebSocket;

// ============================================================
// Test infrastructure
// ============================================================

type ReconnectingWebSocketWithInternals = ReconnectingWebSocket & {
  _messageBuffer: ReconnectingWebSocket["_messageBuffer"];
  _socket: ReconnectingWebSocket["_socket"];
};

// ============================================================
// Echo server
// ============================================================

interface EchoServer {
  port: number;
  shutdown(): Promise<void>;
}

// Deno — Deno.serve + Deno.upgradeWebSocket
function createDenoEchoServer(): EchoServer {
  interface DenoGlobal {
    serve(
      options: { port: number },
      handler: (req: Request) => Promise<Response> | Response,
    ): { addr: { port: number }; shutdown(): Promise<void> };
    upgradeWebSocket(
      req: Request,
      options?: { protocol?: string },
    ): { socket: WebSocket; response: Response };
  }

  const Deno = (globalThis as unknown as { Deno: DenoGlobal }).Deno;

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

// Bun — Bun.serve with websocket handler
function createBunEchoServer(): EchoServer {
  interface BunGlobal {
    serve(options: {
      port: number;
      fetch(req: Request, server: { upgrade(req: Request): boolean }): Response | undefined;
      websocket: {
        message(ws: { send(msg: string | ArrayBuffer): void }, msg: string | ArrayBuffer): void;
      };
    }): { port: number; stop(closeActiveConnections: boolean): Promise<void> };
  }

  const Bun = (globalThis as unknown as { Bun: BunGlobal }).Bun;

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
async function createNodeEchoServer(): Promise<EchoServer> {
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

// Platform-specific dispatcher
function createEchoServer(): Promise<EchoServer> | EchoServer {
  if ("Deno" in globalThis) return createDenoEchoServer();
  if ("Bun" in globalThis) return createBunEchoServer();
  return createNodeEchoServer();
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
      const rws = new ReconnectingWebSocket(WS_URL, { WebSocket: WS });

      for (const prop of ["onopen", "onclose", "onerror", "onmessage"] as const) {
        strictEqual(rws[prop], null, `${prop} should default to null`);

        const handler = () => {};
        rws[prop] = handler;
        strictEqual(rws[prop], handler, `${prop} getter should return the assigned handler`);

        rws[prop] = null;
        strictEqual(rws[prop], null, `${prop} should be null after reset`);
      }

      rws.close();
    });

    it("uses custom WebSocket implementation", async () => {
      class CustomWebSocket extends WS {}
      const rws = new ReconnectingWebSocket(WS_URL, {
        WebSocket: CustomWebSocket,
      }) as ReconnectingWebSocketWithInternals;

      await new Promise((r) => rws.addEventListener("open", r, { once: true }));
      ok(rws._socket instanceof CustomWebSocket);

      rws.close();
    });

    it("throws when no WebSocket implementation is available", () => {
      const original = (globalThis as any).WebSocket;
      (globalThis as any).WebSocket = undefined;

      try {
        throws(
          () => new ReconnectingWebSocket(WS_URL),
          TypeError,
        );
      } finally {
        (globalThis as any).WebSocket = original;
      }
    });
  });

  // --- Before first connection -------------------------------------------------

  describe("Before first connection", () => {
    it("url is empty string", () => {
      const rws = new ReconnectingWebSocket(WS_URL, { WebSocket: WS });
      strictEqual(rws.url, "");
      rws.close();
    });

    it("readyState is CONNECTING", () => {
      const rws = new ReconnectingWebSocket(WS_URL, { WebSocket: WS });
      strictEqual(rws.readyState, ReconnectingWebSocket.CONNECTING);
      rws.close();
    });
  });

  // --- Reconnection ------------------------------------------------------------

  describe("Reconnection", () => {
    describe("url", () => {
      it("supports dynamic URL via function", async () => {
        let callCount = 0;
        const rws = new ReconnectingWebSocket(() => {
          callCount++;
          return WS_URL;
        }, { WebSocket: WS, maxRetries: 2, reconnectionDelay: 0 });

        strictEqual(callCount, 1);

        await new Promise((r) => rws.addEventListener("open", r, { once: true }));
        rws.close(undefined, undefined, false);
        await new Promise((r) => rws.addEventListener("open", r, { once: true }));

        strictEqual(callCount, 2);

        rws.close();
      });

      it("supports async URL via function", async () => {
        let callCount = 0;
        const rws = new ReconnectingWebSocket(async () => {
          callCount++;
          return await Promise.resolve(WS_URL);
        }, { WebSocket: WS, maxRetries: 2, reconnectionDelay: 0 });

        await new Promise((r) => rws.addEventListener("open", r, { once: true }));
        strictEqual(callCount, 1);

        rws.close(undefined, undefined, false);
        await new Promise((r) => rws.addEventListener("open", r, { once: true }));

        strictEqual(callCount, 2);

        rws.close();
      });

      it("errors thrown by async URL factory terminate the instance", async () => {
        const urlError = new Error("token expired");
        const rws = new ReconnectingWebSocket(async () => {
          await Promise.resolve();
          throw urlError;
        }, { WebSocket: WS, maxRetries: 1, reconnectionDelay: 0 });

        await new Promise((r) => rws.addEventListener("terminate", r, { once: true }));

        ok(rws.isTerminated);
        ok(rws.terminationReason instanceof ReconnectingWebSocketError);
        strictEqual(rws.terminationReason.code, "UNKNOWN_ERROR");
        strictEqual(rws.terminationReason.cause, urlError);
      });
    });

    describe("protocols", () => {
      it("retains chosen protocol across reconnect", async () => {
        const rws = new ReconnectingWebSocket(WS_URL, "superchat", { WebSocket: WS });

        await new Promise((r) => rws.addEventListener("open", r, { once: true }));
        strictEqual(rws.protocol, "superchat");

        rws.close(undefined, undefined, false);

        await new Promise((r) => rws.addEventListener("open", r, { once: true }));
        strictEqual(rws.protocol, "superchat");

        rws.close();
      });

      it("supports dynamic protocols via function", async () => {
        let callCount = 0;
        const rws = new ReconnectingWebSocket(
          WS_URL,
          () => {
            callCount++;
            return "superchat";
          },
          { WebSocket: WS, maxRetries: 2, reconnectionDelay: 0 },
        );

        strictEqual(callCount, 1);

        await new Promise((r) => rws.addEventListener("open", r, { once: true }));
        strictEqual(rws.protocol, "superchat");

        rws.close(undefined, undefined, false);
        await new Promise((r) => rws.addEventListener("open", r, { once: true }));

        strictEqual(callCount, 2);
        strictEqual(rws.protocol, "superchat");

        rws.close();
      });

      it("supports async protocols via function", async () => {
        let callCount = 0;
        const rws = new ReconnectingWebSocket(
          WS_URL,
          async () => {
            callCount++;
            return await Promise.resolve("superchat");
          },
          { WebSocket: WS, maxRetries: 2, reconnectionDelay: 0 },
        );

        await new Promise((r) => rws.addEventListener("open", r, { once: true }));
        strictEqual(callCount, 1);
        strictEqual(rws.protocol, "superchat");

        rws.close(undefined, undefined, false);
        await new Promise((r) => rws.addEventListener("open", r, { once: true }));

        strictEqual(callCount, 2);
        strictEqual(rws.protocol, "superchat");

        rws.close();
      });

      it("errors thrown by async protocols factory terminate the instance", async () => {
        const protocolsError = new Error("protocols unavailable");
        const rws = new ReconnectingWebSocket(WS_URL, async () => {
          await Promise.resolve();
          throw protocolsError;
        }, { WebSocket: WS, maxRetries: 1, reconnectionDelay: 0 });

        await new Promise((r) => rws.addEventListener("terminate", r, { once: true }));

        ok(rws.isTerminated);
        ok(rws.terminationReason instanceof ReconnectingWebSocketError);
        strictEqual(rws.terminationReason.code, "UNKNOWN_ERROR");
        strictEqual(rws.terminationReason.cause, protocolsError);
      });
    });

    describe("binaryType", () => {
      it("preserves binaryType across reconnection", async () => {
        const rws = new ReconnectingWebSocket(WS_URL, {
          WebSocket: WS,
          maxRetries: 1,
          reconnectionDelay: 0,
        });

        rws.binaryType = "arraybuffer";

        await new Promise((r) => rws.addEventListener("open", r, { once: true }));
        rws.close(undefined, undefined, false);
        await new Promise((r) => rws.addEventListener("open", r, { once: true }));

        strictEqual(rws.binaryType, "arraybuffer");

        rws.close();
      });
    });

    describe("maxRetries", () => {
      it("respects maxRetries limit", async () => {
        const rws = new ReconnectingWebSocket(INVALID_WS_URL, {
          WebSocket: WS,
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
        const probe = new ReconnectingWebSocket(HANGING_URL, { WebSocket: WS });
        const defaultTimeout = probe.reconnectOptions.connectionTimeout!;
        probe.close();

        const rws = new ReconnectingWebSocket(HANGING_URL, {
          WebSocket: WS,
          connectionTimeout: null,
        });

        await new Promise((r) => setTimeout(r, defaultTimeout + 2000));

        strictEqual(rws.readyState, ReconnectingWebSocket.CONNECTING);

        rws.close();
      });

      it("fires if not opened in time", async () => {
        const rws = new ReconnectingWebSocket(HANGING_URL, {
          WebSocket: WS,
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
        const rws = new ReconnectingWebSocket(INVALID_WS_URL, {
          WebSocket: WS,
          maxRetries: 2,
          reconnectionDelay: customDelay,
        });

        const closeTimes: number[] = [];
        rws.addEventListener("close", () => closeTimes.push(performance.now()));

        await new Promise((r) => rws.addEventListener("terminate", r, { once: true }));

        for (let i = 1; i < closeTimes.length; i++) {
          const diff = closeTimes[i]! - closeTimes[i - 1]!;
          ok(diff >= customDelay - 50, `Gap #${i}: expected >= ${customDelay}ms, got ${diff}ms`);
        }
      });

      it("custom delay (function)", async () => {
        const delays = [200, 500];
        const rws = new ReconnectingWebSocket(INVALID_WS_URL, {
          WebSocket: WS,
          maxRetries: delays.length,
          reconnectionDelay: (attempt) => delays[attempt] ?? delays[delays.length - 1]!,
        });

        const closeTimes: number[] = [];
        rws.addEventListener("close", () => closeTimes.push(performance.now()));

        await new Promise((r) => rws.addEventListener("terminate", r, { once: true }));

        for (let i = 1; i < closeTimes.length; i++) {
          const diff = closeTimes[i]! - closeTimes[i - 1]!;
          const expected = delays[i - 1] ?? delays[delays.length - 1]!;
          ok(diff >= expected - 50, `Gap #${i}: expected >= ${expected}ms, got ${diff}ms`);
        }
      });

      it("errors thrown by reconnectionDelay terminate the instance", async () => {
        const delayError = new Error("boom");
        const rws = new ReconnectingWebSocket(INVALID_WS_URL, {
          WebSocket: WS,
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
      const rws = new ReconnectingWebSocket(WS_URL, {
        WebSocket: WS,
        maxRetries: 1,
        reconnectionDelay: 0,
      }) as ReconnectingWebSocketWithInternals;

      await new Promise((r) => rws.addEventListener("open", r, { once: true }));

      const received: string[] = [];
      rws.addEventListener("message", (e) => received.push(e.data));

      rws.close(undefined, undefined, false);
      rws.send("msg1");
      rws.send("msg2");

      strictEqual(rws._messageBuffer.length, 2);

      await new Promise((r) => rws.addEventListener("open", r, { once: true }));
      // Wait for echo messages to arrive
      await new Promise((r) => setTimeout(r, 500));

      deepStrictEqual(received, ["msg1", "msg2"]);
      strictEqual(rws._messageBuffer.length, 0);

      rws.close();
    });
  });

  // --- close() ------------------------------------------------------------

  describe("close()", () => {
    it("prevents reconnection", async () => {
      const rws = new ReconnectingWebSocket(WS_URL, {
        WebSocket: WS,
        maxRetries: 3,
        reconnectionDelay: 0,
      });

      let openCount = 0;
      rws.addEventListener("open", () => openCount++);

      await new Promise((r) => rws.addEventListener("open", r, { once: true }));
      strictEqual(openCount, 1);

      rws.close();

      // Give the loop a chance to attempt reconnection if close() didn't actually prevent it
      await new Promise((r) => setTimeout(r, 200));

      strictEqual(openCount, 1, "no reconnection should happen after permanent close");
      ok(rws.isTerminated);
    });

    it("close(permanently=false) does not stop reconnection", async () => {
      const rws = new ReconnectingWebSocket(INVALID_WS_URL, {
        WebSocket: WS,
        maxRetries: 3,
        reconnectionDelay: 0,
      });

      rws.close(undefined, undefined, false);

      await new Promise((r) => rws.addEventListener("terminate", r, { once: true }));

      ok(rws.isTerminated);
      ok(rws.terminationReason instanceof ReconnectingWebSocketError);
      strictEqual(rws.terminationReason.code, "RECONNECTION_LIMIT");
    });

    it("double close() dispatches terminate event only once", () => {
      const rws = new ReconnectingWebSocket(WS_URL, { WebSocket: WS });

      let terminateCount = 0;
      rws.addEventListener("terminate", () => terminateCount++);

      rws.close();
      rws.close(); // second call must be a no-op

      strictEqual(terminateCount, 1);
      ok(rws.isTerminated);
    });

    it("is CLOSED (not CLOSING) after close() during CONNECTING", () => {
      const rws = new ReconnectingWebSocket(WS_URL, { WebSocket: WS });

      strictEqual(rws.readyState, ReconnectingWebSocket.CONNECTING);
      rws.close();
      strictEqual(rws.readyState, ReconnectingWebSocket.CLOSED);
    });

    it("dispatches close event when called before socket is assigned", async () => {
      const rws = new ReconnectingWebSocket(WS_URL, { WebSocket: WS });

      let closeCount = 0;
      rws.addEventListener("close", () => closeCount++);

      rws.close();

      // Wait for _runLoop microtask to process the orphaned socket
      await new Promise((r) => setTimeout(r, 500));

      strictEqual(closeCount, 1, "close event should be dispatched exactly once");
      ok(rws.isTerminated);
    });
  });

  // --- Event listeners ------------------------------------------------------------

  describe("Event listeners", () => {
    it("addEventListener persists after reconnection", async () => {
      const rws = new ReconnectingWebSocket(WS_URL, {
        WebSocket: WS,
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

      rws.close();
    });

    it("{ once: true } fires only once across reconnections", async () => {
      const rws = new ReconnectingWebSocket(INVALID_WS_URL, {
        WebSocket: WS,
        maxRetries: 3,
        reconnectionDelay: 0,
      });

      let closeOnceCalls = 0;
      rws.addEventListener("close", () => closeOnceCalls++, { once: true });

      await new Promise((r) => rws.addEventListener("terminate", r, { once: true }));

      strictEqual(closeOnceCalls, 1);
    });

    it("on* handler fires after reconnection", async () => {
      const rws = new ReconnectingWebSocket(WS_URL, {
        WebSocket: WS,
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

      rws.close();
    });
  });

  // --- Termination ------------------------------------------------------------

  describe("Termination", () => {
    it("dispatches terminate event when maxRetries exceeded", async () => {
      const rws = new ReconnectingWebSocket(INVALID_WS_URL, {
        WebSocket: WS,
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
      const rws = new ReconnectingWebSocket(WS_URL, { WebSocket: WS });

      let terminateEvent: CustomEvent<ReconnectingWebSocketError> | undefined;
      rws.addEventListener("terminate", (e) => terminateEvent = e);

      rws.close();

      ok(terminateEvent instanceof CustomEvent);
      ok(terminateEvent.detail instanceof ReconnectingWebSocketError);
      strictEqual(terminateEvent.detail.code, "TERMINATED_BY_USER");
      ok(rws.isTerminated);
    });

    it("no terminate event on temporary close", async () => {
      const rws = new ReconnectingWebSocket(WS_URL, {
        WebSocket: WS,
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

      rws.close();
    });
  });
});
