// node --test netlify/functions/signup/apple.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { verifyAttestation } from "node-app-attest";
import { appleToken, privateKeyFrom } from "./apple.mjs";
import { readReceipt, sameAttestedKey } from "./receipt.mjs";

test("Apple's token is ES256, signed with the key, naming the key and the team", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const token = appleToken({ keyId: "ABC123DEFG", teamId: "24FX5MG467", privateKey: pem }, 1_800_000_000_000);
  const [header, claims, signature] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "ES256", kid: "ABC123DEFG" });
  assert.deepEqual(JSON.parse(Buffer.from(claims, "base64url")), { iss: "24FX5MG467", iat: 1_800_000_000 });
  assert.ok(verify("sha256", Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(signature, "base64url")));
});

test("the key setting is read as base64 of the .p8 file, or the file itself", () => {
  const pem = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" });
  assert.equal(privateKeyFrom(Buffer.from(pem).toString("base64")), pem);
  assert.equal(privateKeyFrom(pem), pem);
  assert.equal(privateKeyFrom("not a key"), null);
  assert.equal(privateKeyFrom(undefined), null);
});

// Real attestations from node-app-attest's tests, pinned at 1.0.1: one development, one production.
for (const environment of ["development", "production"]) {
  const fixture = JSON.parse(readFileSync(new URL(`../../../node_modules/node-app-attest/test/fixtures/attestation-${environment}.json`, import.meta.url)));
  const attested = verifyAttestation({
    attestation: Buffer.from(fixture.attestation, "base64"),
    challenge: Buffer.from(fixture.challenge, "base64"),
    keyId: fixture.keyId,
    bundleIdentifier: "io.uebelacker.AppAttestExample",
    teamIdentifier: "V8H6LQ9448",
    allowDevelopmentEnvironment: true,
  });
  const issued = new Date(environment === "development" ? "2024-02-05" : "2024-02-08");

  test(`a ${environment} receipt reads, signed by Apple, for the attested key`, async () => {
    assert.equal(attested.environment, environment);
    const receipt = await readReceipt(attested.receipt, issued);
    assert.equal(receipt.appId, "V8H6LQ9448.io.uebelacker.AppAttestExample");
    assert.equal(receipt.type, "ATTEST");
    assert.equal(receipt.environment, environment === "development" ? "sandbox" : "production");
    assert.ok(receipt.created instanceof Date);
    assert.equal(receipt.riskMetric, undefined);
    assert.ok(sameAttestedKey(receipt.attestedKey, attested.publicKey));
  });

  test(`a ${environment} receipt with changed contents is refused`, async () => {
    const changed = Buffer.from(attested.receipt);
    const at = changed.indexOf(Buffer.from("uebelacker"));
    changed[at] ^= 0x01;
    await assert.rejects(readReceipt(changed, issued));
  });

  test(`a ${environment} receipt is refused once its certificates expire`, async () => {
    await assert.rejects(readReceipt(attested.receipt, new Date("2045-01-01")));
  });
}

test("a receipt's key must match the attestation's", () => {
  const other = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "pem" });
  assert.equal(sameAttestedKey(Buffer.from("junk"), other), false);
  assert.equal(sameAttestedKey(undefined, other), false);
});
