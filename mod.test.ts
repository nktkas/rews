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
 * - WS_LIB=undici WS_EXPORT=WebSocket node --test mod.test.ts
 */

import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { Buffer } from "node:buffer";
import process from "node:process";
import { describe, it } from "node:test";
import { ReconnectingWebSocket, ReconnectingWebSocketError } from "./mod.ts";

// ============================================================
// WebSocket constructor (native or library via WS_LIB / WS_EXPORT env)
// ============================================================

const WS: typeof WebSocket = process.env.WS_LIB
  ? await (async () => {
    const mod = await import(process.env.WS_LIB!);
    const key = process.env.WS_EXPORT;
    return key ? (mod[key] ?? mod.default[key]) : mod.default;
  })()
  : (globalThis as any).WebSocket;

// ============================================================
// Test infrastructure
// ============================================================

type ReconnectingWebSocketWithInternals = ReconnectingWebSocket & {
  _messageBuffer: ReconnectingWebSocket["_messageBuffer"];
  _socket: ReconnectingWebSocket["_socket"];
};

/** Wait for a single event on an EventTarget. */
function once(target: EventTarget, type: string): Promise<Event> {
  return new Promise((r) => target.addEventListener(type, r, { once: true }));
}

/** Wait until the instance is permanently terminated. */
function terminated(rws: ReconnectingWebSocket): Promise<ReconnectingWebSocketError> {
  return new Promise((resolve) => {
    const signal = rws.terminationSignal;
    if (signal.aborted) return resolve(signal.reason);
    signal.addEventListener("abort", () => resolve(signal.reason), { once: true });
  });
}

/** Returns a port with nothing listening on it. */
async function getClosedPort(): Promise<number> {
  const net = await import("node:net");
  const probe = net.createServer();
  const port = await new Promise<number>((resolve) => {
    probe.listen(0, () => resolve((probe.address() as { port: number }).port));
  });
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

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

  const server = Deno.serve({ port: 0 }, (req: Request) => {
    if (req.headers.get("upgrade") !== "websocket") {
      return new Response(null, { status: 501 });
    }

    const protocol = req.headers.get("sec-websocket-protocol") ?? undefined;
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

      await once(rws, "open");
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
    it("url returns the configured URL", () => {
      const rws = new ReconnectingWebSocket(WS_URL, { WebSocket: WS });
      strictEqual(rws.url, WS_URL);
      rws.close();
    });

    it("url is empty string when the URL is a function", () => {
      const rws = new ReconnectingWebSocket(() => WS_URL, { WebSocket: WS });
      strictEqual(rws.url, "");
      rws.close();
    });

    it("readyState is CONNECTING", () => {
      const rws = new ReconnectingWebSocket(WS_URL, { WebSocket: WS });
      strictEqual(rws.readyState, ReconnectingWebSocket.CONNECTING);
      rws.close();
    });
  });

  // --- readyState ------------------------------------------------

  describe("readyState", () => {
    it("follows the lifecycle: CONNECTING → OPEN → CONNECTING on reconnect → CLOSED on close()", async () => {
      const rws = new ReconnectingWebSocket(WS_URL, {
        WebSocket: WS,
        maxRetries: 3,
        reconnectionDelay: 60_000,
      });
      strictEqual(rws.readyState, ReconnectingWebSocket.CONNECTING);

      await once(rws, "open");
      strictEqual(rws.readyState, ReconnectingWebSocket.OPEN);

      rws.reconnect();
      await once(rws, "close");
      strictEqual(rws.readyState, ReconnectingWebSocket.CONNECTING);

      rws.close();
      strictEqual(rws.readyState, ReconnectingWebSocket.CLOSED);
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

        await once(rws, "open");
        rws.reconnect();
        await once(rws, "open");

        strictEqual(callCount, 2);

        rws.close();
      });

      it("supports async URL via function", async () => {
        let callCount = 0;
        const rws = new ReconnectingWebSocket(async () => {
          callCount++;
          return await Promise.resolve(WS_URL);
        }, { WebSocket: WS, maxRetries: 2, reconnectionDelay: 0 });

        await once(rws, "open");
        strictEqual(callCount, 1);

        rws.reconnect();
        await once(rws, "open");

        strictEqual(callCount, 2);

        rws.close();
      });

      it("errors thrown by the async URL factory count as failed attempts", async () => {
        let calls = 0;
        const rws = new ReconnectingWebSocket(async () => {
          calls++;
          await Promise.resolve();
          throw new Error("token expired");
        }, { WebSocket: WS, maxRetries: 2, reconnectionDelay: 0 });

        const closeReasons: string[] = [];
        rws.addEventListener("close", (e) => closeReasons.push((e as CloseEvent).reason));

        const reason = await terminated(rws);

        strictEqual(reason.code, "RECONNECTION_LIMIT");
        strictEqual(calls, 3); // 1 initial + 2 retries
        ok(closeReasons.every((r) => r.includes("token expired")));
      });

      it("recovers once the URL factory recovers", async () => {
        let calls = 0;
        const rws = new ReconnectingWebSocket(() => {
          if (++calls < 3) throw new Error("transient");
          return WS_URL;
        }, { WebSocket: WS, reconnectionDelay: 0 });

        await once(rws, "open");

        strictEqual(calls, 3);
        ok(!rws.terminationSignal.aborted);
        rws.close();
      });
    });

    describe("protocols", () => {
      it("retains chosen protocol across reconnect", async () => {
        const rws = new ReconnectingWebSocket(WS_URL, "superchat", { WebSocket: WS });

        await once(rws, "open");
        strictEqual(rws.protocol, "superchat");

        rws.reconnect();

        await once(rws, "open");
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

        await once(rws, "open");
        strictEqual(rws.protocol, "superchat");

        rws.reconnect();
        await once(rws, "open");

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

        await once(rws, "open");
        strictEqual(callCount, 1);
        strictEqual(rws.protocol, "superchat");

        rws.reconnect();
        await once(rws, "open");

        strictEqual(callCount, 2);
        strictEqual(rws.protocol, "superchat");

        rws.close();
      });

      it("errors thrown by the async protocols factory count as failed attempts", async () => {
        let calls = 0;
        const rws = new ReconnectingWebSocket(WS_URL, async () => {
          calls++;
          await Promise.resolve();
          throw new Error("protocols unavailable");
        }, { WebSocket: WS, maxRetries: 2, reconnectionDelay: 0 });

        const reason = await terminated(rws);

        strictEqual(reason.code, "RECONNECTION_LIMIT");
        strictEqual(calls, 3); // 1 initial + 2 retries
      });
    });

    describe("binaryType", () => {
      it("applies binaryType set right after the constructor to the first connection", async () => {
        const rws = new ReconnectingWebSocket(WS_URL, { WebSocket: WS });
        rws.binaryType = "arraybuffer";

        await once(rws, "open");
        rws.send(new Uint8Array([1, 2, 3]));
        const event = await once(rws, "message") as MessageEvent;

        ok(
          event.data instanceof ArrayBuffer,
          `expected ArrayBuffer, got ${event.data?.constructor?.name}`,
        );

        rws.close();
      });

      it("preserves binaryType across reconnection", async () => {
        const rws = new ReconnectingWebSocket(WS_URL, {
          WebSocket: WS,
          maxRetries: 1,
          reconnectionDelay: 0,
        });

        rws.binaryType = "arraybuffer";

        await once(rws, "open");
        rws.reconnect();
        await once(rws, "open");

        strictEqual(rws.binaryType, "arraybuffer");

        rws.close();
      });
    });

    describe("maxRetries", () => {
      it("default maxRetries keeps reconnecting indefinitely", async () => {
        const port = await getClosedPort();
        const rws = new ReconnectingWebSocket(`ws://127.0.0.1:${port}`, {
          WebSocket: WS,
          reconnectionDelay: 0,
        });

        let closes = 0;
        await new Promise<void>((resolve) => {
          rws.addEventListener("close", () => {
            if (++closes === 6) resolve();
          });
        });

        ok(!rws.terminationSignal.aborted);
        rws.close();
      });

      it("respects maxRetries limit", async () => {
        const rws = new ReconnectingWebSocket(INVALID_WS_URL, {
          WebSocket: WS,
          maxRetries: 2,
          reconnectionDelay: 0,
        });

        let closeCount = 0;
        rws.addEventListener("close", () => closeCount++);

        await terminated(rws);

        ok(rws.terminationSignal.aborted);
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

        await terminated(rws);

        ok(rws.terminationSignal.aborted);
      });

      it("does not close an already-open socket when the timer fires", async () => {
        // Simulates the boundary race: readyState is already OPEN, but the open
        // event (which clears the timer) has not been dispatched yet.
        let closeCalls = 0;
        class OpenWithoutEventWebSocket extends EventTarget {
          readyState = ReconnectingWebSocket.OPEN;
          binaryType = "blob";
          send(): void {}
          close(): void {
            closeCalls++;
            this.readyState = ReconnectingWebSocket.CLOSED;
            this.dispatchEvent(new Event("close"));
          }
        }

        const rws = new ReconnectingWebSocket(WS_URL, {
          WebSocket: OpenWithoutEventWebSocket as any,
          connectionTimeout: 50,
          maxRetries: 0,
        });

        await new Promise((r) => setTimeout(r, 150));

        strictEqual(closeCalls, 0);

        rws.close();
      });
    });

    describe("stableTimeout", () => {
      it("counts short-lived connections towards maxRetries", async () => {
        // Opens and immediately closes — like a server that accepts and drops every connection
        class InstantCloseWebSocket extends EventTarget {
          readyState = 0;
          binaryType = "blob";
          send(): void {}
          close(): void {
            this.readyState = 3;
            this.dispatchEvent(new Event("close"));
          }
          constructor() {
            super();
            // Open on a macrotask: a real socket cannot open before the caller subscribes
            setTimeout(() => {
              this.readyState = 1;
              this.dispatchEvent(new Event("open"));
              this.close();
            }, 0);
          }
        }

        const rws = new ReconnectingWebSocket(WS_URL, {
          WebSocket: InstantCloseWebSocket as any,
          maxRetries: 2,
          reconnectionDelay: 0,
        });

        const reason = await terminated(rws);

        strictEqual(reason.code, "RECONNECTION_LIMIT");
      });

      it("resets the retry counter after a stable connection", async () => {
        // Opens, stays alive past stableTimeout, then drops
        class DroppingWebSocket extends EventTarget {
          readyState = 0;
          binaryType = "blob";
          send(): void {}
          close(): void {
            this.readyState = 3;
            this.dispatchEvent(new Event("close"));
          }
          constructor() {
            super();
            // Open on a macrotask: a real socket cannot open before the caller subscribes
            setTimeout(() => {
              this.readyState = 1;
              this.dispatchEvent(new Event("open"));
              setTimeout(() => this.close(), 150);
            }, 0);
          }
        }

        const rws = new ReconnectingWebSocket(WS_URL, {
          WebSocket: DroppingWebSocket as any,
          maxRetries: 1,
          reconnectionDelay: 0,
          stableTimeout: 50,
        });

        let closes = 0;
        await new Promise<void>((resolve) => {
          rws.addEventListener("close", () => {
            if (++closes === 3) resolve();
          });
        });

        ok(!rws.terminationSignal.aborted);
        rws.close();
      });
    });

    describe("shouldReconnect", () => {
      it("false terminates with RECONNECTION_DECLINED", async () => {
        const port = await getClosedPort();
        const seen: [number, number][] = [];
        const rws = new ReconnectingWebSocket(`ws://127.0.0.1:${port}`, {
          WebSocket: WS,
          shouldReconnect: (event, attempt) => {
            seen.push([event.code, attempt]);
            return false;
          },
        });

        const reason = await terminated(rws);

        strictEqual(reason.code, "RECONNECTION_DECLINED");
        deepStrictEqual(seen, [[1006, 0]]);
      });

      it("is not consulted for user-initiated closures", async () => {
        let calls = 0;
        const rws = new ReconnectingWebSocket(WS_URL, {
          WebSocket: WS,
          shouldReconnect: () => {
            calls++;
            return true;
          },
        });

        await once(rws, "open");
        rws.reconnect();
        await once(rws, "open");
        rws.close();
        await once(rws, "close");

        strictEqual(calls, 0);
      });
    });

    describe("reconnectionDelay", () => {
      it("default delay applies equal jitter within [delay/2, delay]", () => {
        const rws = new ReconnectingWebSocket(WS_URL, { WebSocket: WS });
        const delayFn = rws.reconnectOptions.reconnectionDelay as (attempt: number) => number;

        for (const [attempt, base] of [[0, 150], [3, 1200], [10, 10_000]] as const) {
          for (let i = 0; i < 20; i++) {
            const delay = delayFn(attempt);
            ok(delay >= base / 2 && delay <= base, `attempt ${attempt}: ${delay} outside [${base / 2}, ${base}]`);
          }
        }

        rws.close();
      });

      it("custom delay (number)", async () => {
        const customDelay = 500;
        const rws = new ReconnectingWebSocket(INVALID_WS_URL, {
          WebSocket: WS,
          maxRetries: 2,
          reconnectionDelay: customDelay,
        });

        const closeTimes: number[] = [];
        rws.addEventListener("close", () => closeTimes.push(performance.now()));

        await terminated(rws);

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

        await terminated(rws);

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

        const reason = await terminated(rws);

        ok(reason instanceof ReconnectingWebSocketError);
        strictEqual(reason.code, "UNKNOWN_ERROR");
        strictEqual(reason.cause, delayError);
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

      await once(rws, "open");

      const received: string[] = [];
      rws.addEventListener("message", (e) => received.push(e.data));

      rws.reconnect();
      rws.send("msg1");
      rws.send("msg2");

      strictEqual(rws._messageBuffer.length, 2);

      await once(rws, "open");
      // Wait for echo messages to arrive
      await new Promise((r) => setTimeout(r, 500));

      deepStrictEqual(received, ["msg1", "msg2"]);
      strictEqual(rws._messageBuffer.length, 0);

      rws.close();
    });
  });

  // --- close event ------------------------------------------------------------

  describe("close event", () => {
    it("reports code 1006 when the connection fails", async () => {
      const port = await getClosedPort();
      const rws = new ReconnectingWebSocket(`ws://127.0.0.1:${port}`, {
        WebSocket: WS,
        maxRetries: 0,
      });

      const event = await once(rws, "close") as CloseEvent;
      strictEqual(event.code, 1006);
    });

    it("aborts terminationSignal before the final close on reconnection limit", async () => {
      const port = await getClosedPort();
      const rws = new ReconnectingWebSocket(`ws://127.0.0.1:${port}`, {
        WebSocket: WS,
        maxRetries: 1,
        reconnectionDelay: 0,
      });

      const abortedInClose: boolean[] = [];
      rws.addEventListener("close", () => abortedInClose.push(rws.terminationSignal.aborted));

      await terminated(rws);
      await new Promise((r) => setTimeout(r, 100));

      deepStrictEqual(abortedInClose, [false, true]);
    });

    it("dispatches a final close when close() is called during the retry sleep", async () => {
      const port = await getClosedPort();
      const rws = new ReconnectingWebSocket(`ws://127.0.0.1:${port}`, {
        WebSocket: WS,
        maxRetries: 5,
        reconnectionDelay: 60_000,
      });

      await once(rws, "close"); // first attempt failed; the loop is sleeping
      const finalClose = new Promise<boolean>((resolve) => {
        rws.addEventListener("close", () => resolve(rws.terminationSignal.aborted), { once: true });
      });

      rws.close();

      ok(await finalClose);
    });

    it("dispatches a final close when a policy error terminates the instance", async () => {
      const port = await getClosedPort();
      const rws = new ReconnectingWebSocket(`ws://127.0.0.1:${port}`, {
        WebSocket: WS,
        reconnectionDelay: () => {
          throw new Error("boom");
        },
      });

      const abortedInClose: boolean[] = [];
      rws.addEventListener("close", () => abortedInClose.push(rws.terminationSignal.aborted));

      await terminated(rws);
      await new Promise((r) => setTimeout(r, 100));

      deepStrictEqual(abortedInClose, [false, true]);
    });

    it("final close on user close() reports the user code", async () => {
      const rws = new ReconnectingWebSocket(WS_URL, { WebSocket: WS });
      await once(rws, "open");

      let abortedInClose: boolean | undefined;
      rws.addEventListener("close", () => abortedInClose = rws.terminationSignal.aborted, { once: true });

      rws.close(4001, "bye");
      const event = await once(rws, "close") as CloseEvent;

      strictEqual(event.code, 4001);
      strictEqual(abortedInClose, true);
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

      await once(rws, "open");
      strictEqual(openCount, 1);

      rws.close();

      // Give the loop a chance to attempt reconnection if close() didn't actually prevent it
      await new Promise((r) => setTimeout(r, 200));

      strictEqual(openCount, 1, "no reconnection should happen after permanent close");
      ok(rws.terminationSignal.aborted);
    });

    it("close() with invalid arguments throws without side effects", async () => {
      const rws = new ReconnectingWebSocket(WS_URL, { WebSocket: WS });

      throws(() => rws.close(1), (e: Error) => e.name === "InvalidAccessError");
      throws(() => rws.close(1000, "x".repeat(124)), (e: Error) => e.name === "SyntaxError");

      await once(rws, "open");
      throws(() => rws.close(1), (e: Error) => e.name === "InvalidAccessError");

      ok(!rws.terminationSignal.aborted);
      rws.close();
    });

    it("double close() keeps the original termination reason", () => {
      const rws = new ReconnectingWebSocket(WS_URL, { WebSocket: WS });

      rws.close();
      const reason = rws.terminationSignal.reason;
      rws.close(); // second call must be a no-op

      strictEqual(rws.terminationSignal.reason, reason);
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
      ok(rws.terminationSignal.aborted);
    });
  });

  // --- reconnect() ------------------------------------------------------------

  describe("reconnect()", () => {
    it("does not stop reconnection", async () => {
      const rws = new ReconnectingWebSocket(INVALID_WS_URL, {
        WebSocket: WS,
        maxRetries: 3,
        reconnectionDelay: 0,
      });

      rws.reconnect();

      const reason = await terminated(rws);

      ok(reason instanceof ReconnectingWebSocketError);
      strictEqual(reason.code, "RECONNECTION_LIMIT");
    });

    it("reconnects instead of terminating at maxRetries: 0", async () => {
      const rws = new ReconnectingWebSocket(WS_URL, { WebSocket: WS, maxRetries: 0 });
      await once(rws, "open");

      const reopened = once(rws, "open");
      rws.reconnect();
      await reopened;

      ok(!rws.terminationSignal.aborted);
      rws.close();
    });

    it("skips the current retry delay", async () => {
      const port = await getClosedPort();
      const rws = new ReconnectingWebSocket(`ws://127.0.0.1:${port}`, {
        WebSocket: WS,
        maxRetries: 5,
        reconnectionDelay: 60_000,
      });

      await once(rws, "close"); // first attempt failed; the loop is sleeping
      const nextClose = once(rws, "close");

      rws.reconnect();

      await nextClose; // arrives immediately instead of after the 60s delay
      ok(!rws.terminationSignal.aborted);
      rws.close();
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

      await once(rws, "open");
      strictEqual(openCount, 1);

      rws.reconnect();

      await once(rws, "open");
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

      await terminated(rws);

      strictEqual(closeOnceCalls, 1);
    });

    it("reassigning an on* handler keeps its position among listeners", async () => {
      const rws = new ReconnectingWebSocket(WS_URL, { WebSocket: WS });

      const calls: string[] = [];
      rws.onopen = () => calls.push("attr-old");
      rws.addEventListener("open", () => calls.push("listener"));
      rws.onopen = () => calls.push("attr");

      await once(rws, "open");
      deepStrictEqual(calls, ["attr", "listener"]);

      rws.close();
    });

    it("on* handler fires after reconnection", async () => {
      const rws = new ReconnectingWebSocket(WS_URL, {
        WebSocket: WS,
        maxRetries: 1,
        reconnectionDelay: 0,
      });

      let openCount = 0;
      rws.onopen = () => openCount++;

      await once(rws, "open");
      strictEqual(openCount, 1);

      rws.reconnect();

      await once(rws, "open");
      strictEqual(openCount, 2);

      rws.close();
    });
  });

  // --- Termination ------------------------------------------------------------

  describe("Termination", () => {
    it("aborts terminationSignal when maxRetries exceeded", async () => {
      const rws = new ReconnectingWebSocket(INVALID_WS_URL, {
        WebSocket: WS,
        maxRetries: 0,
        reconnectionDelay: 0,
      });

      const reason = await terminated(rws);

      ok(reason instanceof ReconnectingWebSocketError);
      strictEqual(reason.code, "RECONNECTION_LIMIT");
    });

    it("aborts terminationSignal synchronously on close()", () => {
      const rws = new ReconnectingWebSocket(WS_URL, { WebSocket: WS });

      rws.close();

      ok(rws.terminationSignal.aborted);
      const reason = rws.terminationSignal.reason;
      ok(reason instanceof ReconnectingWebSocketError);
      strictEqual(reason.code, "TERMINATED_BY_USER");
    });

    it("temporary close does not terminate", async () => {
      const rws = new ReconnectingWebSocket(WS_URL, {
        WebSocket: WS,
        maxRetries: 1,
        reconnectionDelay: 100,
      });

      await once(rws, "open");
      rws.reconnect();
      await once(rws, "open");

      ok(!rws.terminationSignal.aborted);

      rws.close();
    });
  });
});
