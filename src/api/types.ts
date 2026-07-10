/**
 * Typed Firecracker API surface.
 *
 * Hand-curated aliases over the machine-generated spec types in
 * `src/generated/types.gen.ts` (pinned to the Firecracker release named by
 * `FIRECRACKER_COMPAT.pinned`). Every name matches the Firecracker wire
 * schema verbatim — `snake_case` fields and all — so anything in the
 * {@link https://github.com/firecracker-microvm/firecracker/blob/main/src/firecracker/swagger/firecracker.yaml | upstream swagger}
 * or the Firecracker docs can be grepped here directly.
 *
 * The one deliberate rename: the wire schema `Error` is exported as
 * {@linkcode ApiFault} to avoid shadowing the global `Error`.
 *
 * Types marked `@since v1.16` do not exist on Firecracker v1.15.x hosts;
 * using them against older VMMs yields an API 400.
 *
 * @module
 */

import type { components, operations, paths } from "../generated/types.gen.ts";

/** Raw generated spec types, for advanced/spec-level use. */
export type { components, operations, paths };

// ---------------------------------------------------------------------------
// Instance & actions
// ---------------------------------------------------------------------------

/** General information about the running Firecracker instance (`GET /`). */
export type InstanceInfo = components["schemas"]["InstanceInfo"];

/** Body of `PUT /actions` — `InstanceStart`, `SendCtrlAltDel`, or `FlushMetrics`. */
export type InstanceActionInfo = components["schemas"]["InstanceActionInfo"];

/** Firecracker build version (`GET /version`). */
export type FirecrackerVersion = components["schemas"]["FirecrackerVersion"];

/** The complete applied VM configuration (`GET /vm/config`). */
export type FullVmConfiguration = components["schemas"]["FullVmConfiguration"];

/** VM execution-state update body (`PATCH /vm`) — pause/resume. */
export type Vm = components["schemas"]["Vm"];

/**
 * Error body returned by the API on failure; the wire schema is named
 * `Error` (renamed here to avoid shadowing the global `Error`).
 */
export type ApiFault = components["schemas"]["Error"];

// ---------------------------------------------------------------------------
// Machine & boot configuration (pre-boot)
// ---------------------------------------------------------------------------

/** vCPU/memory/SMT machine configuration (`PUT|PATCH /machine-config`). */
export type MachineConfiguration =
  components["schemas"]["MachineConfiguration"];

/** Kernel image, initrd, and boot args (`PUT /boot-source`). */
export type BootSource = components["schemas"]["BootSource"];

/** Named static CPU template selectable in {@linkcode MachineConfiguration} (x86_64). */
export type CpuTemplate = components["schemas"]["CpuTemplate"];

/** Guest CPU feature configuration (`PUT /cpu-config`). */
export type CpuConfig = components["schemas"]["CpuConfig"];

/** CPUID leaf modifier within a {@linkcode CpuConfig} (x86_64). */
export type CpuidLeafModifier = components["schemas"]["CpuidLeafModifier"];

/** CPUID register modifier within a {@linkcode CpuidLeafModifier} (x86_64). */
export type CpuidRegisterModifier =
  components["schemas"]["CpuidRegisterModifier"];

/** Model-specific-register modifier within a {@linkcode CpuConfig} (x86_64). */
export type MsrModifier = components["schemas"]["MsrModifier"];

/** ARM system-register modifier within a {@linkcode CpuConfig} (aarch64). */
export type ArmRegisterModifier = components["schemas"]["ArmRegisterModifier"];

/** vCPU feature flags within a {@linkcode MachineConfiguration}. */
export type VcpuFeatures = components["schemas"]["VcpuFeatures"];

// ---------------------------------------------------------------------------
// Devices: drives, network, vsock, entropy, serial, pmem
// ---------------------------------------------------------------------------

/** Block-device drive configuration (`PUT /drives/{drive_id}`, pre-boot). */
export type Drive = components["schemas"]["Drive"];

/** Post-boot drive update — path and/or rate limiter (`PATCH /drives/{drive_id}`). */
export type PartialDrive = components["schemas"]["PartialDrive"];

/**
 * Network interface configuration (`PUT /network-interfaces/{iface_id}`,
 * pre-boot). The `mtu` field is `@since v1.16`.
 */
export type NetworkInterface = components["schemas"]["NetworkInterface"];

/** Post-boot network-interface rate-limiter update (`PATCH /network-interfaces/{iface_id}`). */
export type PartialNetworkInterface =
  components["schemas"]["PartialNetworkInterface"];

/**
 * Vsock device configuration (`PUT /vsock`, pre-boot only — a booted VM's
 * vsock can never be reconfigured). `guest_cid` must be ≥ 3; `uds_path` is
 * the host-side Unix socket (chroot-relative when jailed).
 */
export type Vsock = components["schemas"]["Vsock"];

/** Entropy (virtio-rng) device configuration (`PUT /entropy`, pre-boot). */
export type EntropyDevice = components["schemas"]["EntropyDevice"];

/**
 * Serial device configuration (`PUT /serial`, pre-boot). The `rate_limiter`
 * field is `@since v1.16`.
 */
export type SerialDevice = components["schemas"]["SerialDevice"];

/**
 * Persistent-memory (virtio-pmem) device configuration (`PUT /pmem/{id}`,
 * pre-boot). The `rate_limiter` field is `@since v1.16`.
 */
export type Pmem = components["schemas"]["Pmem"];

/**
 * Post-boot pmem rate-limiter update (`PATCH /pmem/{id}`).
 *
 * @since v1.16
 */
export type PartialPmem = components["schemas"]["PartialPmem"];

/** Token-bucket rate limiter attached to drives/net/serial/pmem devices. */
export type RateLimiter = components["schemas"]["RateLimiter"];

/** One bucket (size, refill time, one-time burst) of a {@linkcode RateLimiter}. */
export type TokenBucket = components["schemas"]["TokenBucket"];

// ---------------------------------------------------------------------------
// Balloon
// ---------------------------------------------------------------------------

/** Memory balloon device configuration (`PUT /balloon`, pre-boot). */
export type Balloon = components["schemas"]["Balloon"];

/** Post-boot balloon target-size update (`PATCH /balloon`). */
export type BalloonUpdate = components["schemas"]["BalloonUpdate"];

/** Balloon statistics (`GET /balloon/statistics`). */
export type BalloonStats = components["schemas"]["BalloonStats"];

/** Balloon statistics-interval update (`PATCH /balloon/statistics`). */
export type BalloonStatsUpdate = components["schemas"]["BalloonStatsUpdate"];

/** Free-page-hinting start command (`PUT /balloon/hinting/start`). */
export type BalloonStartCmd = components["schemas"]["BalloonStartCmd"];

/** Free-page-hinting status (`GET /balloon/hinting/status`). */
export type BalloonHintingStatus =
  components["schemas"]["BalloonHintingStatus"];

// ---------------------------------------------------------------------------
// Memory hotplug
// ---------------------------------------------------------------------------

/** Virtio-mem hotplug configuration (`PUT /hotplug/memory`, pre-boot). */
export type MemoryHotplugConfig = components["schemas"]["MemoryHotplugConfig"];

/** Post-boot hotplug memory resize (`PATCH /hotplug/memory`). */
export type MemoryHotplugSizeUpdate =
  components["schemas"]["MemoryHotplugSizeUpdate"];

/** Hotplug memory status (`GET /hotplug/memory`). */
export type MemoryHotplugStatus = components["schemas"]["MemoryHotplugStatus"];

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/** Snapshot creation parameters (`PUT /snapshot/create`, paused VM only). */
export type SnapshotCreateParams =
  components["schemas"]["SnapshotCreateParams"];

/**
 * Snapshot load parameters (`PUT /snapshot/load`, pre-boot only). The
 * `vsock_override` field is `@since v1.16`.
 */
export type SnapshotLoadParams = components["schemas"]["SnapshotLoadParams"];

/** Guest-memory backend for snapshot load: `File` or `Uffd`. */
export type MemoryBackend = components["schemas"]["MemoryBackend"];

/** Host-side network device override applied during snapshot load. */
export type NetworkOverride = components["schemas"]["NetworkOverride"];

/**
 * Host-side vsock UDS path override applied during snapshot load.
 *
 * @since v1.16
 */
export type VsockOverride = components["schemas"]["VsockOverride"];

// ---------------------------------------------------------------------------
// MMDS, logging, metrics
// ---------------------------------------------------------------------------

/** MMDS (microVM metadata service) configuration (`PUT /mmds/config`, pre-boot). */
export type MmdsConfig = components["schemas"]["MmdsConfig"];

/** MMDS data-store contents (`GET|PUT|PATCH /mmds`). */
export type MmdsContentsObject = components["schemas"]["MmdsContentsObject"];

/** Logger configuration (`PUT /logger`). */
export type Logger = components["schemas"]["Logger"];

/** Metrics system configuration (`PUT /metrics`). */
export type Metrics = components["schemas"]["Metrics"];
