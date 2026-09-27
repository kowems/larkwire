/**
 * `larkwire up`（Eric 拍板 2026-09-22：「电脑端 pair 和 watch 还是分开的，很麻烦」→ 单命令）：
 *   已配对 → 直接进 watch；
 *   未配对 → 自动先出二维码配对，成功后同进程接续 watch；
 *   配对过期/失败 → 报错退出，提示重新跑 larkwire up。
 */
import { loadConfig } from "./config.js";
import { readAlivePid } from "./pidfile.js";
import { runPair } from "./pair.js";
import { startBridge } from "./watch.js";

export async function runUp(opts: { projectsDir: string; relayOverride?: string }): Promise<void> {
  const alive = readAlivePid();
  const cfg = loadConfig();
  const paired = cfg !== null && cfg.paired.length > 0;

  if (alive !== null) {
    if (paired) {
      // 幂等：目标态（桥在跑且已配对）已是事实 → 成功退出，不制造第二个在线身份
      console.log(`桥已在运行（PID ${alive}），无需重复启动。`);
      console.log("  看日志：tail -f ~/.larkwire/bridge.log；换手机重配对：先 stop 再重新 up。");
      process.exit(0);
    }
    console.error(`✗ 另一个桥进程在跑（PID ${alive}）但还没配对手机。`);
    console.error(`  先去那个终端扫码完成配对，或先 kill ${alive} 再重新运行 larkwire up。`);
    process.exit(1);
  }

  if (!paired) {
    console.log("还没配对手机——先出二维码配对，成功后自动接续常驻。\n");
    try {
      const phone = await runPair({ relayOverride: opts.relayOverride, rerunHint: "larkwire up" });
      console.log(`已配对 ${phone.name}（${phone.deviceId}），接续进入 watch…\n`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }

  // startBridge 同步装配完即返回——常驻靠 conn/定时器吊住事件循环（旧 await runWatch 永不 resolve 同效）；
  // 守卫拒启抛 BridgeStartError 透传到 cli 壳打印+exit 1（行为不变）
  startBridge({ projectsDir: opts.projectsDir, relayOverride: opts.relayOverride, exitOnFatal: true, handleSignals: true });
}
