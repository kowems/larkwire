/**
 * tmux 适配器（批次③ WP4）：发现 tmux 里的活 claude 会话，手机发话直接注入终端 = 共驾。
 *
 * 算法蓝本 = S6/S7 spike（tools/spikes/s6-tmux-assoc.mts，2026-09-24 实测 6/6 通过）：
 * - list-panes -a 枚举全部 pane + ps 进程树从 pane shell 向下找 claude 子孙
 * - sessionId 关联三级：exact（argv --resume <uuid>）/ inferred（cwd→编码转录目录→mtime 最新 jsonl）
 *   / ambiguous（同 realpath cwd ≥2 个活 claude，禁绑防注错会话）
 * - 注入：单行 send-keys -l + Enter；多行 set-buffer + paste-buffer -p（bracketed paste——
 *   默认 paste 把 LF 译成 CR 致首行提前提交，S7 三变体实证）
 *
 * 软依赖：tmux 不在 PATH（或探测失败）→ 适配器整体降级关闭并日志一行，桥其余功能不受影响。
 * 明文不做（计划 WP4）：capture-pane 数据面 / terminal 占用⚡强杀 / iTerm。
 */
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { existsSync, realpathSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const POLL_MS = 5000; // 刷新节奏（watchHolders 同款量级；tmux 枚举轻量）
const CMD_TIMEOUT_MS = 5000;

export type TmuxAssocKind = "exact" | "inferred";

export interface TmuxAssociation {
  paneId: string;
  claudePid: number;
  kind: TmuxAssocKind;
  sessionId: string;
}

export interface InjectResult {
  ok: boolean;
  reason?: string;
}

/**
 * controller submit 路由面（WP4）：TmuxAdapter structurally 实现这三个方法；
 * 抽窄接口=单测可构造 mock 三态（associated/ambiguous/无）而不必造整个 EventEmitter。
 */
export interface TmuxRoute {
  stateForClaudePid: (pid: number) => ClaudePidState | undefined;
  inject: (sessionId: string, text: string) => Promise<InjectResult>;
  associationFor: (sessionId: string) => TmuxAssociation | undefined;
}

/** claude PID 在最近一次扫描里的状态（controller holder 闸门判定用） */
export type ClaudePidState =
  | { kind: "associated"; sessionId: string; assocKind: TmuxAssocKind }
  | { kind: "ambiguous"; reason: string };

interface Pane { id: string; pid: number; cwd: string; cmd: string }
interface PsRow { pid: number; ppid: number; comm: string; args: string }

type Assoc =
  | { kind: "exact"; sessionId: string; claudePid: number }
  | { kind: "inferred"; sessionId: string; claudePid: number }
  | { kind: "ambiguous"; claudePid: number; reason: string }
  | { kind: "none"; reason: string };

export interface TmuxAdapterOptions {
  tmuxBin?: string;
  projectsDir?: string;
  log?: (line: string) => void;
}

/** claude 项目目录编码：非 [a-zA-Z0-9] → "-"（实盘样本核对：CJK/点号全变 dash） */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * 包装类进程：命令行里【提到】claude 但本体不是 claude——
 * `zsh -c "… claude …"` 的 args 含 claude 字样、`env claude` 只是跳板（2026-09-24 实测误判）。
 */
const WRAPPER_COMMS = new Set(["sh", "bash", "zsh", "dash", "fish", "tcsh", "env", "sudo", "time", "nohup"]);

function isClaude(p: PsRow): boolean {
  const base = p.comm.split("/").pop() ?? p.comm;
  if (WRAPPER_COMMS.has(base) || WRAPPER_COMMS.has(base.replace(/^-/, ""))) return false;
  // macOS ps comm 截断到约 15 字符（/Users/eric/.loc），所以仍需 args 路径判定
  return p.comm === "claude" || p.args.includes("/.local/bin/claude") || /(^|\/)claude( |$)/.test(p.args);
}

/**
 * pane 里的候选 claude：pane_pid 自身 + 进程树子孙。
 * 必须包含自身——`tmux new-session -d "env … claude …"` 这类形态下，pane 的 shell 对
 * 末条命令做 exec 优化直接被 claude 替换，pane_pid 就是 claude，没有子孙（2026-09-24 实测）。
 */
function claudeCandidates(panePid: number, ps: PsRow[]): PsRow[] {
  const self = ps.find((p) => p.pid === panePid);
  return [
    ...(self && isClaude(self) ? [self] : []),
    ...claudeDescendants(panePid, ps),
  ];
}

/** 从 pane 的 shell pid 向下走进程树找 claude 子孙 */
function claudeDescendants(panePid: number, ps: PsRow[]): PsRow[] {
  const byPpid = new Map<number, PsRow[]>();
  for (const p of ps) {
    const arr = byPpid.get(p.ppid) ?? [];
    arr.push(p);
    byPpid.set(p.ppid, arr);
  }
  const found: PsRow[] = [];
  const queue = [...(byPpid.get(panePid) ?? [])];
  while (queue.length) {
    const p = queue.shift()!;
    if (isClaude(p)) found.push(p);
    queue.push(...(byPpid.get(p.pid) ?? []));
  }
  return found;
}

export class TmuxAdapter extends EventEmitter {
  private tmuxBin: string;
  private projectsDir: string;
  private log: (line: string) => void;
  private timer?: NodeJS.Timeout;
  private scanning = false;
  private started = false;
  private availability: boolean | undefined;
  private injectCounter = 0;

  /** sessionId → 关联（最近一次扫描） */
  private bySession = new Map<string, TmuxAssociation>();
  /** paneId → 关联（exact/inferred），appear/disappear diff 用 */
  private byPane = new Map<string, TmuxAssociation>();
  /** claudePid → 全量关联状态（含 ambiguous/none），holder 闸门用 */
  private byClaudePid = new Map<number, Assoc>();

  constructor(opts: TmuxAdapterOptions = {}) {
    super();
    this.tmuxBin = opts.tmuxBin ?? "tmux";
    const claudeConfig = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
    this.projectsDir = opts.projectsDir ?? join(claudeConfig, "projects");
    this.log = opts.log ?? ((line) => console.log(line));
  }

  /** 软探测：tmux 可执行且能应答版本号（只探一次） */
  async available(): Promise<boolean> {
    if (this.availability !== undefined) return this.availability;
    try {
      await execFileP(this.tmuxBin, ["-V"], { timeout: CMD_TIMEOUT_MS });
      this.availability = true;
    } catch {
      this.availability = false;
    }
    return this.availability;
  }

  /** 启动轮询；tmux 缺席→降级关闭。返回适配器是否真正启用 */
  async start(): Promise<boolean> {
    if (this.started) return this.availability === true;
    this.started = true;
    const ok = await this.available();
    if (!ok) {
      this.log("tmux 未找到，终端共驾适配已关闭（安装：brew install tmux）");
      return false;
    }
    await this.scanOnce();
    this.timer = setInterval(() => void this.scanOnce(), POLL_MS);
    return true;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.started = false;
  }

  associationFor(sessionId: string): TmuxAssociation | undefined {
    return this.bySession.get(sessionId);
  }

  associations(): TmuxAssociation[] {
    return [...this.bySession.values()];
  }

  stateForClaudePid(pid: number): ClaudePidState | undefined {
    const a = this.byClaudePid.get(pid);
    if (!a) return undefined;
    if (a.kind === "ambiguous") return { kind: "ambiguous", reason: a.reason };
    if (a.kind === "none") return undefined;
    return { kind: "associated", sessionId: a.sessionId, assocKind: a.kind };
  }

  /** 手动触发一轮扫描 */
  async refresh(): Promise<void> {
    await this.scanOnce();
  }

  /**
   * 注入文本到 sessionId 关联的 pane。注前 pane 活探（pane 存在 + claudePid 活）。
   * 单行 send-keys -l；多行 set-buffer + paste-buffer -p + Enter。
   */
  async inject(sessionId: string, text: string): Promise<InjectResult> {
    const assoc = this.bySession.get(sessionId);
    if (!assoc) return { ok: false, reason: "终端里找不到这个会话的窗口" };
    const alive = await this.paneAlive(assoc.paneId, assoc.claudePid);
    if (!alive) return { ok: false, reason: "终端窗口已关闭，注入失败" };
    try {
      if (text.includes("\n")) {
        const bufName = `lwbuf-${process.pid}-${++this.injectCounter}`;
        await this.tmux("set-buffer", "-b", bufName, text);
        await this.tmux("paste-buffer", "-t", assoc.paneId, "-b", bufName, "-p");
        await sleep(1000); // TUI 渲染粘贴草稿（S7 实证节奏）
        await this.tmux("send-keys", "-t", assoc.paneId, "Enter");
      } else {
        await this.tmux("send-keys", "-t", assoc.paneId, "-l", text);
        await this.tmux("send-keys", "-t", assoc.paneId, "Enter");
      }
      this.log(`tmux 注入成功 ${assoc.paneId}（${assoc.kind}，${text.length} 字）`);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: "注入失败：" + errLine(e) };
    }
  }

  private async paneAlive(paneId: string, claudePid: number): Promise<boolean> {
    let panes: Pane[];
    try {
      panes = await this.listPanes();
    } catch {
      return false;
    }
    if (!panes.some((p) => p.id === paneId)) return false;
    try {
      process.kill(claudePid, 0);
    } catch {
      return false;
    }
    return true;
  }

  private async tmux(...args: string[]): Promise<string> {
    const { stdout } = await execFileP(this.tmuxBin, args, { timeout: CMD_TIMEOUT_MS });
    return stdout.trimEnd();
  }

  private async listPanes(): Promise<Pane[]> {
    const out = await this.tmux("list-panes", "-a", "-F", "#{pane_id} #{pane_pid} #{pane_current_path} #{pane_current_command}");
    // cwd 可含空格（不能按空格 split）：pane_id(%开头) + pid 前缀锚定，cmd=行末最后一个 token
    const panes: Pane[] = [];
    for (const l of out.split("\n")) {
      const m = l.match(/^(%\S+)\s+(\d+)\s+(.*)\s+(\S+)$/);
      if (m && m[1] !== undefined && m[2] !== undefined && m[3] !== undefined && m[4] !== undefined) {
        panes.push({ id: m[1], pid: Number(m[2]), cwd: m[3], cmd: m[4] });
      }
    }
    return panes;
  }

  private async psTable(): Promise<PsRow[]> {
    const { stdout } = await execFileP("ps", ["-eo", "pid=,ppid=,comm=,args="], { timeout: CMD_TIMEOUT_MS });
    return stdout.split("\n").filter(Boolean).map((l) => {
      const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      return m ? { pid: Number(m[1]), ppid: Number(m[2]), comm: m[3], args: m[4] } : null;
    }).filter((r): r is PsRow => r !== null);
  }

  /** Q-B 关联（spike 同款；allPanesClaude=每个 realpath cwd 的活 claude 总数） */
  private associate(pane: Pane, ps: PsRow[], allPanesClaude: Map<string, number>): Assoc {
    const claudes = claudeCandidates(pane.pid, ps);
    const c = claudes[0];
    if (!c) return { kind: "none", reason: "pane 进程树里无 claude" };
    const m = c.args.match(/--resume[ =]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
    if (m && m[1]) return { kind: "exact", sessionId: m[1], claudePid: c.pid };
    // inferred：realpath 规范化（/tmp→/private/tmp）→ 编码目录 → mtime 最新 jsonl
    let realCwd = pane.cwd;
    try { realCwd = realpathSync(pane.cwd); } catch { /* 用原值 */ }
    const sameDir = allPanesClaude.get(realCwd) ?? 0;
    // ambiguous：同 realpath cwd 的活 claude ≥2（跨 pane）→ 禁绑定
    if (sameDir >= 2) return { kind: "ambiguous", claudePid: c.pid, reason: `同目录 ${sameDir} 个活 claude` };
    const dir = join(this.projectsDir, encodeProjectDir(realCwd));
    if (!existsSync(dir)) return { kind: "none", reason: "编码目录不存在（新会话尚无转录）: " + dir };
    const jsonls = readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    const newest = jsonls[0];
    if (!newest) return { kind: "none", reason: "项目目录无 jsonl（新会话尚无转录）" };
    return { kind: "inferred", sessionId: newest.f.replace(/\.jsonl$/, ""), claudePid: c.pid };
  }

  private async scanOnce(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      let panes: Pane[];
      let ps: PsRow[];
      try {
        [panes, ps] = await Promise.all([this.listPanes(), this.psTable()]);
      } catch {
        return; // tmux server 暂时无响应等：下轮再试，保持旧快照
      }
      // 每个 realpath cwd 的活 claude 总数（ambiguous 判据）
      const cwdCount = new Map<string, number>();
      for (const p of panes) {
        const cls = claudeCandidates(p.pid, ps);
        if (cls.length === 0) continue;
        let real = p.cwd;
        try { real = realpathSync(p.cwd); } catch { /* 用原值 */ }
        cwdCount.set(real, (cwdCount.get(real) ?? 0) + cls.length);
      }

      const newByPane = new Map<string, TmuxAssociation>();
      const newBySession = new Map<string, TmuxAssociation>();
      const newByClaudePid = new Map<number, Assoc>();
      for (const pane of panes) {
        // associate 要 realpath/readdir/stat——单 pane 读盘异常不该炸掉整轮扫描（=start() 拒死）
        let a: Assoc;
        try {
          a = this.associate(pane, ps, cwdCount);
        } catch (e) {
          a = { kind: "none", reason: "关联读盘异常: " + errLine(e) };
        }
        if (a.kind !== "none") newByClaudePid.set(a.claudePid, a);
        if (a.kind === "exact" || a.kind === "inferred") {
          const t: TmuxAssociation = { paneId: pane.id, claudePid: a.claudePid, kind: a.kind, sessionId: a.sessionId };
          newByPane.set(pane.id, t);
          newBySession.set(a.sessionId, t);
        }
      }

      // appear/disappear：pane 维度 diff（关联内容变化=消失+出现）。先记账、提交快照后再
      // emit——监听方回调里调 associationFor/ownerBody 必须读到【新】状态，不能读到旧快照
      const appeared: TmuxAssociation[] = [];
      const disappeared: Array<{ paneId: string; sessionId: string; claudePid: number }> = [];
      for (const [paneId, t] of newByPane) {
        const prev = this.byPane.get(paneId);
        if (!prev || prev.sessionId !== t.sessionId || prev.kind !== t.kind || prev.claudePid !== t.claudePid) {
          if (prev) disappeared.push({ paneId, sessionId: prev.sessionId, claudePid: prev.claudePid });
          appeared.push(t);
        }
      }
      for (const [paneId, prev] of this.byPane) {
        if (!newByPane.has(paneId)) disappeared.push({ paneId, sessionId: prev.sessionId, claudePid: prev.claudePid });
      }

      this.byPane = newByPane;
      this.bySession = newBySession;
      this.byClaudePid = newByClaudePid;

      for (const d of disappeared) this.emit("disappear", d);
      for (const t of appeared) this.emit("appear", t);
    } finally {
      this.scanning = false;
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function errLine(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.split("\n")[0] ?? msg;
}
