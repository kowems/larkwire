/**
 * 桥包对外面（desktop 等内嵌方 import 这里；CLI 入口 cli.ts 不在桶里——bin 直链）。
 * protocol 同款 raw-TS exports（消费方 esbuild 直接打 TS 源码）。
 */
export {
  startBridge,
  BridgeStartError,
  type BridgeHandle,
  type BridgeOptions,
  type BridgeSnapshot,
  type SnapshotSession,
} from "./watch.js";
export type { Occupancy, OccupancyState } from "./occupancy.js";
export { runPair, type PairHooks, type PairResult } from "./pair.js";
// readAlivePid：桌面接管 launchd 时轮询旧桥是否死透（等 pidfile 释放再 startBridge）
export { readAlivePid } from "./pidfile.js";
export {
  loadConfig,
  saveConfig,
  loadOrCreateConfig,
  larkwireDir,
  configPath,
  type BridgeConfig,
  type PairedPeer,
} from "./config.js";
export type { WatchedSession } from "./watcher.js";
