/**
 * Claude Code 会话注册表（~/.claude/sessions/<pid>.json）——占用判定的权威信号。
 *
 * 为什么需要这个：转录 10s 静默的活跃闸门分辨不出「终端开着但人没打字」和「会话已关」。
 * 2026-09-18 真机实证：手机对正被交互终端占用的会话发话，一次性 resume 子进程 2 秒
 * 交 result 帧退场、零 assistant 产出，话被队列吞掉两头不到岸。注册表白纸黑字写着
 * 哪个活进程持有哪个 sessionId，查它不用猜。
 *
 * 条目格式（实证 2026-09-18，claude 2.1.220）：
 *   { pid, sessionId, procStart: "Sun Sep 13 07:50:10 2026"(UTC 墙钟串),
 *     startedAt: epochMs, kind: "interactive", entrypoint: "claude-vscode", version }
 */
import { readdirSync, readFileSync, watch } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

interface SessionReg {
  pid?: number;
  sessionId?: string;
  procStart?: string;
  kind?: string;
}

interface HolderEntry {
  pid: number;
  procStart?: string;
  kind?: string;
}

/** 注册表里这个会话的【全部】活持有者条目（已做 PID 复用防护），按目录文件顺序排列。
 *  注意返回数组而非首个：同会话可能并存多个持有者（典型=桥自己持续持有的影子 Runner 与
 *  人新打开的 IDE 各写一条）。「哪个是桥自己孩子要跳过」只有调用方知道（controller 的
 *  ourChildPids），本层只如实枚举，不替调用方选——2026-09-26 用例④真机钓出的首命中即返回
 *  会让外部 IDE 被前面的影子条目遮住。 */
function findHolderEntries(sessionId: string): HolderEntry[] {
  const dir = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "sessions");
  const out: HolderEntry[] = [];
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return out; // 注册表目录不存在 = 没有任何会话在跑
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    let reg: SessionReg;
    try {
      reg = JSON.parse(readFileSync(join(dir, f), "utf8")) as SessionReg;
    } catch {
      continue; // 写了一半的文件，跳过
    }
    if (reg.sessionId !== sessionId || typeof reg.pid !== "number") continue;
    if (pidReallyAlive(reg.pid, reg.procStart)) {
      out.push({ pid: reg.pid, procStart: reg.procStart, kind: reg.kind });
    }
  }
  return out;
}

/** 这个会话全部活持有者 PID（文件顺序）；空数组=没人持有。供需要排除桥自己孩子的调用方使用 */
export function liveHolderPids(sessionId: string): number[] {
  return findHolderEntries(sessionId).map((e) => e.pid);
}

/** 这个会话正被哪个活进程占用？返回【文件序首个】活 PID；没占用返回 null。
 *  注意：同会话并存桥自己影子与外部 IDE 时，这可能返回影子 PID——需要外部持有者的调用方
 *  （occupancy/submit/takeover）请用 liveHolderPids + isOurChild 过滤，别用本函数。 */
export function occupiedBy(sessionId: string): number | null {
  return liveHolderPids(sessionId)[0] ?? null;
}

/** 按 PID 找它自己的注册表条目（一个进程只持一个会话）；查无/已死返回 null */
function entryForPid(pid: number): HolderEntry | null {
  const dir = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "sessions");
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return null;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    let reg: SessionReg;
    try {
      reg = JSON.parse(readFileSync(join(dir, f), "utf8")) as SessionReg;
    } catch {
      continue;
    }
    if (reg.pid !== pid) continue;
    if (pidReallyAlive(reg.pid, reg.procStart)) {
      return { pid: reg.pid, procStart: reg.procStart, kind: reg.kind };
    }
  }
  return null;
}

/**
 * 抢夺控制权（M1.5）：杀掉电脑端持有该会话的进程，打开占用闸门。
 *
 * 注册表文件任意本地进程可写，必须假设它会腐烂——kill 前四重验证，任一不过拒杀：
 *   ① 注册表条目仍指向该 PID 且 procStart 匹配（防 PID 复用，entryForPid→pidReallyAlive 已做）
 *   ② 条目 kind === "interactive"（写了 kind 却不是交互终端的，不动）
 *   ③ ps comm 的 basename 精确等于 "claude"（防注册表污染误杀旁人）
 *   ④ comm 检查紧贴 SIGTERM 前最后一刻（TOCTOU 窗口收到毫秒级）
 * SIGTERM 优雅杀（claude 会 flush 转录，历史完整），轮询等死最多 3 秒；
 * 不死【不自动 SIGKILL】——报让人工 /exit，保守（Eric 拍板 2026-09-19 #40）。
 *
 * 同会话多个持有者时逐个杀，任一不过即停并回报（已杀 PID 一并给出）。isOurs 可选：
 * 传入则跳过桥自己的影子进程（takeover/桌面 kill-open 用——绝不能杀自己的 Runner）。
 * 幂等：过滤后没人占用直接 ok。
 */
export function killHolder(
  sessionId: string,
  isOurs?: (pid: number) => boolean,
): { ok: boolean; pid?: number; pids?: number[]; reason?: string } {
  const targets = liveHolderPids(sessionId).filter((p) => !isOurs?.(p));
  const killed: number[] = [];
  // 没人占用（幂等）；注意区分"有持有者但全是自己孩子"——同样不动刀，按 ok 交回调用方
  if (targets.length === 0) return { ok: true, pids: killed };
  for (const target of targets) {
    const entry = entryForPid(target);
    if (!entry) continue; // 扫描途中刚死，跳过
    if (entry.kind !== undefined && entry.kind !== "interactive") {
      return { ok: false, reason: `占用者不是交互终端（kind=${entry.kind}，PID ${entry.pid}），不敢动——请手动处理`, pids: killed };
    }
    const comm = readCommBasename(entry.pid);
    if (comm !== "claude") {
      return { ok: false, reason: `PID ${entry.pid} 不是 claude 进程（${comm ?? "查不到"}），不敢动——请手动关窗`, pids: killed };
    }
    try {
      process.kill(entry.pid, "SIGTERM");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") { killed.push(entry.pid); continue; } // 刚好自己死了
      return { ok: false, reason: `SIGTERM PID ${entry.pid} 失败：${(e as Error).message}`, pids: killed };
    }
    // 轮询等死：200ms × 15 = 3s。zombie（ps stat 查不到或 Z 开头）也算死——父进程没 reap 前
    // kill(pid,0) 仍成功，不误等
    let gone = false;
    for (let i = 0; i < 15; i++) {
      if (processGone(entry.pid)) { gone = true; break; }
      sleepMs(200);
    }
    if (!gone) {
      return { ok: false, reason: `SIGTERM 后 3 秒没退（PID ${entry.pid}）——请到电脑上 /exit 或手动关窗，再从手机发话`, pids: killed };
    }
    killed.push(entry.pid);
  }
  return { ok: true, pid: killed[killed.length - 1], pids: killed };
}

// ---------- 注册表 watcher（方案 B：坐下即用，2026-09-19 Eric 拍板 A+B） ----------
// 人在电脑前坐下重新打开会话窗口 → 注册表多出一条活条目 → 桥立刻知道「电脑端接管了」，
// 有手机 run 在跑就杀 run 让位，并推 session.owner 给全部手机。本层只报客观事实
// （哪条活条目出现/消失），不过滤——「是不是我们自己 spawn 的 run 子进程」由调用方排除
// （一次性 resume 子进程也会注册，不排除会把手机回合误判成电脑端接管）。

export interface HolderInfo {
  sessionId: string;
  pid: number;
  kind?: string;
}

/**
 * 盯注册表目录：活持有者出现/消失时回调（diff 全量扫描，500ms 去抖）。
 * fs.watch 是低延迟主通道，15s 慢轮询常驻对账（漏事件自愈，不是失败兜底才跑）；
 * 起始快照 = 基线，不回调（预存的持有者不报——它一直在那儿，不是「刚接管」）。
 * 死 PID 条目被 pidReallyAlive 滤掉，自然产生 disappear。返回停止函数。
 */
export function watchHolders(
  onAppear: (h: HolderInfo) => void,
  onDisappear: (h: HolderInfo) => void,
): () => void {
  const dir = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "sessions");
  let baseline = scanHolders(dir);
  let timer: ReturnType<typeof setTimeout> | null = null;

  const rescan = (): void => {
    const now = scanHolders(dir);
    for (const [pid, h] of now) {
      if (!baseline.has(pid)) onAppear(h);
    }
    for (const [pid, h] of baseline) {
      if (!now.has(pid)) onDisappear(h);
    }
    baseline = now;
  };
  const debounced = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(rescan, 500);
  };

  let watcher: ReturnType<typeof watch> | null = null;
  try {
    watcher = watch(dir, debounced);
    watcher.on("error", () => { /* fs.watch 挂了还有慢轮询兜底 */ });
  } catch {
    watcher = null; // 目录不存在等：慢轮询兜底
  }
  const poll = setInterval(rescan, 15_000);

  return () => {
    watcher?.close();
    clearInterval(poll);
    if (timer) clearTimeout(timer);
  };
}

/** 全量扫描活持有者（PID 复用防护同 findHolderEntry）。key=pid——一个进程只持一个会话 */
function scanHolders(dir: string): Map<number, HolderInfo> {
  const out = new Map<number, HolderInfo>();
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return out;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    let reg: SessionReg;
    try {
      reg = JSON.parse(readFileSync(join(dir, f), "utf8")) as SessionReg;
    } catch {
      continue; // 写了一半的文件，跳过
    }
    if (typeof reg.sessionId !== "string" || typeof reg.pid !== "number") continue;
    if (pidReallyAlive(reg.pid, reg.procStart)) {
      out.set(reg.pid, { sessionId: reg.sessionId, pid: reg.pid, kind: reg.kind });
    }
  }
  return out;
}

/** PID 活着且没被别人复用？宁拒不错放：拿不准的一律按活处理 */
function pidReallyAlive(pid: number, procStart?: string): boolean {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return false; // 死透了
    // EPERM = 活着但属于别的用户，按活处理
  }
  // PID 复用防护：注册表记了进程启动时刻（UTC 墙钟），ps lstart 给本地墙钟，
  // 两边对不上说明这个 PID 早就换了主人，注册条目是尸体
  if (!procStart) return true;
  try {
    const lstart = execSync(`ps -p ${pid} -o lstart=`, { encoding: "utf8" }).trim();
    if (!lstart) return false;
    const a = parseWallClock(lstart, false);
    const b = parseWallClock(procStart, true);
    if (!Number.isNaN(a) && !Number.isNaN(b) && Math.abs(a - b) > 5_000) return false;
  } catch {
    /* ps 不可用就按活处理 */
  }
  return true;
}

/** ps comm → basename 小写（macOS comm 给全路径，实证 2.1.220）；查不到返回 null */
function readCommBasename(pid: number): string | null {
  try {
    const out = execSync(`ps -p ${pid} -o comm=`, { encoding: "utf8" }).trim();
    if (!out) return null;
    return (out.split("/").pop() ?? out).toLowerCase();
  } catch {
    return null;
  }
}

/** 进程死透了？kill(pid,0) ESRCH 或 zombie（stat 空/Z 开头）都算 */
function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return true;
  }
  try {
    const stat = execSync(`ps -p ${pid} -o stat=`, { encoding: "utf8" }).trim();
    if (!stat || stat.startsWith("Z")) return true;
  } catch {
    /* ps 不可用就按活处理 */
  }
  return false;
}

/** 同步 sleep（本文件全同步风格；killHolder 等死轮询用）。Node 主线程允许 Atomics.wait */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/** "Sun Sep 13 07:50:10 2026" → epoch ms；utc=true 按 UTC 解析（procStart），false 按本地（ps lstart） */
function parseWallClock(s: string, utc: boolean): number {
  const m = /^\w+ (\w+) +(\d+) (\d+):(\d+):(\d+) (\d+)$/.exec(s.trim());
  const [, mon, dd, hh, mm, ss, yy] = m ?? [];
  const month = mon !== undefined ? MONTHS[mon] : undefined;
  if (month === undefined || !dd || !hh || !mm || !ss || !yy) return NaN;
  const [y, d, h, mi, se] = [+yy, +dd, +hh, +mm, +ss];
  return utc ? Date.UTC(y, month, d, h, mi, se) : new Date(y, month, d, h, mi, se).getTime();
}
