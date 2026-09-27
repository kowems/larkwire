/**
 * pidfile 互踢自守（~/.larkwire/bridge.pid）：同一台 Mac 上只跑一个 watch/up 常驻。
 *
 * 为什么需要（第一刀 WP2）：install 之后 LaunchAgent 常驻一个 watch——此时再手动
 * `larkwire up/watch` 会以同一桥身份连中继，中继把旧连接 4000 踢掉，KeepAlive 复活
 * 旧连接又把新的踢掉，无限互踢乒乓。启动前先查 pidfile 挡掉第二个实例。
 *
 * 活判口径（macOS 无 /proc）：
 *   kill(pid, 0) 探活（ESRCH=死透；EPERM=活着但非本用户，继续校验）；
 *   ps 命令行正则复核——防 PID 复用（别的进程复用了死桥的 PID 不能误判桥活着）。
 */
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { larkwireDir } from "./config.js";

// 只认桥自己的命令行——CLI 四形态 + 桌面两形态：
//   node --import tsx packages/bridge/src/cli.ts watch   （源码直跑，开发期）
//   node /path/dist/cli.js up                          （npm 打包后）
//   node ~/"Library/Application Support/larkwire/cli.mjs" watch  （launchd bundle 快照，WP3 定稿形态）
//   手动 tsx 包装壳同理（launchd 禁用包装壳=信号传不到，但手动跑可能撞见）
//   …/灵鹊.app/Contents/MacOS/灵鹊                          （桌面 App 打包形态，productName=灵鹊）
//   …/Electron . --larkwire-desktop                        （桌面开发形态：electron 二进制+标记参数）
const OWN_CMDS = [/cli\.(ts|js|mjs)\s+(watch|up)\b/, /灵鹊\.app\/Contents\/MacOS\//, /--larkwire-desktop(\s|$)/];

export function pidfilePath(): string {
  return join(larkwireDir(), "bridge.pid");
}

/** pidfile 里记的活桥 PID；死了/陈尸/命令行不是桥 → null（调用方直接覆盖启动） */
export function readAlivePid(): number | null {
  const p = pidfilePath();
  if (!existsSync(p)) return null;
  const pid = Number(readFileSync(p, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0); // 探活：不真发信号
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return null; // 死透了
    // EPERM = 活着但不是本用户的进程——继续 ps 校验是不是桥
  }
  try {
    const cmdline = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    return OWN_CMDS.some((re) => re.test(cmdline)) ? pid : null; // PID 被别的进程复用 → 陈尸
  } catch {
    return null;
  }
}

export function writePidfile(): void {
  mkdirSync(larkwireDir(), { recursive: true });
  writeFileSync(pidfilePath(), String(process.pid), { mode: 0o600 });
}

/** 只删自己写的（新主已接管时 pidfile 是它的，误删会让第三实例失去拦截依据） */
export function removeOwnPidfile(): void {
  try {
    const p = pidfilePath();
    if (readFileSync(p, "utf8").trim() === String(process.pid)) unlinkSync(p);
  } catch {
    /* 不存在/读不了都算已清 */
  }
}
