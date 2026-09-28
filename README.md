# 灵鹊 Larkwire

把跑在电脑上的 AI Agent（Claude Code 等 stream-json 兼容 CLI）安全送上手机：**看**实时输出、出门后**接**管发话、**控**权限卡点允许。

```
   手机 App                         公网中继                     你的电脑
┌───────────┐   E2E 密文帧    ┌──────────────┐   密文帧    ┌──────────────┐
│ 看 / 接 / 控 │ ◀─────────── ▶ │  哑中继（盲）  │ ◀───────── ▶ │ larkwire 桥  │
└───────────┘                 └──────────────┘             └──────────────┘
```

中继对内容**零可见**：所有会话帧端到端加密（X25519 + NaCl box），中继只按连接映射转发。

## 三个源码仓

| 仓库 | 内容 | 分发 |
|---|---|---|
| [kowems/larkwire](https://github.com/kowems/larkwire) | **本仓**·桥 + 协议 | npm：[`larkwire`](https://www.npmjs.com/package/larkwire) / [`@larkwire/protocol`](https://www.npmjs.com/package/@larkwire/protocol) |
| [kowems/larkwire-relay](https://github.com/kowems/larkwire-relay) | 哑中继：WSS 转发 / 配对路由 / 离线队列 / 计量 | npm [`@larkwire/relay`](https://www.npmjs.com/package/@larkwire/relay) + Release 单文件 bundle |
| [kowems/larkwire-desktop](https://github.com/kowems/larkwire-desktop) | macOS 桌面端（Electron 菜单栏壳） | Release 公证 dmg |

手机 App（iOS / Android）闭源，不在任何公开仓。

## 快速开始（电脑端）

需要 Node.js ≥ 22：

```bash
npx larkwire up
```

未配对会自动先配对（终端显示二维码，手机 App 扫码），随后进入监听。手机 App（iOS TestFlight 审核中 / Android 应用市场即将上架）下载见官网：<https://larkwire.kowems.site#download>。

## 仓库结构

| 包 | 说明 |
|----|------|
| [`packages/protocol`](packages/protocol) | 三端共享协议：信封 / 消息类型 / E2E 加密 / UiEvent |
| [`packages/bridge`](packages/bridge) | 电脑端桥（npm 包名 `larkwire`）：CLI + 可嵌入核心 |

中继源码与官网静态页（首页 / 配对落地页 / AASA / 下载占位）已迁至 [larkwire-relay](https://github.com/kowems/larkwire-relay)；macOS 桌面壳在 [larkwire-desktop](https://github.com/kowems/larkwire-desktop)。

## 从源码构建

```bash
pnpm install
pnpm -r build
```

## 自建中继

中继已独立成仓：克隆 [larkwire-relay](https://github.com/kowems/larkwire-relay)，
`npm install && npm run bundle` 得到单文件 `relay.bundle.mjs`，node 直跑；
完整生产部署 runbook（nginx 反代 / systemd / 环境变量）见该仓 [DEPLOY.md](https://github.com/kowems/larkwire-relay/blob/main/DEPLOY.md)。

## 安全模型

- **E2E 加密**：手机与桥各自 X25519 密钥对，共享密钥不落中继；NaCl box 加密每帧正文
- **配对**：二维码 + 公钥指纹人工核对，10 分钟 token TTL；修桥须重新公钥交换（防桥侧公钥替换）
- **中继盲区**：中继只能看到连接元数据（哪台设备在线、帧大小、时间戳），无法解密任何内容
- **离线暂存**：最长 10 分钟 TTL、每设备 50 帧，同样是密文

## License

[MIT](LICENSE) — Copyright (c) 2026 Larkwire contributors
