// deno-lint-ignore-file no-explicit-any

type UrlProvider = string | URL | (() => string | URL);
type ProtocolsProvider = string | string[] | undefined | (() => string | string[] | undefined);

type WebSocketSendData = string | ArrayBufferLike | Blob | ArrayBufferView;

type ReconnectingWebSocketErrorCode =
  | "RECONNECTION_LIMIT"
  | "TERMINATED_BY_USER"
  | "UNKNOWN_ERROR";

/** Configuration options for the {@link ReconnectingWebSocket}. */
export interface ReconnectingWebSocketOptions {
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

interface ReconnectingWebSocketEventMap extends WebSocketEventMap {
  terminate: CustomEvent<ReconnectingWebSocketError>;
}

/** Error thrown when reconnection fails in {@link ReconnectingWebSocket}. */
export class ReconnectingWebSocketError extends Error {
  /**
   * Error code indicating the type of reconnection error:
   * - `RECONNECTION_LIMIT`: Maximum reconnection attempts reached
   * - `TERMINATED_BY_USER`: Closed via `close()` method
   * - `UNKNOWN_ERROR`: Unexpected failure during reconnection
   */
  code: ReconnectingWebSocketErrorCode;
  constructor(code: ReconnectingWebSocketErrorCode, cause?: unknown) {
    super(`Error when reconnecting WebSocket: ${code}`);
    this.name = "ReconnectingWebSocketError";
    this.cause = cause;
    this.code = code;
  }
}

/**
 * A WebSocket with auto-reconnection logic. Fully compatible with standard WebSocket API.
 *
 * Features:
 * - Automatic reconnection with configurable max retries and delay.
 * - Buffers messages sent while disconnected and sends them upon reconnection.
 * - Re-applies event listeners after reconnection.
 * - Supports dynamic URL and protocols via functions.
 *
 * Additional properties and events:
 * - `isTerminated`: Indicates whether the instance has been permanently terminated.
 * - `terminationReason`: If terminated, provides the reason for termination.
 * - `terminationSignal`: AbortSignal that is aborted when the instance is permanently terminated.
 * - `terminate` event: Fired when the instance is permanently terminated.
 */
export class ReconnectingWebSocket implements WebSocket {
  protected _socket!: WebSocket;
  protected _urlProvider: UrlProvider;
  protected _protocolsProvider: ProtocolsProvider;
  protected _listeners: {
    type: string;
    listener: EventListenerOrEventListenerObject;
    options?: boolean | AddEventListenerOptions;
    listenerProxy: EventListenerOrEventListenerObject;
  }[] = [];
  protected _attempt = 0;
  protected _messageBuffer: WebSocketSendData[] = [];
  protected _abortController: AbortController = new AbortController();

  /** Indicates whether the instance has been permanently terminated. */
  get isTerminated(): boolean {
    return this._abortController.signal.aborted;
  }

  /** If terminated, provides the reason for termination. */
  get terminationReason(): ReconnectingWebSocketError | undefined {
    return this._abortController.signal.reason;
  }

  /** AbortSignal that is aborted when the instance is permanently terminated. */
  get terminationSignal(): AbortSignal {
    return this._abortController.signal;
  }

  /** Reconnection configuration options. */
  reconnectOptions: Required<ReconnectingWebSocketOptions>;

  constructor(url: UrlProvider, options?: ReconnectingWebSocketOptions);
  constructor(url: UrlProvider, protocols?: ProtocolsProvider, options?: ReconnectingWebSocketOptions);
  constructor(
    url: UrlProvider,
    protocolsOrOptions?: ProtocolsProvider | ReconnectingWebSocketOptions,
    maybeOptions?: ReconnectingWebSocketOptions,
  ) {
    const protocols = typeof protocolsOrOptions === "string" ||
        typeof protocolsOrOptions === "function" ||
        Array.isArray(protocolsOrOptions)
      ? protocolsOrOptions
      : undefined;
    const options = typeof protocolsOrOptions === "object" && !Array.isArray(protocolsOrOptions)
      ? protocolsOrOptions
      : maybeOptions;

    if (!globalThis.WebSocket && !options?.WebSocket) {
      throw new Error(
        "No WebSocket implementation found. Please provide a custom WebSocket constructor in the options.",
      );
    }

    this._urlProvider = url;
    this._protocolsProvider = protocols;
    this.reconnectOptions = {
      WebSocket: options?.WebSocket ?? WebSocket,
      maxRetries: options?.maxRetries ?? 3,
      connectionTimeout: options?.connectionTimeout === undefined ? 10_000 : options.connectionTimeout,
      reconnectionDelay: options?.reconnectionDelay ?? ((n) => Math.min(~~(1 << n) * 150, 10_000)),
    };

    this._createSocket();
    this._initInternalListeners();
  }

  protected _createSocket() {
    const url = typeof this._urlProvider === "function" ? this._urlProvider() : this._urlProvider;
    const protocols = typeof this._protocolsProvider === "function"
      ? this._protocolsProvider()
      : this._protocolsProvider;
    this._socket = createSocketWithTimeout(
      () => new this.reconnectOptions.WebSocket(url, protocols),
      this.reconnectOptions.connectionTimeout,
    );
  }

  protected _initInternalListeners() {
    const handleClose = () => {
      this._socket.removeEventListener("error", handleError);
      this._close();
    };
    const handleError = () => {
      this._socket.removeEventListener("close", handleClose);
      this._close();
    };
    this._socket.addEventListener("open", this._open, { once: true });
    this._socket.addEventListener("close", handleClose, { once: true });
    this._socket.addEventListener("error", handleError, { once: true });
  }

  protected _open: () => void = () => {
    // Reset the attempt counter
    this._attempt = 0;

    // Send all buffered messages
    this._messageBuffer.forEach((item) => {
      this._socket.send(item);
    });
    this._messageBuffer = [];
  };

  protected _close = async () => {
    try {
      // If the instance is terminated, do not attempt to reconnect
      if (this._abortController.signal.aborted) return;

      // Check if reconnection should be attempted
      if (++this._attempt > this.reconnectOptions.maxRetries) {
        this._cleanup("RECONNECTION_LIMIT");
        return;
      }

      // Delay before reconnecting
      const delay = typeof this.reconnectOptions.reconnectionDelay === "number"
        ? this.reconnectOptions.reconnectionDelay
        : this.reconnectOptions.reconnectionDelay(this._attempt);
      await sleep(delay, this._abortController.signal);

      // Create a new WebSocket instance and re-apply event listeners (and some properties)
      const { onclose, onerror, onmessage, onopen, binaryType } = this._socket; // preserve event handlers

      this._createSocket();
      this._initInternalListeners();

      this._listeners.forEach(({ type, listenerProxy, options }) => {
        this._socket.addEventListener(type, listenerProxy, options);
      });
      this._socket.onclose = onclose;
      this._socket.onerror = onerror;
      this._socket.onmessage = onmessage;
      this._socket.onopen = onopen;
      this._socket.binaryType = binaryType;
    } catch (error) {
      this._cleanup("UNKNOWN_ERROR", error);
    }
  };

  protected _cleanup(code: ConstructorParameters<typeof ReconnectingWebSocketError>[0], cause?: unknown) {
    const error = new ReconnectingWebSocketError(code, cause);
    this._abortController.abort(error);
    this._socket.close();
    this.dispatchEvent(new CustomEvent("terminate", { detail: error }));
  }

  // WebSocket property implementations
  get url(): string {
    return this._socket.url;
  }
  get readyState(): number {
    return this._socket.readyState;
  }
  get bufferedAmount(): number {
    return this._socket.bufferedAmount;
  }
  get extensions(): string {
    return this._socket.extensions;
  }
  get protocol(): string {
    return this._socket.protocol;
  }
  get binaryType(): BinaryType {
    return this._socket.binaryType;
  }
  set binaryType(value: BinaryType) {
    this._socket.binaryType = value;
  }

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  get onclose(): ((this: WebSocket, ev: CloseEvent) => any) | null {
    return this._socket.onclose;
  }
  set onclose(value: ((this: WebSocket, ev: CloseEvent) => any) | null) {
    this._socket.onclose = value;
  }

  get onerror(): ((this: WebSocket, ev: Event) => any) | null {
    return this._socket.onerror;
  }
  set onerror(value: ((this: WebSocket, ev: Event) => any) | null) {
    this._socket.onerror = value;
  }

  get onmessage(): ((this: WebSocket, ev: MessageEvent<any>) => any) | null {
    return this._socket.onmessage;
  }
  set onmessage(value: ((this: WebSocket, ev: MessageEvent<any>) => any) | null) {
    this._socket.onmessage = value;
  }

  get onopen(): ((this: WebSocket, ev: Event) => any) | null {
    return this._socket.onopen;
  }
  set onopen(value: ((this: WebSocket, ev: Event) => any) | null) {
    this._socket.onopen = value;
  }

  /**
   * @param permanently - If `true`, the connection will be permanently closed. Default is `true`.
   */
  close(code?: number, reason?: string, permanently: boolean = true): void {
    this._socket.close(code, reason);
    if (permanently) this._cleanup("TERMINATED_BY_USER");
  }

  /**
   * @note If the connection is not open, the data will be buffered and sent when the connection is established.
   */
  send(data: WebSocketSendData): void {
    if (this._socket.readyState !== ReconnectingWebSocket.OPEN && !this._abortController.signal.aborted) {
      this._messageBuffer.push(data);
    } else {
      this._socket.send(data);
    }
  }

  /**
   * @note The event listeners added via this method will be re-applied after reconnection. `once` option is supported.
   */
  addEventListener<K extends keyof ReconnectingWebSocketEventMap>(
    type: K,
    listener:
      | ((this: ReconnectingWebSocket, ev: ReconnectingWebSocketEventMap[K]) => any)
      | { handleEvent: (event: ReconnectingWebSocketEventMap[K]) => any },
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void {
    // Wrap the listener to handle reconnection
    let listenerProxy: EventListenerOrEventListenerObject;
    if (this._abortController.signal.aborted) {
      // If the instance is terminated, use the original listener
      listenerProxy = listener;
    } else {
      // Check if the listener is already registered
      const index = this._listeners.findIndex((e) => listenersMatch(e, { type, listener, options }));
      if (index !== -1) {
        // Use the existing listener proxy
        listenerProxy = this._listeners[index].listenerProxy;
      } else {
        // Wrap the original listener to follow the once option when reconnecting
        listenerProxy = (event: Event) => {
          try {
            if (typeof listener === "function") {
              listener.call(this, event);
            } else {
              listener.handleEvent(event);
            }
          } finally {
            // If the listener is marked as once, remove it after the first invocation
            if (typeof options === "object" && options.once === true) {
              const index = this._listeners.findIndex((e) => listenersMatch(e, { type, listener, options }));
              if (index !== -1) {
                this._listeners.splice(index, 1);
              }
            }
          }
        };
        this._listeners.push({ type, listener, options, listenerProxy });
      }
    }

    // Add the wrapped (or original) listener
    this._socket.addEventListener(type, listenerProxy, options);
  }

  removeEventListener<K extends keyof ReconnectingWebSocketEventMap>(
    type: K,
    listener:
      | ((this: ReconnectingWebSocket, ev: ReconnectingWebSocketEventMap[K]) => any)
      | { handleEvent: (event: ReconnectingWebSocketEventMap[K]) => any },
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void {
    // Remove a wrapped listener, not an original listener
    const index = this._listeners.findIndex((e) => listenersMatch(e, { type, listener, options }));
    if (index !== -1) {
      const { listenerProxy } = this._listeners[index];
      this._socket.removeEventListener(type, listenerProxy, options);
      this._listeners.splice(index, 1);
    } else {
      // If the wrapped listener is not found, remove the original listener
      this._socket.removeEventListener(type, listener, options);
    }
  }

  dispatchEvent(event: Event): boolean {
    return this._socket.dispatchEvent(event);
  }
}

function createSocketWithTimeout(socketFactory: () => WebSocket, timeout: number | null): WebSocket {
  const socket = socketFactory();
  if (timeout === null) return socket;

  const handleOpen = () => {
    socket.removeEventListener("close", handleClose);
    socket.removeEventListener("error", handleError);
    signal.removeEventListener("abort", handleAbort);
  };
  const handleClose = () => {
    socket.removeEventListener("open", handleOpen);
    socket.removeEventListener("error", handleError);
    signal.removeEventListener("abort", handleAbort);
  };
  const handleError = () => {
    socket.removeEventListener("open", handleOpen);
    socket.removeEventListener("close", handleClose);
    signal.removeEventListener("abort", handleAbort);
  };
  const handleAbort = () => {
    socket.close(3008, "Timeout"); // https://www.iana.org/assignments/websocket/websocket.xml#close-code-number
  };

  const signal = AbortSignal.timeout(timeout);

  socket.addEventListener("open", handleOpen, { once: true, signal });
  socket.addEventListener("close", handleClose, { once: true, signal });
  socket.addEventListener("error", handleError, { once: true, signal });
  signal.addEventListener("abort", handleAbort, { once: true });

  return socket;
}

type ListenerRecord = {
  type: string;
  listener: EventListenerOrEventListenerObject;
  options?: boolean | AddEventListenerOptions;
};

function listenersMatch(a: ListenerRecord, b: ListenerRecord): boolean {
  const aCapture = typeof a.options === "object" ? a.options.capture : a.options;
  const bCapture = typeof b.options === "object" ? b.options.capture : b.options;
  return a.type === b.type && a.listener === b.listener && !!aCapture === !!bCapture;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const onTimeout = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(onTimeout, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
