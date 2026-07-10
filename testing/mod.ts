/**
 * `FakeFirecracker` — a test double that speaks the Firecracker API and
 * hybrid-vsock protocols over real Unix sockets, with the real boot-phase
 * rules (pre-boot vs post-boot endpoint gating), fault injection, and
 * request recording. No KVM, no Linux, no root: your sandbox platform's
 * test suite runs anywhere Deno runs.
 *
 * The fake aims for *protocol* fidelity, not emulation: it enforces the
 * same state machine and answers with the same shapes real Firecracker
 * does, but boots nothing. Fault-message strings are approximations.
 *
 * @example Testing code that drives a Firecracker API socket
 * ```ts
 * import { FirecrackerClient } from "@nullstyle/firecracker/client";
 * import { FakeFirecracker } from "@nullstyle/firecracker/testing";
 *
 * await using fake = await FakeFirecracker.start();
 * using client = new FirecrackerClient({ socketPath: fake.socketPath });
 *
 * await client.putBootSource({ kernel_image_path: "/vmlinux" });
 * await client.instanceStart();
 * // pre-boot-only calls now fail exactly like the real thing:
 * // await client.putMachineConfig(...) → ApiError (400)
 * ```
 *
 * @module
 */

import { isAbsolute, join } from "@std/path";
import type {
  Balloon,
  BalloonHintingStatus,
  BalloonStats,
  BootSource,
  CpuConfig,
  Drive,
  EntropyDevice,
  FullVmConfiguration,
  InstanceInfo,
  Logger,
  MachineConfiguration,
  MemoryHotplugConfig,
  Metrics,
  MmdsConfig,
  MmdsContentsObject,
  NetworkInterface,
  Pmem,
  SerialDevice,
  SnapshotCreateParams,
  SnapshotLoadParams,
  Vsock,
} from "../src/api/types.ts";
import { readLineBytewise, writeAll } from "../src/internal/line_reader.ts";

/** One request the fake has served, in arrival order. */
export interface RecordedRequest {
  method: string;
  path: string;
  /** Parsed JSON body, the raw text when unparsable, or `undefined`. */
  body?: unknown;
}

/** Matcher + response for {@linkcode FakeFirecracker.failNext}. */
export interface InjectedFailure {
  method: string;
  /** Exact request path to match, e.g. `"/drives/rootfs"`. */
  path: string;
  status: number;
  faultMessage: string;
}

/** Handler for host-initiated vsock connections to one guest port. */
export type VsockPortHandler = (conn: Deno.Conn) => void | Promise<void>;

/** Options for {@linkcode FakeFirecracker.start}. */
export interface FakeFirecrackerOptions {
  /** Directory for the sockets; defaults to a fresh temp dir (removed on dispose). */
  dir?: string;
  /** Exact API socket path to bind. @default `<dir>/api.sock` */
  socketPath?: string;
  /** Instance id reported by `GET /`. @default "fake-fc" */
  id?: string;
  /** Version reported by `GET /version`. @default "1.16.1" */
  version?: string;
  /** Called when the API receives `SendCtrlAltDel` while running. */
  onCtrlAltDel?: () => void;
  /**
   * Chroot-emulation prefix for the vsock UDS: when set, `PUT /vsock`
   * binds the mux at `prefix + uds_path`, the way a jailed Firecracker
   * resolves in-jail paths. Used by jailer test doubles.
   */
  vsockPathPrefix?: string;
}

const POST_BOOT_MSG =
  "The requested operation is not supported after starting the microVM.";
const PRE_BOOT_MSG =
  "The requested operation is not allowed before starting the microVM.";

/**
 * In-process Firecracker test double serving the API on a real Unix socket
 * and the hybrid-vsock handshake on another. See the module docs.
 */
export class FakeFirecracker implements AsyncDisposable {
  /** Directory holding the fake's sockets. */
  readonly dir: string;
  /** Path of the API Unix socket. */
  readonly socketPath: string;

  #id: string;
  #version: string;
  #onCtrlAltDel?: () => void;
  #vsockPathPrefix?: string;
  #server: Deno.HttpServer<Deno.UnixAddr>;
  #ownsDir: boolean;

  #state: InstanceInfo["state"] = "Not started";
  #machineConfig: MachineConfiguration = { vcpu_count: 1, mem_size_mib: 128 };
  #bootSource?: BootSource;
  #cpuConfig?: CpuConfig;
  #drives = new Map<string, Drive>();
  #networkInterfaces = new Map<string, NetworkInterface>();
  #pmem = new Map<string, Pmem>();
  #vsock?: Vsock;
  #balloon?: Balloon;
  #hintingHostCmd = 0;
  #memoryHotplug?: MemoryHotplugConfig;
  #hotplugRequestedMib?: number;
  #mmdsConfig?: MmdsConfig;
  #mmdsData?: MmdsContentsObject;
  #logger?: Logger;
  #metrics?: Metrics;
  #entropy?: EntropyDevice;
  #serial?: SerialDevice;

  #requests: RecordedRequest[] = [];
  #failures: InjectedFailure[] = [];

  #vsockHandlers = new Map<number, VsockPortHandler>();
  #vsockListener: Deno.Listener | null = null;
  #vsockBoundPath: string | null = null;
  #vsockAcceptLoop: Promise<void> | null = null;
  #nextHostPort = 1_000_000;

  private constructor(
    dir: string,
    ownsDir: boolean,
    opts: FakeFirecrackerOptions,
  ) {
    this.dir = dir;
    this.#ownsDir = ownsDir;
    this.socketPath = opts.socketPath ?? join(dir, "api.sock");
    this.#id = opts.id ?? "fake-fc";
    this.#version = opts.version ?? "1.16.1";
    this.#onCtrlAltDel = opts.onCtrlAltDel;
    this.#vsockPathPrefix = opts.vsockPathPrefix;
    this.#server = Deno.serve(
      { path: this.socketPath, transport: "unix", onListen: () => {} },
      (req) => this.#handle(req),
    );
  }

  /** Start a fake on fresh Unix sockets. */
  static async start(
    opts: FakeFirecrackerOptions = {},
  ): Promise<FakeFirecracker> {
    const ownsDir = opts.dir === undefined;
    const dir = opts.dir ?? await Deno.makeTempDir({ prefix: "fake-fc-" });
    return new FakeFirecracker(dir, ownsDir, opts);
  }

  /**
   * The host-side vsock UDS path: where the mux is bound once `PUT /vsock`
   * has configured a device, and the natural `uds_path` to configure it
   * with before that.
   */
  get vsockUdsPath(): string {
    return this.#vsockBoundPath ?? join(this.dir, "v.sock");
  }

  /** Every request served so far, in order (live view). */
  get requests(): ReadonlyArray<RecordedRequest> {
    return this.#requests;
  }

  /** Current instance state, as `GET /` would report it. */
  get state(): InstanceInfo["state"] {
    return this.#state;
  }

  /**
   * Make the next request matching `method` + exact `path` fail with the
   * given status/fault. Failures queue and are consumed one per match.
   */
  failNext(
    matcher: { method: string; path: string },
    resp: { status: number; faultMessage: string },
  ): void {
    this.#failures.push({
      method: matcher.method.toUpperCase(),
      path: matcher.path,
      status: resp.status,
      faultMessage: resp.faultMessage,
    });
  }

  /**
   * Register a guest-side listener for host-initiated vsock connections to
   * `port`. Dials to unregistered ports get the faithful
   * close-without-`OK` rejection.
   */
  onVsockPort(port: number, handler: VsockPortHandler): void {
    this.#vsockHandlers.set(port, handler);
  }

  /**
   * Simulate a guest-initiated vsock connection: connect to the host
   * listener socket `${vsockUdsPath}_${port}` (which the host side must
   * have created, e.g. via `listenVsock`).
   */
  connectFromGuest(port: number): Promise<Deno.Conn> {
    return Deno.connect({
      transport: "unix",
      path: `${this.vsockUdsPath}_${port}`,
    });
  }

  /** Shut down servers, unlink sockets, and remove the owned temp dir. */
  async [Symbol.asyncDispose](): Promise<void> {
    this.#closeVsock();
    await this.#server.shutdown();
    if (this.#vsockAcceptLoop) await this.#vsockAcceptLoop;
    for (const path of [this.socketPath, this.#vsockBoundPath]) {
      if (path === null) continue;
      try {
        await Deno.remove(path);
      } catch {
        // already gone
      }
    }
    if (this.#ownsDir) {
      try {
        await Deno.remove(this.dir, { recursive: true });
      } catch {
        // already gone
      }
    }
  }

  // -------------------------------------------------------------------------
  // API routing
  // -------------------------------------------------------------------------

  async #handle(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    const method = req.method.toUpperCase();
    let body: unknown = undefined;
    const text = await req.text();
    if (text !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    this.#requests.push(
      body === undefined ? { method, path } : { method, path, body },
    );

    const idx = this.#failures.findIndex((f) =>
      f.method === method && f.path === path
    );
    if (idx !== -1) {
      const [injected] = this.#failures.splice(idx, 1);
      return fault(injected.status, injected.faultMessage);
    }

    try {
      return await this.#route(method, path, body);
    } catch (err) {
      return fault(
        500,
        `fake-firecracker internal error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // deno-lint-ignore no-explicit-any -- bodies are validated per-route
  async #route(method: string, path: string, body: any): Promise<Response> {
    const key = `${method} ${path}`;
    const seg = path.split("/").filter((s) => s !== "");

    switch (key) {
      case "GET /":
        return json(this.#instanceInfo());
      case "GET /version":
        return json({ firecracker_version: this.#version });
      case "GET /vm/config":
        return json(this.#fullVmConfiguration());
      case "PUT /actions":
        return this.#handleAction(body?.action_type);
      case "PATCH /vm":
        return this.#handlePatchVm(body?.state);

      case "GET /machine-config":
        return json(this.#machineConfig);
      case "PUT /machine-config": {
        const rejected = this.#requirePreBoot();
        if (rejected) return rejected;
        if (
          typeof body?.vcpu_count !== "number" ||
          typeof body?.mem_size_mib !== "number"
        ) {
          return fault(
            400,
            "An error occurred when deserializing the json body of a request: missing field.",
          );
        }
        this.#machineConfig = body as MachineConfiguration;
        return noContent();
      }
      case "PATCH /machine-config": {
        const rejected = this.#requirePreBoot();
        if (rejected) return rejected;
        this.#machineConfig = { ...this.#machineConfig, ...body };
        return noContent();
      }

      case "PUT /boot-source": {
        const rejected = this.#requirePreBoot();
        if (rejected) return rejected;
        this.#bootSource = body as BootSource;
        return noContent();
      }
      case "PUT /cpu-config": {
        const rejected = this.#requirePreBoot();
        if (rejected) return rejected;
        this.#cpuConfig = body as CpuConfig;
        return noContent();
      }
      case "PUT /vsock": {
        const rejected = this.#requirePreBoot();
        if (rejected) return rejected;
        this.#vsock = body as Vsock;
        this.#bindVsock(
          this.#vsockPathPrefix !== undefined
            ? this.#vsockPathPrefix +
              (this.#vsock.uds_path.startsWith("/")
                ? this.#vsock.uds_path
                : `/${this.#vsock.uds_path}`)
            : this.#resolvePath(this.#vsock.uds_path),
        );
        return noContent();
      }
      case "PUT /entropy": {
        const rejected = this.#requirePreBoot();
        if (rejected) return rejected;
        this.#entropy = body as EntropyDevice;
        return noContent();
      }
      case "PUT /serial": {
        const rejected = this.#requirePreBoot();
        if (rejected) return rejected;
        this.#serial = body as SerialDevice;
        return noContent();
      }

      case "GET /balloon":
        return this.#balloon
          ? json(this.#balloon)
          : fault(400, "No balloon device configured.");
      case "PUT /balloon": {
        const rejected = this.#requirePreBoot();
        if (rejected) return rejected;
        this.#balloon = body as Balloon;
        return noContent();
      }
      case "PATCH /balloon": {
        const rejected = this.#requirePostBoot() ?? this.#requireBalloon();
        if (rejected) return rejected;
        this.#balloon = { ...this.#balloon!, amount_mib: body.amount_mib };
        return noContent();
      }
      case "GET /balloon/statistics": {
        const rejected = this.#requireBalloon();
        if (rejected) return rejected;
        if (!this.#balloon!.stats_polling_interval_s) {
          return fault(400, "Balloon device statistics are disabled.");
        }
        return json(this.#balloonStats());
      }
      case "PATCH /balloon/statistics": {
        const rejected = this.#requirePostBoot() ?? this.#requireBalloon();
        if (rejected) return rejected;
        this.#balloon = {
          ...this.#balloon!,
          stats_polling_interval_s: body.stats_polling_interval_s,
        };
        return noContent();
      }
      case "PATCH /balloon/hinting/start": {
        const rejected = this.#requirePostBoot() ?? this.#requireBalloon();
        if (rejected) return rejected;
        this.#hintingHostCmd++;
        return noContent();
      }
      case "GET /balloon/hinting/status": {
        const rejected = this.#requireBalloon();
        if (rejected) return rejected;
        const status: BalloonHintingStatus = { host_cmd: this.#hintingHostCmd };
        return json(status);
      }
      case "PATCH /balloon/hinting/stop": {
        const rejected = this.#requirePostBoot() ?? this.#requireBalloon();
        if (rejected) return rejected;
        return noContent();
      }

      case "GET /hotplug/memory":
        return this.#memoryHotplug
          ? json({
            block_size_mib: this.#memoryHotplug.block_size_mib,
            total_size_mib: this.#memoryHotplug.total_size_mib,
            requested_size_mib: this.#hotplugRequestedMib ?? 0,
            plugged_size_mib: this.#hotplugRequestedMib ?? 0,
          })
          : fault(400, "Memory hotplug device not configured.");
      case "PUT /hotplug/memory": {
        const rejected = this.#requirePreBoot();
        if (rejected) return rejected;
        this.#memoryHotplug = body as MemoryHotplugConfig;
        return noContent();
      }
      case "PATCH /hotplug/memory": {
        const rejected = this.#requirePostBoot();
        if (rejected) return rejected;
        if (!this.#memoryHotplug) {
          return fault(400, "Memory hotplug device not configured.");
        }
        this.#hotplugRequestedMib = body.requested_size_mib;
        return noContent();
      }

      case "PUT /mmds/config": {
        const rejected = this.#requirePreBoot();
        if (rejected) return rejected;
        this.#mmdsConfig = body as MmdsConfig;
        return noContent();
      }
      case "GET /mmds":
        return this.#mmdsData !== undefined
          ? json(this.#mmdsData)
          : fault(400, "The MMDS data store is not initialized.");
      case "PUT /mmds":
        this.#mmdsData = body as MmdsContentsObject;
        return noContent();
      case "PATCH /mmds": {
        if (this.#mmdsData === undefined) {
          return fault(400, "The MMDS data store is not initialized.");
        }
        this.#mmdsData = mergePatch(this.#mmdsData, body) as MmdsContentsObject;
        return noContent();
      }

      case "PUT /logger": {
        if (this.#logger) {
          return fault(400, "Reinitialization of logger not allowed.");
        }
        this.#logger = body as Logger;
        return noContent();
      }
      case "PUT /metrics": {
        if (this.#metrics) {
          return fault(400, "Reinitialization of metrics not allowed.");
        }
        this.#metrics = body as Metrics;
        return noContent();
      }

      case "PUT /snapshot/create": {
        if (this.#state === "Not started") return fault(400, PRE_BOOT_MSG);
        if (this.#state !== "Paused") {
          return fault(
            400,
            "Cannot create snapshot while the microVM is running.",
          );
        }
        const params = body as SnapshotCreateParams;
        await Deno.writeTextFile(
          this.#resolvePath(params.snapshot_path),
          "fake-firecracker snapshot state\n",
        );
        await Deno.writeTextFile(
          this.#resolvePath(params.mem_file_path),
          "fake-firecracker guest memory\n",
        );
        return noContent();
      }
      case "PUT /snapshot/load": {
        const rejected = this.#requirePreBoot();
        if (rejected) return rejected;
        const params = body as SnapshotLoadParams;
        if (params.vsock_override?.uds_path !== undefined) {
          // The restored snapshot's vsock device rebinds at the override.
          const uds = params.vsock_override.uds_path;
          this.#bindVsock(
            this.#vsockPathPrefix !== undefined
              ? this.#vsockPathPrefix + (uds.startsWith("/") ? uds : `/${uds}`)
              : this.#resolvePath(uds),
          );
        }
        this.#state = params.resume_vm ? "Running" : "Paused";
        return noContent();
      }
    }

    // Parameterized paths.
    if (seg.length === 2 && seg[0] === "drives") {
      return this.#handleDevice(method, seg[1], body, {
        store: this.#drives,
        idField: "drive_id",
        label: "drive",
      });
    }
    if (seg.length === 2 && seg[0] === "network-interfaces") {
      return this.#handleDevice(method, seg[1], body, {
        store: this.#networkInterfaces,
        idField: "iface_id",
        label: "network interface",
      });
    }
    if (seg.length === 2 && seg[0] === "pmem") {
      return this.#handleDevice(method, seg[1], body, {
        store: this.#pmem,
        idField: "id",
        label: "pmem device",
      });
    }

    return fault(400, `Invalid request method and/or path: ${method} ${path}.`);
  }

  #handleAction(actionType: unknown): Response {
    switch (actionType) {
      case "InstanceStart": {
        const rejected = this.#requirePreBoot();
        if (rejected) return rejected;
        if (!this.#bootSource) {
          return fault(
            400,
            "Cannot start microvm without kernel configuration.",
          );
        }
        this.#state = "Running";
        return noContent();
      }
      case "SendCtrlAltDel": {
        const rejected = this.#requirePostBoot();
        if (rejected) return rejected;
        this.#onCtrlAltDel?.();
        return noContent();
      }
      case "FlushMetrics": {
        const rejected = this.#requirePostBoot();
        if (rejected) return rejected;
        return noContent();
      }
      default:
        return fault(
          400,
          "An error occurred when deserializing the json body of a request: unknown action type.",
        );
    }
  }

  #handlePatchVm(state: unknown): Response {
    const rejected = this.#requirePostBoot();
    if (rejected) return rejected;
    if (state === "Paused") {
      this.#state = "Paused";
      return noContent();
    }
    if (state === "Resumed") {
      this.#state = "Running";
      return noContent();
    }
    return fault(
      400,
      "An error occurred when deserializing the json body of a request: invalid state.",
    );
  }

  #handleDevice(
    method: string,
    pathId: string,
    // deno-lint-ignore no-explicit-any -- validated below
    body: any,
    opts: {
      // deno-lint-ignore no-explicit-any -- heterogeneous device stores
      store: Map<string, any>;
      idField: string;
      label: string;
    },
  ): Response {
    const bodyId = body?.[opts.idField];
    if (bodyId !== undefined && bodyId !== pathId) {
      return fault(
        400,
        `The id from the path [${pathId}] does not match the id from the body [${bodyId}]!`,
      );
    }
    if (method === "PUT") {
      const rejected = this.#requirePreBoot();
      if (rejected) return rejected;
      opts.store.set(pathId, body);
      return noContent();
    }
    if (method === "PATCH") {
      const rejected = this.#requirePostBoot();
      if (rejected) return rejected;
      const existing = opts.store.get(pathId);
      if (!existing) {
        return fault(400, `Invalid ${opts.label} id: ${pathId}.`);
      }
      opts.store.set(pathId, { ...existing, ...body });
      return noContent();
    }
    return fault(400, `Invalid request method and/or path: ${method}.`);
  }

  #requirePreBoot(): Response | null {
    return this.#state === "Not started" ? null : fault(400, POST_BOOT_MSG);
  }

  #requirePostBoot(): Response | null {
    return this.#state === "Not started" ? fault(400, PRE_BOOT_MSG) : null;
  }

  #requireBalloon(): Response | null {
    return this.#balloon ? null : fault(400, "No balloon device configured.");
  }

  #instanceInfo(): InstanceInfo {
    return {
      app_name: "Firecracker",
      id: this.#id,
      state: this.#state,
      vmm_version: this.#version,
    };
  }

  #balloonStats(): BalloonStats {
    const amount = this.#balloon?.amount_mib ?? 0;
    return {
      actual_mib: amount,
      actual_pages: amount * 256,
      target_mib: amount,
      target_pages: amount * 256,
    };
  }

  #fullVmConfiguration(): FullVmConfiguration {
    const config: FullVmConfiguration = {
      "machine-config": this.#machineConfig,
    };
    if (this.#bootSource) config["boot-source"] = this.#bootSource;
    if (this.#cpuConfig) config["cpu-config"] = this.#cpuConfig;
    if (this.#drives.size > 0) config.drives = [...this.#drives.values()];
    if (this.#networkInterfaces.size > 0) {
      config["network-interfaces"] = [...this.#networkInterfaces.values()];
    }
    if (this.#pmem.size > 0) config.pmem = [...this.#pmem.values()];
    if (this.#vsock) config.vsock = this.#vsock;
    if (this.#balloon) config.balloon = this.#balloon;
    if (this.#memoryHotplug) config["memory-hotplug"] = this.#memoryHotplug;
    if (this.#mmdsConfig) config["mmds-config"] = this.#mmdsConfig;
    if (this.#logger) config.logger = this.#logger;
    if (this.#metrics) config.metrics = this.#metrics;
    if (this.#entropy) config.entropy = this.#entropy;
    return config;
  }

  #resolvePath(path: string): string {
    return isAbsolute(path) ? path : join(this.dir, path);
  }

  // -------------------------------------------------------------------------
  // Hybrid-vsock mux
  // -------------------------------------------------------------------------

  #bindVsock(path: string): void {
    if (this.#vsockBoundPath === path) return;
    this.#closeVsock();
    this.#vsockListener = Deno.listen({ transport: "unix", path });
    this.#vsockBoundPath = path;
    this.#vsockAcceptLoop = (async () => {
      try {
        for await (const conn of this.#vsockListener!) {
          void this.#handleVsockConn(conn);
        }
      } catch {
        // listener closed
      }
    })();
  }

  #closeVsock(): void {
    if (this.#vsockListener === null) return;
    try {
      this.#vsockListener.close();
    } catch {
      // already closed
    }
    this.#vsockListener = null;
  }

  async #handleVsockConn(conn: Deno.Conn): Promise<void> {
    try {
      const result = await readLineBytewise(conn, 64);
      if (result.kind !== "line" || this.#state !== "Running") {
        conn.close();
        return;
      }
      const match = /^CONNECT (\d+)$/.exec(result.line);
      if (match === null) {
        conn.close();
        return;
      }
      const handler = this.#vsockHandlers.get(Number(match[1]));
      if (handler === undefined) {
        // Faithful rejection: no error frame exists in the protocol — the
        // connection just closes before any `OK`.
        conn.close();
        return;
      }
      const hostPort = this.#nextHostPort++;
      await writeAll(conn, new TextEncoder().encode(`OK ${hostPort}\n`));
      await handler(conn);
    } catch {
      try {
        conn.close();
      } catch {
        // already closed
      }
    }
  }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

function fault(status: number, faultMessage: string): Response {
  return new Response(JSON.stringify({ fault_message: faultMessage }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** RFC 7386-style JSON merge patch, as MMDS PATCH behaves. */
function mergePatch(target: unknown, patch: unknown): unknown {
  if (
    patch === null || typeof patch !== "object" || Array.isArray(patch)
  ) {
    return patch;
  }
  const result: Record<string, unknown> =
    target !== null && typeof target === "object" && !Array.isArray(target)
      ? { ...(target as Record<string, unknown>) }
      : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key];
    } else {
      result[key] = mergePatch(result[key], value);
    }
  }
  return result;
}
