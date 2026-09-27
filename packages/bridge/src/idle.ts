/**
 * 「人离开」判定（Eric 拍板 2026-09-23）：读 macOS 键鼠空闲时间做完成通知的推送闸门——
 * 人在电脑前 = 屏幕就在眼前，推了纯打扰；人离开 = 手机是唯一触达通道，才推。
 * 锁屏/屏保天然覆盖（锁屏必然无键鼠）。零依赖（ioreg 系统自带），事件时即时读不轮询。
 *
 * WP1（2026-09-23）execSync → execFile 异步化：桥被 Electron 主进程内嵌后，最长 5s 的
 * 同步阻塞会卡死整个桌面 IPC/托盘；调用点（看模式完成检测到点判定）顺势 await。
 */
import { execFile } from "node:child_process";

/** macOS 键鼠空闲秒数（HIDIdleTime 原生单位纳秒，实测 2026-09-23 与人工计时吻合）。
 *  解析失败/非 darwin/超时 → Infinity（fail-open = 推）：硬需求是「人走了要收到」——
 *  检测坏掉时宁可多推一条（日志留痕立即可见），也不能让功能死了还隐形 */
export function getIdleSeconds(): Promise<number> {
  if (process.platform !== "darwin") return Promise.resolve(Infinity);
  return new Promise((resolve) => {
    execFile("ioreg", ["-c", "IOHIDSystem", "-d", "4"], { encoding: "utf8", timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(Infinity);
      const m = stdout.match(/"HIDIdleTime"\s*=\s*(\d+)/);
      if (!m) return resolve(Infinity);
      resolve(Number(m[1]) / 1e9);
    });
  });
}
