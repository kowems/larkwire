/**
 * E2E 加密（架构 §3）：X25519 设备密钥对 + 配对协商共享密钥 + 每消息 XSalsa20-Poly1305。
 * tweetnacl box —— Happy 同款成熟路径。本文件只用 tweetnacl + 纯 JS，三端通用。
 */
import nacl from "tweetnacl";
import { u8ToB64, b64ToU8, u8ToB64Url } from "./base64.js";

export interface DeviceKeyPair {
  publicKey: Uint8Array; // 32B X25519 公钥
  secretKey: Uint8Array; // 32B 私钥（只存本地，永不上线）
}

/**
 * 安装自定义 PRNG。App 端逻辑层跑在裸 JSCore（无 crypto.getRandomValues），
 * tweetnacl 找不到随机源会直接抛 "no PRNG"（2026-09-18 真机白屏事故根因）。
 * 必须走本包的 nacl 实例透传——pnpm 下 app 直接 import tweetnacl 可能拿到
 * 另一份模块副本，在那边 setPRNG 等于白设。
 */
export function installPRNG(fn: (x: Uint8Array, n: number) => void): void {
  nacl.setPRNG(fn);
}

// ─── UTF-8 编解码 ─────────────────────────────────────────────
// TextEncoder/TextDecoder 优先（浏览器/Node）；裸 JSCore 没有这两个类，纯 JS 兜底。
function utf8Encode(str: string): Uint8Array {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(str);
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let cp = str.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < str.length) {
      const lo = str.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return new Uint8Array(out);
}

function utf8Decode(bytes: Uint8Array): string {
  if (typeof TextDecoder !== "undefined") return new TextDecoder().decode(bytes);
  let s = "";
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i]!;
    let cp: number;
    if (b0 < 0x80) {
      cp = b0;
      i += 1;
    } else if (b0 < 0xe0) {
      cp = ((b0 & 0x1f) << 6) | (bytes[i + 1]! & 0x3f);
      i += 2;
    } else if (b0 < 0xf0) {
      cp = ((b0 & 0x0f) << 12) | ((bytes[i + 1]! & 0x3f) << 6) | (bytes[i + 2]! & 0x3f);
      i += 3;
    } else {
      cp = ((b0 & 0x07) << 18) | ((bytes[i + 1]! & 0x3f) << 12) | ((bytes[i + 2]! & 0x3f) << 6) | (bytes[i + 3]! & 0x3f);
      i += 4;
    }
    if (cp > 0xffff) {
      cp -= 0x10000;
      s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else {
      s += String.fromCharCode(cp);
    }
  }
  return s;
}

export function generateKeyPair(): DeviceKeyPair {
  const kp = nacl.box.keyPair();
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}

/** 配对完成后双方各自推导的同一把共享密钥 */
export function deriveSharedKey(theirPublicKey: Uint8Array, mySecretKey: Uint8Array): Uint8Array {
  return nacl.box.before(theirPublicKey, mySecretKey);
}

/** body 加密：随机 nonce 前置，整体 base64。明文侧是 JSON。 */
export function encryptBody(sharedKey: Uint8Array, payload: unknown): string {
  const plaintext = utf8Encode(JSON.stringify(payload));
  const nonce = nacl.randomBytes(nacl.box.nonceLength); // 24B
  const cipher = nacl.box.after(plaintext, nonce, sharedKey);
  const packed = new Uint8Array(nonce.length + cipher.length);
  packed.set(nonce, 0);
  packed.set(cipher, nonce.length);
  return u8ToB64(packed);
}

export function decryptBody<T = unknown>(sharedKey: Uint8Array, b64: string): T {
  const packed = b64ToU8(b64);
  const nonce = packed.slice(0, nacl.box.nonceLength);
  const cipher = packed.slice(nacl.box.nonceLength);
  const plain = nacl.box.open.after(cipher, nonce, sharedKey);
  if (!plain) throw new Error("decrypt failed: bad key or tampered ciphertext");
  return JSON.parse(utf8Decode(plain)) as T;
}

/**
 * 公钥指纹（配对时人对照用）：SHA-512 截前 6 字节，XX-XX-XX 分组显示。
 * 双方各显对方指纹前 6 位，人对照一致才 confirm（架构 §2.3 step 7-8）。
 */
export function fingerprint(publicKey: Uint8Array): string {
  const h = nacl.hash(publicKey); // SHA-512，取前 6 字节足够人对照
  const hex = Array.from(h.slice(0, 6), (b) => b.toString(16).padStart(2, "0").toUpperCase());
  return `${hex[0]}-${hex[1]}-${hex[2]}`;
}

/** 短指纹（日志/UI 角标用） */
export function shortFingerprint(publicKey: Uint8Array): string {
  const h = nacl.hash(publicKey);
  return h[0]!.toString(16).padStart(2, "0") + h[1]!.toString(16).padStart(2, "0");
}

/** 一次性配对 token（10 分钟有效，URL 安全） */
export function randomPairToken(): string {
  return u8ToB64Url(nacl.randomBytes(16));
}

export function randomNonce(): Uint8Array {
  return nacl.randomBytes(32);
}

let uuidCounter = 0;
/**
 * uuid v4（多源熵混合，不信任何单源）。
 * 真机实证 2026-09-19：uni-app jscore 运行时注入的 crypto.randomUUID 是残血 polyfill，
 * 每次返回同一个固定全零串 → clientMsgId 三次全同值 00000000…，幂等键报废。
 * 这里 getRandomValues / Math.random 取其一打底，再 XOR Date.now 与自增计数器——
 * 打底源真随机时 XOR 已知值是双射不降熵；打底源残血（全零/固定串）时时间戳+计数器仍保唯一。
 * clientMsgId/requestId 只是幂等键非安全凭证，此强度足够；
 * 密码学级随机（randomNonce/keyPair）走 nacl.randomBytes，与本函数无关。
 */
export function uuid(): string {
  const rnd = new Uint8Array(16);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => void } }).crypto;
  if (c?.getRandomValues) {
    c.getRandomValues(rnd);
  } else {
    for (let i = 0; i < 16; i++) rnd[i] = Math.floor(Math.random() * 256);
  }
  const t = Date.now();
  rnd[0]! ^= t & 0xff;
  rnd[1]! ^= (t >>> 8) & 0xff;
  rnd[2]! ^= (t >>> 16) & 0xff;
  rnd[3]! ^= (t >>> 24) & 0xff;
  rnd[4]! ^= uuidCounter & 0xff;
  rnd[5]! ^= (uuidCounter >>> 8) & 0xff;
  uuidCounter = (uuidCounter + 1) & 0xffff;
  rnd[6] = (rnd[6]! & 0x0f) | 0x40;
  rnd[8] = (rnd[8]! & 0x3f) | 0x80;
  const hex = Array.from(rnd, (b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

export function nowTs(): number {
  return Math.floor(Date.now() / 1000);
}
