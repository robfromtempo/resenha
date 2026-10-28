// node --test netlify/functions/signup/core.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { validHandle, issueChallenge, readChallenge, CHALLENGE_SECONDS } from "./core.mjs";

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
