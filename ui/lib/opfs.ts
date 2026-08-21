/**
 * Best effort persistent cache for the published parquet, backed by the Origin
 * Private File System with an in memory fallback.
 *
 * The query table is the only large artifact the UI downloads. Caching it means
 * the second visit, and every navigation between pages, costs no gateway
 * traffic. Every OPFS call is wrapped: Safari private windows, older Firefox and
 * locked down enterprise profiles all fail here in different ways, and none of
 * those failures should stop the app from working.
 */

const memoryCache = new Map<string, Uint8Array>();

const DIRECTORY = "artifact-cache";

function keyFor(url: string, version: string | null): string {
  const raw = version ? `${url}::${version}` : url;
  let hash = 0x811c9dc5;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `qt-${hash.toString(16)}.parquet`;
}

async function directory(): Promise<FileSystemDirectoryHandle | null> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) return null;
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(DIRECTORY, { create: true });
  } catch {
    return null;
  }
}

export async function cacheGet(url: string, version: string | null): Promise<Uint8Array | null> {
  const key = keyFor(url, version);
  const inMemory = memoryCache.get(key);
  if (inMemory) return inMemory;

  const dir = await directory();
  if (!dir) return null;
  try {
    const handle = await dir.getFileHandle(key);
    const file = await handle.getFile();
    if (file.size === 0) return null;
    const bytes = new Uint8Array(await file.arrayBuffer());
    memoryCache.set(key, bytes);
    return bytes;
  } catch {
    return null;
  }
}

export async function cachePut(url: string, version: string | null, bytes: Uint8Array): Promise<void> {
  const key = keyFor(url, version);
  memoryCache.set(key, bytes);

  const dir = await directory();
  if (!dir) return;
  try {
    const handle = await dir.getFileHandle(key, { create: true });
    const writable = await handle.createWritable();
    // Copy into a plain ArrayBuffer so the write is not tied to the wasm heap.
    await writable.write(bytes.slice().buffer as ArrayBuffer);
    await writable.close();
  } catch {
    // Cache is an optimisation. Losing it is not an error worth surfacing.
  }
}

export async function cacheClear(): Promise<void> {
  memoryCache.clear();
  const dir = await directory();
  if (!dir) return;
  try {
    const entries = dir as unknown as {
      keys?: () => AsyncIterableIterator<string>;
      removeEntry: (name: string) => Promise<void>;
    };
    if (!entries.keys) return;
    const names: string[] = [];
    for await (const name of entries.keys()) names.push(name);
    for (const name of names) await entries.removeEntry(name);
  } catch {
    // ignore
  }
}
