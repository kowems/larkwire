#!/usr/bin/env node
/**
 * larkwire CLI
 *   larkwire up                 一条命令：未配对先出二维码配对 → 接续常驻（推荐入口）
 *   larkwire install            注册 launchd 开机自启（nohup 退休；挂了自动复活）
 *   larkwire pair               配对手机（出二维码）
 *   larkwire watch              看模式常驻：转录 → 手机实时滚动
 *   larkwire sessions           列出本机发现的会话（调试）
 *   larkwire unpair             解绑所有手机（手机丢失时踢掉旧密钥）
 *   公共参数：--relay ws(s)://…（覆盖默认官方云）  --dir <转录目录>
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { runInstall } from "./install.js";
import { runPair } from "./pair.js";
import { runUp } from "./up.js";
import { startBridge } from "./watch.js";
import { loadConfig, saveConfig, configKeyPair } from "./config.js";
import { RelayConnection } from "./connection.js";
import { TranscriptWatcher } from "./watcher.js";
import { StateStore } from "./state.js";
import { T, type PairRevokeBody } from "@larkwire/protocol";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const HELP = `灵鹊 larkwire · 把手机变成 Agent 遥控台

用法：
  larkwire up          一条命令搞定：没配对先出二维码，配好自动接续常驻（推荐）
  larkwire install     注册开机自启（launchd 托管：挂了自动复活，重启自动起）
  larkwire pair        只配对手机（显示二维码，微信扫一扫直达）
  larkwire watch       只看模式常驻（已配对前提）：Claude Code 会话实时滚屏上手机
  larkwire sessions    列出本机发现的会话（调试用，不连中继）
  larkwire unpair      解绑所有手机（手机丢失时用，旧密钥立即作废）

参数：
  --relay <url>        覆盖中继地址（默认官方云 wss://larkwire.kowems.site/ws）
  --dir <path>         覆盖转录目录（默认 ~/.claude/projects）
`;

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const relay = arg("--relay");
  const dir = arg("--dir") ?? join(homedir(), ".claude", "projects");

  switch (cmd) {
    case "up":
      await runUp({ projectsDir: dir, relayOverride: relay });
      return;

    case "install":
      runInstall();
      return;

    case "pair":
      // runPair 已 Promise 化（up 复用）——壳维持原行为：成功 0 / 失败打印+exit 1
      try {
        await runPair({ relayOverride: relay, rerunHint: "larkwire pair" });
        console.log("下一步：运行 larkwire watch（或 larkwire up），手机即可看到这台电脑上的会话实时滚动。\n");
        // 显式 exit(0) 恢复重构前行为契约——人对照的 readline 用完 rl.close() 后 stdin
        // 仍保持 ref，事件循环不死进程吊着（T7 回归钓出：pair 配上后 5 分钟不退）。
        // up 接续路径走 runPair 不经过这里，不受影响。
        process.exit(0);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      return;

    case "watch":
      // 守卫拒启（未配对/已有活桥）抛 BridgeStartError → main().catch 打印 message + exit 1（逐字旧行为）；
      // startBridge 同步返回后事件循环由 conn/定时器吊住（旧 await runWatch 永不 resolve 同效）
      startBridge({ projectsDir: dir, relayOverride: relay, exitOnFatal: true, handleSignals: true });
      return;

    case "sessions": {
      const watcher = new TranscriptWatcher(dir, new StateStore());
      await watcher.rescan();
      const list = watcher.listSessions();
      console.log(`发现 ${list.length} 个会话（${dir}）：\n`);
      for (const s of list.slice(0, 30)) {
        const when = new Date(s.lastActiveAt).toLocaleString("zh-CN", { hour12: false }); // 口径=毫秒 epoch（§10 #19）
        console.log(`  ${s.sessionId.slice(0, 8)}…  ${when}  ${s.project}${s.registered ? "" : "  (不活跃)"}`);
      }
      if (list.length > 30) console.log(`  … 还有 ${list.length - 30} 个`);
      return;
    }

    case "unpair": {
      const cfg = loadConfig();
      if (!cfg || cfg.paired.length === 0) {
        console.log("没有已配对的设备。");
        return;
      }
      const keys = configKeyPair(cfg);
      const targets = cfg.paired.map((p) => p.deviceId);
      console.log(`解绑 ${targets.length} 台设备：${targets.join(", ")}`);
      try {
        const conn = new RelayConnection({
          relayUrl: relay ?? cfg.relay,
          deviceId: cfg.deviceId,
          publicKey: keys.publicKey,
          secretKey: keys.secretKey,
          name: cfg.name,
        });
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 5000);
          conn.on("ready", () => {
            for (const t of targets) {
              conn.sendPlain("relay", T.PairRevoke, { targetDeviceId: t } satisfies PairRevokeBody);
              conn.sendPlain(t, T.PairRevoke, { targetDeviceId: t } satisfies PairRevokeBody);
            }
            clearTimeout(timer);
            setTimeout(() => { conn.close(); resolve(); }, 500);
          });
          conn.on("wsError", () => resolve());
          conn.connect();
        });
      } catch {
        console.warn("⚠ 中继不可达，仅执行本地解绑（手机端密钥已无法通过中继路由，风险可控）");
      }
      cfg.paired = [];
      saveConfig(cfg);
      console.log("✅ 已解绑。旧手机上的密钥已成废铁。");
      return;
    }

    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(HELP);
      return;

    default:
      console.error(`未知命令：${cmd}\n\n${HELP}`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
