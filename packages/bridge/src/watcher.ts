/**
 * 转录 watcher（看模式核心）：发现 ~/.claude/projects/**\/*.jsonl，按字节偏移 tail。
 *
 * 实测依据（S4/架构 §4.1）：CC 转录段级落盘（1-15s 间隔），我们 500ms 轮询 stat，
 * 有新字节才读——落盘粒度以下的"伪实时"是物理约束，不是这里偷懒。
 * 偏移即 seq：断线/重启从 lastAck+1（字节偏移）续传，不重放全量。
 */
import { EventEmitter } from "node:events";
import { statSync, openSync, readSync, closeSync, existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import type { UiEvent, AgentKind } from "@larkwire/protocol";
import { translateChunk } from "./adapter/claude-code.js";
import { StateStore } from "./state.js";

const POLL_MS = 500;
const REGISTER_WINDOW_MS = 48 * 3600 * 1000; // 启动时只注册 48h 内活跃的会话
const MAX_CHUNK_BYTES = 4 * 1024 * 1024; // 单轮最多读 4MB，防长时间离线后一次爆读
const TAIL_READ_BYTES = 256 * 1024; // snapshot 回读窗口

export interface WatchedSession {
  sessionId: string;
  path: string;
  offset: number;
  agent: AgentKind;
  project: string;
  title?: string; // 会话名：summary/ai-title 优先，否则首条用户消息截断（2026-09-20 Eric：列表只显示项目名分不清同名会话）
  cwd?: string;
  startedAt: number;
  lastActiveAt: number;
  registered: boolean; // 是否已上报 session.register（老文件复活场景防漏报）
}

export interface DeltaEvent {
  session: WatchedSession;
  events: UiEvent[];
  endOffset: number;
}

/** 会话名挑选：summary/ai-title 事件优先；否则首条真实用户消息（跳过 <command> 类噪声）压成单行截 40 字 */
function pickTitle(events: UiEvent[]): string | undefined {
  const t = events.find((e) => e.kind === "title");
  if (t) return (t as { text: string }).text;
  for (const e of events) {
    if (e.kind !== "user") continue;
    const oneLine = e.text.replace(/\s+/g, " ").trim();
    if (!oneLine || oneLine.startsWith("<")) continue;
    return oneLine.length > 40 ? oneLine.slice(0, 40) + "…" : oneLine;
  }
  return undefined;
}

export class TranscriptWatcher extends EventEmitter {
  private projectsDir: string;
  private state: StateStore;
  private sessions = new Map<string, WatchedSession>(); // path → session
  private timer?: NodeJS.Timeout;
  private scanning = false;

  constructor(projectsDir: string, state: StateStore) {
    super();
    this.projectsDir = projectsDir;
    this.state = state;
  }

  start(): void {
    if (this.timer) return; // 幂等：中继重连会再触发一次 ready → start，不能起双轮询
    this.timer = setInterval(() => void this.scanOnce(), POLL_MS);
    void this.scanOnce();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  listSessions(): WatchedSession[] {
    return [...this.sessions.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  getSession(sessionId: string): WatchedSession | undefined {
    for (const s of this.sessions.values()) if (s.sessionId === sessionId) return s;
    return undefined;
  }

  /** snapshot：回读文件末尾 N 行翻译成事件（App 打开会话页 / 重连补发用） */
  readSnapshot(sessionId: string, maxLines: number): { events: UiEvent[]; endOffset: number; truncated: boolean } | null {
    const s = this.getSession(sessionId);
    if (!s || !existsSync(s.path)) return null;
    const size = statSync(s.path).size;
    const readLen = Math.min(size, TAIL_READ_BYTES);
    const buf = Buffer.alloc(readLen);
    const fd = openSync(s.path, "r");
    try {
      readSync(fd, buf, 0, readLen, size - readLen);
    } finally {
      closeSync(fd);
    }
    let text = buf.toString("utf8");
    if (readLen < size) {
      // 丢掉第一行残段
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : "";
    }
    const lines = text.split("\n");
    const tail = lines.slice(-maxLines).join("\n");
    const { events } = translateChunk(tail);
    return { events, endOffset: size, truncated: size > readLen || lines.length > maxLines };
  }

  /** 断线续传：从指定字节偏移读到文件尾（上限 1MB/次），翻译完整行 */
  readFrom(sessionId: string, fromOffset: number, maxBytes = 1024 * 1024): { events: UiEvent[]; endOffset: number } | null {
    const s = this.getSession(sessionId);
    if (!s || !existsSync(s.path)) return null;
    const size = statSync(s.path).size;
    if (fromOffset >= size) return { events: [], endOffset: size };
    const readLen = Math.min(size - fromOffset, maxBytes);
    const buf = Buffer.alloc(readLen);
    const fd = openSync(s.path, "r");
    try {
      readSync(fd, buf, 0, readLen, fromOffset);
    } finally {
      closeSync(fd);
    }
    const text = buf.toString("utf8");
    const lastNl = text.lastIndexOf("\n");
    if (lastNl < 0) return { events: [], endOffset: fromOffset };
    const complete = text.slice(0, lastNl + 1);
    const { events } = translateChunk(complete);
    return { events, endOffset: fromOffset + Buffer.byteLength(complete, "utf8") };
  }

  /** 手动触发一轮扫描（sessions 调试命令用） */
  async rescan(): Promise<void> {
    await this.scanOnce();
  }

  private async scanOnce(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      let projectDirs: string[];
      try {
        projectDirs = await readdir(this.projectsDir);
      } catch {
        return; // 目录还不存在（没跑过 CC）
      }
      const now = Date.now();
      for (const dir of projectDirs) {
        const dirPath = join(this.projectsDir, dir);
        let files: string[];
        try {
          const st = await stat(dirPath);
          if (!st.isDirectory()) continue;
          files = await readdir(dirPath);
        } catch {
          continue;
        }
        for (const f of files) {
          if (!f.endsWith(".jsonl")) continue;
          this.trackFile(dirPath, join(dirPath, f), dir, now);
        }
      }
    } finally {
      this.scanning = false;
    }
  }

  private trackFile(dirPath: string, filePath: string, dirName: string, now: number): void {
    let st;
    try {
      st = statSync(filePath);
    } catch {
      return;
    }
    const existing = this.sessions.get(filePath);
    if (!existing) {
      const sessionId = basename(filePath, ".jsonl");
      const saved = this.state.get(sessionId);
      // 有落盘偏移 → 续传（桥停机期间的增长会补发）；没有 → 从现在起 tail（历史靠 snapshot 点播）
      const offset = saved ? Math.min(saved.offset, st.size) : st.size;
      const meta = this.probeMeta(filePath, dirName);
      // 测试 scratch 会话不上手机（2026-09-20 Eric：.e2e/.park/.s10-scratch 混进列表）：
      // 项目名（cwd basename）以 "." 开头的一律跳过——只是我们 spike/e2e 的隐藏目录会这样
      if (meta.project.startsWith(".")) return;
      const session: WatchedSession = {
        sessionId,
        path: filePath,
        offset,
        agent: "claude-code",
        project: meta.project,
        title: meta.title,
        cwd: meta.cwd,
        startedAt: Math.floor(st.birthtimeMs),
        lastActiveAt: Math.floor(st.mtimeMs),
        registered: false,
      };
      this.sessions.set(filePath, session);
      const activeRecently = now - st.mtimeMs < REGISTER_WINDOW_MS;
      if (activeRecently || saved) {
        session.registered = true;
        this.emit("register", session);
      }
      // 续传场景：有落后就直接补读
      if (offset < st.size) this.pump(session, st.size);
      return;
    }

    existing.lastActiveAt = Math.floor(st.mtimeMs);
    if (st.size < existing.offset) {
      // 文件被截断/替换（CC 不轮转转录，防御分支）：从现在重新 tail
      existing.offset = st.size;
      this.state.set(existing.sessionId, st.size);
      return;
    }
    if (st.size > existing.offset) this.pump(existing, st.size);
  }

  /** 读 [offset, size) 的新字节，处理到最后一根完整行（残行留下轮） */
  private pump(session: WatchedSession, fileSize: number): void {
    const readLen = Math.min(fileSize - session.offset, MAX_CHUNK_BYTES);
    if (readLen <= 0) return;
    const buf = Buffer.alloc(readLen);
    let fd: number;
    try {
      fd = openSync(session.path, "r");
    } catch {
      return;
    }
    try {
      readSync(fd, buf, 0, readLen, session.offset);
    } finally {
      closeSync(fd);
    }
    const text = buf.toString("utf8");
    const lastNl = text.lastIndexOf("\n");
    if (lastNl < 0) return; // 一行都没写完，下轮再说
    const complete = text.slice(0, lastNl + 1);
    const { events, meta } = translateChunk(complete);

    if (meta.cwd && !session.cwd) {
      session.cwd = meta.cwd;
      session.project = basename(meta.cwd);
    }
    const endOffset = session.offset + Buffer.byteLength(complete, "utf8");
    session.offset = endOffset;
    this.state.set(session.sessionId, endOffset);

    if (events.length > 0) {
      if (!session.registered) {
        // 老会话复活（启动时不活跃没注册）：先补注册再发增量，防手机收到无名会话
        session.registered = true;
        this.emit("register", session);
      }
      const hasTitle = events.some((e) => e.kind === "title");
      if (hasTitle) {
        const t = events.find((e) => e.kind === "title");
        session.title = (t as { text: string }).text;
        this.emit("update", session, session.title);
      }
      const delta: DeltaEvent = { session, events, endOffset };
      this.emit("delta", delta);
    }
  }

  /** 新文件元信息探测：读头 256KB 找 cwd + 会话名（summary/ai-title 优先，首条用户消息兜底）；找不到用目录名兜底。
   *  必须读 256KB 而非几 KB（2026-09-20 实证 7b5142f9）：queue-operation 行后第一条 user 行可长达 ~8KB+
   *  （首条用户消息本体），8KB 窗口内最后一根完整行停在 queue-operation → cwd/title 全丢 → 空 project。 */
  private probeMeta(filePath: string, dirName: string): { project: string; cwd?: string; title?: string } {
    try {
      const fd = openSync(filePath, "r");
      const buf = Buffer.alloc(TAIL_READ_BYTES);
      let cwd: string | undefined;
      let title: string | undefined;
      try {
        const n = readSync(fd, buf, 0, TAIL_READ_BYTES, 0);
        const head = buf.toString("utf8", 0, n);
        const { events, meta } = translateChunk(head.slice(0, head.lastIndexOf("\n") + 1));
        cwd = meta.cwd;
        title = pickTitle(events);
      } finally {
        closeSync(fd);
      }
      if (cwd) return { project: basename(cwd), cwd, title };
    } catch { /* fall through */ }
    return { project: dirName.replace(/^-/, "").replaceAll("-", "/").split("/").filter(Boolean).pop() ?? dirName };
  }
}
