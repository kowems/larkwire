# 灵鹊 Larkwire

把跑在电脑上的 AI Agent（Claude Code 等 stream-json 兼容 CLI）安全送上手机：**看**实时输出、出门后**接**管发话、**控**权限卡点允许。

```
   手机 App                         公网中继                     你的电脑
┌───────────┐   E2E 密文帧    ┌──────────────┐   密文帧    ┌──────────────┐
│ 看 / 接 / 控 │ ◀─────────── ▶ │  哑中继（盲）  │ ◀───────── ▶ │ larkwire 桥  │
└───────────┘                 └──────────────┘             └──────────────┘
```

中继对内容**零可见**：所有会话帧端到端加密（X25519 + NaCl secretbox），中继只按连接映射转发。

## 快速开始（电脑端）

需要 Node.js ≥ 22：

```bash
npx larkwire up
```

未配对会自动先配对（终端显示二维码，手机 App 扫码），随后进入监听。手机 App 下载见官网：<https://larkwire.kowems.site>。

## 仓库结构

| 包 | 说明 |
|----|------|
| [`packages/protocol`](packages/protocol) | 三端共享协议：信封 / 消息类型 / E2E 加密 / UiEvent |
| [`packages/bridge`](packages/bridge) | 电脑端桥（npm 包名 `larkwire`）：CLI + 可嵌入核心 |
| [`packages/relay`](packages/relay) | 哑中继（npm 包名 `@larkwire/relay`）：WSS 转发 / 配对路由 / 离线队列 / 计量 |

## 从源码构建

```bash
pnpm install
pnpm -r build
```

## 自建中继

```bash
node packages/relay/dist/index.js
# 默认 127.0.0.1:8790，详见 packages/relay/README.md
```

中继不含 App 客户端（闭源）与桌面壳。配对落地页在 [packages/relay/www/pair](packages/relay/www/pair)。

## 安全模型

- **E2E 加密**：手机与桥各自 X25519 密钥对，共享密钥不落中继；NaCl secretbox 加密每帧正文
- **配对**：二维码 + 公钥指纹人工核对，10 分钟 token TTL；修桥须重新公钥交换（防桥侧公钥替换）
- **中继盲区**：中继只能看到连接元数据（哪台设备在线、帧大小、时间戳），无法解密任何内容
- **离线暂存**：最长 10 分钟 TTL、每设备 50 帧，同样是密文

## License

[MIT](LICENSE) — Copyright (c) 2026 Larkwire contributors
