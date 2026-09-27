# @larkwire/protocol

灵鹊 Larkwire 三端（手机 App / 电脑桥 / 中继）共享的协议层：信封格式、消息类型、端到端加密原语、UI 事件模型。

- 纯 TypeScript，零运行时依赖（仅 `tweetnacl`）
- 不包含任何 I/O：不监听端口、不读写文件，可嵌入任意端
- MIT 开源

## 安装

```bash
npm install @larkwire/protocol
```

## 主要内容

| 模块 | 内容 |
|------|------|
| `envelope` | `Envelope` 信封结构、`makeEnvelope()`、`MAX_ENVELOPE_BYTES`（64 KiB）、离线队列常量 |
| `messages` | 全部消息类型常量 `T`（Hello/Auth/StreamDelta/Permission…）、`PLAINTEXT_BODY_TYPES`、`QUEUEABLE_TYPES` |
| `crypto` | `generateKeyPair()`、`deriveSharedKey()`、`encryptBody()`/`decryptBody()`、`fingerprint()`、`randomPairToken()` |
| `base64` | Base64 / Base64URL 编解码 |
| `uievent` | `UiEvent` 联合类型（转录事件）、`ToolRenderData`（TodoWrite/Bash/Edit 特化渲染数据） |

## 快速示例

```ts
import {
  generateKeyPair,
  deriveSharedKey,
  encryptBody,
  decryptBody,
  fingerprint,
} from "@larkwire/protocol";

const a = generateKeyPair();
const b = generateKeyPair();

const shared = deriveSharedKey(b.publicKey, a.secretKey);
const box = encryptBody(shared, { hello: "world" });
const data = decryptBody<{ hello: string }>(shared, box);

console.log(fingerprint(a.publicKey)); // 32 位 hex 公钥指纹
```

## 版本

语义化版本。0.x 阶段协议字段只做 additive 扩展（新增可选字段 / 新消息类型），不做破坏性变更。

## 相关包

- [`larkwire`](https://www.npmjs.com/package/larkwire) — 电脑端桥
- [`@larkwire/relay`](https://www.npmjs.com/package/@larkwire/relay) — 哑中继

官网：<https://larkwire.kowems.site>
