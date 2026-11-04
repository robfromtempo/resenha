// Addresses taken from records and DID documents, which anyone can write, are checked before the site fetches them:
// only public https hosts on the standard port, never a private or internal address. Shared by the functions that
// read readers' own servers (reviews, blocks, comics). Kept outside netlify/functions, where every file is a function.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** How long any fetch of a reader-named host may take. */
export const FETCH_TIMEOUT_MS = 8000;

/** Options for a fetch of a host taken from a record: no redirects (they could lead anywhere), a time limit. */
export function safeFetchOptions(extra = {}) {
  return { redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), ...extra };
}

const known = new Map();

/** The origin of `url` when it's a public https host, else null. Answers are kept ten minutes per host. */
export async function safeOrigin(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
  if (parsed.port && parsed.port !== "443") return null;
  const host = parsed.hostname.toLowerCase();
  if (!(await isPublicHost(host))) return null;
  return `https://${host}`;
}

/** Whether a host name is a public one: not an address written out, not a local or internal name, and not resolving
 *  to a private, loopback or link-local address. */
export async function isPublicHost(host) {
  if (!host || host.length > 253 || isIP(host.replace(/^\[|\]$/g, ""))) return false;
  if (host === "localhost" || /\.(local|internal|localhost|lan|home|corp|intranet|flycast)$/.test(host)) return false;
  const cached = known.get(host);
  if (cached && Date.now() - cached.at < 600_000) return cached.ok;
  let ok = false;
  try {
    const addresses = await lookup(host, { all: true });
    ok = addresses.length > 0 && addresses.every((a) => !isPrivate(a.address));
  } catch {
    ok = false;
  }
  known.set(host, { ok, at: Date.now() });
  return ok;
}

function isPrivate(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = address.toLowerCase();
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe8") || v6.startsWith("fe9")
    || v6.startsWith("fea") || v6.startsWith("feb") || v6.startsWith("::ffff:");
}
