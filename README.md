# @nktkas/rews

[![License: MIT](https://img.shields.io/badge/License-MIT-brightgreen.svg)](https://opensource.org/licenses/MIT)
[![npm](https://img.shields.io/npm/v/@nktkas/rews)](https://www.npmjs.com/package/@nktkas/rews)
[![JSR](https://jsr.io/badges/@nktkas/rews)](https://jsr.io/@nktkas/rews)

Drop-in WebSocket replacement that reconnects automatically and preserves all event listeners and buffered messages.

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

Replace `WebSocket` with `ReconnectingWebSocket`:

```ts
import { ReconnectingWebSocket } from "@nktkas/rews";

// const ws = new WebSocket("wss://...");
const ws = new ReconnectingWebSocket("wss://...", {
  // optional reconnection options
});
ws.addEventListener("message", (e) => console.log(e.data));
ws.send("hello");
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

### Differences from standard WebSocket:

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

Dispatched on permanent closure (reconnection limit, user termination, or unknown error during reconnection):

```ts
import { ReconnectingWebSocket } from "@nktkas/rews";

const ws = new ReconnectingWebSocket("wss://...");

ws.addEventListener("terminate", (event) => {
  const error = event.detail; // ReconnectingWebSocketError
  console.log(error.code, error.cause);
  // code: "RECONNECTION_LIMIT" | "TERMINATED_BY_USER" | "UNKNOWN_ERROR"
  // cause: original `Error` if available
});
```
