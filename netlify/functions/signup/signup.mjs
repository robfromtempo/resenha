// Opens a place for one new account on Resenha's account server, pds.resenha.ink, for a genuine copy of the app.
//
// The server only creates accounts with an invite code. The app asks here for a challenge, has the device attest
// a fresh key over it with Apple's App Attest, and sends the attestation back. When Apple's certificates vouch for
// it, this mints one single-use code through Protobase's Admin API. The app then creates the account on the server
// itself, so passwords and emails never pass through here. See Notes/account-creation.md in the app's repository.
//
// Against accounts made in bulk, each device may create three accounts, counted in Apple's DeviceCheck bits, and a
// device that has made too many App Attest keys lately is refused. A daily cap bounds the whole server, and a switch
// pauses it. See Notes/signup-abuse.md in the app's repository.
//
// Settings, in Netlify's environment: PROTOBASE_KEY, PROTOBASE_SERVER_ID, SIGNUP_SECRET, APPLE_KEY_ID and
// APPLE_PRIVATE_KEY (the DeviceCheck key's .p8 file, base64), APP_ATTEST_ALLOW_DEVELOPMENT ("true" while testing
// from Xcode), SIGNUP_DAILY_LIMIT (50 if unset), and SIGNUP_PAUSED ("true" to stop new accounts).

import { createHmac } from "node:crypto";
import { getStore } from "@netlify/blobs";
import { verifyAttestation } from "node-app-attest";
import { AppleUnavailable, privateKeyFrom, readDeviceBits, riskMetric, writeDeviceBits } from "./apple.mjs";
import {
  dayOf, deviceAllowance, issueChallenge, readChallenge, validHandle, RISK_LIMIT, SignupError,
} from "./core.mjs";

const BUNDLE_ID = "com.robertoramos.Resenha";
const TEAM_ID = "24FX5MG467";
const PROTOBASE = "https://api.protobase.at/v1";
/// Sign-ups allowed from one address in an hour.
const HOURLY_LIMIT = 10;
const HOUR_MS = 60 * 60 * 1000;
/// How long a used challenge is remembered: past its own expiry, so it can't come back.
const NONCE_MEMORY_MS = 15 * 60 * 1000;
const DEFAULT_DAILY_LIMIT = 50;

export const config = { path: ["/api/signup/challenge", "/api/signup/invite"] };

export default async (request, context) => {
  try {
    if (request.method !== "POST") throw new SignupError(405, "method_not_allowed", { Allow: "POST" });
    const secret = process.env.SIGNUP_SECRET;
    if (!secret) {
      console.error("signup: SIGNUP_SECRET is not set");
      throw new SignupError(503, "unavailable");
    }
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") throw new SignupError(400, "bad_request");
    const path = new URL(request.url).pathname;
    if (path.endsWith("/challenge")) return reply(200, await challenge(body, secret));
    return reply(200, await invite(body, secret, context));
  } catch (error) {
    if (error instanceof SignupError) {
      console.log(`signup: ${error.code}`);
      return reply(error.status, { error: error.code }, error.headers);
    }
    console.error("signup: unexpected", error);
    return reply(503, { error: "unavailable" });
  }
};

async function challenge(body, secret) {
  const handle = validHandle(body.handle);
  if (!handle) throw new SignupError(422, "invalid_handle");
  return { challenge: issueChallenge(handle, secret) };
}

async function invite(body, secret, context) {
  const { challenge: token, keyId, attestation, deviceToken } = body;
  const read = readChallenge(token, secret);
  if (typeof keyId !== "string" || typeof attestation !== "string" || attestation.length > 20000
    || typeof deviceToken !== "string" || deviceToken.length === 0 || deviceToken.length > 10000) {
    throw new SignupError(400, "bad_request");
  }
  if (process.env.SIGNUP_PAUSED === "true") throw new SignupError(503, "paused");
  const apple = appleCredentials();
  await useNonce(read.nonce);
  await countAddress(context.ip, secret);
  await forgetOld();

  let attested;
  try {
    attested = verifyAttestation({
      attestation: Buffer.from(attestation, "base64"),
      challenge: token,
      keyId,
      bundleIdentifier: BUNDLE_ID,
      teamIdentifier: TEAM_ID,
      allowDevelopmentEnvironment: process.env.APP_ATTEST_ALLOW_DEVELOPMENT === "true",
    });
  } catch (error) {
    console.log(`signup: attestation refused (${error.message})`);
    throw new SignupError(401, "attestation_failed");
  }
  const environment = attested.environment;

  const device = await checkDevice(apple, environment, deviceToken);
  await checkRisk(apple, environment, attested);
  // The day's place is taken before the code is minted, atomically: two sign-ups at once can't both slip in at the
  // limit. Given back if minting fails.
  const day = await takeDay();
  let inviteCode;
  try {
    inviteCode = await mintCode();
  } catch (error) {
    await giveBackDay(day);
    throw error;
  }
  if (device) await chargeDevice(apple, environment, deviceToken, device);
  return { inviteCode, handle: read.handle };
}

/** Apple's key for DeviceCheck, from Netlify's settings. */
function appleCredentials() {
  const keyId = process.env.APPLE_KEY_ID;
  const privateKey = privateKeyFrom(process.env.APPLE_PRIVATE_KEY);
  if (!keyId || !privateKey) {
    console.error("signup: APPLE_KEY_ID or APPLE_PRIVATE_KEY is missing or unreadable");
    throw new SignupError(503, "unavailable");
  }
  return { keyId, teamId: TEAM_ID, privateKey };
}

/** Adds `by` to a counter unless it would pass `limit`, as one compare-and-set: a write only lands on the version
 *  that was read, so requests arriving together can't both take the last place. Returns whether it was counted. */
async function bump(store, key, limit, by = 1) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await store.getWithMetadata(key, { type: "json" });
    const count = current?.data?.count ?? 0;
    if (by > 0 && count + by > limit) return false;
    const next = { count: Math.max(count + by, 0) };
    const result = current ? await store.setJSON(key, next, { onlyIfMatch: current.etag }) : await store.setJSON(key, next, { onlyIfNew: true });
    if (result.modified) return true;
  }
  throw new SignupError(503, "unavailable");
}

/** A place among the server's new accounts today, refused past the daily limit. */
async function takeDay() {
  const limit = Number(process.env.SIGNUP_DAILY_LIMIT) || DEFAULT_DAILY_LIMIT;
  const store = getStore({ name: "signup-days", consistency: "strong" });
  const day = dayOf();
  if (!(await bump(store, day, limit))) {
    const now = new Date();
    const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    console.log(`signup: daily limit of ${limit} reached`);
    throw new SignupError(503, "full", { "Retry-After": String(Math.max(Math.ceil((midnight - now) / 1000), 1)) });
  }
  return { store, day };
}

async function giveBackDay({ store, day }) {
  try {
    await bump(store, day, Infinity, -1);
  } catch (error) {
    console.log(`signup: couldn't give the day's place back (${error.message})`);
  }
}

/** The device's accounts so far, refused at the limit. Null when Apple can't say: the sign-up goes ahead
 *  uncharged, and the daily cap still counts it. */
async function checkDevice(apple, environment, deviceToken) {
  let bits;
  try {
    bits = await readDeviceBits(apple, environment, deviceToken);
  } catch (error) {
    if (!(error instanceof AppleUnavailable)) throw error;
    console.log(`signup: device not checked (${error.message})`);
    return null;
  }
  const allowance = deviceAllowance(bits.value, bits.lastUpdate);
  if (!allowance.allowed) {
    console.log(`signup: device at its limit (${bits.value}, last ${bits.lastUpdate})`);
    throw new SignupError(403, "device_limit");
  }
  return { from: bits.value, to: allowance.next };
}

/** Counts the account against the device. A failure here isn't the person's fault, so the code still goes out. */
async function chargeDevice(apple, environment, deviceToken, { from, to }) {
  try {
    await writeDeviceBits(apple, environment, deviceToken, to);
    console.log(`signup: device ${from} → ${to}`);
  } catch (error) {
    console.log(`signup: device not charged (${error.message})`);
  }
}

/** Refuses a device that has made many App Attest keys lately. Logged each time, so the limit can be tuned. */
async function checkRisk(apple, environment, attested) {
  let metric;
  try {
    metric = await riskMetric(apple, environment, attested, `${TEAM_ID}.${BUNDLE_ID}`);
  } catch (error) {
    if (!(error instanceof AppleUnavailable)) throw error;
    console.log(`signup: risk metric unavailable (${error.message})`);
    return;
  }
  console.log(`signup: risk metric ${metric}`);
  if (metric > RISK_LIMIT) throw new SignupError(403, "device_limit");
}

/** Each challenge opens one place. A second use within its life is refused. */
async function useNonce(nonce) {
  const store = getStore({ name: "signup-nonces", consistency: "strong" });
  // Kept under the window it was used in, so old ones are found by name alone. A challenge lives no longer than a
  // window, so the window before is the only other place it could have been used.
  const bucket = Math.floor(Date.now() / NONCE_MEMORY_MS);
  if (await store.get(`${bucket - 1}/${nonce}`)) throw new SignupError(409, "used_challenge");
  // Written only if new: of the same challenge sent several times at once, one write lands and the rest are refused.
  const { modified } = await store.setJSON(`${bucket}/${nonce}`, { at: Date.now() }, { onlyIfNew: true });
  if (!modified) throw new SignupError(409, "used_challenge");
}

/** Ten sign-ups an hour from one address. The address is never stored: only a keyed hash of it, in a bucket for
 *  the current hour, with no handle or email beside it. Buckets are deleted once their hour has passed. */
async function countAddress(ip, secret) {
  if (!ip) return;
  const store = getStore({ name: "signup-ip", consistency: "strong" });
  const now = Date.now();
  const hour = Math.floor(now / HOUR_MS);
  const key = `${hour}/${createHmac("sha256", secret).update(`ip:${ip}`).digest("base64url")}`;
  if (!(await bump(store, key, HOURLY_LIMIT))) {
    const wait = Math.ceil(((hour + 1) * HOUR_MS - now) / 1000);
    throw new SignupError(429, "too_many", { "Retry-After": String(Math.max(wait, 1)) });
  }
}

/** Blobs don't expire, so each sign-up deletes the counters from past hours and days, and the challenges that
 *  can't come back. */
async function forgetOld() {
  try {
    const hour = Math.floor(Date.now() / HOUR_MS);
    const counters = getStore({ name: "signup-ip", consistency: "strong" });
    const { blobs: counted } = await counters.list();
    await Promise.all(counted.filter((b) => Number(b.key.split("/")[0]) < hour).map((b) => counters.delete(b.key)));

    const today = dayOf();
    const days = getStore({ name: "signup-days", consistency: "strong" });
    const { blobs: countedDays } = await days.list();
    await Promise.all(countedDays.filter((b) => b.key < today).map((b) => days.delete(b.key)));

    // Challenges from before the last two windows, by their names; keys from before buckets carry no "/" and go too.
    const nonces = getStore({ name: "signup-nonces", consistency: "strong" });
    const { blobs: used } = await nonces.list();
    const current = Math.floor(Date.now() / NONCE_MEMORY_MS);
    await Promise.all(used.filter((b) => {
      const bucket = Number(b.key.split("/")[0]);
      return !b.key.includes("/") || !(bucket >= current - 1);
    }).map((b) => nonces.delete(b.key)));
  } catch (error) {
    // Tidying can wait for the next sign-up.
    console.log(`signup: tidying failed (${error.message})`);
  }
}

/** One code, good for one account. */
async function mintCode() {
  const key = process.env.PROTOBASE_KEY;
  const server = process.env.PROTOBASE_SERVER_ID;
  if (!key || !server) {
    console.error("signup: PROTOBASE_KEY or PROTOBASE_SERVER_ID is not set");
    throw new SignupError(502, "invite_unavailable");
  }
  const response = await fetch(`${PROTOBASE}/servers/${encodeURIComponent(server)}/invite-codes`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ count: 1, uses: 1, prefix: "resenha" }),
  });
  if (response.status === 429) {
    throw new SignupError(503, "try_later", { "Retry-After": response.headers.get("Retry-After") ?? "60" });
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    console.error(`signup: Protobase answered ${response.status} ${detail?.error?.code ?? ""}`);
    throw new SignupError(502, "invite_unavailable");
  }
  const code = (await response.json())?.data?.codes?.[0];
  if (typeof code !== "string") {
    console.error("signup: Protobase's answer had no code");
    throw new SignupError(502, "invite_unavailable");
  }
  return code;
}

function reply(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}
