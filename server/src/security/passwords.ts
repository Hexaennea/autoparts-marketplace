// Password hashing with scrypt (memory-hard, Node standard library).
// Format: scrypt$<n>$<r>$<p>$<salt b64>$<hash b64>, identical to the Python version,
// so parameters can be raised later and old hashes still verify (needsRehash).

import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

const N = 2 ** 14;
const R = 8;
const P = 1;
const DKLEN = 32;
const MAX_PASSWORD_BYTES = 1024; // bound the work an attacker can force per request

function scrypt(password: Buffer, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

const COMMON = new Set([
  "password",
  "password1",
  "12345678",
  "123456789",
  "1234567890",
  "qwerty123",
  "iloveyou",
  "admin123",
  "welcome1",
  "partpilot",
  "letmein1",
  "abc12345",
]);

function pwBytes(password: string): Buffer {
  return Buffer.from(password, "utf8").subarray(0, MAX_PASSWORD_BYTES);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const digest = await scrypt(pwBytes(password), salt, DKLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${digest.toString("base64")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  try {
    const [scheme, n, r, p, saltB64, hashB64] = encoded.split("$");
    if (scheme !== "scrypt" || !hashB64) return false;
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");
    const actual = await scrypt(pwBytes(password), salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 128 * 1024 * 1024,
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function needsRehash(encoded: string): boolean {
  const parts = encoded.split("$");
  return (
    parts.length !== 6 ||
    parts[0] !== "scrypt" ||
    Number(parts[1]) !== N ||
    Number(parts[2]) !== R ||
    Number(parts[3]) !== P
  );
}

// Pre-computed hash used to equalise timing when an email does not exist.
let dummy: Promise<string> | null = null;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(16).toString("base64url"));
  return dummy;
}

/** Human-readable reasons a password is too weak (empty list = acceptable). */
export function passwordProblems(password: string, opts: { email?: string; name?: string } = {}): string[] {
  const problems: string[] = [];
  if ([...password].length < 10) problems.push("Use at least 10 characters.");
  if (Buffer.byteLength(password, "utf8") > 128) problems.push("Use at most 128 characters.");
  const classes = [
    /\p{Ll}/u.test(password),
    /\p{Lu}/u.test(password),
    /\p{Nd}/u.test(password),
    /[^\p{L}\p{N}]/u.test(password),
  ].filter(Boolean).length;
  if (classes < 3) problems.push("Mix at least three of: lowercase, uppercase, numbers, symbols.");
  const lowered = password.toLowerCase();
  if (COMMON.has(lowered)) problems.push("This password is too common.");
  const local = (opts.email ?? "").split("@")[0].toLowerCase();
  if (local && local.length >= 4 && lowered.includes(local)) problems.push("Don't include your email address.");
  const first = opts.name ? opts.name.split(" ")[0].toLowerCase() : "";
  if (first && first.length >= 4 && lowered.includes(first)) problems.push("Don't include your name.");
  return problems;
}
