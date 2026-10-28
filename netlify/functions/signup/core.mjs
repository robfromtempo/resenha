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

/** A refusal with the status and the code the app maps to a sentence. */
export class SignupError extends Error {
  constructor(status, code, headers = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}
