import { ed25519 } from "@noble/curves/ed25519.js";
import * as cborg from "cborg";
import { base36 } from "multiformats/bases/base36";
import { CID } from "multiformats/cid";
import { UnsupportedContenthashError } from "../contenthash.js";

// IPNS: a *mutable* pointer on top of immutable IPFS.
//
//   name   = hash of a public key        (what ENS stores; never changes)
//   record = signed note from the key's owner:
//              "name k51... currently points at /ipfs/<cid>"   + sequence number + expiry
//
// The owner publishes a newer record to update the site: no ENS transaction, no gas.
// We don't trust whoever hands us a record. We check three things ourselves:
//   1. the signature is valid for the public key the NAME was derived from
//   2. the record hasn't expired
//   3. if several valid records exist, the highest sequence number wins
// Residual risk: a server can hand us an *older* valid record (a rollback) until it
// expires. Signatures can prove a record is genuine, but not that it's the latest.

export class IpnsError extends Error {}
export class IpnsNotFoundError extends IpnsError {}

export interface IpnsResult {
  /** Root CID the name points to. */
  cid: string;
  /** Sub-path inside that CID, if the record pointed at /ipfs/<cid>/some/dir. */
  path: string[];
  sequence: bigint;
  /** How long the publisher says this answer may be cached. */
  ttlMs: number;
}

// ---- 1. Reading the record: a tiny protobuf parser --------------------------
// Protobuf is a compact binary format: a sequence of (field number + wire type,
// value) pairs. We only need two wire types:
//   0 = varint (a number)         2 = length-delimited (bytes)
function readVarint(buf: Uint8Array, pos: number): [number, number] {
  let value = 0, shift = 0;
  for (let i = pos; i < buf.length; i++) {
    value += (buf[i] & 0x7f) * 2 ** shift; // not <<, which would overflow 32 bits
    if ((buf[i] & 0x80) === 0) return [value, i + 1];
    shift += 7;
    if (shift > 63) break;
  }
  throw new IpnsError("malformed protobuf varint");
}

function parseProtobuf(buf: Uint8Array): Map<number, Uint8Array | number> {
  const fields = new Map<number, Uint8Array | number>();
  let pos = 0;
  while (pos < buf.length) {
    let tag: number;
    [tag, pos] = readVarint(buf, pos);
    const field = tag >>> 3, wire = tag & 7;
    if (wire === 0) {
      let v: number;
      [v, pos] = readVarint(buf, pos);
      fields.set(field, v);
    } else if (wire === 2) {
      let len: number;
      [len, pos] = readVarint(buf, pos);
      if (pos + len > buf.length) throw new IpnsError("protobuf field overruns buffer");
      fields.set(field, buf.subarray(pos, pos + len));
      pos += len;
    } else {
      throw new IpnsError(`unsupported protobuf wire type ${wire}`);
    }
  }
  return fields;
}

// ---- 2. Name -> public key ---------------------------------------------------
// An ed25519 IPNS name is a CID whose "hash" is not really a hash: it uses the
// *identity* multihash (code 0x00), meaning the digest IS the data. That data is a
// protobuf PublicKey { KeyType = 1 (Ed25519), Data = 32 key bytes }. So the name
// itself contains the public key: nothing to look up, and nobody can swap it.
const KEYTYPE_ED25519 = 1;
const MULTIHASH_IDENTITY = 0x00;
const CODEC_LIBP2P_KEY = 0x72;

function publicKeyFromName(name: string): Uint8Array {
  let cid: CID;
  try { cid = CID.parse(name, base36); } catch { throw new IpnsError("invalid IPNS name"); }
  if (cid.code !== CODEC_LIBP2P_KEY) throw new IpnsError("not an IPNS key name");
  if (cid.multihash.code !== MULTIHASH_IDENTITY) {
    throw new UnsupportedContenthashError("only ed25519 IPNS keys are supported (RSA keys are not)");
  }
  const key = parseProtobuf(cid.multihash.digest);
  const type = key.get(1), data = key.get(2);
  if (type !== KEYTYPE_ED25519 || !(data instanceof Uint8Array) || data.length !== 32) {
    throw new UnsupportedContenthashError("only ed25519 IPNS keys are supported");
  }
  return data;
}

// ---- 3. Verify one record ----------------------------------------------------
const SIGNATURE_PREFIX = new TextEncoder().encode("ipns-signature:");
const MAX_RECORD_BYTES = 10 * 1024;

// "2026-12-01T00:00:00.123456789Z" -> milliseconds since epoch (nanoseconds truncated)
function parseValidity(bytes: Uint8Array): number {
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?Z$/.exec(new TextDecoder().decode(bytes));
  if (!m) throw new IpnsError("malformed validity timestamp");
  const ms = m[2] ? Number(m[2].slice(0, 3).padEnd(3, "0")) : 0;
  return Date.parse(`${m[1]}Z`) + ms;
}

export function verifyRecord(name: string, raw: Uint8Array, now = Date.now()): IpnsResult {
  if (raw.length > MAX_RECORD_BYTES) throw new IpnsError("record too large");
  const publicKey = publicKeyFromName(name);
  const entry = parseProtobuf(raw);

  // Field 8 = signatureV2, field 9 = data (CBOR). Old V1-only records signed
  // different, weaker data, so we require V2.
  const signature = entry.get(8), data = entry.get(9);
  if (!(signature instanceof Uint8Array) || !(data instanceof Uint8Array)) {
    throw new IpnsError("record has no V2 signature");
  }

  // (1) The signature covers "ipns-signature:" + data, made with the key in the name.
  const signed = new Uint8Array(SIGNATURE_PREFIX.length + data.length);
  signed.set(SIGNATURE_PREFIX);
  signed.set(data, SIGNATURE_PREFIX.length);
  let valid = false;
  try { valid = ed25519.verify(signature, signed, publicKey); } catch { /* malformed => invalid */ }
  if (!valid) throw new IpnsError("invalid signature");

  // Everything below reads from `data`, the signed part, never from the unsigned
  // protobuf fields next to it, which an attacker could alter freely.
  let doc: any;
  try { doc = cborg.decode(data); } catch { throw new IpnsError("malformed record data"); }

  // (2) Expiry. ValidityType 0 means "valid until this timestamp".
  if (doc.ValidityType !== 0 || !(doc.Validity instanceof Uint8Array)) throw new IpnsError("unsupported validity");
  if (parseValidity(doc.Validity) <= now) throw new IpnsError("record expired");

  // The value is a path like "/ipfs/bafy.../optional/subdir".
  if (!(doc.Value instanceof Uint8Array)) throw new IpnsError("record has no value");
  const [, kind, cid, ...path] = new TextDecoder().decode(doc.Value).split("/");
  if (kind === "ipns") throw new UnsupportedContenthashError("IPNS record pointing at another IPNS name");
  if (kind !== "ipfs" || !cid) throw new IpnsError("unrecognised record value");
  try { CID.parse(cid); } catch { throw new IpnsError("record contains an invalid CID"); }

  const ttlNs = Number(doc.TTL ?? 0);
  return {
    cid,
    path: path.filter(Boolean),
    sequence: BigInt(doc.Sequence ?? 0),
    // Clamp: honour the publisher's TTL, but never poll faster than every 30s or sit stale past 5min.
    ttlMs: Math.min(Math.max(ttlNs / 1e6, 30_000), 5 * 60_000),
  };
}

// ---- 4. Find records, keep the best ------------------------------------------
export type IpnsResolver = (name: string) => Promise<IpnsResult>;

export interface IpnsResolverOptions {
  /**
   * Endpoints that serve signed records, as ".../ipns" prefixes. Works with both IPFS
   * gateways (https://ipfs.io/ipns) and delegated routers (https://delegated-ipfs.dev/routing/v1/ipns).
   * All are asked at once; none are trusted, since every record is verified.
   */
  sources: string[];
  fetch?: typeof fetch;
  now?: () => number;
}

export function createIpnsResolver(opts: IpnsResolverOptions): IpnsResolver {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;

  async function fromSource(source: string, name: string): Promise<IpnsResult> {
    const res = await doFetch(`${source.replace(/\/$/, "")}/${name}`, {
      headers: { accept: "application/vnd.ipfs.ipns-record" }, // "give me the signed record, not the website"
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new IpnsError(`${source}: HTTP ${res.status}`);
    // Some routers answer "200 OK" with a plain-text error ("routing: not found").
    // A real record is binary; treat text as the "no record" answer it is.
    if ((res.headers.get("content-type") ?? "").startsWith("text/")) {
      throw new IpnsError(`${source}: ${(await res.text()).trim().slice(0, 60)}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    return verifyRecord(name, bytes, now()); // throws if the signature/expiry check fails
  }

  return async (name) => {
    publicKeyFromName(name); // fail fast, before any network calls, on bad or unsupported names

    const settled = await Promise.allSettled(opts.sources.map((s) => fromSource(s, name)));
    const good = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    if (good.length === 0) {
      // A genuine "unsupported" error should surface as such, not as "not found".
      const unsupported = settled.find((r) => r.status === "rejected" && r.reason instanceof UnsupportedContenthashError);
      if (unsupported && unsupported.status === "rejected") throw unsupported.reason;
      const why = settled.map((r) => (r.status === "rejected" ? String(r.reason.message) : "")).filter(Boolean);
      throw new IpnsNotFoundError(`no valid IPNS record found (${why.join("; ")})`);
    }
    // Highest sequence number = most recent publication.
    return good.reduce((best, r) => (r.sequence > best.sequence ? r : best));
  };
}
