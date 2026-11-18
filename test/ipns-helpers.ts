import { ed25519 } from "@noble/curves/ed25519.js";
import * as cborg from "cborg";
import { base36 } from "multiformats/bases/base36";
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";

const enc = new TextEncoder();

// --- the inverse of what src/ipfs/ipns.ts does: what a *publisher* does ---

function varint(n: number): number[] {
  const out: number[] = [];
  while (n >= 0x80) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
  out.push(n);
  return out;
}
const lenField = (field: number, bytes: Uint8Array) => [...varint((field << 3) | 2), ...varint(bytes.length), ...bytes];
const numField = (field: number, n: number) => [...varint(field << 3), ...varint(n)];

export function newKey() {
  const { secretKey, publicKey } = ed25519.keygen();
  // PublicKey protobuf { KeyType: 1 (Ed25519), Data: <32 bytes> }, wrapped in an identity multihash
  const pkProto = new Uint8Array([...numField(1, 1), ...lenField(2, publicKey)]);
  const cid = CID.createV1(0x72, Digest.create(0x00, pkProto));
  return { secretKey, publicKey, name: cid.toString(base36) };
}

export interface RecordOpts {
  value?: string;          // default "/ipfs/<cid>"
  sequence?: number;
  validUntil?: Date;       // default: tomorrow
  ttlNs?: number;
  tamper?: boolean;        // flip a byte of the signed data after signing
  signWith?: Uint8Array;   // sign with a different key than the name's
}

export function buildRecord(key: ReturnType<typeof newKey>, value: string, o: RecordOpts = {}): Uint8Array {
  const validUntil = o.validUntil ?? new Date(Date.now() + 24 * 3600_000);
  const validity = enc.encode(validUntil.toISOString().replace("Z", "000000Z")); // RFC3339 with nanoseconds
  const sequence = o.sequence ?? 1;
  const ttl = o.ttlNs ?? 60e9;

  let data = cborg.encode({ Value: enc.encode(value), ValidityType: 0, Validity: validity, Sequence: sequence, TTL: ttl });
  const signed = new Uint8Array([...enc.encode("ipns-signature:"), ...data]);
  const signature = ed25519.sign(signed, o.signWith ?? key.secretKey);
  if (o.tamper) { data = data.slice(); data[data.length - 3] ^= 0xff; }

  return new Uint8Array([
    ...lenField(1, enc.encode(value)), ...numField(3, 0), ...lenField(4, validity), ...numField(5, sequence), ...numField(6, ttl),
    ...lenField(8, signature), ...lenField(9, data),
  ]);
}
