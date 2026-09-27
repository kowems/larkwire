/**
 * 桥状态落盘（架构 §2.4）：每会话转录偏移持久化到 ~/.larkwire/state/，桥重启不重放全量。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./config.js";

export interface SessionState {
  offset: number; // 已发送到的转录字节偏移（= 最后一条 stream.delta 的 seq）
  updatedAt: number;
}

export class StateStore {
  private dir: string;
  private cache = new Map<string, SessionState>();

  constructor(dir?: string) {
    this.dir = dir ?? stateDir();
    mkdirSync(this.dir, { recursive: true });
  }

  get(sessionId: string): SessionState | null {
    if (this.cache.has(sessionId)) return this.cache.get(sessionId)!;
    const p = join(this.dir, `${sessionId}.json`);
    if (!existsSync(p)) return null;
    try {
      const s = JSON.parse(readFileSync(p, "utf8")) as SessionState;
      this.cache.set(sessionId, s);
      return s;
    } catch {
      return null;
    }
  }

  set(sessionId: string, offset: number): void {
    const s: SessionState = { offset, updatedAt: Date.now() };
    this.cache.set(sessionId, s);
    writeFileSync(join(this.dir, `${sessionId}.json`), JSON.stringify(s));
  }

  knownSessionIds(): string[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5));
  }
}
