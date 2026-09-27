/**
 * UiEvent：桥把各 agent 的原始输出翻译成统一 UI 事件，App 只管渲染。
 * claude-code 适配器（转录 JSONL → UiEvent）在桥侧，本文件只是类型契约。
 */
export type UiEvent =
  | { kind: "user"; ts: number; text: string }
  // 看模式=段级（转录落盘粒度）；升舱后=token 级。
  // turnEnd=true：该 text block 所在 assistant 行是回合终点（stop_reason 非 tool_use）——
  // App 凭它把「还在工作」指示器停下（additive 可选字段，旧桥不发=App 永远推 busy，零破坏）
  // delta=true（批次③ WP2 additive）：token 级增量——text 只含新增片段，App 拼接到上一条
  // assistant 末尾（无分隔符）；缺省=完整段落（照旧 "\n\n" 段级合并）。旧 App 忽略此字段=按段合并，视觉瑕疵非崩溃
  | { kind: "assistant"; ts: number; text: string; turnEnd?: boolean; delta?: boolean }
  | { kind: "thinking"; ts: number; text: string }
  // title=头行意图标题（缺省 App 回退 name(summary)）；data=按工具名分派的结构化渲染数据
  | { kind: "tool_use"; ts: number; name: string; summary: string; title?: string; data?: ToolRenderData }
  | { kind: "tool_result"; ts: number; text: string; isError: boolean }
  | { kind: "system"; ts: number; text: string }
  | { kind: "title"; ts: number; text: string } // ai-title / summary
  | { kind: "raw"; ts: number; jsonType: string }; // 未知条目类型宽容透传（格式漂移防线）

export type UiEventKind = UiEvent["kind"];

// ---------- tool_use 结构化渲染（2026-09 公测前 additive；仅少数工具产出） ----------
// adapter 是唯一裁剪者（受 64KB 信封硬约束）：data 各字段已按字节/行数裁过，App 不存在
// 「取全文」通道；App 自己的行数闸只是渲染窗。旧 App 不读 title/data=零影响，
// 新 App 遇 undefined=回退 name(summary) 老形态。
export type TodoStatus = "pending" | "in_progress" | "completed";

export interface ToolTodoItem {
  content: string;
  status: TodoStatus;
  activeForm?: string;
}

// 判别子字段名=tool（值=工具名），与 UiEvent.kind 区分；加新工具只加联合一支
export type ToolRenderData =
  | { tool: "TodoWrite"; todos: ToolTodoItem[]; done: number; total: number }
  | { tool: "Bash"; description?: string; command: string }
  | { tool: "Edit"; file: string; replaceAll: boolean; oldText: string; newText: string };
