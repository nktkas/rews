// deno-lint-ignore-file no-explicit-any

/**
 * Reconnecting WebSocket with automatic retry logic.
 *
 * Features:
 * - **Drop-in replacement** — standard `WebSocket` API, swap one line
 * - **Auto-reconnection** — configurable retries and delay strategy
 * - **Message buffering** — `send()` queues data while offline, flushes on reconnect
 * - **Persistent listeners** — `addEventListener` and `on*` handlers survive reconnections
 * - **Dynamic URL & protocols** — resolve fresh values on each reconnection
 * - **Zero dependencies** — works in Node.js, Deno, Bun, and browsers
 *
 * @module
 */

// ============================================================
// Types
// ============================================================

/** Type that can be a value or a Promise of that value. */
type MaybePromise<T> = T | Promise<T>;

/** URL or factory function that returns a URL for the WebSocket connection (sync or async). */
type UrlProvider =
  | string
  | URL
  | (() => MaybePromise<string | URL>);
/** Subprotocol(s) or factory function that returns subprotocol(s) for the WebSocket connection (sync or async). */
type ProtocolsProvider =
  | string
  | string[]
  | undefined
  | (() => MaybePromise<string | string[] | undefined>);

/** Data types accepted by {@link ReconnectingWebSocket.send}. */
type WebSocketSendData = string | ArrayBufferLike | Blob | ArrayBufferView;

/** Error code indicating the type of reconnection failure. */
type ReconnectingWebSocketErrorCode =
  | "RECONNECTION_LIMIT"
  | "RECONNECTION_DECLINED"
  | "TERMINATED_BY_USER"
  | "UNKNOWN_ERROR";

/** Configuration options for the {@link ReconnectingWebSocket}. */
export interface ReconnectingWebSocketOptions {
  /**
   * Maximum number of consecutive failed reconnection attempts.
   *
   * The counter resets after a connection stays open for {@link stableTimeout}.
   * @default `Infinity`
   */
  maxRetries?: number;
  /**
   * Maximum time in ms to wait for a connection to open. Set to `null` to disable.
   *
   * Does not limit the time spent in url/protocols factories.
   * @default `10_000`
   */
  connectionTimeout?: number | null;
  /**
   * Time in ms a connection must stay open before the retry counter resets.
   * @default `3_000`
   */
  stableTimeout?: number;
  /**
   * Delay before reconnection in ms, or a function of the attempt number (0-based).
   * @default Exponential backoff `2 ** n * 150` capped at 10s, with equal jitter.
   */
  reconnectionDelay?: number | ((attempt: number) => number);
  /**
   * Decide whether to reconnect after a non-user closure. Return `false` to permanently terminate.
   *
   * Receives the close event and the attempt number (0-based).
   * Not consulted for `close()` and `reconnect()` calls.
   * @default `() => true`
   */
  shouldReconnect?: (event: CloseEvent, attempt: number) => boolean;
}

/** Event types supported by attribute-style event handlers (`onopen`, `onclose`, etc.). */
type AttributeEventType = "open" | "close" | "error" | "message";

// ============================================================
// Classes
// ============================================================

/** Error thrown when reconnection fails in {@link ReconnectingWebSocket}. */
export class ReconnectingWebSocketError extends Error {
  /**
   * Error code indicating the type of reconnection error:
   * - `RECONNECTION_LIMIT`: Maximum reconnection attempts reached.
   * - `RECONNECTION_DECLINED`: `shouldReconnect` returned `false`.
   * - `TERMINATED_BY_USER`: Closed via `close()` method.
   * - `UNKNOWN_ERROR`: Unhandled error outside a connection attempt (e.g. in `reconnectionDelay` or `shouldReconnect`).
   */
  readonly code: ReconnectingWebSocketErrorCode;

  constructor(code: ReconnectingWebSocketErrorCode, cause?: unknown) {
    super(`WebSocket permanently terminated: ${code}`, { cause });
    this.name = "ReconnectingWebSocketError";
    this.code = code;
  }
}

/** WebSocket with auto-reconnection logic. */
export interface ReconnectingWebSocket {
  /** Register an event listener for the specified event type. */
  addEventListener<K extends keyof WebSocketEventMap>(
    type: K,
    listener: (this: ReconnectingWebSocket, ev: WebSocketEventMap[K]) => any,
    options?: boolean | AddEventListenerOptions,
  ): void;
  /** Register an event listener for a custom event type. */
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;

  /** Remove a previously registered event listener. */
  removeEventListener<K extends keyof WebSocketEventMap>(
    type: K,
    listener: (this: ReconnectingWebSocket, ev: WebSocketEventMap[K]) => any,
    options?: boolean | EventListenerOptions,
  ): void;
  /** Remove a previously registered listener for a custom event type. */
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
}
export class ReconnectingWebSocket extends EventTarget implements WebSocket {
  // ============================================================
  // State and initialization
  // ============================================================

  // --- Protected state -------------------------------------------

  /** URL provider for creating new connections. */
  protected readonly _urlProvider: UrlProvider;
  /** Protocols provider for creating new connections. */
  protected readonly _protocolsProvider: ProtocolsProvider;

  /** Current underlying WebSocket instance. */
  protected _socket: WebSocket | undefined;
  /** Binary data type for the WebSocket. */
  protected _binaryType: BinaryType = "blob";
  /** Buffer for messages sent while disconnected. */
  protected _messageBuffer: WebSocketSendData[] = [];

  /** Current reconnection attempt number. */
  protected _retryCount = 0;
  /** Resolves the in-flight {@link _awaitSocketLifecycle} promise; `undefined` when idle. */
  protected _settleLifecycle: ((init: CloseEventInit) => void) | undefined;
  /** Resolves the in-flight retry delay; `undefined` when not sleeping. */
  protected _skipDelay: (() => void) | undefined;
  /** Set while a user-requested reconnect closes the current socket; that close is not counted as a retry. */
  protected _reconnectRequested = false;
  /** Skips the upcoming retry delay; set by {@link reconnect} when no sleep is active. */
  protected _skipNextDelay = false;

  /** Attribute-style listener for the `close` event. */
  protected _onclose: ((this: WebSocket, ev: CloseEvent) => any) | null = null;
  /** Attribute-style listener for the `error` event. */
  protected _onerror: ((this: WebSocket, ev: Event) => any) | null = null;
  /** Attribute-style listener for the `message` event. */
  protected _onmessage: ((this: WebSocket, ev: MessageEvent<any>) => any) | null = null;
  /** Attribute-style listener for the `open` event. */
  protected _onopen: ((this: WebSocket, ev: Event) => any) | null = null;
  /** Map of currently active attribute-style listeners. */
  protected _attributeListeners: Partial<Record<AttributeEventType, EventListener>> = {};

  /** Controller used to signal permanent termination. */
  protected readonly _abortController: AbortController = new AbortController();

  // --- Public state ----------------------------------------------

  /** Reconnection configuration options. Read on every attempt, so changes apply live. */
  reconnectOptions: Required<ReconnectingWebSocketOptions>;

  /**
   * AbortSignal that is aborted when the instance is permanently terminated.
   * The abort reason is always a {@link ReconnectingWebSocketError}.
   */
  get terminationSignal(): AbortSignal {
    return this._abortController.signal;
  }

  // --- Constructor -----------------------------------------------

  /**
   * Create a new ReconnectingWebSocket with URL and options.
   *
   * @param url URL or factory function for the WebSocket connection.
   * @param options Configuration options.
   *
   * @throws {TypeError} If no WebSocket implementation is available.
   */
  constructor(url: UrlProvider, options?: ReconnectingWebSocketOptions);
  /**
   * Create a new ReconnectingWebSocket with URL, protocols and options.
   *
   * @param url URL or factory function for the WebSocket connection.
   * @param protocols Subprotocol(s) or factory function.
   * @param options Configuration options.
   *
   * @throws {TypeError} If no WebSocket implementation is available.
   */
  constructor(url: UrlProvider, protocols?: ProtocolsProvider, options?: ReconnectingWebSocketOptions);
  constructor(
    url: UrlProvider,
    protocolsOrOptions?: ProtocolsProvider | ReconnectingWebSocketOptions,
    maybeOptions?: ReconnectingWebSocketOptions,
  ) {
    super();

    const secondArgIsProtocols = protocolsOrOptions === undefined ||
      typeof protocolsOrOptions === "string" ||
      typeof protocolsOrOptions === "function" ||
      Array.isArray(protocolsOrOptions);
    const protocols = secondArgIsProtocols ? protocolsOrOptions : undefined;
    const options = secondArgIsProtocols ? maybeOptions : protocolsOrOptions;

    if (!globalThis.WebSocket) {
      throw new TypeError("No WebSocket implementation found.");
    }

    this._urlProvider = url;
    this._protocolsProvider = protocols;
    this.reconnectOptions = {
      maxRetries: options?.maxRetries ?? Infinity,
      connectionTimeout: options?.connectionTimeout === undefined ? 10_000 : options.connectionTimeout,
      stableTimeout: options?.stableTimeout ?? 3_000,
      reconnectionDelay: options?.reconnectionDelay ?? ((n) => {
        const delay = Math.min(2 ** n * 150, 10_000);
        return delay / 2 + Math.random() * (delay / 2);
      }),
      shouldReconnect: options?.shouldReconnect ?? (() => true),
    };

    // Background reconnection loop — handles its own errors via _terminate
    this._runLoop();
  }

  // ============================================================
  // Reconnection lifecycle
  // ============================================================

  /** Run the main reconnection loop. */
  protected async _runLoop(): Promise<void> {
    try {
      while (true) {
        this._skipNextDelay = false;

        let closeInit: CloseEventInit;
        try {
          this._socket = await this._createSocket();
          this._socket.binaryType = this._binaryType;
          if (this.terminationSignal.aborted) {
            this._socket.close();
            break;
          }

          closeInit = await this._awaitSocketLifecycle();
        } catch (error) {
          // Failure to even create the socket (e.g. a URL factory error) counts as a failed attempt
          if (this.terminationSignal.aborted) break;
          this.dispatchEvent(new Event("error"));
          closeInit = { code: 1006, reason: String(error), wasClean: false };
        }

        const reconnectRequested = this._reconnectRequested;
        this._reconnectRequested = false;

        // HACK (nktkas/rews#7):
        // Dispatch a freshly constructed event on `this`, never the socket's own —
        // React Native's strict EventTarget throws on a foreign event.
        const closeEvent = new CloseEvent_("close", closeInit);

        if (!reconnectRequested && !this.terminationSignal.aborted) {
          if (!this.reconnectOptions.shouldReconnect(closeEvent, this._retryCount)) {
            this._terminate("RECONNECTION_DECLINED");
          } else if (this._retryCount >= this.reconnectOptions.maxRetries) {
            this._terminate("RECONNECTION_LIMIT");
          }
        }
        this.dispatchEvent(closeEvent);
        if (this.terminationSignal.aborted) return;

        if (!reconnectRequested) {
          const retryCount = this._retryCount++;

          if (!this._skipNextDelay) {
            const delay = typeof this.reconnectOptions.reconnectionDelay === "number"
              ? this.reconnectOptions.reconnectionDelay
              : this.reconnectOptions.reconnectionDelay(retryCount);
            await this._delay(delay);
            if (this.terminationSignal.aborted) break;
          }
        }
      }
    } catch (error) {
      this._terminate("UNKNOWN_ERROR", error);
    }

    // Paths that exit the loop without a close event (terminated before the socket
    // opened, during the retry sleep, or by a policy callback throwing) synthesize
    // the final one. On the throwing path the socket's real close code/reason is lost.
    this.dispatchEvent(new CloseEvent_("close", { code: 1006, reason: "", wasClean: false }));
  }

  /**
   * Create a new WebSocket instance using the current URL and protocols providers.
   *
   * @return Configured WebSocket instance.
   */
  protected async _createSocket(): Promise<WebSocket> {
    // A hung user factory must not outlive termination — race it against the signal
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(this.terminationSignal.reason);

      // HACK:
      // React Native's AbortController polyfill ignores the { signal } listener option,
      // so the listener is removed manually instead.
      this.terminationSignal.addEventListener("abort", onAbort, { once: true });
    });

    try {
      const url = typeof this._urlProvider === "function"
        ? await Promise.race([this._urlProvider(), aborted])
        : this._urlProvider;
      const protocols = typeof this._protocolsProvider === "function"
        ? await Promise.race([this._protocolsProvider(), aborted])
        : this._protocolsProvider;

      const socket = new WebSocket(url, protocols);
      this._armConnectionTimeout(socket);

      return socket;
    } finally {
      this.terminationSignal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Close the socket and settle its lifecycle if it does not open within the timeout.
   *
   * @param socket Socket to monitor.
   */
  protected _armConnectionTimeout(socket: WebSocket): void {
    const timeout = this.reconnectOptions.connectionTimeout;
    if (timeout === null) return;

    const timer = setTimeout(() => {
      if (socket.readyState !== ReconnectingWebSocket.CONNECTING) return;

      socket.close();

      // HACK:
      // Node.js <24, Bun, and React Native skip the close event during CONNECTING.
      // Settle directly; the identity check guards against a stale timer.
      if (this._socket === socket) {
        this._settleLifecycle?.({ code: 1006, reason: "", wasClean: false });
      }
    }, timeout);

    const cleanup = () => clearTimeout(timer);
    for (const type of ["open", "close", "error"] as const) {
      socket.addEventListener(type, cleanup, { once: true });
    }
  }

  /** Await the full lifecycle of the current socket until it closes. */
  protected _awaitSocketLifecycle(): Promise<CloseEventInit> {
    return new Promise<CloseEventInit>((resolve) => {
      const socket = this._socket!;
      const ac = new AbortController();
      const { signal } = ac;

      const settle = (init: CloseEventInit): void => {
        if (signal.aborted) return; // already settled
        this._settleLifecycle = undefined;
        ac.abort();
        resolve(init);
      };
      this._settleLifecycle = settle;

      socket.addEventListener("open", () => {
        if (!this._flushBuffer(socket)) return;

        const stableTimer = setTimeout(() => this._retryCount = 0, this.reconnectOptions.stableTimeout);
        signal.addEventListener("abort", () => clearTimeout(stableTimer), { once: true });

        this.dispatchEvent(new Event("open"));
      }, { signal });

      socket.addEventListener("message", (event) => {
        this.dispatchEvent(new MessageEvent_("message", { data: event.data, origin: event.origin }));
      }, { signal });

      socket.addEventListener("error", () => {
        this.dispatchEvent(new Event("error"));

        // HACK (nodejs/undici#3546):
        // Node.js <24 skips close on connection failure — settle directly.
        if (socket.readyState === ReconnectingWebSocket.CONNECTING) {
          settle({ code: 1006, reason: "", wasClean: false });
        }
      }, { signal });

      socket.addEventListener("close", (event) => {
        // Some runtimes report code 0 (reserved by RFC 6455) when the connection fails
        settle({ code: event.code || 1006, reason: event.reason, wasClean: event.wasClean });
      }, { signal });
    });
  }

  /** Flush buffered messages; on partial failure keeps the unsent tail and drops the socket. */
  protected _flushBuffer(socket: WebSocket): boolean {
    let sentCount = 0;
    try {
      for (; sentCount < this._messageBuffer.length; sentCount++) {
        socket.send(this._messageBuffer[sentCount]!);
      }
      this._messageBuffer = [];
      return true;
    } catch {
      this._messageBuffer.splice(0, sentCount);
      socket.close();
      return false;
    }
  }

  /** Wait between retries; cut short by reconnect() and termination. */
  protected _delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        if (this._skipDelay === done) this._skipDelay = undefined;
        clearTimeout(timer);
        this.terminationSignal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this._skipDelay = done;
      this.terminationSignal.addEventListener("abort", done, { once: true });
    });
  }

  /** Close the current socket and settle its lifecycle if it was still connecting. */
  protected _dropSocket(code?: number, reason?: string): void {
    const wasConnecting = this._socket?.readyState === ReconnectingWebSocket.CONNECTING;
    this._socket?.close(code, reason);

    // HACK:
    // Node.js <24, Bun, and React Native skip the close event when close() is called during CONNECTING.
    // Settle directly; on compliant runtimes the native close settles first and this is a no-op.
    if (wasConnecting) {
      this._settleLifecycle?.({ code: 1006, reason: "", wasClean: false });
    }
  }

  /** Permanently terminate the instance and clean up resources. */
  protected _terminate(code: ReconnectingWebSocketErrorCode, cause?: unknown): void {
    if (this.terminationSignal.aborted) return;

    this._abortController.abort(new ReconnectingWebSocketError(code, cause));
    this._socket?.close();
    this._messageBuffer = [];
  }

  // ============================================================
  // WebSocket property implementations
  // ============================================================

  // --- Properties ------------------------------------------------

  /** The current socket's URL; before the first connection — the static URL, or `""` for a factory. */
  get url(): string {
    if (this._socket) return this._socket.url;
    return typeof this._urlProvider === "function" ? "" : String(this._urlProvider);
  }

  /** `CLOSED` only after permanent termination; any reconnection phase reports `CONNECTING`. */
  get readyState(): number {
    if (this.terminationSignal.aborted) return ReconnectingWebSocket.CLOSED;
    return this._socket?.readyState === ReconnectingWebSocket.OPEN
      ? ReconnectingWebSocket.OPEN
      : ReconnectingWebSocket.CONNECTING;
  }

  /** Bytes queued on the current socket plus messages buffered while disconnected. */
  get bufferedAmount(): number {
    let total = this._socket?.bufferedAmount ?? 0;
    for (const data of this._messageBuffer) {
      if (typeof data === "string") total += new TextEncoder().encode(data).length;
      else if (data instanceof Blob) total += data.size;
      else total += data.byteLength;
    }
    return total;
  }

  get extensions(): string {
    return this._socket?.extensions ?? "";
  }

  get protocol(): string {
    return this._socket?.protocol ?? "";
  }

  get binaryType(): BinaryType {
    return this._binaryType;
  }
  set binaryType(value: BinaryType) {
    this._binaryType = value;
    if (this._socket) this._socket.binaryType = value;
  }

  // --- Constants -------------------------------------------------

  /** Connection is being established. */
  readonly CONNECTING = 0;
  /** Connection is open and ready to communicate. */
  readonly OPEN = 1;
  /** Connection is in the process of closing. */
  readonly CLOSING = 2;
  /** Connection is closed. */
  readonly CLOSED = 3;

  /** Connection is being established. */
  static readonly CONNECTING = 0;
  /** Connection is open and ready to communicate. */
  static readonly OPEN = 1;
  /** Connection is in the process of closing. */
  static readonly CLOSING = 2;
  /** Connection is closed. */
  static readonly CLOSED = 3;

  // --- Event handlers --------------------------------------------

  /** Attribute-style handler for `close` events. */
  get onclose(): ((this: WebSocket, ev: CloseEvent) => any) | null {
    return this._onclose;
  }
  /** Set the attribute-style handler for `close` events. */
  set onclose(handler: ((this: WebSocket, ev: CloseEvent) => any) | null) {
    this._onclose = handler;
    this._setAttributeListener("close", handler);
  }

  /** Attribute-style handler for `error` events. */
  get onerror(): ((this: WebSocket, ev: Event) => any) | null {
    return this._onerror;
  }
  /** Set the attribute-style handler for `error` events. */
  set onerror(handler: ((this: WebSocket, ev: Event) => any) | null) {
    this._onerror = handler;
    this._setAttributeListener("error", handler);
  }

  /** Attribute-style handler for `message` events. */
  get onmessage(): ((this: WebSocket, ev: MessageEvent<any>) => any) | null {
    return this._onmessage;
  }
  /** Set the attribute-style handler for `message` events. */
  set onmessage(handler: ((this: WebSocket, ev: MessageEvent<any>) => any) | null) {
    this._onmessage = handler;
    this._setAttributeListener("message", handler);
  }

  /** Attribute-style handler for `open` events. */
  get onopen(): ((this: WebSocket, ev: Event) => any) | null {
    return this._onopen;
  }
  /** Set the attribute-style handler for `open` events. */
  set onopen(handler: ((this: WebSocket, ev: Event) => any) | null) {
    this._onopen = handler;
    this._setAttributeListener("open", handler);
  }

  /** Attach or detach the dispatcher for an attribute-style event handler. */
  protected _setAttributeListener(type: AttributeEventType, handler: object | null): void {
    const active = this._attributeListeners[type];

    if (handler && !active) {
      const dispatch = (event: Event) => {
        this[`_on${type}`]?.call(this, event as CloseEvent & MessageEvent);
      };
      this._attributeListeners[type] = dispatch;
      super.addEventListener(type, dispatch);
    } else if (!handler && active) {
      super.removeEventListener(type, active);
      delete this._attributeListeners[type];
    }
  }

  // --- Public methods --------------------------------------------

  /**
   * Permanently close the WebSocket connection and stop reconnection.
   *
   * @param code Status code for the closure.
   * @param reason Human-readable reason for the closure.
   *
   * @throws {DOMException} If the code is not 1000 or in 3000-4999, or the reason is longer than 123 UTF-8 bytes.
   */
  close(code?: number, reason?: string): void {
    validateCloseArgs(code, reason);
    this._dropSocket(code, reason);
    this._terminate("TERMINATED_BY_USER");
  }

  /**
   * Drop the current connection and reconnect immediately.
   *
   * Closes the current socket without counting it towards `maxRetries`, or skips
   * the current/upcoming retry delay. Cannot interrupt an in-flight url/protocols
   * factory. Does nothing once permanently terminated.
   *
   * @param code Status code for closing the current socket.
   * @param reason Human-readable reason for the closure.
   *
   * @throws {DOMException} If the code is not 1000 or in 3000-4999, or the reason is longer than 123 UTF-8 bytes.
   */
  reconnect(code?: number, reason?: string): void {
    validateCloseArgs(code, reason);
    if (this.terminationSignal.aborted) return;

    if (this._skipDelay) {
      this._skipDelay();
      return;
    }

    if (this._settleLifecycle && this._socket && this._socket.readyState !== ReconnectingWebSocket.CLOSED) {
      this._reconnectRequested = true;
      this._dropSocket(code, reason);
      return;
    }

    // Settled but not yet sleeping: skip the upcoming delay
    this._skipNextDelay = true;
  }

  /**
   * Send data to the server.
   *
   * If the connection is not open, the data is buffered and sent once it is established.
   * After permanent termination, data is silently discarded.
   */
  send(data: WebSocketSendData): void {
    if (this._socket?.readyState === ReconnectingWebSocket.OPEN) {
      this._socket.send(data);
    } else if (!this.terminationSignal.aborted) {
      this._messageBuffer.push(data);
    }
  }
}

// ============================================================
// Polyfills
// ============================================================

const CloseEvent_ = globalThis.CloseEvent || class CloseEvent extends Event {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
  constructor(type: string, eventInitDict?: CloseEventInit) {
    super(type, eventInitDict);
    this.code = eventInitDict?.code ?? 0;
    this.reason = eventInitDict?.reason ?? "";
    this.wasClean = eventInitDict?.wasClean ?? false;
  }
};

const DOMException_ = globalThis.DOMException || class DOMException extends Error {
  constructor(message = "", name = "Error") {
    super(message);
    this.name = name;
  }
};

const MessageEvent_ = globalThis.MessageEvent || class MessageEvent<T> extends Event {
  readonly data: T | null;
  readonly origin: string;
  readonly lastEventId: string;
  readonly source: MessageEventSource | null;
  readonly ports: ReadonlyArray<MessagePort>;
  constructor(type: string, eventInitDict?: MessageEventInit<T>) {
    super(type, eventInitDict);
    this.data = eventInitDict?.data ?? null;
    this.origin = eventInitDict?.origin ?? "";
    this.lastEventId = eventInitDict?.lastEventId ?? "";
    this.source = eventInitDict?.source ?? null;
    this.ports = eventInitDict?.ports ?? [];
  }
  initMessageEvent() {}
};

// ============================================================
// Utilities
// ============================================================

/** Validate close code and reason per the WHATWG WebSocket specification. */
function validateCloseArgs(code?: number, reason?: string): void {
  if (code !== undefined && code !== 1000 && !(code >= 3000 && code <= 4999)) {
    throw new DOMException_(
      `The close code must be either 1000, or between 3000 and 4999. ${code} is neither.`,
      "InvalidAccessError",
    );
  }
  if (reason !== undefined && new TextEncoder().encode(reason).length > 123) {
    throw new DOMException_("The close reason must not be greater than 123 UTF-8 bytes.", "SyntaxError");
  }
}
