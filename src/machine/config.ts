/**
 * Whole-VM configuration: the {@linkcode VmConfig} shape and its
 * translation into the correctly-ordered sequence of API calls.
 *
 * @module
 */

import type { FirecrackerClient } from "../api/client.ts";
import type {
  Balloon,
  BootSource,
  CpuConfig,
  Drive,
  EntropyDevice,
  Logger,
  MachineConfiguration,
  MemoryHotplugConfig,
  Metrics,
  MmdsConfig,
  MmdsContentsObject,
  NetworkInterface,
  Pmem,
  SerialDevice,
  Vsock,
} from "../api/types.ts";

/**
 * Everything to configure before boot, in one declarative object. Keys are
 * `snake_case` because their contents are Firecracker wire schemas — see
 * the naming convention in the package docs.
 *
 * A `GET /vm/config` (`FullVmConfiguration`) from a running VM can be
 * mechanically reshaped into this (the wire uses kebab-case section names).
 */
export interface VmConfig {
  /** vCPUs/memory; omit to accept Firecracker's defaults (1 vCPU, 128 MiB). */
  machine_config?: MachineConfiguration;
  /** Kernel to boot. Required — a VM with nothing to boot is a config error. */
  boot_source: BootSource;
  drives?: Drive[];
  network_interfaces?: NetworkInterface[];
  vsock?: Vsock;
  balloon?: Balloon;
  entropy?: EntropyDevice;
  serial?: SerialDevice;
  pmem?: Pmem[];
  memory_hotplug?: MemoryHotplugConfig;
  cpu_config?: CpuConfig;
  mmds?: { config: MmdsConfig; data?: MmdsContentsObject };
  logger?: Logger;
  metrics?: Metrics;
}

/**
 * Apply `config` through `client` in dependency order. Logger and metrics
 * go first so everything after is observable; MMDS config follows the
 * network interfaces it references.
 *
 * Throws the underlying `ApiError` on the first rejected call — nothing is
 * rolled back (the caller owns the VMM process and will tear it down).
 */
export async function applyVmConfig(
  client: FirecrackerClient,
  config: VmConfig,
): Promise<void> {
  if (config.logger) await client.putLogger(config.logger);
  if (config.metrics) await client.putMetrics(config.metrics);
  if (config.machine_config) {
    await client.putMachineConfig(config.machine_config);
  }
  if (config.cpu_config) await client.putCpuConfig(config.cpu_config);
  await client.putBootSource(config.boot_source);
  for (const drive of config.drives ?? []) {
    await client.putDrive(drive);
  }
  for (const iface of config.network_interfaces ?? []) {
    await client.putNetworkInterface(iface);
  }
  if (config.vsock) await client.putVsock(config.vsock);
  if (config.entropy) await client.putEntropyDevice(config.entropy);
  if (config.serial) await client.putSerialDevice(config.serial);
  for (const pmem of config.pmem ?? []) {
    await client.putPmem(pmem);
  }
  if (config.memory_hotplug) {
    await client.putMemoryHotplug(config.memory_hotplug);
  }
  if (config.balloon) await client.putBalloon(config.balloon);
  if (config.mmds) {
    await client.putMmdsConfig(config.mmds.config);
    if (config.mmds.data !== undefined) await client.putMmds(config.mmds.data);
  }
}
