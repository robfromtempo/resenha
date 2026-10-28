// Reads an App Attest receipt: a PKCS #7 container signed by Apple, holding numbered fields. Attestations carry one
// (type ATTEST); Apple's attestationData endpoint swaps it for a new one (type RECEIPT) that adds the risk metric,
// the number of App Attest keys the device made for the app in the last 30 days.
// https://developer.apple.com/documentation/devicecheck/assessing-fraud-risk

import { X509Certificate } from "node:crypto";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";

/** Apple Root CA - G3, from apple.com/certificateauthority. SHA-256 fingerprint 63:34:3A:BF:…:3E:91:79. Receipts
 *  carry a copy of it too; the chain is checked against this one, never theirs. */
const APPLE_ROOT_CA_G3 = `-----BEGIN CERTIFICATE-----
MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwS
QXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9u
IEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcN
MTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBS
b290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9y
aXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49
AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtf
TjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517
IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySr
MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gA
MGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4
at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM
6BgD56KyKA==
-----END CERTIFICATE-----`;

const FIELD = { appId: 2, attestedKey: 3, type: 6, environment: 7, created: 12, riskMetric: 17, notBefore: 19, expires: 21 };

/** The receipt's fields, once Apple's signature and chain to Apple Root CA - G3 hold at `at`. Throws otherwise. */
export async function readReceipt(receipt, at = new Date()) {
  const asn1 = asn1js.fromBER(toArrayBuffer(receipt));
  if (asn1.offset === -1) throw new Error("receipt isn't DER");
  const signed = new pkijs.SignedData({ schema: new pkijs.ContentInfo({ schema: asn1.result }).content });

  const root = pkijs.Certificate.fromBER(toArrayBuffer(pemBody(APPLE_ROOT_CA_G3)));
  const verified = await signed.verify({
    signer: 0,
    trustedCerts: [root],
    checkChain: true,
    checkDate: at,
    extendedMode: true,
  });
  if (!verified.signatureVerified) throw new Error("receipt signature doesn't verify");

  const fields = new Map();
  const set = asn1js.fromBER(toArrayBuffer(octets(signed.encapContentInfo.eContent))).result;
  for (const entry of set.valueBlock.value ?? []) {
    const [type, , value] = entry.valueBlock.value ?? [];
    if (type && value) fields.set(type.valueBlock.valueDec, Buffer.from(value.valueBlock.valueHexView));
  }
  const text = (n) => fields.get(n)?.toString("utf8");
  return {
    appId: text(FIELD.appId),
    attestedKey: fields.get(FIELD.attestedKey),
    type: text(FIELD.type),
    environment: text(FIELD.environment),
    created: dateOf(text(FIELD.created)),
    riskMetric: text(FIELD.riskMetric) === undefined ? undefined : Number(text(FIELD.riskMetric)),
    notBefore: dateOf(text(FIELD.notBefore)),
    expires: dateOf(text(FIELD.expires)),
  };
}

/** Whether the receipt's attested key, a certificate, holds the same public key the attestation did. */
export function sameAttestedKey(attestedKey, publicKeyPem) {
  if (!attestedKey) return false;
  try {
    return new X509Certificate(attestedKey).publicKey.export({ type: "spki", format: "pem" }) === publicKeyPem;
  } catch {
    return false;
  }
}

function octets(block) {
  const value = block.valueBlock;
  if (!value.isConstructed) return Buffer.from(value.valueHexView);
  return Buffer.concat(value.value.map(octets));
}

function dateOf(text) {
  if (!text) return undefined;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function pemBody(pem) {
  return Buffer.from(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
}

function toArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}
