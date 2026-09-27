/**
 * 纯 JS base64 —— 不依赖 Buffer / atob，三端（Node 桥 / Node 中继 / uni-app webview）通用。
 */
const B64_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function u8ToB64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64_CHARS[(n >> 18) & 63]! + B64_CHARS[(n >> 12) & 63]! + B64_CHARS[(n >> 6) & 63]! + B64_CHARS[n & 63]!;
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i]! << 16;
    out += B64_CHARS[(n >> 18) & 63]! + B64_CHARS[(n >> 12) & 63]! + "==";
  } else if (rem === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64_CHARS[(n >> 18) & 63]! + B64_CHARS[(n >> 12) & 63]! + B64_CHARS[(n >> 6) & 63]! + "=";
  }
  return out;
}

const B64_REV: Record<string, number> = {};
for (let i = 0; i < B64_CHARS.length; i++) B64_REV[B64_CHARS[i]!] = i;

export function b64ToU8(s: string): Uint8Array {
  const clean = s.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = B64_REV[clean[i]!] ?? 0;
    const b = B64_REV[clean[i + 1]!] ?? 0;
    const c = i + 2 < clean.length ? B64_REV[clean[i + 2]!] ?? 0 : 0;
    const d = i + 3 < clean.length ? B64_REV[clean[i + 3]!] ?? 0 : 0;
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

/** base64url（配对 token 进 URL 用） */
export function u8ToB64Url(bytes: Uint8Array): string {
  return u8ToB64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function b64UrlToU8(s: string): Uint8Array {
  return b64ToU8(s.replaceAll("-", "+").replaceAll("_", "/"));
}
