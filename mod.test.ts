import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import { WebSocketServer } from "ws";
import { ReconnectingWebSocket, ReconnectingWebSocketError } from "./mod.ts";

const server = http.createServer();
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", async (request, socket, head) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const delay = url.searchParams.has("delay") ? parseInt(url.searchParams.get("delay") ?? "1000") : 1000;
  await new Promise((resolve) => setTimeout(resolve, delay));
  wss.handleUpgrade(request, socket, head, (ws) => {
    ws.on("message", (data) => {
      ws.send(data.toString());
    });
  });
});
server.listen(8080);

test("ReconnectingWebSocket", async (t) => {
  await t.test("Basic WebSocket", async (t) => {
    await t.test("get url()", () => {
      const rws = new ReconnectingWebSocket("ws://localhost:8080/");

      assert.strictEqual(rws.url, "ws://localhost:8080/");

      rws.close();
    });

    await t.test("get readyState()", () => {
      const rws = new ReconnectingWebSocket("ws://localhost:8080/");

      assert.strictEqual(rws.readyState, WebSocket.CONNECTING);

      rws.close();
    });

    await t.test("get bufferedAmount()", () => {
      const rws = new ReconnectingWebSocket("ws://localhost:8080/");

      assert.strictEqual(rws.bufferedAmount, 0);

      rws.close();
    });

    await t.test("get extensions()", () => {
      const rws = new ReconnectingWebSocket("ws://localhost:8080/");

      assert.strictEqual(rws.extensions, "");

      rws.close();
    });

    await t.test("get protocol()", async () => {
      const rws = new ReconnectingWebSocket("ws://localhost:8080/", "superchat");
      await new Promise((resolve) => rws.addEventListener("open", resolve)); // Wait for the connection to open

      assert.strictEqual(rws.protocol, "superchat");

      rws.close();
    });

    await t.test("binaryType", async (t) => {
      await t.test("get binaryType()", () => {
        const rws = new ReconnectingWebSocket("ws://localhost:8080/");

        assert.strictEqual(rws.binaryType, "blob");

        rws.close();
      });
      await t.test("set binaryType()", () => {
        const rws = new ReconnectingWebSocket("ws://localhost:8080/");

        rws.binaryType = "arraybuffer";
        assert.strictEqual(rws.binaryType, "arraybuffer");

        rws.close();
      });
    });

    await t.test("CONNECTING", async (t) => {
      await t.test("get CONNECTING()", () => {
        const rws = new ReconnectingWebSocket("ws://localhost:8080/");

        assert.strictEqual(rws.CONNECTING, WebSocket.CONNECTING);

        rws.close();
      });
      await t.test("static CONNECTING", () => {
        assert.strictEqual(ReconnectingWebSocket.CONNECTING, WebSocket.CONNECTING);
      });
    });
    await t.test("OPEN", async (t) => {
      await t.test("get OPEN()", () => {
        const rws = new ReconnectingWebSocket("ws://localhost:8080/");

        assert.strictEqual(rws.OPEN, WebSocket.OPEN);

        rws.close();
      });
      await t.test("static OPEN", () => {
        assert.strictEqual(ReconnectingWebSocket.OPEN, WebSocket.OPEN);
      });
    });
    await t.test("CLOSING", async (t) => {
      await t.test("get CLOSING()", () => {
        const rws = new ReconnectingWebSocket("ws://localhost:8080/");

        assert.strictEqual(rws.CLOSING, WebSocket.CLOSING);

        rws.close();
      });
      await t.test("static CLOSING", () => {
        assert.strictEqual(ReconnectingWebSocket.CLOSING, WebSocket.CLOSING);
      });
    });
    await t.test("CLOSED", async (t) => {
      await t.test("get CLOSED()", () => {
        const rws = new ReconnectingWebSocket("ws://localhost:8080/");

        assert.strictEqual(rws.CLOSED, WebSocket.CLOSED);

        rws.close();
      });
      await t.test("static CLOSED", () => {
        assert.strictEqual(ReconnectingWebSocket.CLOSED, WebSocket.CLOSED);
      });
    });

    await t.test("onclose", async (t) => {
      await t.test("get onclose()", () => {
        const rws = new ReconnectingWebSocket("ws://localhost:8080/");

        assert.strictEqual(rws.onclose, null);

        rws.close();
      });
      await t.test("set onclose()", () => {
        const rws = new ReconnectingWebSocket("ws://localhost:8080/");

        const onclose = () => {};
        rws.onclose = onclose;

        assert.strictEqual(rws.onclose, onclose);

        rws.close();
      });
    });
    await t.test("onerror", async (t) => {
      await t.test("get onerror()", () => {
        const rws = new ReconnectingWebSocket("ws://localhost:8080/");

        assert.strictEqual(rws.onerror, null);

        rws.close();
      });
      await t.test("set onerror()", () => {
        const rws = new ReconnectingWebSocket("ws://localhost:8080/");

        const onerror = () => {};
        rws.onerror = onerror;

        assert.strictEqual(rws.onerror, onerror);

        rws.close();
      });
    });
    await t.test("onmessage", async (t) => {
      await t.test("get onmessage()", () => {
        const rws = new ReconnectingWebSocket("ws://localhost:8080/");

        assert.strictEqual(rws.onmessage, null);

        rws.close();
      });
      await t.test("set onmessage()", () => {
        const rws = new ReconnectingWebSocket("ws://localhost:8080/");

        const onmessage = () => {};
        rws.onmessage = onmessage;

        assert.strictEqual(rws.onmessage, onmessage);

        rws.close();
      });
    });
    await t.test("onopen", async (t) => {
      await t.test("get onopen()", () => {
        const rws = new ReconnectingWebSocket("ws://localhost:8080/");

        assert.strictEqual(rws.onopen, null);

        rws.close();
      });
      await t.test("set onopen()", () => {
        const rws = new ReconnectingWebSocket("ws://localhost:8080/");

        const onopen = () => {};
        rws.onopen = onopen;

        assert.strictEqual(rws.onopen, onopen);

        rws.close();
      });
    });

    await t.test("close()", () => {
      const rws = new ReconnectingWebSocket("ws://localhost:8080/");

      assert.notStrictEqual(rws.readyState, WebSocket.CLOSED);

      rws.close();

      assert.strictEqual(rws.readyState, WebSocket.CLOSING);
    });

    await t.test("send()", () => {
      const rws = new ReconnectingWebSocket("ws://localhost:8080/");

      const message = "Hello, World!";
      let received = "";
      rws.addEventListener("message", (e) => received = e.data);
      rws.dispatchEvent(new MessageEvent("message", { data: message }));
      assert.strictEqual(received, message);

      rws.close();
    });

    await t.test("addEventListener()", async (t) => {
      await t.test("listener is fn", () => {
        const rws = new ReconnectingWebSocket("ws://localhost:8080/");

        let called = false;
        rws.addEventListener("message", () => called = true);
        rws.dispatchEvent(new Event("message"));
        assert(called);

        rws.close();
      });

      await t.test("listener is an object", () => {
        const rws = new ReconnectingWebSocket("ws://localhost:8080/");

        let called = false;
        rws.addEventListener("message", { handleEvent: () => called = true });
        rws.dispatchEvent(new Event("message"));
        assert(called);

        rws.close();
      });

      await t.test("Does not wrap listener when termination signal is aborted", () => {
        const rws = new ReconnectingWebSocket("ws://localhost:8080/");
        rws.close();

        rws.addEventListener("message", () => {});
        // @ts-ignore - accessing private property
        const listenersCount = rws._listeners.length;
        assert.strictEqual(listenersCount, 0);
      });
    });

    await t.test("removeEventListener()", async (t) => {
      await t.test("listener is fn", () => {
        const rws = new ReconnectingWebSocket("ws://localhost:8080/");

        let called = false;
        const listener = () => called = true;
        rws.addEventListener("message", listener);
        rws.removeEventListener("message", listener);
        rws.dispatchEvent(new Event("message"));
        assert(!called);

        rws.close();
      });

      await t.test("listener is an object", () => {
        const rws = new ReconnectingWebSocket("ws://localhost:8080/");

        let called = false;
        const listener = { handleEvent: () => called = true };
        rws.addEventListener("message", listener);
        rws.removeEventListener("message", listener);
        rws.dispatchEvent(new Event("message"));
        assert(!called);

        rws.close();
      });

      await t.test("Removes original listener when wrapped listener not found", () => {
        const rws = new ReconnectingWebSocket("ws://localhost:8080/");

        // First, terminate the connection to prevent wrapping
        rws.close();

        // Add listener after termination (will not be wrapped)
        let called = false;
        const listener = () => called = true;

        rws.addEventListener("message", listener);

        // @ts-ignore - accessing private property
        const listenersCount = rws._listeners.length;
        assert.strictEqual(listenersCount, 0, "No wrapped listeners should be stored");

        // Verify listener is called
        rws.dispatchEvent(new Event("message"));
        assert(called, "Listener should have been called");
        called = false;

        // Remove the listener - should fall back to removing original
        rws.removeEventListener("message", listener);

        // Verify it was removed by trying to dispatch event
        rws.dispatchEvent(new Event("message"));
        assert(!called, "Listener should have been removed");
      });
    });

    await t.test("dispatchEvent()", () => {
      const rws = new ReconnectingWebSocket("ws://localhost:8080/");

      let called = false;
      rws.addEventListener("open", () => called = true);
      rws.dispatchEvent(new Event("open"));
      assert(called);

      rws.close();
    });
  });

  await t.test("Reconnecting WebSocket", async (t) => {
    await t.test("url", async (t) => {
      await t.test("Supports dynamic URL via function", async () => {
        let callCount = 0;
        const urlProvider = () => {
          callCount++;
          return "ws://localhost:8080/";
        };

        const rws = new ReconnectingWebSocket(urlProvider, {
          maxRetries: 2,
          reconnectionDelay: 0,
        });

        assert.strictEqual(callCount, 1, "URL function should be called on initial connection");

        await new Promise((resolve) => rws.addEventListener("open", resolve, { once: true }));
        rws.close(undefined, undefined, false); // Close without permanently aborting
        await new Promise((resolve) => rws.addEventListener("open", resolve, { once: true }));

        assert.strictEqual(callCount, 2, "URL function should be called on reconnection");

        rws.close();
      });
    });

    await t.test("protocols", async (t) => {
      await t.test("Retains chosen protocol across reconnect", async () => {
        const rws = new ReconnectingWebSocket("ws://localhost:8080/", "superchat");

        await new Promise<void>((resolve) => {
          rws.addEventListener("open", () => {
            assert.strictEqual(rws.protocol, "superchat");
            resolve();
          }, { once: true });
        });

        rws.close(undefined, undefined, false); // Close without permanently aborting

        await new Promise<void>((resolve) => {
          rws.addEventListener("open", () => {
            assert.strictEqual(rws.protocol, "superchat");
            resolve();
          }, { once: true });
        });

        rws.close();
      });

      await t.test("Supports dynamic protocols via function", async () => {
        let callCount = 0;
        const protocolsProvider = () => {
          callCount++;
          return "superchat";
        };

        const rws = new ReconnectingWebSocket("ws://localhost:8080/", protocolsProvider, {
          maxRetries: 2,
          reconnectionDelay: 0,
        });

        assert.strictEqual(callCount, 1, "Protocols function should be called on initial connection");

        await new Promise((resolve) => rws.addEventListener("open", resolve, { once: true }));
        assert.strictEqual(rws.protocol, "superchat");

        rws.close(undefined, undefined, false); // Close without permanently aborting
        await new Promise((resolve) => rws.addEventListener("open", resolve, { once: true }));

        assert.strictEqual(callCount, 2, "Protocols function should be called on reconnection");
        assert.strictEqual(rws.protocol, "superchat");

        rws.close();
      });
    });

    await t.test("binaryType", async (t) => {
      await t.test("Preserves binaryType across reconnection", async () => {
        const rws = new ReconnectingWebSocket("ws://localhost:8080/", {
          maxRetries: 1,
          reconnectionDelay: 0,
        });

        rws.binaryType = "arraybuffer";
        assert.strictEqual(rws.binaryType, "arraybuffer");

        await new Promise((resolve) => rws.addEventListener("open", resolve, { once: true }));
        rws.close(undefined, undefined, false);
        await new Promise((resolve) => rws.addEventListener("open", resolve, { once: true }));

        assert.strictEqual(rws.binaryType, "arraybuffer", "binaryType should persist after reconnection");

        rws.close();
      });
    });

    await t.test("maxRetries", async (t) => {
      await t.test("Respects maxRetries limit", async () => {
        const rws = new ReconnectingWebSocket("ws://invalid4567t7281.com", {
          maxRetries: 2,
          reconnectionDelay: 0,
        });

        let closeCount = 0;
        rws.addEventListener("close", () => closeCount++);

        await new Promise((resolve) => setTimeout(resolve, 5000)); // Delay for network operations

        assert.strictEqual(rws.readyState, WebSocket.CLOSED, "WebSocket should be closed");
        // Initial connection + 2 reconnect attempts = 3 total calls
        assert.strictEqual(closeCount, 3);

        rws.close();
      });
    });

    await t.test("connectionTimeout", async (t) => {
      await t.test("Connection timeout is disabled if set to `connectionTimeout: null`", async () => {
        const defaultConnectionTimeout = new ReconnectingWebSocket("ws://example.com")
          .reconnectOptions.connectionTimeout!;
        const rws = new ReconnectingWebSocket(
          `ws://localhost:8080?delay=${defaultConnectionTimeout + 5000}`,
          { connectionTimeout: null },
        );

        await new Promise((resolve) => setTimeout(resolve, defaultConnectionTimeout + 2000)); // Wait longer than default timeout but less than server delay
        assert.strictEqual(rws.readyState, WebSocket.CONNECTING);

        rws.close();
      });

      await t.test("Connection timeout if not opened in time", async () => {
        const rwsTimeout = new ReconnectingWebSocket("ws://localhost:8080/", {
          maxRetries: 0,
          connectionTimeout: 10, // too short to connect
        });

        await new Promise((resolve) => setTimeout(resolve, 1000)); // Delay for network operations
        assert.strictEqual(rwsTimeout.readyState, WebSocket.CLOSED);

        rwsTimeout.close();
      });
    });

    await t.test("reconnectionDelay", async (t) => {
      await t.test("Custom delay", async () => {
        const customDelay = 500;
        const rws = new ReconnectingWebSocket("ws://invalid4567t7281.com", {
          maxRetries: 3,
          reconnectionDelay: customDelay,
        });

        const closeTimes: number[] = [];
        rws.addEventListener("close", () => closeTimes.push(performance.now()));

        await new Promise((resolve) => setTimeout(resolve, 3000)); // Delay for network operations
        rws.close();

        for (let i = 1; i < closeTimes.length; i++) {
          const diff = closeTimes[i] - closeTimes[i - 1];
          assert(
            diff >= customDelay,
            `Close event #${i} waited less than "customDelay". Expected at least ${customDelay}ms, got ${diff}ms`,
          );
        }
      });

      await t.test("Custom delay via function", async () => {
        const delays = [200, 500, 700];
        const rws = new ReconnectingWebSocket("ws://invalid4567t7281.com", {
          maxRetries: delays.length,
          reconnectionDelay: (attempt) => delays[attempt] || delays[delays.length - 1],
        });

        const closeTimes: number[] = [];
        rws.addEventListener("close", () => closeTimes.push(performance.now()));

        await new Promise((resolve) => setTimeout(resolve, 3000)); // Delay for network operations
        rws.close();

        for (let i = 1; i < closeTimes.length; i++) {
          const diff = closeTimes[i] - closeTimes[i - 1];
          const expected = delays[i - 1] || delays[delays.length - 1];
          assert(
            diff >= expected,
            `Close event #${i} waited less than the function-supplied delay. Expected at least ${expected}ms, got ${diff}ms`,
          );
        }
      });
    });

    await t.test("send()", async (t) => {
      await t.test("Buffers messages when not open and replays on reconnect", async () => {
        const rws = new ReconnectingWebSocket("ws://localhost:8080/", {
          maxRetries: 1,
          reconnectionDelay: 0,
        });

        await new Promise((resolve) => rws.addEventListener("open", resolve)); // Wait for the connection to open

        rws.close(undefined, undefined, false); // Close without permanently aborting
        rws.send("HelloAfterClose1");
        rws.send("HelloAfterClose2");

        // @ts-ignore - accessing private property
        assert.strictEqual(rws._messageBuffer.length, 2);

        const receivedMessages: string[] = [];
        rws.addEventListener("message", (ev) => receivedMessages.push(ev.data));

        await new Promise((resolve) => setTimeout(resolve, 5000)); // Delay for network operations

        assert.strictEqual(receivedMessages.length, 2);
        assert(receivedMessages.includes("HelloAfterClose1"));
        assert(receivedMessages.includes("HelloAfterClose2"));

        // @ts-ignore - accessing private property
        assert.strictEqual(rws._messageBuffer.length, 0);

        rws.close();
      });
    });

    await t.test("close()", async (t) => {
      await t.test("close() prevents reconnection", async () => {
        const rws = new ReconnectingWebSocket("ws://invalid4567t7281.com", {
          maxRetries: 3,
          reconnectionDelay: 0,
        });

        let closeEvents = 0;
        rws.addEventListener("close", () => closeEvents++);

        rws.close();

        await new Promise((resolve) => setTimeout(resolve, 5000)); // Delay for network operations

        // Node.js WebSocket emits duplicate close events, Deno does not
        const expectedCloseEvents = "Deno" in globalThis ? 1 : 2;
        assert.strictEqual(closeEvents, expectedCloseEvents, `should have ${expectedCloseEvents} close event(s)`);
        assert.strictEqual(rws.readyState, WebSocket.CLOSED, "socket should remain closed");
        assert(rws.isTerminated, "should be permanently closed");
      });

      await t.test("close(permanently = false) closes but does not stop reconnection logic", async () => {
        const rws = new ReconnectingWebSocket("ws://invalid4567t7281.com", {
          maxRetries: 3,
          reconnectionDelay: 0,
        });

        let closeEvents = 0;
        rws.addEventListener("close", () => closeEvents++);

        rws.close(undefined, undefined, false); // Close without permanently aborting

        await new Promise((resolve) => setTimeout(resolve, 3000)); // Delay for network operations

        // Node.js WebSocket emits duplicate close events, Deno does not
        const expectedCloseEvents = "Deno" in globalThis ? 4 : 5;
        assert.strictEqual(closeEvents, expectedCloseEvents, "should have multiple close events for reconnection");
        assert.strictEqual(rws.readyState, WebSocket.CLOSED, "socket should remain closed");
        assert(rws.isTerminated, "should be permanently closed");

        rws.close();
      });
    });

    await t.test("Event listeners", async (t) => {
      await t.test("Re-registers event listeners after reconnection", async () => {
        const rws = new ReconnectingWebSocket("ws://localhost:8080/", {
          maxRetries: 1,
          reconnectionDelay: 0,
        });

        let openCount = 0;
        rws.addEventListener("open", () => openCount++);
        let messageCount = 0;
        rws.addEventListener("message", () => messageCount++);

        await new Promise((resolve) => setTimeout(resolve, 5000)); // Delay for network operations
        assert.strictEqual(openCount, 1);

        rws.close(undefined, undefined, false); // Close without permanently aborting

        await new Promise((resolve) => setTimeout(resolve, 5000)); // Delay for network operations
        assert.strictEqual(openCount, 2);

        rws.send("TestingReRegistration");

        await new Promise((resolve) => setTimeout(resolve, 5000)); // Delay for network operations
        assert.strictEqual(messageCount, 1);

        rws.close();
      });

      await t.test("Executes { once: true } listener only 1 time and does not reconnect", async () => {
        const rws = new ReconnectingWebSocket("ws://invalid4567t7281.com", {
          maxRetries: 3,
          reconnectionDelay: 0,
        });

        let closeOnceCalls = 0;
        const onceClose = () => closeOnceCalls++;
        rws.addEventListener("close", onceClose, { once: true }); // `maxRetries` is 3, but should only be called once

        await new Promise((resolve) => setTimeout(resolve, 3000)); // Delay for network operations
        assert.strictEqual(closeOnceCalls, 1);

        rws.close();
      });

      await t.test("Adding identical listeners does not increase eventListeners array", () => {
        const rws = new ReconnectingWebSocket("ws://localhost:8080/");
        const handler = () => {};

        // @ts-ignore - internal property
        assert.strictEqual(rws._listeners.length, 0, "Initially no event listeners stored");

        rws.addEventListener("message", handler);
        rws.addEventListener("message", handler);
        rws.addEventListener("message", handler);

        // @ts-ignore - internal property
        assert.strictEqual(rws._listeners.length, 1, "should still only have 1 event listener after duplicates");

        // Remove it once, array should be empty
        rws.removeEventListener("message", handler);

        // @ts-ignore - internal property
        assert.strictEqual(rws._listeners.length, 0, "should have no listeners after removal");

        rws.close();
      });

      await t.test("Reattaches `on*` properties after reconnection", async () => {
        const rws = new ReconnectingWebSocket("ws://localhost:8080/");

        let onopenCalled = 0;
        let oncloseCalled = 0;
        let onerrorCalled = 0;
        let onmessageCalled = 0;
        const onopen = () => onopenCalled++;
        const onclose = () => oncloseCalled++;
        const onerror = () => onerrorCalled++;
        const onmessage = () => onmessageCalled++;
        rws.onopen = onopen;
        rws.onclose = onclose;
        rws.onerror = onerror;
        rws.onmessage = onmessage;

        await new Promise((resolve) => rws.addEventListener("open", resolve, { once: true })); // Wait for the connection to open
        rws.close(undefined, undefined, false); // Close without permanently aborting
        await new Promise((resolve) => rws.addEventListener("open", resolve, { once: true })); // Wait for the connection to reopen

        assert.strictEqual(rws.onopen, onopen);
        assert.strictEqual(rws.onclose, onclose);
        assert.strictEqual(rws.onerror, onerror);
        assert.strictEqual(rws.onmessage, onmessage);

        rws.close();
      });
    });

    await t.test("Termination", async (t) => {
      await t.test("Dispatch 'terminate' event when maxRetries exceeded", async () => {
        const rws = new ReconnectingWebSocket("ws://invalid4567t7281.com", {
          maxRetries: 0,
          reconnectionDelay: 0,
        });

        let terminateEvent: CustomEvent<ReconnectingWebSocketError> | null = null;
        rws.addEventListener("terminate", (e) => {
          terminateEvent = e;
        });

        await new Promise((resolve) => setTimeout(resolve, 5000)); // Delay for network operations

        assert(terminateEvent! instanceof CustomEvent);
        assert((terminateEvent as CustomEvent).detail instanceof ReconnectingWebSocketError);
        assert.strictEqual(
          (terminateEvent as CustomEvent<ReconnectingWebSocketError>).detail.code,
          "RECONNECTION_LIMIT",
        );
        assert(rws.isTerminated, "should be permanently closed");

        rws.close();
      });

      await t.test("Dispatch 'terminate' event when user calls close()", () => {
        const rws = new ReconnectingWebSocket("ws://localhost:8080/");

        let terminateEvent: CustomEvent<ReconnectingWebSocketError> | null = null;
        rws.addEventListener("terminate", (e) => {
          terminateEvent = e as CustomEvent<ReconnectingWebSocketError>;
        });

        rws.close();

        assert(terminateEvent! instanceof CustomEvent);
        assert((terminateEvent as CustomEvent).detail instanceof ReconnectingWebSocketError);
        assert.strictEqual(
          (terminateEvent as CustomEvent<ReconnectingWebSocketError>).detail.code,
          "TERMINATED_BY_USER",
        );
        assert(rws.isTerminated, "should be permanently closed");
      });

      await t.test("No 'terminate' event on temporary close", async () => {
        const rws = new ReconnectingWebSocket("ws://localhost:8080/", {
          maxRetries: 1,
          reconnectionDelay: 100,
        });

        let terminateCalled = false;
        rws.addEventListener("terminate", () => terminateCalled = true);

        await new Promise((resolve) => rws.addEventListener("open", resolve, { once: true }));

        rws.close(undefined, undefined, false);

        await new Promise((resolve) => setTimeout(resolve, 5000)); // Delay for network operations

        assert.strictEqual(terminateCalled, false);
        assert(!rws.isTerminated, "should not be permanently closed");

        rws.close();
      });

      await t.test("Directly pass a message to the socket if the instance is terminated", () => {
        const rws = new ReconnectingWebSocket("ws://localhost:8080/");
        rws.close(); // Permanently terminate

        let called = false;
        // @ts-ignore - access private property
        const originalSend = rws._socket.send;
        // @ts-ignore - access private property
        rws._socket.send = function (data) {
          called = true;
          originalSend.call(this, data);
        };

        rws.send("DirectMessage");

        assert(called, "Socket send() should be called directly when terminated");
        // @ts-ignore - accessing private property
        assert.strictEqual(rws._messageBuffer.length, 0);
      });

      await t.test("Directly attach a listener to the socket if the instance is terminated", () => {
        const rws = new ReconnectingWebSocket("ws://localhost:8080/");
        rws.close(); // Permanently terminate

        let called = false;
        const listener = () => called = true;
        rws.addEventListener("message", listener);

        // @ts-ignore - accessing private property
        assert.strictEqual(rws._listeners.length, 0, "Listener should not be wrapped when terminated");

        rws.dispatchEvent(new Event("message"));
        assert(called, "Listener should be called directly");
      });
    });
  });

  server.close();
});
