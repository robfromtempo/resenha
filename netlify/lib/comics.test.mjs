// node --test netlify/lib/comics.test.mjs
// Kept outside netlify/functions, where every top-level file is a function.
import { test } from "node:test";
import assert from "node:assert/strict";
import { thumbnail } from "../functions/comics.mjs";

const DID = "did:plc:beygtqob7ofm6e3omfbdrgdu";
const CID = "bafkreihsn6sgbvupbtdxjh5cwjl6rl7roiux5ayzj3rvkw4yw7afcn2i4u";
const blob = { ref: { $link: CID } };

/** The address the image CDN is asked to fetch, out of a thumbnail's url= parameter. */
function source(address) {
  return new URL(new URL(address).searchParams.get("url"));
}

test("a thumbnail asks the CDN for the picture door with the DID unescaped, as Netlify routes /img/:did/:cid", () => {
  const address = thumbnail("https://pds.example", DID, blob, 400);
  assert.ok(address.startsWith("https://resenha.ink/.netlify/images?url="));
  assert.equal(new URL(address).searchParams.get("w"), "400");
  const door = source(address);
  assert.equal(door.origin, "https://resenha.ink");
  // The raw path, as the router sees it: an escaped colon (did%3Aplc) never reaches the function and answers 404.
  assert.equal(door.pathname, `/img/${DID}/${CID}`);
  assert.ok(!door.pathname.includes("%"), door.pathname);
});

test("a did:web creator's thumbnail keeps its DID as written", () => {
  const door = source(thumbnail("https://pds.example", "did:web:comics.example.com", blob, 900));
  assert.equal(door.pathname, `/img/did:web:comics.example.com/${CID}`);
});

test("no thumbnail for a blob without a plain cid, or for an account that isn't a DID", () => {
  assert.equal(thumbnail("https://pds.example", DID, null, 400), null);
  assert.equal(thumbnail("https://pds.example", DID, { ref: { $link: "../x" } }, 400), null);
  assert.equal(thumbnail("https://pds.example", "did:plc:../../x", blob, 400), null);
});
