import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { CID } from "multiformats/cid";

const require = createRequire(import.meta.url);
const ipfsOnlyHash = require("ipfs-only-hash") as {
  of: (content: Uint8Array | string, options?: Record<string, unknown>) => Promise<string>;
};

export interface CidResult {
  /** CID exactly as the reference Elephant scripts compute it (ipfs-only-hash defaults). */
  cid: string;
  /** Same multihash rendered as CIDv1 base32 (what Filebase echoes in x-amz-meta-cid for dag-pb). */
  cidV1: string;
  sha256: string;
  bytes: number;
}

/** Local, network-free CID computation (same library + defaults as elephant-query-db uploaders). */
export async function computeCid(content: Buffer): Promise<CidResult> {
  const cid = await ipfsOnlyHash.of(content);
  const parsed = CID.parse(cid);
  return {
    cid,
    cidV1: parsed.toV1().toString(),
    sha256: createHash("sha256").update(content).digest("hex"),
    bytes: content.byteLength,
  };
}

export async function computeFileCid(path: string): Promise<CidResult> {
  return computeCid(await readFile(path));
}

/** True when two CID strings address the same content (v0/v1 render of one multihash). */
export function sameCid(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  try {
    return CID.parse(a).toV1().toString() === CID.parse(b).toV1().toString();
  } catch {
    return a === b;
  }
}
