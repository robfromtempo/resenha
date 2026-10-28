// node --test netlify/functions/signup/core.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validHandle, issueChallenge, readChallenge, deviceAllowance, monthsSince, dayOf, CHALLENGE_SECONDS,
} from "./core.mjs";

const SECRET = "test-secret";

test("handles of the right shape pass, lowercased", () => {
  assert.equal(validHandle("Reader.resenha.ink"), "reader.resenha.ink");
  assert.equal(validHandle("abc.resenha.ink"), "abc.resenha.ink");
  assert.equal(validHandle("a-very-long-name-1.resenha.ink"), "a-very-long-name-1.resenha.ink");
  assert.equal(validHandle("a--b.resenha.ink"), "a--b.resenha.ink");
});

test("handles of the wrong shape fail", () => {
  for (const bad of ["ab.resenha.ink", "a-very-long-name-12.resenha.ink", "-abc.resenha.ink", "abc-.resenha.ink",
    "a.b.resenha.ink", "abc_d.resenha.ink", "abc.bsky.social", "abc", "", null, 42]) {
    assert.equal(validHandle(bad), null, String(bad));
  }
});

test("a challenge reads back with its handle", () => {
  const token = issueChallenge("reader.resenha.ink", SECRET);
  const read = readChallenge(token, SECRET);
  assert.equal(read.handle, "reader.resenha.ink");
  assert.equal(typeof read.nonce, "string");
});

test("two challenges differ", () => {
  assert.notEqual(issueChallenge("reader.resenha.ink", SECRET), issueChallenge("reader.resenha.ink", SECRET));
});

test("a tampered challenge is refused", () => {
  const token = issueChallenge("reader.resenha.ink", SECRET);
  const [payload, signature] = token.split(".");
  const other = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url")), h: "other.resenha.ink" })).toString("base64url");
  assert.throws(() => readChallenge(`${other}.${signature}`, SECRET), { code: "bad_challenge" });
  assert.throws(() => readChallenge(token, "another-secret"), { code: "bad_challenge" });
  assert.throws(() => readChallenge(`${token}.x`, SECRET), { code: "bad_challenge" });
  assert.throws(() => readChallenge("garbage", SECRET), { code: "bad_challenge" });
  assert.throws(() => readChallenge(undefined, SECRET), { code: "bad_challenge" });
});

test("an expired challenge is refused", () => {
  const issued = Date.now() - (CHALLENGE_SECONDS + 5) * 1000;
  const token = issueChallenge("reader.resenha.ink", SECRET, issued);
  assert.throws(() => readChallenge(token, SECRET), { code: "expired_challenge" });
  assert.doesNotThrow(() => readChallenge(token, SECRET, issued + 1000));
});

test("a device makes three accounts, then waits six months for each more", () => {
  const now = new Date(Date.UTC(2026, 9, 28));
  assert.deepEqual(deviceAllowance(0, null, now), { allowed: true, next: 1 });
  assert.deepEqual(deviceAllowance(1, "2026-10", now), { allowed: true, next: 2 });
  assert.deepEqual(deviceAllowance(2, "2026-10", now), { allowed: true, next: 3 });
  assert.deepEqual(deviceAllowance(3, "2026-10", now), { allowed: false, next: 3 });
  assert.deepEqual(deviceAllowance(3, "2026-05", now), { allowed: false, next: 3 });
  assert.deepEqual(deviceAllowance(3, "2026-04", now), { allowed: true, next: 3 });
  assert.deepEqual(deviceAllowance(3, null, now), { allowed: false, next: 3 });
  assert.deepEqual(deviceAllowance(3, "garbage", now), { allowed: false, next: 3 });
});

test("months count across a year", () => {
  assert.equal(monthsSince("2025-11", new Date(Date.UTC(2026, 4, 1))), 6);
  assert.equal(monthsSince("2026-05", new Date(Date.UTC(2026, 4, 31))), 0);
  assert.equal(monthsSince("2026-5", new Date()), null);
});

test("days are UTC dates", () => {
  assert.equal(dayOf(new Date("2026-10-28T23:59:59-05:00")), "2026-10-29");
});
