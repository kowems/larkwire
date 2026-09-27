/**
 * 控模式 controller（M1 + 批次③ WP3 持续持有）：手机发一句话 → ShadowRunner 影子进程续跑。
 *
 * 进程模型（WP3，2026-09-24；S5 spike 闸门 2026-09-23 通过，tools/spikes/s5-multiturn.mts）：
 *   一次性 resume 进程升级为【持续持有】——ShadowRunner = 进程级（sessionId/cwd/child），
 *   RoundState = 回合级（clientMsgId/看门狗/权限卡/delta 记账）。result 帧后进程【不退】：
 *   回合收尾（endRound）→ idle 引信（LARKWIRE_RUNNER_IDLE_MS，默认 10min）→ 无新回合
 *   则关进程回收 + runnerIdle 事件知会 watch 发合成还回 ack。下一句话写新 user 帧进同一
 *   进程 stdin（S5 实证：多轮 stream-json 上下文连续，num_turns 每回合=1）。
 *   S5 若失败降级预案 = Runner 只作封装每回合新建（未启用，git 历史即回退路径）。
 *
 * 设计依据（S10 spike 2026-09-17，见 灵鹊-S10-spike-权限控制协议.md）：
 *   - spawn 必须带 --permission-prompt-tool stdio，stdin 第一帧 initialize（仅进程启动时
 *     一次，后续回合只写 user 帧——S5 实证不需要重新握手）；
 *   - can_use_tool 走 control_request(stdout) / control_response(stdin)；
 *   - CLI 对无人应答的权限请求【永不超时】。
 *
 * 权限口径（Eric 拍板 2026-09-21，supersede 原「120s 无人答桥自动拒绝」）：
 *   spawn 固定 --permission-mode auto（能自动允许的 CLI 自己过，过不了才弹 stdio 请示）；
 *   弹出的卡【无限期挂起等人点】——废 TTL，不超时自动拒绝。挂起的卡只随答复/回合结束撤下；
 *   卡挂起期间 run 看门狗不杀（CLI 静默等待是正常态不是卡死），重臂续期。
 *
 * 手机全离线 = 卡在授权等手机回来（Eric 拍板 2026-09-17，supersede 原「全离线立刻代拒」）：
 *   权限卡挂起不拒，看门狗时钟停摆；手机上线重投卡片，时钟重新给满窗口。
 *   「并在手机弹通知」= M3 已落地：桥广播 notify.request，中继见手机离线转 uni-push。
 *
 * 补跑防御（WP2 E2E 2026-09-24 实证形态，WP3 显性修复）：
 *   种子转录末尾若是【真人文本 user 悬空】（如电脑上 Ctrl-C 打断回合），claude --resume
 *   启动会先补跑一个内部回合（"No response requested."，完全不经 stream_event 无 delta），
 *   它的 result 帧与真回合 result 无法从单帧区分。WP2 一次性模型下补跑 result 误触
 *   endRun+5s SIGTERM 悬在真回合头上（E2E 两轮靠回合短幸存）。WP3 修复 = startRunner 时
 *   读转录尾型确定性判定 expectPreambleResult（不赌时序）：首 result 判补跑簿记不 endRound，
 *   并重置 sawAssistant（补跑的 assistant 帧不算数，否则真回合空跑兜底失效）；
 *   首个 text_delta 到达 = 真回合在跑的铁证（补跑无 delta），反证清 false 双保险。
 *
 * 双写防线（S4 实证：双写不崩但 parentUuid 分叉）：
 *   - 每会话同时只许一个我们的回合（串行，第二个直接拒）；
 *   - 转录 mtime 新鲜且不能归因于我们自己上一个回合 → 判电脑端活跃，拒收。
 *   已知残留：IDE 开着但安静时注入仍会分叉（v1 接受+App 提示，M1.5 接管纪律解）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { TranscriptWatcher } from "./watcher.js";
import { liveHolderPids, killHolder } from "./session-registry.js";
import type { TmuxRoute } from "./tmux-adapter.js";

const ACTIVE_GATE_MS = 10_000; // 转录 10s 内有写入 = 电脑端活跃
const OUR_WRITE_MARGIN_MS = 1_500; // 归因余量：回合结束后转录还有最后一次 flush
// 连续静默上限：零 stdout 帧满 10 分钟才掐（Fix G 活动感知，有帧即续命；权限卡挂起期间豁免——卡等人点不限时）。
// LARKWIRE_RUN_WATCHDOG_MS 可覆盖（运维调参/短引信测试用；缺省或非正数 = 10 分钟）
const envFuseMs = Number(process.env.LARKWIRE_RUN_WATCHDOG_MS);
const RUN_WATCHDOG_MS = Number.isFinite(envFuseMs) && envFuseMs > 0 ? envFuseMs : 10 * 60_000;
const RESULT_EXIT_GRACE_MS = 5_000; // 关 stdin 后等进程自己退，不退再 SIGTERM
// Runner 无回合闲置回收（WP3）：LARKWIRE_RUNNER_IDLE_MS 可覆盖（短引信测试用；缺省或非正数 = 10 分钟）。
// 回收 = 关 stdin 温和退场（S5 实证优雅退出）+ runnerIdle 事件 → watch 发合成还回 ack + owner 重算
const envIdleMs = Number(process.env.LARKWIRE_RUNNER_IDLE_MS);
const RUNNER_IDLE_MS = Number.isFinite(envIdleMs) && envIdleMs > 0 ? envIdleMs : 10 * 60_000;

export interface PermissionInfo {
  sessionId: string;
  requestId: string;
  tool: string;
  description?: string;
  inputSummary: string;
  inputJson: string;
  suggestions: string[];
}

interface PendingPermission {
  info: PermissionInfo;
  round: RoundState;
  rawInput: unknown;
}

/** 回合级状态（WP2 的 RunState 迁名——WP3 把「进程」与「回合」拆成两层，这里只管一回合） */
interface RoundState {
  sessionId: string;
  clientMsgId: string;
  holderTo?: string; // 受理这条话的手机 deviceId（批次③ WP1：submit 第 4 参 from）——idle 回收定向回执 / WP5 桌面本地还回定目标用
  done: boolean;
  releaseAfter?: { to: string; requestId: string }; // 温和还回预约（Eric 拍板 2026-09-20：不中断工作）——回合自然说完后由 endRound 关 Runner 并发最终回执给预约手机
  sawAssistant: boolean; // stdout 上见过 assistant 帧 = 话真送进去了（空跑兜底用）
  // delta 升舱记账（批次③ WP2，--include-partial-messages 的 stream_event 流）：
  //   currentBlockText = 当前 text block 累积器（content_block_start 开 / content_block_stop 收）；
  //   partialText      = 本回合全部 text delta 平铺累计（中途订阅补发合成 partial 用）。
  // 整块直播完即 emit runBlockDone（载荷带文本）知会 watch 记抑制集合——不另存台账
  currentBlockText: string | null;
  partialText: string;
  pending: Map<string, PendingPermission>; // requestId →
  watchdog: NodeJS.Timeout;
}

/**
 * 进程级状态（WP3 ShadowRunner 持续持有）：一个 claude -p --resume 进程的生命周期。
 * round = 在飞回合（闲=undefined）；进程在 result 后不死，idle 引信到期才回收。
 */
interface ShadowRunner {
  sessionId: string;
  cwd: string;
  child: ChildProcess;
  round?: RoundState;
  lastHolderTo?: string; // 最近回合的受理手机（idle 回收合成还回 ack 的定向目标）
  idleTimer?: NodeJS.Timeout;
  expectPreambleResult: boolean; // 启动时转录尾型判定：末尾真人 user 悬空 → CLI 会先补跑一回合（见头注「补跑防御」）
  closing: boolean; // closeRunner 已发起——exit 处理器不再报「进程提前退出」，submit 也不再往里写帧
  stdoutBuf: string; // stdout 行缓冲（进程级存续，跨回合）
}

export interface SubmitResult {
  ok: boolean;
  reason?: string;
  occupiedPid?: number; // 拒收原因是「会话被电脑端进程占用」时带上持有进程 PID（App 凭此亮「抢夺控制权」）
  via?: "tmux" | "resume"; // 受理通道（批次③ WP4）：tmux=注入终端活会话；resume=影子进程（默认，字段常省略）
}

export class SessionController extends EventEmitter {
  private watcher: TranscriptWatcher;
  private tmuxRoute?: TmuxRoute;
  private claudeBin: string;
  private runners = new Map<string, ShadowRunner>(); // sessionId → 持有的影子进程（串行闸门查 runner.round）
  private pendingById = new Map<string, PendingPermission>(); // requestId →（跨回合全局索引）
  private lastOurActivity = new Map<string, number>(); // sessionId → 我们造成的转录写入时间（回合注入 / takeover 触发的持有者退出 flush）——活跃闸门归因豁免用
  private phonesOnline = true; // 手机全离线 = false（#38 时钟停摆期间，来帧也不许重臂看门狗）
  // spawn 过的影子进程 PID（注册表 watcher 排除用——它们也会注册，不排除会把手机
  // 回合误判成「电脑端接管」）。死了也不删：桥生命周期内同一 PID 被复用且又是 claude 交互窗的
  // 概率可忽略，最坏=漏报一次接管（用户 ⚡ 兜底），删了反而有 PID 复用漏过滤风险
  private ourChildPids = new Set<number>();

  constructor(watcher: TranscriptWatcher, tmux?: TmuxRoute) {
    super();
    this.watcher = watcher;
    this.tmuxRoute = tmux;
    // 非交互环境 PATH 里常常没有 claude（S10 踩过）；HOME 也可能被改（隔离测试 HOME
    // 2026-09-27 踩过：$HOME/.local/bin/claude 不存在 → 裸 "claude" → spawn ENOENT）。
    // 优先显式配置，再依次找 HOME 安装位、PATH、其他常见安装位
    this.claudeBin = process.env.LARKWIRE_CLAUDE_BIN ?? SessionController.resolveClaudeBin();
  }

  /**
   * 定位 claude 可执行文件。顺序：$HOME/.local/bin（官方 installer 默认位）→
   * 真实家目录（userInfo().homedir 走 getpwuid；HOME 被隔离时仍是真实家目录）→
   * Homebrew/全局 npm 常见位 → PATH；都找不到回退裸 "claude"（spawn 报错信息照常）。
   */
  private static resolveClaudeBin(): string {
    const realHome = userInfo().homedir;
    const candidates: string[] = [
      join(realHome, ".local", "bin", "claude"),
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
    ];
    if (process.env.HOME && process.env.HOME !== realHome) {
      candidates.unshift(join(process.env.HOME, ".local", "bin", "claude"));
    }
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    // PATH 查找（不引第三方依赖）：逐目录试 claude
    for (const dir of (process.env.PATH ?? "").split(":")) {
      if (dir && existsSync(join(dir, "claude"))) return join(dir, "claude");
    }
    return "claude";
  }

  /** 活跃闸门检查 + 受理。tmux 注入为异步操作→整体 async；受理后影子路径异步开跑。
   *  from = 发话手机 deviceId（记入 RoundState.holderTo） */
  async submit(sessionId: string, text: string, clientMsgId: string, from?: string): Promise<SubmitResult> {
    const s = this.watcher.getSession(sessionId);
    if (!s) return { ok: false, reason: "桥这边没找到这个会话的转录（可能已被清理）" };
    const existing = this.runners.get(sessionId);
    if (existing?.round) {
      return {
        ok: false,
        reason: existing.round.releaseAfter ? "它还在工作中——已约还回，说完这回合自动交接电脑" : "上一条还在跑，等它说完再发",
      };
    }
    if (!s.cwd) return { ok: false, reason: "不知道这个会话在哪个目录，没法续跑" };

    // 占用闸门（Eric 拍板 2026-09-18 #39：拒收+明示）：会话注册表里有活进程持有 = 一次性
    // resume 的话会被队列吞掉两头不到岸（真机实证）——转录活跃度分辨不出「终端开着闲置」。
    // WP3 必排 isOurChild：持续持有的 Runner 闲时也注册在表内，不排除会把自己的影子进程
    // 误判成「电脑端终端开着」，导致 Runner 存活期间手机永远发不出话。
    // 用全部活持有者里第一个外部 PID：桥影子与外部 IDE 并存时不能被文件序在前的影子遮住
    const holder = liveHolderPids(sessionId).find((p) => !this.isOurChild(p)) ?? null;
    if (holder !== null) {
      // WP4 tmux 共驾拦截：holder 是 tmux pane 里与【本 sessionId】exact/inferred 关联的活 claude
      // → 注入终端不起 resume-spawn（双写分叉防线：tmux 活会话绝不另起影子进程）。
      // sessionId 一致性是关键安全检查：registry 条目持有 id 与 tmux argv/转录推断 id 对上才放行。
      const tmuxState = this.tmuxRoute?.stateForClaudePid(holder);
      if (tmuxState?.kind === "associated" && tmuxState.sessionId === sessionId) {
        const r = await this.tmuxRoute!.inject(sessionId, text);
        if (r.ok) return { ok: true, via: "tmux" };
        return { ok: false, reason: r.reason ?? "注入终端失败", occupiedPid: holder };
      }
      // ambiguous（同目录两个活 claude）：防注错会话，禁用注入
      if (tmuxState?.kind === "ambiguous") {
        return {
          ok: false,
          reason: "终端里有两个同目录会话，认不出哪个——先去终端关掉一个，再从手机发话",
          occupiedPid: holder,
        };
      }
      return {
        ok: false,
        reason: `这个会话正在电脑的终端里开着（PID ${holder}）——先在电脑上 /exit 或关掉那个窗口，再从手机发话`,
        occupiedPid: holder,
      };
    }

    const now = Date.now();
    const fresh = now - s.lastActiveAt < ACTIVE_GATE_MS;
    const ours = this.lastOurActivity.get(sessionId) ?? 0;
    if (fresh && s.lastActiveAt > ours + OUR_WRITE_MARGIN_MS) {
      return { ok: false, reason: "会话正在电脑上活跃——在电脑上停一停再从手机发" };
    }

    // get-or-create Runner：在册但进程已死/正在关闭 → 除名新建（exit 处理器幂等，不碍）
    let runner = existing;
    if (runner && (runner.closing || runner.child.exitCode !== null || runner.child.killed)) {
      if (this.runners.get(sessionId) === runner) this.runners.delete(sessionId);
      runner = undefined;
    }
    if (!runner) runner = this.startRunner(sessionId, s.cwd, s.path);
    this.startRound(runner, text, clientMsgId, from);
    return { ok: true };
  }

  /**
   * 手机「抢夺控制权」（M1.5，Eric 拍板 2026-09-19 #40）：杀掉电脑端持有该会话的进程，
   * 占用闸门打开后 App 自动重发被拒的话。幂等（没人占用直接 ok）；
   * 多持有者（同会话开两个终端）循环杀，上限 3 次防死循环。
   * WP3：isOurChild 排除——自己的 idle Runner 不算占用者，绝不动刀（App 时序滞后时
   * 横幅可能还亮着 💻，此时按 ⚡ 不能杀自己的影子进程）。
   */
  takeover(sessionId: string): { ok: boolean; reason?: string; killedPid?: number } {
    // killHolder 一次遍历【全部】外部持有者（跳过自己影子），遇不可杀即停——原 3 次循环已内置
    const r = killHolder(sessionId, (p) => this.isOurChild(p));
    if (!r.ok) return { ok: false, reason: r.reason };
    if ((r.pids ?? []).length > 0) {
      // SIGTERM 优雅退出会 flush 转录 → lastActiveAt 变新——记为我们造成的，否则 App
      // 紧接着的自动重发会被 fresh 活跃闸门误拦
      this.lastOurActivity.set(sessionId, Date.now());
    }
    return { ok: true, killedPid: r.pid };
  }

  /** 这个 PID 是我们 spawn 的影子进程？注册表 watcher/occupiedBy 复查必须排除 */
  isOurChild(pid: number): boolean {
    return this.ourChildPids.has(pid);
  }

  /** 这个会话有我们的回合在飞？（批次③ WP1：occupancy 判定取数面——release 内部同款判法外提） */
  hasRun(sessionId: string): boolean {
    return this.runners.get(sessionId)?.round !== undefined;
  }

  /** delta 升舱中途订阅补发（批次③ WP2）：回合在飞时给出已直播文本的平铺累计——
   *  watch 在 snapshot 后补发一条合成 partial delta，订阅者开新泡，后续 token delta 自然并入 */
  runSnapshot(sessionId: string): { partialText: string } | null {
    const round = this.runners.get(sessionId)?.round;
    if (!round || round.done) return null;
    return { partialText: round.partialText };
  }

  /**
   * 手机「还回电脑」（方案 A，Eric 拍板 2026-09-19；2026-09-20 修订为温和还回）：
   * 不中断正在进行的工作——人回电脑是为了继续干活，把干到一半的活掐了再换地方没意义。
   * 回合在跑 = 预约（scheduled）：回合自然说完、完整落盘，Runner 温和退场 = 控制权天然回电脑，
   * 全程零杀进程零固化竞争；回合说完由 endRound 发最终回执（同 requestId 的第二段 ack）。
   * Runner 闲着（WP3 持续持有）：立即关 Runner 温和退场，单段 ack 即完结。
   * Runner 不存在 = 纯交接，幂等 ok（interruptedRun=false）。
   * 重复预约（双手机/超时重按）：后到者覆盖——最终回执发给最后按的那台。
   */
  release(
    sessionId: string,
    from: string,
    requestId: string,
  ): { ok: boolean; reason?: string; interruptedRun?: boolean; scheduled?: boolean } {
    const runner = this.runners.get(sessionId);
    if (!runner) return { ok: true, interruptedRun: false };
    if (runner.round) {
      runner.round.releaseAfter = { to: from, requestId };
      return { ok: true, scheduled: true, reason: "它还在工作中——说完这回合自动还回电脑" };
    }
    // Runner 闲（WP3）：占用着进程不放也是资源——温和退场（S5 实证 stdin.end 后优雅退出）。
    // releaseDone 第二段只属 scheduled 路径；这里单段 ack 即完结，owner 广播走 watch 重算
    this.closeRunner(runner, "手机还回（Runner 闲置）");
    return { ok: true, interruptedRun: false };
  }

  /**
   * 电脑端窗口打开了（方案 B：注册表 watcher 探测到新持有者）。
   * Eric 拍板 2026-09-20 温和交接：不杀进行中的手机回合——正在做的工作让它做完，
   * 回合说完进程自然退场，控制权完整归电脑（owner=desktop 推送照旧，是事实陈述：
   * 人已经坐下了）。返回是否有在跑的手机回合（watcher 决定 owner 推送的 note 文案）。
   *
   * WP3 补漏（2026-09-26 用例④真机钓出）：回合已跑完但 Runner 持续挂着持有时，人一坐下
   * 必须立即关 Runner 让位——否则它与新 IDE 持有者并存，occupancy 的 occupiedBy 按文件序
   * 可能先撞到我们自己的 Runner（被 isOurChild 排除），桌面快照漏判 desktop、横幅卡在手机态。
   */
  onDesktopHolderAppeared(sessionId: string, _pid: number): boolean {
    if (this.hasRun(sessionId)) return true;
    const runner = this.runners.get(sessionId);
    if (runner && !runner.closing) this.closeRunner(runner, "电脑端开窗（Runner 闲置让位）");
    return false;
  }

  /** 手机回了权限卡：写 control_response 进子进程 stdin */
  respond(requestId: string, behavior: "allow" | "deny", message?: string): boolean {
    const p = this.pendingById.get(requestId);
    if (!p) return false; // 已了结/已撤——App 那边靠 permission.resolve 清卡
    this.answerControl(p, behavior, message);
    this.clearPending(p);
    return true;
  }

  /** 手机全离线（Eric 拍板 2026-09-17：不代拒，卡在授权等手机回来）：看门狗时钟停摆 */
  onAllPhonesOffline(): void {
    for (const runner of this.runners.values()) {
      if (runner.round) clearTimeout(runner.round.watchdog);
    }
    this.phonesOnline = false;
  }

  /** 手机回来了：挂起的卡重投 + 看门狗重新给满窗口（人刚坐下，别拿残余时间催） */
  onPhoneOnline(): void {
    this.phonesOnline = true;
    for (const runner of this.runners.values()) {
      if (runner.round) this.armWatchdog(runner.round);
    }
    for (const p of [...this.pendingById.values()]) {
      this.emit("permissionReplay", p.info);
    }
  }

  /** 挂起中的权限卡数量（watch 打日志用） */
  pendingCount(): number {
    return this.pendingById.size;
  }

  /** 全部挂起中的权限卡（permission.list 拉取重投用——M3 缝隙补漏，App 按 requestId 去重） */
  pendingList(): PermissionInfo[] {
    return [...this.pendingById.values()].map((p) => p.info);
  }

  /** 桥退出前清理：杀掉所有持有的影子进程 */
  shutdown(): void {
    for (const runner of this.runners.values()) this.closeRunner(runner, "桥进程退出", true);
  }

  // ---------- 内部：Runner（进程级） ----------

  /** 起影子进程 + initialize 握手（S10 实证必须首帧）。转录尾型判定补跑预期（见头注） */
  private startRunner(sessionId: string, cwd: string, transcriptPath: string): ShadowRunner {
    const child = spawn(
      this.claudeBin,
      [
        "-p",
        "--resume", sessionId,
        "--input-format=stream-json",
        "--output-format=stream-json",
        "--verbose",
        // delta 升舱（批次③ WP2）：stdout 多出 stream_event 帧（Anthropic SSE 包装），
        // text_delta 实时直达手机=打字机。只对 --print+stream-json 生效（2.1.201 实证有此 flag）
        "--include-partial-messages",
        "--permission-mode", "auto", // 手机遥控固定 auto（Eric 拍板 2026-09-21）：能自动过的 CLI 自己过，过不了才弹 stdio 请示
        "--permission-prompt-tool", "stdio",
      ],
      { cwd, stdio: ["pipe", "pipe", "inherit"] }, // stderr 直通桥日志
    );
    if (child.pid !== undefined) this.ourChildPids.add(child.pid);

    const runner: ShadowRunner = {
      sessionId,
      cwd,
      child,
      expectPreambleResult: this.detectPreambleResume(transcriptPath),
      closing: false,
      stdoutBuf: "",
    };
    this.runners.set(sessionId, runner);
    this.lastOurActivity.set(sessionId, Date.now()); // 补跑会写转录——归因我们，免活跃闸门误拦紧接着的回合

    child.stdout!.on("data", (chunk: Buffer) => {
      runner.stdoutBuf += chunk.toString();
      let i;
      while ((i = runner.stdoutBuf.indexOf("\n")) >= 0) {
        const line = runner.stdoutBuf.slice(0, i).trim();
        runner.stdoutBuf = runner.stdoutBuf.slice(i + 1);
        if (line) this.handleFrame(runner, line);
      }
    });

    child.on("error", (err) => {
      const round = runner.round;
      if (round && !round.done) {
        round.done = true;
        this.emit("runFail", { sessionId, clientMsgId: round.clientMsgId, reason: `起进程失败：${err.message}` });
        this.endRound(round, "spawn error");
      }
      if (this.runners.get(sessionId) === runner) this.runners.delete(sessionId);
    });
    child.on("exit", (code, sig) => {
      const round = runner.round;
      // closing = 我们主动关的（还回/idle 回收/shutdown/看门狗）——不是「提前退出」
      if (round && !round.done && !runner.closing) {
        round.done = true;
        this.emit("runFail", {
          sessionId,
          clientMsgId: round.clientMsgId,
          reason: `进程提前退出（code=${code} sig=${sig}），没看到结果帧`,
        });
        this.endRound(round, `exit code=${code}`);
      }
      if (this.runners.get(sessionId) === runner) this.runners.delete(sessionId);
    });

    // initialize 只在进程启动时握一次（S5 实证：后续回合只写 user 帧，不需要重新握手）
    this.writeFrame(runner, {
      type: "control_request",
      request_id: `lw-init-${Date.now()}`,
      request: { subtype: "initialize" },
    });
    return runner;
  }

  /**
   * 补跑预期判定（WP3，见头注「补跑防御」）：读转录尾 32KB，从后往前找第一条
   * 「真人消息」——是 user 文本 = 悬空（CLI 启动会补跑）；是 assistant = 干净。
   * 工具结果（tool_result）行不算真人悬空，跳过继续往前扫；meta/sidechain 行跳过。
   * 读不到/扫不到 = 判无补跑（宁 false 不乱 true：false 失效只退化 WP2 形态，
   * 乱 true + CLI 实际不补跑会把真 result 吞成补跑，回合挂到看门狗）。
   */
  private detectPreambleResume(transcriptPath: string): boolean {
    try {
      const size = statSync(transcriptPath).size;
      const fd = openSync(transcriptPath, "r");
      try {
        const tailSize = Math.min(size, 32 * 1024);
        const buf = Buffer.alloc(tailSize);
        readSync(fd, buf, 0, tailSize, size - tailSize);
        const lines = buf.toString("utf8").split("\n").filter(Boolean);
        for (let i = lines.length - 1; i >= 0 && i > lines.length - 60; i--) {
          const tailLine = lines[i];
          if (!tailLine) continue;
          let j: { type?: string; isMeta?: boolean; isSidechain?: boolean; message?: { content?: unknown } };
          try {
            j = JSON.parse(tailLine);
          } catch {
            continue; // 尾部半行（正在写入），跳过
          }
          if (j.type === "assistant") return false;
          if (j.type !== "user" || j.isMeta || j.isSidechain) continue;
          const c = j.message?.content;
          if (typeof c === "string") return true; // 真人文本悬空
          if (Array.isArray(c) && c.some((b) => (b as { type?: string })?.type === "text")) return true;
          // 工具结果型 user 行：不是真人悬空，继续往前扫
        }
      } finally {
        closeSync(fd);
      }
    } catch { /* 转录读不到 = 判无补跑 */ }
    return false;
  }

  /** 关影子进程（幂等）：温和 = 关 stdin 等自己退（S5 实证优雅），5s 不退 SIGTERM；immediate = 立即 SIGTERM */
  private closeRunner(runner: ShadowRunner, _why: string, immediate = false): void {
    if (runner.idleTimer) {
      clearTimeout(runner.idleTimer);
      runner.idleTimer = undefined;
    }
    if (runner.closing) return;
    runner.closing = true;
    try {
      if (immediate) {
        if (!runner.child.killed) runner.child.kill("SIGTERM");
      } else {
        // 判空非断言：closing 途中 stdin 可能已被对端销毁，静默跳过贴幂等语义
        if (runner.child.stdin) runner.child.stdin.end();
        setTimeout(() => {
          if (!runner.child.killed) runner.child.kill("SIGTERM");
        }, RESULT_EXIT_GRACE_MS);
      }
    } catch { /* 已退出 */ }
  }

  /** Runner 无回合闲置回收引信：到期仍闲 → 温和关进程 + runnerIdle（watch 发合成还回 ack + owner 重算） */
  private armIdleRecycle(runner: ShadowRunner): void {
    if (runner.idleTimer) clearTimeout(runner.idleTimer);
    runner.idleTimer = setTimeout(() => {
      runner.idleTimer = undefined;
      if (this.runners.get(runner.sessionId) !== runner || runner.round || runner.closing) return;
      this.closeRunner(runner, "idle 回收");
      this.emit("runnerIdle", { sessionId: runner.sessionId, holderTo: runner.lastHolderTo });
    }, RUNNER_IDLE_MS);
  }

  // ---------- 内部：Round（回合级） ----------

  /** 开回合：建 RoundState + 臂看门狗 + 写 user 帧（Runner 闲时由 submit 调用） */
  private startRound(runner: ShadowRunner, text: string, clientMsgId: string, holderTo?: string): void {
    if (runner.idleTimer) {
      clearTimeout(runner.idleTimer);
      runner.idleTimer = undefined;
    }
    const round: RoundState = {
      sessionId: runner.sessionId,
      clientMsgId,
      holderTo,
      done: false,
      sawAssistant: false,
      currentBlockText: null,
      partialText: "",
      pending: new Map(),
      watchdog: null as unknown as NodeJS.Timeout, // 马上由 armWatchdog 装填
    };
    this.armWatchdog(round);
    runner.round = round;
    if (holderTo) runner.lastHolderTo = holderTo;
    this.lastOurActivity.set(runner.sessionId, Date.now());
    this.writeFrame(runner, {
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
    });
  }

  private handleFrame(runner: ShadowRunner, line: string): void {
    let msg: {
      type?: string;
      subtype?: string;
      request_id?: string;
      request?: { subtype?: string; tool_name?: string; input?: unknown; description?: string; permission_suggestions?: unknown[] };
      is_error?: boolean;
      // stream_event（--include-partial-messages）：event = Anthropic SSE 原始事件
      event?: {
        type?: string;
        content_block?: { type?: string };
        delta?: { type?: string; text?: string };
      };
    };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // 非 JSON 行（警告之类），忽略
    }

    const round = runner.round;
    // Fix G 活动感知看门狗（Eric 拍板 2026-09-19）：任何一帧都是活着的证据，引信重置——
    // 连环读文件/写码的健康长回合随便跑。真机实证误杀：13:53 受理的健康回合跑满固定 10
    // 分钟被掐死在半路。手机全离线时不重臂：#38 时钟停摆纪律优先（离线期间帧照来，但 fuse 保持清除态）
    // D-1 修复（2026-09-22 真机实证三连）：已 done 的回合迟到 stdout 帧不许重臂——result 帧臂的表
    // 已被 endRound 撤掉，迟到帧再臂就成孤儿引信，10 分钟后对已死回合空放一枪（假 runFail 广播）
    if (round && !round.done && this.phonesOnline) this.armWatchdog(round);

    if (msg.type === "control_request" && msg.request?.subtype === "can_use_tool") {
      if (round && !round.done) {
        this.onCanUseTool(round, msg.request_id!, msg.request);
      } else {
        // 无回合在飞时来权限请求（未知形态——补跑是纯文本不调工具）：直接拒，不建幽灵卡
        this.writeFrame(runner, {
          type: "control_response",
          response: { request_id: msg.request_id, response: { behavior: "deny", message: "桥侧无在飞回合，无法请示手机" } },
        });
      }
      return;
    }
    if (msg.type === "result") {
      // 补跑防御（头注）：启动时判定有补跑预期 → 首个 result 是补跑回合的，簿记不 endRound，
      // 并重置 sawAssistant（补跑的 assistant 帧不算数，否则真回合空跑兜底失效）
      if (runner.expectPreambleResult) {
        runner.expectPreambleResult = false;
        if (round) round.sawAssistant = false;
        this.lastOurActivity.set(runner.sessionId, Date.now()); // 补跑写转录归因我们
        return;
      }
      if (!round || round.done) return; // 迟到 result（D-1 纪律：不重臂不误报）
      round.done = true;
      this.lastOurActivity.set(runner.sessionId, Date.now());
      // 空跑兜底：result 到了但一个 assistant 帧都没见过 = 话根本没送进去
      // （2026-09-18 真机实证：会话被别的活进程占用时子进程 2s 交 result 退场，零产出零
      // 报错，手机干等）。占用闸门是主防线，这是未知漏网形态的兜底——同样复用迟到回执
      if (!round.sawAssistant) {
        this.emit("runFail", {
          sessionId: round.sessionId,
          clientMsgId: round.clientMsgId,
          reason: "子进程空跑——没产生任何回复，话没送进去。这个会话可能被别的程序占着，或电脑端环境有问题",
        });
      }
      // delta 升舱收尾（批次③ WP2）：
      // ① 残余累积器兜底知会（content_block_stop 未至的形态）——已直播的每块都必须
      //    runBlockDone 入账，否则转录回显抑制集合缺项 = 那块文本双渲染
      if (round.currentBlockText !== null && round.currentBlockText !== "") {
        this.emit("runBlockDone", { sessionId: round.sessionId, text: round.currentBlockText });
      }
      round.currentBlockText = null;
      // ② 非空跑才合成 turnEnd 清手机忙碌（空跑=话没送进去，runFail 已发，别画收工）。
      //    转录末行的 turnEnd 事件会被内容匹配抑制掉，手机 busy 全靠这条收场
      if (round.sawAssistant) {
        this.emit("runDelta", { sessionId: round.sessionId, text: "", turnEnd: true });
      }
      // WP3 持续持有：回合收尾但进程【不退】——不关 stdin 不杀，idle 引信接管；
      // 有还回预约的例外：回合说完=交接完成，温和关 Runner（releaseDone 第二段在 endRound 发）
      this.endRound(round, "result");
      return;
    }
    // delta 升舱（批次③ WP2）：stream_event = Anthropic SSE 流。逐 text-block 记账——
    // start 开累积器 → text_delta 追加 + 实时 emit runDelta（打字机）→ stop 整块记块并知会
    // watch（runBlockDone → 转录回显抑制集合）。input_json_delta（工具入参）/thinking_delta
    // 不走这条道——工具卡/thinking 仍靠转录（已接受瑕疵：run 期间它们不直播，回合末才到）
    if (msg.type === "stream_event") {
      const ev = msg.event;
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && runner.expectPreambleResult) {
        // 真回合在跑的铁证（补跑完全不经 stream_event，WP2 E2E 实证 Δ片=0）——反证清预期，
        // 防尾型误判（乱 true）时把真 result 吞成补跑
        runner.expectPreambleResult = false;
      }
      if (!round || round.done) return; // 无回合（迟到帧/补跑期）：不记账不广播
      if (ev?.type === "content_block_start" && ev.content_block?.type === "text") {
        round.currentBlockText = "";
      } else if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
        round.currentBlockText = (round.currentBlockText ?? "") + ev.delta.text; // 未见 start 也容错记账
        round.partialText += ev.delta.text;
        this.emit("runDelta", { sessionId: round.sessionId, text: ev.delta.text });
      } else if (ev?.type === "content_block_stop" && round.currentBlockText !== null) {
        if (round.currentBlockText !== "") {
          this.emit("runBlockDone", { sessionId: round.sessionId, text: round.currentBlockText });
        }
        round.currentBlockText = null;
      }
      return;
    }
    if (msg.type === "assistant" && round) round.sawAssistant = true;
    // control_response（initialize 回执）/ system / user：数据面由 watcher 管，这里不碰
  }

  private onCanUseTool(
    round: RoundState,
    requestId: string,
    req: { tool_name?: string; input?: unknown; description?: string; permission_suggestions?: unknown[] },
  ): void {
    const info: PermissionInfo = {
      sessionId: round.sessionId,
      requestId,
      tool: req.tool_name ?? "?",
      description: req.description,
      inputSummary: summarizeInput(req.tool_name ?? "", req.input, 500),
      inputJson: JSON.stringify(req.input ?? null, null, 2).slice(0, 2000),
      suggestions: summarizeSuggestions(req.permission_suggestions),
    };
    const pending: PendingPermission = { info, round, rawInput: req.input ?? {} };
    round.pending.set(requestId, pending);
    this.pendingById.set(requestId, pending);
    this.emit("permission", info);
  }

  /** 装填/重计时回合看门狗：活动感知——有帧即续命，连续静默 10 分钟才掐。已 done 的回合永不装填（D-1） */
  private armWatchdog(round: RoundState): void {
    if (round.done) return;
    clearTimeout(round.watchdog);
    round.watchdog = setTimeout(() => {
      const runner = this.runners.get(round.sessionId);
      // 孤儿引信自毁（D-1 双保险）：回合已结束（Runner 除名/回合已换）或已 done——静默退场，不误报不误杀
      if (round.done || runner?.round !== round) return;
      // 权限卡挂起期间不杀（Eric 拍板 2026-09-21：卡无限期等人点，CLI 静默等待是正常态
      // 不是卡死）——重臂续期；答复后输出恢复，活动感知回归正常
      if (round.pending.size > 0) {
        this.armWatchdog(round);
        return;
      }
      // 先置 done 再收尾：SIGTERM 会触发 exit 处理器，它查 !round.done 会再报一次
      // 「进程提前退出 code=143」——同一回合双重 runFail（2026-09-19 12:18 桥日志实证）
      round.done = true;
      // 静默时长智能格式化（WP3 case 5 钓出）：<60s 显秒防「连续 0 分钟」鬼话，≥60s 显分钟
      const silentFor = RUN_WATCHDOG_MS < 60_000 ? `${Math.round(RUN_WATCHDOG_MS / 1000)} 秒` : `${Math.round(RUN_WATCHDOG_MS / 60_000)} 分钟`;
      this.emit("runFail", { sessionId: round.sessionId, clientMsgId: round.clientMsgId, reason: `连续 ${silentFor}没有任何输出，判定卡死已掐断` });
      if (runner) this.closeRunner(runner, "看门狗静默超时", true); // runner 必在（上行 round 比对已排 undefined），防御式判空
      this.endRound(round, "看门狗静默超时");
    }, RUN_WATCHDOG_MS);
  }

  private answerControl(p: PendingPermission, behavior: "allow" | "deny", message?: string): void {
    const response =
      behavior === "allow"
        ? { behavior: "allow", updatedInput: p.rawInput }
        : { behavior: "deny", message: message ?? "用户在手机上拒绝了" };
    const runner = this.runners.get(p.round.sessionId);
    if (runner) {
      this.writeFrame(runner, {
        type: "control_response",
        response: { request_id: p.info.requestId, response },
      });
    }
  }

  private clearPending(p: PendingPermission): void {
    p.round.pending.delete(p.info.requestId);
    this.pendingById.delete(p.info.requestId);
  }

  /**
   * 回合收尾（幂等）：停看门狗、撤未决权限、回合离档、runEnd；有温和还回预约的
   * 关 Runner + 补发最终回执（回合说完=交接完成），无预约的起 idle 回收引信（WP3）。
   * 进程级关闭不在这里——closeRunner 专管。
   */
  private endRound(round: RoundState, why: string): void {
    const runner = this.runners.get(round.sessionId);
    if (runner?.round !== round) return;
    runner.round = undefined;
    clearTimeout(round.watchdog);
    // 未决权限全部撤销并告知手机
    for (const p of [...round.pending.values()]) {
      this.answerControl(p, "deny", "回合已结束");
      this.emit("permissionResolve", {
        sessionId: round.sessionId,
        requestId: p.info.requestId,
        outcome: "cancelled",
        note: why,
      });
      this.clearPending(p);
    }
    this.lastOurActivity.set(round.sessionId, Date.now());
    this.emit("runEnd", { sessionId: round.sessionId, why });
    // 温和还回的第二段 ack：回合自然说完（或异常收场）= Runner 退场 = 控制权天然回电脑。
    // 自然 result 路径转录已完整落盘——手机收到这个回执时 Mac resume 必能看到完整回合
    if (round.releaseAfter) {
      this.closeRunner(runner, "还回交接");
      this.emit("releaseDone", { sessionId: round.sessionId, ...round.releaseAfter, why });
    } else if (!runner.closing) {
      this.armIdleRecycle(runner);
    }
  }

  private writeFrame(runner: ShadowRunner, frame: unknown): void {
    try {
      runner.child.stdin!.write(JSON.stringify(frame) + "\n");
    } catch { /* 进程已死，exit 处理器会收尾 */ }
  }
}

// ---------- 展示用摘要 ----------

function summarizeInput(tool: string, input: unknown, max: number): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (tool === "Bash" && typeof o.command === "string") return truncate(o.command, max);
    if ((tool === "Write" || tool === "Edit" || tool === "Read") && typeof o.file_path === "string")
      return truncate(o.file_path, max);
    if (tool === "WebFetch" && typeof o.url === "string") return truncate(o.url, max);
  }
  return truncate(JSON.stringify(input ?? ""), max);
}

function summarizeSuggestions(suggestions: unknown[] | undefined): string[] {
  if (!Array.isArray(suggestions)) return [];
  const out: string[] = [];
  for (const s of suggestions.slice(0, 3)) {
    const sug = s as { type?: string; rules?: { toolName?: string; ruleContent?: string }[]; behavior?: string };
    if (sug.type === "addRules" && Array.isArray(sug.rules)) {
      for (const r of sug.rules.slice(0, 2)) {
        out.push(`规则：${r.toolName ?? "?"}(${truncate(r.ruleContent ?? "*", 60)})`);
      }
    }
  }
  return out;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
