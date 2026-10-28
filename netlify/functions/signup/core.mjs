// The parts of sign-up that need no network: the handle's shape and the signed, short-lived challenge.
// Kept apart from the function so `node --test` can check them without Netlify or a device.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const HANDLE_SUFFIX = ".resenha.ink";
/// How long a challenge can be used for, from when it was issued.
export const CHALLENGE_SECONDS = 600;

/** The full handle, lowercased, when its shape is one the account server accepts; otherwise null.
 *  The user part is 3 to 18 letters, digits and hyphens, and doesn't start or end with a hyphen. */
export function validHandle(value) {
  if (typeof value !== "string") return null;
  const handle = value.trim().toLowerCase();
  if (!handle.endsWith(HANDLE_SUFFIX)) return null;
  const user = handle.slice(0, -HANDLE_SUFFIX.length);
  if (!/^[a-z0-9](?:[a-z0-9-]{1,16})[a-z0-9]$/.test(user)) return null;
  return handle;
}

/** A challenge for this handle: its payload, then an HMAC of it. Nothing is stored; the signature is the proof. */
export function issueChallenge(handle, secret, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({
    n: randomBytes(16).toString("base64url"),
    h: handle,
    exp: Math.floor(now / 1000) + CHALLENGE_SECONDS,
  })).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

/** The challenge's contents when its signature holds and it hasn't expired. Throws `bad_challenge` or
 *  `expired_challenge` otherwise, as the function answers. */
export function readChallenge(token, secret, now = Date.now()) {
  if (typeof token !== "string" || token.length > 1024) throw new SignupError(400, "bad_challenge");
  const [payload, signature, ...rest] = token.split(".");
  if (!payload || !signature || rest.length) throw new SignupError(400, "bad_challenge");
  const expected = Buffer.from(sign(payload, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new SignupError(400, "bad_challenge");
  let fields;
  try {
    fields = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new SignupError(400, "bad_challenge");
  }
  if (typeof fields?.n !== "string" || !validHandle(fields?.h) || typeof fields?.exp !== "number") {
    throw new SignupError(400, "bad_challenge");
  }
  if (fields.exp * 1000 < now) throw new SignupError(400, "expired_challenge");
  return { nonce: fields.n, handle: fields.h, expires: fields.exp };
}

function sign(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/// Accounts one device may create, counted in its two DeviceCheck bits (0 to 3).
export const DEVICE_LIMIT = 3;
/// After the limit, one more account once this many months have passed since the device's last.
export const DEVICE_COOLDOWN_MONTHS = 6;
/// More App Attest keys than this from one device in 30 days is refused. Each sign-up attempt makes one.
export const RISK_LIMIT = 10;

/** Whether a device whose bits read `value`, last changed in `lastUpdate` ("YYYY-MM", or null), may create an
 *  account now, and the value to write once it has. */
export function deviceAllowance(value, lastUpdate, now = new Date()) {
  if (value < DEVICE_LIMIT) return { allowed: true, next: value + 1 };
  const since = monthsSince(lastUpdate, now);
  if (since !== null && since >= DEVICE_COOLDOWN_MONTHS) return { allowed: true, next: DEVICE_LIMIT };
  return { allowed: false, next: value };
}

/** Whole months from "YYYY-MM" to now's month, in UTC; null when the month can't be read. */
export function monthsSince(month, now = new Date()) {
  const match = /^(\d{4})-(\d{2})$/.exec(month ?? "");
  if (!match) return null;
  return (now.getUTCFullYear() - Number(match[1])) * 12 + (now.getUTCMonth() + 1 - Number(match[2]));
}

/** The UTC day a sign-up counts toward, "YYYY-MM-DD". */
export function dayOf(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** A refusal with the status and the code the app maps to a sentence. */
export class SignupError extends Error {
  constructor(status, code, headers = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}
