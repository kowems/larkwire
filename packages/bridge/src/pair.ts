/**
 * 配对流程（架构 §2.3 状态机，双端全程状态可见——Happy 裂脑事故的设计级修复）：
 *   offer → 中继回执 → 亮二维码 → accept → 双端显指纹人对照 → confirm（E2E 密文自验证）→ 完成
 * 任何一步超时/失败都报具体卡在哪。
 *
 * 第一刀重构（2026-09-22）：从「自己打印+process.exit」改为 Promise<PairResult>——
 * `larkwire up` 需要 await 配对成功后同进程接续 watch；CLI 的 pair 壳接住 reject
 * 维持原退出码与文案（行为不变）。
 */
import * as readline from "node:readline";
import qrcode from "qrcode-terminal";
import {
  T,
  fingerprint,
  randomPairToken,
  b64ToU8,
  PAIR_TOKEN_TTL_MS,
  type Envelope,
  type PairAcceptBody,
  type PairErrorBody,
  type PairConfirmBody,
} from "@larkwire/protocol";
import { loadConfig, loadOrCreateConfig, saveConfig, configKeyPair } from "./config.js";
import { RelayConnection } from "./connection.js";

/** 配对成功的收获（=新入册的手机），up 接续流程用 */
export interface PairResult {
  deviceId: string;
  publicKey: string; // base64（与 config 落盘口径一致）
  name: string;
}

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans.trim()); }));
}

/** 配对 UI 钩子（desktop 注入窗口交互；缺省=CLI 终端实现逐字保持） */
export interface PairHooks {
  /** 亮出配对二维码：pairUrl 已含 token/relay/桥指纹 */
  showPairUrl?(pairUrl: string, bridgeFp: string): void;
  /** 指纹人对照（手机已扫码，等人确认）；true=一致继续 confirm */
  confirmFingerprint?(ctx: { phoneName: string; phoneDeviceId: string; bridgeFp: string; phoneFp: string }): Promise<boolean>;
  /** 进展/失败文案行（连接重试行在 CLI 走 stderr，hook 形态两流合一） */
  onLog?(line: string): void;
}

/** CLI 缺省亮码：终端小二维码 + URL + 桥指纹（desktop 经 PairHooks.showPairUrl 换成窗口大码） */
function cliShowPairUrl(pairUrl: string, bridgeFp: string): void {
  console.log("手机扫这个二维码配对（微信扫一扫也可以）：\n");
  qrcode.generate(pairUrl, { small: true });
  console.log(`\n二维码内容（无法扫码时手机浏览器直接打开）：\n${pairUrl}\n`);
  console.log(`你的桥指纹：${bridgeFp}（手机端会显示同一串，人对照用）`);
  console.log("等待手机扫码…（10 分钟有效）");
}

/** CLI 缺省人对照：readline y/N（desktop 经 PairHooks.confirmFingerprint 换成确认按钮） */
async function cliConfirmFingerprint(): Promise<boolean> {
  const ans = await ask("两侧指纹一致？[y/N] ");
  return ans.toLowerCase() === "y";
}

export function runPair(opts?: { relayOverride?: string; rerunHint?: string }, hooks?: PairHooks): Promise<PairResult> {
  const out = hooks?.onLog ?? ((line: string) => console.log(line));
  const errOut = hooks?.onLog ?? ((line: string) => console.error(line));
  const relayOverride = opts?.relayOverride;
  const rerunHint = opts?.rerunHint ?? "larkwire pair"; // 失败指引随入口变（pair 壳 / up 接续）
  const relayBefore = loadConfig()?.relay;
  const cfg = loadOrCreateConfig(relayOverride); // pair 是「选中继」的入口：--relay 会持久化
  if (relayOverride && relayBefore && relayBefore !== relayOverride) {
    out(`⚠ 默认中继已从 ${relayBefore} 改为 ${relayOverride}（已写回配置，之后 watch 也走这个）\n`);
  }
  const keys = configKeyPair(cfg);
  const token = randomPairToken();
  const myFp = fingerprint(keys.publicKey);

  out(`\n灵鹊配对 · 设备 ${cfg.deviceId}（${cfg.name}）`);
  out(`中继：${cfg.relay}\n`);

  const conn = new RelayConnection({
    relayUrl: cfg.relay,
    deviceId: cfg.deviceId,
    publicKey: keys.publicKey,
    secretKey: keys.secretKey,
    name: cfg.name,
  });

  let phase: "connecting" | "offering" | "waiting" | "confirming" | "done" = "connecting";

  function phaseName(p: typeof phase): string {
    return {
      connecting: "连接中继（网络/中继地址是否正确？）",
      offering: "登记配对请求（中继无回执）",
      waiting: "等待手机扫码",
      confirming: "等待指纹确认",
      done: "完成",
    }[p];
  }

  return new Promise<PairResult>((resolve, reject) => {
    /** 统一失败出口：清定时器 + 关连接（防 socket 吊住进程）+ reject 交调用方决定退出码 */
    function fail(err: Error): void {
      clearTimeout(timeout);
      conn.close();
      reject(err);
    }

    const timeout = setTimeout(() => {
      if (phase !== "done") {
        fail(new Error(`\n✗ 配对超时（token 10 分钟有效）。卡在阶段：${phaseName(phase)}\n  重新运行 ${rerunHint} 生成新二维码。`));
      }
    }, PAIR_TOKEN_TTL_MS);

    conn.on("error", (err: Error) => {
      fail(new Error(`\n✗ ${err.message}`));
    });
    conn.on("wsError", () => {
      if (phase === "connecting") errOut("连接中继失败，重试中…（检查网络或 --relay 参数）");
    });
    conn.on("kicked", () => {
      fail(
        new Error(
          `\n⛔ 另一个 larkwire 进程接管了中继连接——同一桥身份同时只允许一个在线（pair 和 watch 不能同时跑）\n   这个二维码已失效。先停掉另一个进程（或等它退出），再重新运行 ${rerunHint} 生成新二维码。`,
        ),
      );
    });

    conn.on("ready", () => {
      phase = "offering";
      conn.sendPlain("relay", T.PairOffer, { token, publicKey: cfg.publicKey, name: cfg.name });
    });

    conn.on("envelope", (env: Envelope) => {
      void (async () => {
        if (env.type === T.PairOfferAck) {
          phase = "waiting";
          const pairUrl = `${cfg.pairPageBase}?t=${encodeURIComponent(token)}&r=${encodeURIComponent(cfg.relay)}&fp=${encodeURIComponent(myFp)}`;
          (hooks?.showPairUrl ?? cliShowPairUrl)(pairUrl, myFp);
          return;
        }

        if (env.type === T.PairAccept) {
          const body = JSON.parse(env.body) as PairAcceptBody;
          if (body.token !== token) return; // 不是给我的
          phase = "confirming";
          const phone = { deviceId: env.from, publicKey: b64ToU8(body.publicKey), name: body.name };
          const phoneFp = fingerprint(phone.publicKey);
          out(`\n手机已扫码连接：${body.name}（${env.from}）`);
          out(`请核对手机屏幕上显示的桥指纹 = ${myFp}`);
          out(`你这里看到的手机指纹 = ${phoneFp}（手机端自显应一致）`);
          const confirmed = await (hooks?.confirmFingerprint ?? cliConfirmFingerprint)({
            phoneName: body.name,
            phoneDeviceId: env.from,
            bridgeFp: myFp,
            phoneFp,
          });
          if (!confirmed) {
            conn.sendPlain(env.from, T.PairError, { token, stage: "confirm", reason: "用户拒绝：指纹不一致" });
            fail(new Error("✗ 已取消。若反复出现指纹不一致，警惕中间人——检查中继地址是否被篡改。"));
            return;
          }
          // confirm 走 E2E 密文：手机能解开 = 双方密钥推导一致（握手自验证）
          conn.sendSecure(
            { deviceId: env.from, publicKey: phone.publicKey },
            T.PairConfirm,
            { ok: true, bridgeName: cfg.name } satisfies PairConfirmBody,
            0,
          );
          cfg.paired = cfg.paired.filter((p) => p.deviceId !== env.from);
          cfg.paired.push({ deviceId: env.from, publicKey: body.publicKey, name: body.name, pairedAt: Date.now() });
          saveConfig(cfg);
          phase = "done";
          clearTimeout(timeout);
          out("\n✅ 配对完成，加密通道已建立。");
          const result: PairResult = { deviceId: phone.deviceId, publicKey: body.publicKey, name: phone.name };
          // 等连接真正合上再交还（up 紧接着要用同一桥身份开 watch——中继先处理完 close，
          // 才不会把接续的新连接当成「第二个在线」互踢；1500ms 兜底防 close 事件丢失干等）
          conn.close();
          const fallback = setTimeout(() => resolve(result), 1500);
          fallback.unref();
          conn.once("close", () => {
            clearTimeout(fallback);
            resolve(result);
          });
          return;
        }

        if (env.type === T.PairError) {
          const body = JSON.parse(env.body) as PairErrorBody;
          fail(new Error(`\n✗ 配对失败（阶段 ${body.stage}）：${body.reason}`));
        }
      })();
    });

    conn.connect();
  });
}
