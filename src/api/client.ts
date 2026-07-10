/**
 * Typed client for the Firecracker API socket — one method per endpoint of
 * the pinned spec, over HTTP-on-UDS. Zero opinions: no process management,
 * no config sequencing, no retries beyond what you ask for.
 *
 * @example
 * ```ts
 * import { FirecrackerClient } from "@nullstyle/firecracker/client";
 *
 * using client = new FirecrackerClient({ socketPath: "/run/firecracker.sock" });
 * await client.waitReady();
 * await client.putMachineConfig({ vcpu_count: 2, mem_size_mib: 512 });
 * await client.instanceStart();
 * ```
 *
 * @module
 */

import { ApiError, ReadinessTimeoutError, TransportError } from "../errors.ts";
import { type ApiTransport, UnixHttpTransport } from "./transport.ts";
import type {
  Balloon,
  BalloonHintingStatus,
  BalloonStartCmd,
  BalloonStats,
  BalloonStatsUpdate,
  BalloonUpdate,
  BootSource,
  CpuConfig,
  Drive,
  EntropyDevice,
  FirecrackerVersion,
  FullVmConfiguration,
  InstanceActionInfo,
  InstanceInfo,
  Logger,
  MachineConfiguration,
  MemoryHotplugConfig,
  MemoryHotplugSizeUpdate,
  MemoryHotplugStatus,
  Metrics,
  MmdsConfig,
  MmdsContentsObject,
  NetworkInterface,
  PartialDrive,
  PartialNetworkInterface,
  PartialPmem,
  Pmem,
  SerialDevice,
  SnapshotCreateParams,
  SnapshotLoadParams,
  Vm,
  Vsock,
} from "./types.ts";

/** Per-request options accepted by every client method. */
export interface RequestOptions {
  /** Abort the request early; composed with the client-wide timeout. */
  signal?: AbortSignal;
}

/** Constructor options for {@linkcode FirecrackerClient}. */
export interface FirecrackerClientOptions {
  /** Path of the Firecracker API Unix socket. */
  socketPath: string;
  /** Custom transport (testing/exotic setups). Defaults to {@linkcode UnixHttpTransport}. */
  transport?: ApiTransport;
  /**
   * Per-request deadline in milliseconds; `0` disables it. Applies to every
   * method, composed with any per-request `signal`.
   * @default 30_000
   */
  requestTimeoutMs?: number;
}

/** Options for {@linkcode FirecrackerClient.waitReady}. */
export interface WaitReadyOptions {
  /**
   * Total budget for the API socket to accept and answer `GET /`.
   * @default 5_000
   */
  timeoutMs?: number;
  /**
   * Delay between attempts.
   * @default 50
   */
  intervalMs?: number;
  /** Abort waiting early (e.g. because the VMM process died). */
  signal?: AbortSignal;
}

/**
 * Spec-operation inventory: `"METHOD /path"` (as written in the swagger,
 * with `{param}` placeholders) → the {@linkcode FirecrackerClient} method
 * covering it. Exists so tests can prove the client covers the entire
 * pinned spec surface; grows in lockstep with the spec.
 */
export const API_OPERATIONS: Readonly<Record<string, string>> = {
  "GET /": "getInstanceInfo",
  "PUT /actions": "putAction",
  "GET /balloon": "getBalloon",
  "PUT /balloon": "putBalloon",
  "PATCH /balloon": "patchBalloon",
  "GET /balloon/statistics": "getBalloonStats",
  "PATCH /balloon/statistics": "patchBalloonStatsInterval",
  "PATCH /balloon/hinting/start": "startBalloonHinting",
  "GET /balloon/hinting/status": "getBalloonHintingStatus",
  "PATCH /balloon/hinting/stop": "stopBalloonHinting",
  "PUT /boot-source": "putBootSource",
  "PUT /cpu-config": "putCpuConfig",
  "PUT /drives/{drive_id}": "putDrive",
  "PATCH /drives/{drive_id}": "patchDrive",
  "PUT /pmem/{id}": "putPmem",
  "PATCH /pmem/{id}": "patchPmem",
  "PUT /logger": "putLogger",
  "GET /machine-config": "getMachineConfig",
  "PUT /machine-config": "putMachineConfig",
  "PATCH /machine-config": "patchMachineConfig",
  "PUT /metrics": "putMetrics",
  "GET /mmds": "getMmds",
  "PUT /mmds": "putMmds",
  "PATCH /mmds": "patchMmds",
  "PUT /mmds/config": "putMmdsConfig",
  "PUT /entropy": "putEntropyDevice",
  "PUT /serial": "putSerialDevice",
  "GET /hotplug/memory": "getMemoryHotplug",
  "PUT /hotplug/memory": "putMemoryHotplug",
  "PATCH /hotplug/memory": "patchMemoryHotplug",
  "PUT /network-interfaces/{iface_id}": "putNetworkInterface",
  "PATCH /network-interfaces/{iface_id}": "patchNetworkInterface",
  "PUT /snapshot/create": "createSnapshot",
  "PUT /snapshot/load": "loadSnapshot",
  "GET /version": "getVersion",
  "PATCH /vm": "patchVm",
  "GET /vm/config": "getVmConfig",
  "PUT /vsock": "putVsock",
};

/**
 * Typed Firecracker API client over a Unix domain socket.
 *
 * Every method maps 1:1 onto a spec endpoint (see {@linkcode API_OPERATIONS})
 * and throws {@linkcode ApiError} on non-2xx responses or
 * {@linkcode TransportError} when the socket is unreachable. Methods whose
 * endpoint takes a path parameter derive it from the body's own id field
 * (e.g. {@linkcode FirecrackerClient.putDrive} uses `drive.drive_id`), so an
 * id can never disagree with its path.
 *
 * Disposable: `using client = new FirecrackerClient(...)` closes the
 * underlying transport on scope exit.
 */
export class FirecrackerClient implements Disposable {
  /** Path of the Firecracker API Unix socket. */
  readonly socketPath: string;
  #transport: ApiTransport;
  #timeoutMs: number;

  /** Create a client for the API socket; connections open lazily per request. */
  constructor(options: FirecrackerClientOptions) {
    this.socketPath = options.socketPath;
    this.#transport = options.transport ??
      new UnixHttpTransport(options.socketPath);
    this.#timeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  // -------------------------------------------------------------------------
  // Instance, version, configuration reads
  // -------------------------------------------------------------------------

  /** `GET /` — general instance info, including the boot state. */
  getInstanceInfo(opts?: RequestOptions): Promise<InstanceInfo> {
    return this.#json<InstanceInfo>("GET", "/", undefined, opts);
  }

  /** `GET /version` — the Firecracker build version. */
  getVersion(opts?: RequestOptions): Promise<FirecrackerVersion> {
    return this.#json<FirecrackerVersion>("GET", "/version", undefined, opts);
  }

  /** `GET /vm/config` — the full applied VM configuration. */
  getVmConfig(opts?: RequestOptions): Promise<FullVmConfiguration> {
    return this.#json<FullVmConfiguration>(
      "GET",
      "/vm/config",
      undefined,
      opts,
    );
  }

  /** `GET /machine-config` — current vCPU/memory configuration. */
  getMachineConfig(opts?: RequestOptions): Promise<MachineConfiguration> {
    return this.#json<MachineConfiguration>(
      "GET",
      "/machine-config",
      undefined,
      opts,
    );
  }

  // -------------------------------------------------------------------------
  // Actions & VM state
  // -------------------------------------------------------------------------

  /** `PUT /actions` — raw synchronous action. Prefer the named helpers. */
  putAction(body: InstanceActionInfo, opts?: RequestOptions): Promise<void> {
    return this.#void("PUT", "/actions", body, opts);
  }

  /** Boot the configured microVM (`InstanceStart`). Pre-boot only. */
  instanceStart(opts?: RequestOptions): Promise<void> {
    return this.putAction({ action_type: "InstanceStart" }, opts);
  }

  /**
   * Send Ctrl+Alt+Del to the guest (`SendCtrlAltDel`) — the graceful
   * shutdown knock. x86_64 only; aarch64 Firecracker has no i8042.
   */
  sendCtrlAltDel(opts?: RequestOptions): Promise<void> {
    return this.putAction({ action_type: "SendCtrlAltDel" }, opts);
  }

  /** Flush the metrics device (`FlushMetrics`). */
  flushMetrics(opts?: RequestOptions): Promise<void> {
    return this.putAction({ action_type: "FlushMetrics" }, opts);
  }

  /** `PATCH /vm` — raw VM state update. Prefer {@linkcode pauseVm}/{@linkcode resumeVm}. */
  patchVm(body: Vm, opts?: RequestOptions): Promise<void> {
    return this.#void("PATCH", "/vm", body, opts);
  }

  /** Pause the running microVM's vCPUs. */
  pauseVm(opts?: RequestOptions): Promise<void> {
    return this.patchVm({ state: "Paused" }, opts);
  }

  /** Resume the paused microVM's vCPUs. */
  resumeVm(opts?: RequestOptions): Promise<void> {
    return this.patchVm({ state: "Resumed" }, opts);
  }

  // -------------------------------------------------------------------------
  // Pre-boot machine & device configuration
  // -------------------------------------------------------------------------

  /** `PUT /machine-config` — set vCPUs/memory/SMT. Pre-boot only. */
  putMachineConfig(
    body: MachineConfiguration,
    opts?: RequestOptions,
  ): Promise<void> {
    return this.#void("PUT", "/machine-config", body, opts);
  }

  /** `PATCH /machine-config` — partial update. Pre-boot only. */
  patchMachineConfig(
    body: MachineConfiguration,
    opts?: RequestOptions,
  ): Promise<void> {
    return this.#void("PATCH", "/machine-config", body, opts);
  }

  /** `PUT /boot-source` — kernel image, initrd, boot args. Pre-boot only. */
  putBootSource(body: BootSource, opts?: RequestOptions): Promise<void> {
    return this.#void("PUT", "/boot-source", body, opts);
  }

  /** `PUT /cpu-config` — guest CPU feature template. Pre-boot only. */
  putCpuConfig(body: CpuConfig, opts?: RequestOptions): Promise<void> {
    return this.#void("PUT", "/cpu-config", body, opts);
  }

  /**
   * `PUT /drives/{drive_id}` — attach/replace a block device. Pre-boot only.
   * The path parameter comes from `drive.drive_id`.
   */
  putDrive(drive: Drive, opts?: RequestOptions): Promise<void> {
    return this.#void(
      "PUT",
      `/drives/${encodeURIComponent(drive.drive_id)}`,
      drive,
      opts,
    );
  }

  /**
   * `PATCH /drives/{drive_id}` — post-boot update of a drive's host path
   * and/or rate limiter. The path parameter comes from `patch.drive_id`.
   */
  patchDrive(patch: PartialDrive, opts?: RequestOptions): Promise<void> {
    return this.#void(
      "PATCH",
      `/drives/${encodeURIComponent(patch.drive_id)}`,
      patch,
      opts,
    );
  }

  /**
   * `PUT /network-interfaces/{iface_id}` — attach a tap-backed network
   * interface. Pre-boot only. The path parameter comes from `iface.iface_id`.
   */
  putNetworkInterface(
    iface: NetworkInterface,
    opts?: RequestOptions,
  ): Promise<void> {
    return this.#void(
      "PUT",
      `/network-interfaces/${encodeURIComponent(iface.iface_id)}`,
      iface,
      opts,
    );
  }

  /**
   * `PATCH /network-interfaces/{iface_id}` — post-boot rate-limiter update.
   * The path parameter comes from `patch.iface_id`.
   */
  patchNetworkInterface(
    patch: PartialNetworkInterface,
    opts?: RequestOptions,
  ): Promise<void> {
    return this.#void(
      "PATCH",
      `/network-interfaces/${encodeURIComponent(patch.iface_id)}`,
      patch,
      opts,
    );
  }

  /**
   * `PUT /pmem/{id}` — attach a persistent-memory device. Pre-boot only.
   * The path parameter comes from `pmem.id`.
   */
  putPmem(pmem: Pmem, opts?: RequestOptions): Promise<void> {
    return this.#void(
      "PUT",
      `/pmem/${encodeURIComponent(pmem.id)}`,
      pmem,
      opts,
    );
  }

  /**
   * `PATCH /pmem/{id}` — post-boot pmem rate-limiter update. The path
   * parameter comes from `patch.id`.
   *
   * @since v1.16
   */
  patchPmem(patch: PartialPmem, opts?: RequestOptions): Promise<void> {
    return this.#void(
      "PATCH",
      `/pmem/${encodeURIComponent(patch.id)}`,
      patch,
      opts,
    );
  }

  /** `PUT /vsock` — configure the vsock device. Pre-boot only, never reconfigurable. */
  putVsock(body: Vsock, opts?: RequestOptions): Promise<void> {
    return this.#void("PUT", "/vsock", body, opts);
  }

  /** `PUT /entropy` — configure the virtio-rng entropy device. Pre-boot only. */
  putEntropyDevice(body: EntropyDevice, opts?: RequestOptions): Promise<void> {
    return this.#void("PUT", "/entropy", body, opts);
  }

  /** `PUT /serial` — configure the serial device. Pre-boot only. */
  putSerialDevice(body: SerialDevice, opts?: RequestOptions): Promise<void> {
    return this.#void("PUT", "/serial", body, opts);
  }

  // -------------------------------------------------------------------------
  // Balloon
  // -------------------------------------------------------------------------

  /** `GET /balloon` — current balloon device configuration. */
  getBalloon(opts?: RequestOptions): Promise<Balloon> {
    return this.#json<Balloon>("GET", "/balloon", undefined, opts);
  }

  /** `PUT /balloon` — configure the balloon device. Pre-boot only. */
  putBalloon(body: Balloon, opts?: RequestOptions): Promise<void> {
    return this.#void("PUT", "/balloon", body, opts);
  }

  /** `PATCH /balloon` — post-boot balloon target-size update. */
  patchBalloon(body: BalloonUpdate, opts?: RequestOptions): Promise<void> {
    return this.#void("PATCH", "/balloon", body, opts);
  }

  /** `GET /balloon/statistics` — latest balloon statistics. */
  getBalloonStats(opts?: RequestOptions): Promise<BalloonStats> {
    return this.#json<BalloonStats>(
      "GET",
      "/balloon/statistics",
      undefined,
      opts,
    );
  }

  /** `PATCH /balloon/statistics` — update the statistics polling interval. */
  patchBalloonStatsInterval(
    body: BalloonStatsUpdate,
    opts?: RequestOptions,
  ): Promise<void> {
    return this.#void("PATCH", "/balloon/statistics", body, opts);
  }

  /** `PATCH /balloon/hinting/start` — start free-page hinting. */
  startBalloonHinting(
    body: BalloonStartCmd,
    opts?: RequestOptions,
  ): Promise<void> {
    return this.#void("PATCH", "/balloon/hinting/start", body, opts);
  }

  /** `GET /balloon/hinting/status` — free-page hinting status. */
  getBalloonHintingStatus(
    opts?: RequestOptions,
  ): Promise<BalloonHintingStatus> {
    return this.#json<BalloonHintingStatus>(
      "GET",
      "/balloon/hinting/status",
      undefined,
      opts,
    );
  }

  /** `PATCH /balloon/hinting/stop` — stop free-page hinting. */
  stopBalloonHinting(opts?: RequestOptions): Promise<void> {
    return this.#void("PATCH", "/balloon/hinting/stop", undefined, opts);
  }

  // -------------------------------------------------------------------------
  // Memory hotplug
  // -------------------------------------------------------------------------

  /** `GET /hotplug/memory` — hotplug memory status. */
  getMemoryHotplug(opts?: RequestOptions): Promise<MemoryHotplugStatus> {
    return this.#json<MemoryHotplugStatus>(
      "GET",
      "/hotplug/memory",
      undefined,
      opts,
    );
  }

  /** `PUT /hotplug/memory` — configure virtio-mem hotplug. Pre-boot only. */
  putMemoryHotplug(
    body: MemoryHotplugConfig,
    opts?: RequestOptions,
  ): Promise<void> {
    return this.#void("PUT", "/hotplug/memory", body, opts);
  }

  /** `PATCH /hotplug/memory` — post-boot hotplug memory resize. */
  patchMemoryHotplug(
    body: MemoryHotplugSizeUpdate,
    opts?: RequestOptions,
  ): Promise<void> {
    return this.#void("PATCH", "/hotplug/memory", body, opts);
  }

  // -------------------------------------------------------------------------
  // MMDS
  // -------------------------------------------------------------------------

  /** `PUT /mmds/config` — configure the metadata service. Pre-boot only. */
  putMmdsConfig(body: MmdsConfig, opts?: RequestOptions): Promise<void> {
    return this.#void("PUT", "/mmds/config", body, opts);
  }

  /** `GET /mmds` — read the MMDS data store. */
  getMmds(opts?: RequestOptions): Promise<MmdsContentsObject> {
    return this.#json<MmdsContentsObject>("GET", "/mmds", undefined, opts);
  }

  /** `PUT /mmds` — replace the MMDS data store. */
  putMmds(body: MmdsContentsObject, opts?: RequestOptions): Promise<void> {
    return this.#void("PUT", "/mmds", body, opts);
  }

  /** `PATCH /mmds` — merge into the MMDS data store. */
  patchMmds(body: MmdsContentsObject, opts?: RequestOptions): Promise<void> {
    return this.#void("PATCH", "/mmds", body, opts);
  }

  // -------------------------------------------------------------------------
  // Logging & metrics
  // -------------------------------------------------------------------------

  /** `PUT /logger` — initialize the logger (once per process). */
  putLogger(body: Logger, opts?: RequestOptions): Promise<void> {
    return this.#void("PUT", "/logger", body, opts);
  }

  /** `PUT /metrics` — initialize the metrics system (once per process). */
  putMetrics(body: Metrics, opts?: RequestOptions): Promise<void> {
    return this.#void("PUT", "/metrics", body, opts);
  }

  // -------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------

  /** `PUT /snapshot/create` — snapshot a paused microVM. */
  createSnapshot(
    body: SnapshotCreateParams,
    opts?: RequestOptions,
  ): Promise<void> {
    return this.#void("PUT", "/snapshot/create", body, opts);
  }

  /** `PUT /snapshot/load` — restore from a snapshot. Pre-boot only. */
  loadSnapshot(
    body: SnapshotLoadParams,
    opts?: RequestOptions,
  ): Promise<void> {
    return this.#void("PUT", "/snapshot/load", body, opts);
  }

  // -------------------------------------------------------------------------
  // Readiness & lifecycle
  // -------------------------------------------------------------------------

  /**
   * Poll `GET /` until the API socket answers, the budget runs out
   * (→ {@linkcode ReadinessTimeoutError}), or `signal` aborts.
   *
   * This alone cannot distinguish "not ready yet" from "the VMM died" — the
   * `Machine` layer races this against process exit. Use the `signal` for
   * that when driving the client directly.
   */
  async waitReady(opts?: WaitReadyOptions): Promise<InstanceInfo> {
    const timeoutMs = opts?.timeoutMs ?? 5_000;
    const intervalMs = opts?.intervalMs ?? 50;
    const deadline = performance.now() + timeoutMs;
    let lastError: unknown;
    while (performance.now() < deadline) {
      opts?.signal?.throwIfAborted();
      try {
        // Bound each attempt by the remaining budget: a socket that accepts
        // but never answers must not stretch waitReady past its deadline.
        const attemptBudget = Math.max(1, deadline - performance.now());
        const signals = [AbortSignal.timeout(attemptBudget)];
        if (opts?.signal !== undefined) signals.push(opts.signal);
        return await this.getInstanceInfo({ signal: AbortSignal.any(signals) });
      } catch (err) {
        if (!(err instanceof TransportError)) throw err;
        lastError = err;
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      await delay(Math.min(intervalMs, remaining), opts?.signal);
    }
    opts?.signal?.throwIfAborted();
    throw new ReadinessTimeoutError({
      socketPath: this.socketPath,
      waitedMs: timeoutMs,
      stderrTail: "",
      cause: lastError,
    });
  }

  /** Close the underlying transport. */
  close(): void {
    this.#transport.close();
  }

  /** `using` support: closes the transport on scope exit. */
  [Symbol.dispose](): void {
    this.close();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  async #request(
    method: string,
    path: string,
    body: unknown,
    opts: RequestOptions | undefined,
  ): Promise<Response> {
    const signals: AbortSignal[] = [];
    if (this.#timeoutMs > 0) signals.push(AbortSignal.timeout(this.#timeoutMs));
    if (opts?.signal) signals.push(opts.signal);
    const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;
    const res = await this.#transport.request(method, path, body, signal);
    if (!res.ok) {
      const text = await res.text();
      let faultMessage = text;
      try {
        const parsed = JSON.parse(text) as { fault_message?: unknown };
        if (typeof parsed.fault_message === "string") {
          faultMessage = parsed.fault_message;
        }
      } catch {
        // not JSON — keep the raw body
      }
      throw new ApiError({ status: res.status, faultMessage, method, path });
    }
    return res;
  }

  async #void(
    method: string,
    path: string,
    body: unknown,
    opts: RequestOptions | undefined,
  ): Promise<void> {
    const res = await this.#request(method, path, body, opts);
    await res.body?.cancel();
  }

  async #json<T>(
    method: string,
    path: string,
    body: unknown,
    opts: RequestOptions | undefined,
  ): Promise<T> {
    const res = await this.#request(method, path, body, opts);
    return await res.json() as T;
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(id);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
