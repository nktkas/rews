# @nktkas/rews

[![npm](https://img.shields.io/npm/v/@nktkas/rews)](https://www.npmjs.com/package/@nktkas/rews)
[![JSR](https://jsr.io/badges/@nktkas/rews)](https://jsr.io/@nktkas/rews)
[![bundlejs](https://img.shields.io/bundlejs/size/@nktkas/rews)](https://bundlejs.com/?q=@nktkas/rews)

WebSocket with auto-reconnection — a drop-in replacement for the standard WebSocket.

## Installation

### Node.js (choose your package manager)

```
npm i @nktkas/rews

pnpm add @nktkas/rews

yarn add @nktkas/rews
```

### Deno

```
deno add jsr:@nktkas/rews
```

## Usage

Simply replace `WebSocket` with `ReconnectingWebSocket`:

```ts
import { ReconnectingWebSocket } from "@nktkas/rews";

// const ws = new WebSocket("wss://...");
const ws = new ReconnectingWebSocket("wss://...", {
  // optional reconnection options
});
ws.addEventListener("message", (e) => console.log(e.data));
ws.send("data");
```

### Options

```ts
interface ReconnectingWebSocketOptions {
  /**
   * Custom WebSocket constructor.
   * @default globalThis.WebSocket
   */
  WebSocket?: new (url: string | URL, protocols?: string | string[]) => WebSocket;
  /**
   * Maximum number of reconnection attempts.
   * @default 3
   */
  maxRetries?: number;
  /**
   * Maximum time in ms to wait for a connection to open.
   * Set to `null` to disable.
   * @default 10_000
   */
  connectionTimeout?: number | null;
  /**
   * Delay before reconnection in ms.
   * May be a number or a function that returns a number.
   * @param attempt - The current attempt number.
   * @default (attempt) => Math.min(~~(1 << attempt) * 150, 10_000); // Exponential backoff (max 10s)
   */
  reconnectionDelay?: number | ((attempt: number) => number);
}
```

### Differences from standard WebSocket

#### Automatic Reconnection

`ReconnectingWebSocket` will automatically attempt to reconnect when the connection is lost, up to a configurable number
of retries.

#### Message Buffering

Messages sent while the connection is closed are buffered and sent once the connection is re-established.

#### Preserved Event Listeners

All event listeners added to the `ReconnectingWebSocket` instance are preserved across reconnections.

#### Dynamic URL and Protocol Providers

The `url` and `protocols` parameters accept functions that return their respective values. These functions are invoked
on each reconnection attempt, enabling dynamic endpoint resolution or authentication token refresh.

```ts
const ws = new ReconnectingWebSocket(
  () => `wss://example.com?token=${getAuthToken()}`,
  () => ["protocol-v1"],
);
```

#### Terminate Event

The `terminate` event fires when the WebSocket permanently closes.

Error Codes:

- `RECONNECTION_LIMIT` - Maximum reconnection attempts reached
- `TERMINATED_BY_USER` - Closed via `close()` method
- `UNKNOWN_ERROR` - An unknown error occurred during reconnection

Usage:

```ts
ws.addEventListener("terminate", (event) => {
  const error = event.detail; // ReconnectingWebSocketError
  console.log(error.code); // Error code
  console.log(error.cause); // Original error if available
});

// Check termination status manually
if (ws.isTerminated) {
  const error = ws.terminationReason!; // ReconnectingWebSocketError
  console.log(error.code); // Error code
  console.log(error.cause); // Original error if available
}
```

## Why Use This

**Before:**

```ts
// Requires manual reconnection logic, listener re-attachment, and message buffering
let ws: WebSocket;
let attempts = 0;
const messageHandler = (e) => console.log(e.data);
const messageQueue: string[] = [];

function connect() {
  ws = new WebSocket("wss://example.com");

  // Re-attach listener on each reconnection
  ws.addEventListener("message", messageHandler);

  ws.onopen = () => {
    attempts = 0;

    // Send queued messages
    while (messageQueue.length > 0) {
      ws.send(messageQueue.shift()!);
    }
  };

  ws.onclose = () => {
    // Attempt reconnection
    if (attempts++ < 3) {
      setTimeout(connect, 1000);
    }
  };

  ws.onerror = () => {
    ws.close();
  };
}

function send(data: string) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(data);
  } else {
    messageQueue.push(data); // Buffer message if not connected
  }
}

connect();
send("data");
```

**After:**

```ts
// Original WebSocket API remains unchanged despite reconnection logic
const ws = new ReconnectingWebSocket("wss://example.com");
ws.addEventListener("message", (e) => console.log(e.data)); // listener persists across reconnections
ws.send("data"); // buffered if disconnected
```
