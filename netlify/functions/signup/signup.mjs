// Opens a place for one new account on Resenha's account server, pds.resenha.ink, for a genuine copy of the app.
//
// The server only creates accounts with an invite code. The app asks here for a challenge, has the device attest
// a fresh key over it with Apple's App Attest, and sends the attestation back. When Apple's certificates vouch for
// it, this mints one single-use code through Protobase's Admin API. The app then creates the account on the server
// itself, so passwords and emails never pass through here. See Notes/account-creation.md in the app's repository.
//
// Settings, in Netlify's environment: PROTOBASE_KEY, PROTOBASE_SERVER_ID, SIGNUP_SECRET, and
// APP_ATTEST_ALLOW_DEVELOPMENT ("true" while testing from Xcode).

import { getStore } from "@netlify/blobs";
import { verifyAttestation } from "node-app-attest";
import { issueChallenge, readChallenge, validHandle, SignupError } from "./core.mjs";

const BUNDLE_ID = "com.robertoramos.Resenha";
const TEAM_ID = "24FX5MG467";
const PROTOBASE = "https://api.protobase.at/v1";
/// Sign-ups allowed from one address in an hour.
const HOURLY_LIMIT = 10;
const HOUR_MS = 60 * 60 * 1000;
/// How long a used challenge is remembered: past its own expiry, so it can't come back.
const NONCE_MEMORY_MS = 15 * 60 * 1000;

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
  const { challenge: token, keyId, attestation } = body;
  const read = readChallenge(token, secret);
  if (typeof keyId !== "string" || typeof attestation !== "string" || attestation.length > 20000) {
    throw new SignupError(400, "bad_request");
  }
  await useNonce(read.nonce);
  await countAddress(context.ip);

  try {
    verifyAttestation({
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

  return { inviteCode: await mintCode(), handle: read.handle };
}

/** Each challenge opens one place. A second use within its life is refused. */
async function useNonce(nonce) {
  const store = getStore({ name: "signup-nonces", consistency: "strong" });
  const seen = await store.get(nonce, { type: "json" });
  if (seen && Date.now() - seen.at < NONCE_MEMORY_MS) throw new SignupError(409, "used_challenge");
  await store.setJSON(nonce, { at: Date.now() });
}

/** Ten sign-ups an hour from one address. The address is kept only as the counter's key, with no handle beside it. */
async function countAddress(ip) {
  if (!ip) return;
  const store = getStore({ name: "signup-ip", consistency: "strong" });
  const now = Date.now();
  const entry = await store.get(ip, { type: "json" });
  const fresh = !entry || now - entry.start > HOUR_MS;
  const count = fresh ? 1 : entry.count + 1;
  const start = fresh ? now : entry.start;
  if (count > HOURLY_LIMIT) {
    const wait = Math.ceil((start + HOUR_MS - now) / 1000);
    throw new SignupError(429, "too_many", { "Retry-After": String(Math.max(wait, 1)) });
  }
  await store.setJSON(ip, { start, count });
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
