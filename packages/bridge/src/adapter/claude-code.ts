/**
 * claude-code 转录适配器：~/.claude/projects/**\/*.jsonl 行 → UiEvent。
 *
 * 格式漂移防线（PRD §8 风险表 ★★ 行）：
 *   - 解析宽容：字段缺失/形状变异不抛异常，尽力翻译
 *   - 已知噪声类型静默跳过；未知类型 → raw 事件透传（只带类型名不带内容）
 *   - fixture 测试：S4 合成会话 21f74fc3 转录作回归 baseline
 */
import type { UiEvent, ToolRenderData, ToolTodoItem, TodoStatus } from "@larkwire/protocol";

/** 已知且无 UI 价值的条目类型——静默跳过 */
const NOISE_TYPES = new Set([
  "last-prompt",
  "file-history-snapshot",
  "file-history-delta",
  "queue-operation",
  "attachment",
  "hook_success",
  "progress",
  "user-prompt-submitted-hook",
  // mode=CC 每回合落的权限模式记录行（normal/acceptEdits/plan）——无变化时纯噪音，
  // 有变化在手机上也不可操作。2026-09-19 真机实证：175 条全 normal，App 渲染成「未知条目 mode」
  "mode",
]);

/** system 行里已知无 UI 价值的 subtype（无 content，只剩 `[subtype]` 裸壳噪音）——静默跳过。
 *  2026-09-19 真机实证：stop_hook_summary 每回合刷数条黄字，纯噪声。
 *  api_error 同属无 content 裸壳但含错误信号，暂留（改造或过滤待拍板） */
const NOISE_SYSTEM_SUBTYPES = new Set(["stop_hook_summary"]);

export interface TranscriptLine {
  type?: string;
  subtype?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  isSidechain?: boolean;
  message?: {
    role?: string;
    content?: unknown;
    stop_reason?: unknown; // assistant 行的回合状态："tool_use"=还要继续干活，其他非空值=回合终点
  };
  summary?: string;
  title?: string;
  aiTitle?: string; // ai-title 行的真实字段名（2026-09-20 Eric 真机转录实证：{"type":"ai-title","aiTitle":"…"}）
  content?: unknown;
  [k: string]: unknown;
}

/** 协议口径：所有时间字段一律毫秒 epoch（JS Date 惯例，App 直接 new Date(ts)） */
function toTs(iso?: string): number {
  if (!iso) return Date.now();
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Date.now() : t;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object" && "text" in b && typeof (b as { text?: unknown }).text === "string") {
          return (b as { text: string }).text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function toolSummary(name: string, input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    const pick =
      o.command ?? o.file_path ?? o.pattern ?? o.url ?? o.query ?? o.description ?? o.prompt ?? o.skill;
    if (typeof pick === "string") return truncate(pick, 200);
    try {
      return truncate(JSON.stringify(input), 200);
    } catch {
      return "";
    }
  }
  return "";
}

// ---------- tool_use 结构化渲染分派（2026-09，仅 TodoWrite/Bash/Edit） ----------
// 受 64KB 信封硬约束，adapter 是唯一裁剪者：按 UTF-8 字节（中文 3B/字，不能按字符数）
// 与行数双闸裁剪，截断处统一尾标。常量正常时单事件 JSON 恒 ≤ ~20KB。
const MAX_TOOL_EVENT_BYTES = 32 * 1024; // 单 tool_use 事件序列化硬闸（防御兜底）
const EDIT_SIDE_BYTES = 8 * 1024; // Edit old/new 各侧字节预算（两侧合计 16KB）
const EDIT_SIDE_LINES = 200;
const BASH_CMD_BYTES = 2 * 1020;
const BASH_CMD_LINES = 30;
const TODO_ITEM_CHARS = 200;
const TODO_ITEMS_MAX = 50;
const CLIP_MARK = "…（已截断，完整内容见电脑端）";

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** 行数硬闸 */
function clipLines(s: string, maxLines: number): { text: string; clipped: boolean } {
  const lines = s.split("\n");
  return lines.length <= maxLines ? { text: s, clipped: false } : { text: lines.slice(0, maxLines).join("\n"), clipped: true };
}

/** UTF-8 字节预算收敛（按行累加，不劈开多字节字符） */
function clipBytes(s: string, maxBytes: number): { text: string; clipped: boolean } {
  if (utf8Bytes(s) <= maxBytes) return { text: s, clipped: false };
  const kept: string[] = [];
  let used = 0;
  for (const ln of s.split("\n")) {
    const add = (kept.length ? 1 : 0) + utf8Bytes(ln);
    if (used + add > maxBytes) break;
    used += add;
    kept.push(ln);
  }
  return { text: kept.join("\n"), clipped: true };
}

/** 一行/字节双闸裁剪，任一触发即挂尾标 */
function clipSide(s: string, maxLines: number, maxBytes: number): string {
  const byLines = clipLines(s, maxLines);
  const byBytes = clipBytes(byLines.text, maxBytes);
  return byLines.clipped || byBytes.clipped ? byBytes.text + CLIP_MARK : byBytes.text;
}

function baseName(p: string): string {
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

/** TodoWrite 宽容规整：todos 非数组→undefined（走老 summary 路径）；不识别的 status
 *  一律归 pending 但不丢条目；非对象元素跳过。content 按字符裁短 */
function normalizeTodos(input: unknown): { todos: ToolTodoItem[]; done: number; total: number } | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = (input as Record<string, unknown>).todos;
  if (!Array.isArray(raw)) return undefined;
  const todos: ToolTodoItem[] = [];
  let done = 0;
  for (const el of raw) {
    if (!el || typeof el !== "object") continue;
    const r = el as Record<string, unknown>;
    let content: string;
    if (typeof r.content === "string") content = r.content;
    else {
      try {
        content = String(r.content);
      } catch {
        continue;
      }
    }
    if (!content) continue;
    const status: TodoStatus =
      r.status === "completed" || r.status === "in_progress" || r.status === "pending" ? r.status : "pending";
    const item: ToolTodoItem = { content: truncate(content, TODO_ITEM_CHARS), status };
    if (typeof r.activeForm === "string" && r.activeForm) item.activeForm = r.activeForm;
    todos.push(item);
    if (status === "completed") done++;
  }
  return { todos, done, total: todos.length };
}

/** 头行意图标题；未特化工具返回 undefined（App 回退 name(summary) 老形态） */
function toolTitle(name: string, o: Record<string, unknown>): string | undefined {
  if (name === "Bash") {
    if (typeof o.description === "string" && o.description.trim()) return o.description.trim();
    if (typeof o.command === "string" && o.command) return truncate(o.command, 80);
    return undefined;
  }
  if (name === "Edit") {
    if (typeof o.file_path === "string" && o.file_path) return baseName(o.file_path) || truncate(o.file_path, 80);
    return undefined;
  }
  if (name === "TodoWrite") {
    const n = normalizeTodos(o);
    if (!n || n.total === 0) return undefined;
    return `待办 ${n.done} / ${n.total}`;
  }
  return undefined;
}

/** 结构化渲染数据；仅三类工具产出，其余/形态异常返回 undefined */
function toolData(name: string, input: unknown): ToolRenderData | undefined {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  if (name === "Bash") {
    if (typeof o.command !== "string" || !o.command) return undefined;
    const d: ToolRenderData = { tool: "Bash", command: clipSide(o.command, BASH_CMD_LINES, BASH_CMD_BYTES) };
    if (typeof o.description === "string" && o.description.trim()) d.description = o.description.trim();
    return d;
  }
  if (name === "Edit") {
    if (typeof o.file_path !== "string" || !o.file_path) return undefined;
    // 空串是合法值（纯增/纯删），必须严格保留；字段缺失才是形态异常
    if (typeof o.old_string !== "string" || typeof o.new_string !== "string") return undefined;
    if (o.old_string === "" && o.new_string === "") return undefined;
    return {
      tool: "Edit",
      file: o.file_path,
      replaceAll: o.replace_all === true,
      oldText: o.old_string === "" ? "" : clipSide(o.old_string, EDIT_SIDE_LINES, EDIT_SIDE_BYTES),
      newText: o.new_string === "" ? "" : clipSide(o.new_string, EDIT_SIDE_LINES, EDIT_SIDE_BYTES),
    };
  }
  if (name === "TodoWrite") {
    const n = normalizeTodos(o);
    if (!n) return undefined;
    // 数组超 50 项只发前 50；done/total 按全量真实计数（标题不撒谎）
    const todos = n.todos.length > TODO_ITEMS_MAX ? n.todos.slice(0, TODO_ITEMS_MAX) : n.todos;
    return { tool: "TodoWrite", todos, done: n.done, total: n.total };
  }
  return undefined;
}

/** 单行转录 → 0..n 个 UiEvent */
export function translateLine(line: TranscriptLine): UiEvent[] {
  const ts = toTs(line.timestamp);
  const type = line.type ?? "unknown";

  if (NOISE_TYPES.has(type)) return [];

  if (type === "user") {
    const content = line.message?.content;
    // tool_result 也以 user 行落盘
    if (Array.isArray(content)) {
      const out: UiEvent[] = [];
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type === "tool_result") {
          const text = truncate(contentToText(b.content), 500);
          out.push({ kind: "tool_result", ts, text, isError: b.is_error === true });
        } else if (b.type === "text" && typeof b.text === "string") {
          out.push({ kind: "user", ts, text: b.text });
        }
      }
      return out;
    }
    const text = contentToText(content);
    // 本地命令类噪声（<command-name> 等）不推送
    if (!text || text.startsWith("<")) return [];
    return [{ kind: "user", ts, text }];
  }

  if (type === "assistant") {
    const content = line.message?.content;
    if (!Array.isArray(content)) return [];
    // 回合终点判定：stop_reason 存在且非 "tool_use" = 这条 assistant 说完整个回合就结束了
    // （"tool_use"=马上调工具继续干活；null/缺省=还在流式写入）。App 用它停忙碌指示器。
    const stopReason = line.message?.stop_reason;
    const turnEnd = typeof stopReason === "string" && stopReason !== "tool_use";
    const out: UiEvent[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "thinking" && typeof b.thinking === "string") {
        out.push({ kind: "thinking", ts, text: truncate(b.thinking, 500) });
      } else if (b.type === "text" && typeof b.text === "string") {
        out.push({ kind: "assistant", ts, text: b.text, ...(turnEnd ? { turnEnd: true } : {}) });
      } else if (b.type === "tool_use" && typeof b.name === "string") {
        const ev: UiEvent = { kind: "tool_use", ts, name: b.name, summary: toolSummary(b.name, b.input) };
        // title/data 仅 TodoWrite/Bash/Edit 三类产出；undefined 时不挂键（老形态字节级不变）
        const o = b.input && typeof b.input === "object" ? (b.input as Record<string, unknown>) : undefined;
        if (o) {
          const title = toolTitle(b.name, o);
          if (title) ev.title = title;
        }
        const data = toolData(b.name, b.input);
        if (data) ev.data = data;
        // 防御兜底：仍超 32KB（异常巨型事件）则剥掉 data，保 name/summary 不被中继 DROP
        if (utf8Bytes(JSON.stringify(ev)) > MAX_TOOL_EVENT_BYTES) {
          delete ev.data;
          if (ev.title && utf8Bytes(JSON.stringify(ev)) > MAX_TOOL_EVENT_BYTES) delete ev.title;
        }
        out.push(ev);
      }
    }
    return out;
  }

  if (type === "system") {
    if (typeof line.subtype === "string" && NOISE_SYSTEM_SUBTYPES.has(line.subtype)) return [];
    const text =
      typeof line.content === "string"
        ? line.content
        : typeof line.subtype === "string"
          ? `[${line.subtype}]`
          : "";
    if (!text) return [];
    return [{ kind: "system", ts, text: truncate(text, 300) }];
  }

  if (type === "summary") {
    if (typeof line.summary !== "string" || !line.summary) return [];
    return [{ kind: "title", ts, text: line.summary }];
  }

  if (type === "ai-title") {
    // 真机字段名=aiTitle（2026-09-20 实证，见 TranscriptLine.aiTitle 注释）；title/content 是早期猜测口径，留作宽容兜底
    const t = line.aiTitle ?? line.title ?? (typeof line.content === "string" ? line.content : undefined);
    if (typeof t !== "string" || !t) return [];
    return [{ kind: "title", ts, text: t }];
  }

  // 未知类型宽容透传：只带类型名，内容不出桥
  return [{ kind: "raw", ts, jsonType: type }];
}

/** 从行里提取会话元信息（注册用）。cwd 在 user/assistant 行上。 */
export function extractMeta(line: TranscriptLine): { sessionId?: string; cwd?: string } {
  return {
    sessionId: typeof line.sessionId === "string" ? line.sessionId : undefined,
    cwd: typeof line.cwd === "string" ? line.cwd : undefined,
  };
}

/** 解析一段 JSONL 文本（保证只含完整行）→ { events, meta } */
export function translateChunk(text: string): { events: UiEvent[]; meta: { sessionId?: string; cwd?: string } } {
  const events: UiEvent[] = [];
  const meta: { sessionId?: string; cwd?: string } = {};
  for (const rawLine of text.split("\n")) {
    const s = rawLine.trim();
    if (!s) continue;
    let line: TranscriptLine;
    try {
      line = JSON.parse(s) as TranscriptLine;
    } catch {
      continue; // 坏行跳过（可能是写了一半的行——偏移管理保证下轮重读）
    }
    const m = extractMeta(line);
    if (m.sessionId && !meta.sessionId) meta.sessionId = m.sessionId;
    if (m.cwd && !meta.cwd) meta.cwd = m.cwd;
    events.push(...translateLine(line));
  }
  return { events, meta };
}
