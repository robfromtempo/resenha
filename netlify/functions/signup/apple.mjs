// Apple's two fraud services, called from the server: DeviceCheck's two bits per device, and App Attest's risk
// metric. Both take a token signed with the key made for DeviceCheck in the Apple Developer portal.
// https://developer.apple.com/documentation/devicecheck/accessing-and-modifying-per-device-data
// https://developer.apple.com/documentation/devicecheck/assessing-fraud-risk

import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { readReceipt, sameAttestedKey } from "./receipt.mjs";

const HOSTS = {
  production: { bits: "https://api.devicecheck.apple.com", metric: "https://data.appattest.apple.com" },
  development: { bits: "https://api.development.devicecheck.apple.com", metric: "https://data-development.appattest.apple.com" },
};
const TIMEOUT_MS = 3000;
/// Apple refuses tokens older than an hour; a new one is made well before.
const TOKEN_LIFE_MS = 20 * 60 * 1000;

/** No usable answer from Apple: down, slow, or something unexpected. Sign-up goes ahead without that check. */
export class AppleUnavailable extends Error {}

/** A token for Apple's servers: ES256, the key's ID in the header, the team as issuer. */
export function appleToken({ keyId, teamId, privateKey }, now = Date.now()) {
  const header = encode({ alg: "ES256", kid: keyId });
  const claims = encode({ iss: teamId, iat: Math.floor(now / 1000) });
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), {
    key: createPrivateKey(privateKey),
    dsaEncoding: "ieee-p1363",
  });
  return `${header}.${claims}.${signature.toString("base64url")}`;
}

/** The .p8 file from Netlify's setting: base64 of the file, or the file itself. */
export function privateKeyFrom(setting) {
  if (!setting) return null;
  const text = setting.includes("-----BEGIN") ? setting : Buffer.from(setting, "base64").toString("utf8");
  return text.includes("-----BEGIN PRIVATE KEY-----") ? text : null;
}

let cached = { token: null, made: 0, keyId: null };

function currentToken(credentials) {
  const now = Date.now();
  if (!cached.token || cached.keyId !== credentials.keyId || now - cached.made > TOKEN_LIFE_MS) {
    cached = { token: appleToken(credentials, now), made: now, keyId: credentials.keyId };
  }
  return cached.token;
}

/** The device's two bits as a number, 0 to 3, and the month they last changed ("YYYY-MM"), or null for a device
 *  Apple has no bits for. */
export async function readDeviceBits(credentials, environment, deviceToken) {
  const response = await call(`${HOSTS[environment].bits}/v1/query_two_bits`, {
    headers: { Authorization: `Bearer ${currentToken(credentials)}`, "Content-Type": "application/json" },
    body: JSON.stringify(transaction(deviceToken)),
  });
  const text = await response.text();
  if (response.status !== 200) throw new AppleUnavailable(`DeviceCheck query answered ${response.status} ${text.slice(0, 80)}`);
  if (text.trim() === "" || /bit state not found/i.test(text)) return { value: 0, lastUpdate: null };
  let bits;
  try {
    bits = JSON.parse(text);
  } catch {
    throw new AppleUnavailable("DeviceCheck query answered something other than JSON");
  }
  return { value: (bits.bit0 ? 1 : 0) + (bits.bit1 ? 2 : 0), lastUpdate: bits.last_update_time ?? null };
}

export async function writeDeviceBits(credentials, environment, deviceToken, value) {
  const response = await call(`${HOSTS[environment].bits}/v1/update_two_bits`, {
    headers: { Authorization: `Bearer ${currentToken(credentials)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...transaction(deviceToken), bit0: (value & 1) === 1, bit1: (value & 2) === 2 }),
  });
  if (response.status !== 200) {
    const text = await response.text().catch(() => "");
    throw new AppleUnavailable(`DeviceCheck update answered ${response.status} ${text.slice(0, 80)}`);
  }
}

/** The number of App Attest keys the device made for the app in the last 30 days, from Apple's new receipt for the
 *  attestation's own. The receipt must be Apple's, for this app, fresh, and for the key just attested. */
export async function riskMetric(credentials, environment, attestation, appId) {
  const response = await call(`${HOSTS[environment].metric}/v1/attestationData`, {
    headers: { Authorization: currentToken(credentials) },
    body: attestation.receipt.toString("base64"),
  });
  const text = await response.text();
  if (response.status !== 200) throw new AppleUnavailable(`attestationData answered ${response.status} ${text.slice(0, 80)}`);
  let receipt;
  try {
    receipt = await readReceipt(Buffer.from(text.trim(), "base64"));
  } catch (error) {
    throw new AppleUnavailable(`attestationData receipt didn't verify: ${error.message}`);
  }
  const fresh = receipt.created && Math.abs(Date.now() - receipt.created.getTime()) < 5 * 60 * 1000;
  if (receipt.appId !== appId || receipt.type !== "RECEIPT" || !fresh || !sameAttestedKey(receipt.attestedKey, attestation.publicKey)) {
    throw new AppleUnavailable(`attestationData receipt doesn't match (${receipt.type}, ${receipt.appId}, fresh ${fresh})`);
  }
  if (!Number.isFinite(receipt.riskMetric)) throw new AppleUnavailable("attestationData receipt has no risk metric");
  return receipt.riskMetric;
}

function transaction(deviceToken) {
  return { device_token: deviceToken, transaction_id: randomUUID(), timestamp: Date.now() };
}

async function call(url, { headers, body }) {
  try {
    return await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new AppleUnavailable(`${new URL(url).host} didn't answer (${error.message})`);
  }
}

function encode(object) {
  return Buffer.from(JSON.stringify(object)).toString("base64url");
}
