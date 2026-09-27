/**
 * 统一占用视图（批次③ WP1，架构 §10 #49 数据底座）：「谁在持有这条会话」的单一事实源。
 *
 * 判定优先级链只此一份（桥协议帧 ownerBody 与桌面 snapshot 共用）：
 *   run 在飞          → phone(via=run)      ——手机受理的话正在跑，手机持有
 *   tmux 关联 pane    → terminal(via=tmux, 含 claudePid) ——tmux 里的活 claude（WP4；
 *                       交互 claude 也写 registry，同源条目必须识别成 terminal 而非 desktop，
 *                       否则手机会误亮「抢夺控制权」——terminal 明文不设强杀入口）
 *   registry 持有者   → desktop(via=registry, 含 PID) ——非 tmux 的电脑端窗口（IDE/裸终端）
 *   phoneHold 登记    → phone(via=hold, 含受理时刻) ——回合跑完未还回，手机仍持有
 *   全空              → free(via=none)
 * 特例：registry holder 与 tmuxAssoc 是【不同 pid】（IDE 和 tmux 各开一个同会话）→ desktop 优先。
 *
 * active-gate（转录 mtime<10s）不进这里——它只是提交闸门，不是占有（计划 Q-C 拍板）。
 */
export type OccupancyState = "free" | "desktop" | "terminal" | "phone";

export interface Occupancy {
  state: OccupancyState;
  pid?: number; // desktop=registry 持有者 PID；terminal=tmux 关联的 claudePid；phone/free 无
  via: "registry" | "tmux" | "run" | "hold" | "none";
  since?: number; // via=hold 时=受理时刻（Date.now 毫秒）
}

/** 取数面：全部回调由 watch.ts 注入，occupancy.ts 保持纯函数不碰进程/文件 */
export interface OccupancyCtx {
  /** 会话有桥的 run 在飞？（controller.hasRun） */
  hasRun: (sessionId: string) => boolean;
  /** 手机持有登记（受理置位，release/releaseDone 清除） */
  phoneHold: ReadonlyMap<string, { to: string; since: number }>;
  /** tmux pane 关联（WP4 适配器接线；WP1 期间 undefined=永不判 terminal） */
  tmuxAssoc?: (sessionId: string) => { claudePid: number } | undefined;
  /** 注册表【全部】活持有者 PID（session-registry.liveHolderPids，含存活/procStart 验证）；
   *  空数组=无。给全部而非首个：同会话桥自己影子与外部 IDE 并存时，外部 IDE 不能被影子遮住 */
  holders: (sessionId: string) => number[];
  /** 该 PID 是桥自己 spawn 的 run 子进程？（必须排除，否则手机回合被误判 desktop） */
  isOurChild: (pid: number) => boolean;
}

/** 从全部活 PID 里选第一个非桥孩子的（外部持有者）；都不是外部的→undefined */
function externalHolder(pids: number[], isOurChild: (pid: number) => boolean): number | undefined {
  return pids.find((p) => !isOurChild(p));
}

export function computeOccupancy(sessionId: string, ctx: OccupancyCtx): Occupancy {
  if (ctx.hasRun(sessionId)) return { state: "phone", via: "run" };
  const registryHolder = externalHolder(ctx.holders(sessionId), ctx.isOurChild);
  const t = ctx.tmuxAssoc?.(sessionId);
  // tmux 关联：与 registry 同源（tmux 交互 claude 自己也写注册表条目）→ terminal；
  // registry 无条目（条目滞后/版本不写）但 tmux 活着 → 同样 terminal
  if (t && (registryHolder === undefined || t.claudePid === registryHolder)) {
    return { state: "terminal", pid: t.claudePid, via: "tmux" };
  }
  if (registryHolder !== undefined) return { state: "desktop", pid: registryHolder, via: "registry" };
  const hold = ctx.phoneHold.get(sessionId);
  if (hold) return { state: "phone", via: "hold", since: hold.since };
  return { state: "free", via: "none" };
}
