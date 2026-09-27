/**
 * `larkwire install`（Eric 拍板 2026-09-22：nohup 形态退休 → launchd 开机自启）：
 * 把 watch 常驻注册成 LaunchAgent——登录自动起、进程死了 launchd ~10s 复活。
 *
 * 形态纪律（踩过的坑钉死）：
 *   - **装的是 esbuild 单文件 bundle 快照，放在 ~/Library/Application Support/larkwire/，
 *     绝不指向 repo 源码**——2026-09-23 凌晨 T8 事故定案：launchd 拉起的进程触碰
 *     ~/Documents（TCC 保护区）会被拒/堵死（A/B 对照实证：/bin/pwd cwd=Documents exit 1、
 *     cwd=/tmp 秒过；node 主线程 100% 样本堵在 getcwd→open 内核调用 26s+）。repo 在
 *     ~/Documents/被动收入创意谷/ 下，WorkingDirectory/脚本/node_modules 全在禁区内。
 *   - 快照含义：repo 代码改动不影响常驻桥；升级 = 重跑 larkwire install。
 *   - bundle 配方 = relay DEPLOY.md 同款：createRequire banner 必须（ws/qrcode-terminal/
 *     tweetnacl 是 CJS，ESM bundle 里 dynamic require 会崩）；产物 .mjs 免 package.json 配合。
 *   - node 用 /opt/homebrew/bin/node 稳定路径——Cellar 版本路径随 brew 升级失效；
 *   - PATH 必须带 $HOME/.local/bin——claude CLI 住那，桥 resume 会话要调它；
 *   - bundle 是纯 JS 直跑（无 tsx）——tsx 包装壳信号传不到的坑整个消失，启动还快。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, larkwireDir } from "./config.js";
import { readAlivePid } from "./pidfile.js";

const LABEL = "site.kowems.larkwire.bridge";
/** bundle 文件名：pidfile.ts 的 OWN_CMD 活判正则认 cli.(ts|js|mjs) + watch|up——改名要同步那边 */
const BUNDLE_NAME = "cli.mjs";

// 以下工具导出供 scratch 验证脚本复用（测试 Label 变体用同一份生成器，防两份 plist 配方漂移）
export function repoRoot(): string {
  // 起点已是 install.ts 所在目录（src）：src→bridge→packages→larkwire 根 = 三级 dirname
  // （曾误写四级 → WorkingDirectory 指到 Agent遥控台——那个 bug 已随 bundle 形态整体退役，
  //  但 repoRoot 仍用于定位 esbuild 与入口，级数照样错不得）
  let p = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 3; i++) p = dirname(p);
  return p;
}

export function nodePath(): { path: string; stable: boolean } {
  for (const c of ["/opt/homebrew/bin/node", "/usr/local/bin/node"]) {
    if (existsSync(c)) return { path: c, stable: true };
  }
  return { path: process.execPath, stable: false }; // 兜底：可能是 Cellar 版本路径（brew 升级断）
}

/** 安装目录（TCC 保护区外，见文件头事故定案）。单独成函数：测试用注入 HOME 算自己的路径 */
export function installDir(): string {
  return join(homedir(), "Library", "Application Support", "larkwire");
}

/** esbuild 单文件 bundle（配方出处见文件头）。outPath 由调用方定——生产=installDir()，测试=TEST_HOME */
export function buildBundle(outPath: string): void {
  const root = repoRoot();
  const entry = join(root, "packages", "bridge", "src", "cli.ts");
  if (!existsSync(entry)) {
    throw new Error(`仓库根目录定位失败（算出来是 ${root}）——install 请在 larkwire 仓库的源码形态下运行。`);
  }
  mkdirSync(dirname(outPath), { recursive: true });
  try {
    execFileSync(join(root, "node_modules", ".bin", "esbuild"), [
      entry, "--bundle", "--platform=node", "--format=esm", "--target=node22",
      "--banner:js=import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      `--outfile=${outPath}`,
    ], { stdio: ["ignore", "pipe", "pipe"], timeout: 60000 });
  } catch (err) {
    throw new Error(`esbuild 打包失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

function xmlEscape(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export interface PlistSpec {
  node: string;             // node 稳定路径
  script: string;           // bundle 绝对路径
  workDir: string;          // WorkingDirectory（必须在 TCC 保护区外）
  label?: string;           // 默认生产 Label；测试传 …bridge-e2e 变体
  args?: string[];          // 追加 CLI 参数（测试注 --relay dev 中继）
  env?: Record<string, string>; // 追加环境变量（测试注 HOME 隔离）
  logPath?: string;         // 默认 ~/.larkwire/bridge.log；测试指 TEST_HOME
}

export function plistXml(spec: PlistSpec): string {
  const label = spec.label ?? LABEL;
  const log = spec.logPath ?? join(larkwireDir(), "bridge.log");
  const extraArgs = (spec.args ?? []).map((a) => `\t\t<string>${xmlEscape(a)}</string>\n`).join("");
  const extraEnv = Object.entries(spec.env ?? {})
    .map(([k, v]) => `\t\t<key>${xmlEscape(k)}</key>\n\t\t<string>${xmlEscape(v)}</string>\n`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${xmlEscape(label)}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${xmlEscape(spec.node)}</string>
		<string>${xmlEscape(spec.script)}</string>
		<string>watch</string>
${extraArgs}	</array>
	<key>WorkingDirectory</key>
	<string>${xmlEscape(spec.workDir)}</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>${homedir()}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
${extraEnv}	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>${xmlEscape(log)}</string>
	<key>StandardErrorPath</key>
	<string>${xmlEscape(log)}</string>
</dict>
</plist>
`;
}

function launchctl(args: string[], ignoreError = false): string {
  try {
    return execFileSync("launchctl", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  } catch (err) {
    if (ignoreError) return "";
    throw new Error(`launchctl ${args.join(" ")} 失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

export function runInstall(): void {
  // 闸门①：未配对拒装——launchd 常驻的是已配对的桥，装个没配对的只会空转
  const cfg = loadConfig();
  if (!cfg || cfg.paired.length === 0) {
    console.error("✗ 还没配对手机——先运行 larkwire up 完成配对，再来 install。");
    process.exit(1);
  }

  const home = homedir();
  const plistPath = join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  const domain = `gui/${uid}`;
  const target = `${domain}/${LABEL}`;
  const installed = existsSync(plistPath);
  const alive = readAlivePid();

  // 闸门②：手动形态（nohup/终端）的桥活着且不是 launchd 装的 → 拒装，防双实例互踢乒乓
  if (!installed && alive !== null) {
    console.error(`✗ 已有一个手动启动的桥在跑（PID ${alive}）。`);
    console.error(`  launchd 接管前先停它：kill ${alive}，再重新运行 larkwire install。`);
    process.exit(1);
  }

  const node = nodePath();
  if (!node.stable) {
    console.warn(`⚠ 没找到 /opt/homebrew/bin/node，用当前 node（${node.path}）——brew 升级后可能失效，届时重装即可`);
  }

  // 打快照：先落到临时名，和已装比对后再决定动不动（幂等材料）
  const dir = installDir();
  const bundlePath = join(dir, BUNDLE_NAME);
  const tmpBundle = join(dir, `.${BUNDLE_NAME}.new`);
  console.log("打包桥快照（esbuild 单文件 bundle）…");
  buildBundle(tmpBundle);
  const bundleChanged = !existsSync(bundlePath) || readFileSync(bundlePath, "utf8") !== readFileSync(tmpBundle, "utf8");

  const xml = plistXml({ node: node.path, script: bundlePath, workDir: dir });
  const xmlUnchanged = installed && readFileSync(plistPath, "utf8") === xml;

  if (xmlUnchanged && !bundleChanged && alive !== null) {
    // 幂等：plist 没变 + 快照没变 + launchd 的桥在跑 → 不动
    rmSync(tmpBundle, { force: true });
    console.log(`✅ 已安装且桥在运行（PID ${alive}），无需变更。`);
    printHints(target, false);
    return;
  }

  renameSync(tmpBundle, bundlePath);
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  mkdirSync(larkwireDir(), { recursive: true });
  writeFileSync(plistPath, xml);

  // bootout 旧的（没装过/没加载会报错，忽略）→ bootstrap 拉起（RunAtLoad=true 立即启动）
  launchctl(["bootout", target], true);
  launchctl(["bootstrap", domain, plistPath]);

  // 验证：launchctl print 拿运行状态（bootstrap 是异步拉起，bundle 形态秒级就绪，15s 兜底）
  const t0 = Date.now();
  let state = "";
  while (Date.now() - t0 < 15000) {
    const out = launchctl(["print", target], true);
    const m = out.match(/state = (\w+)/);
    if (m && m[1] !== undefined) {
      state = m[1];
      if (state === "running") break;
    }
    execFileSync("sleep", ["1"]);
  }
  if (state !== "running") {
    console.error(`✗ 已写入 plist 但服务没跑起来（state=${state || "未知"}）。`);
    console.error(`  排查：launchctl print ${target}；日志：tail -50 ${join(larkwireDir(), "bridge.log")}`);
    process.exit(1);
  }
  if (bundleChanged) console.log("   快照已更新（repo 代码的冻结副本——repo 后续改动不影响常驻桥，重跑 install 才会带过去）。");
  printHints(target, true);
}

function printHints(target: string, fresh: boolean): void {
  const log = join(larkwireDir(), "bridge.log");
  console.log(fresh ? `\n✅ 已注册开机自启：桥由 launchd 托管（挂了 ~10s 自动复活，重启 Mac 自动起）。` : "");
  console.log(`   日志：tail -f ${log}`);
  console.log(`   状态：launchctl print ${target}`);
  console.log(`   重启：launchctl kickstart -k ${target}`);
  console.log(`   卸载：launchctl bootout ${target} && rm ~/Library/LaunchAgents/${LABEL}.plist && rm -rf ~/"Library/Application Support/larkwire"`);
}
