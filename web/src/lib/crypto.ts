import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"

export interface CalculateFileSha256Options {
  chunkSize?: number
  signal?: AbortSignal
  onProgress?: (processedBytes: number, totalBytes: number) => void
}

const DEFAULT_CHUNK_SIZE = 2 * 1024 * 1024

export async function calculateFileSha256(
  file: File | Blob,
  options?: CalculateFileSha256Options
): Promise<string | null> {
  try {
    const totalBytes = file.size
    const chunkSize = options?.chunkSize ?? DEFAULT_CHUNK_SIZE
    const signal = options?.signal
    const onProgress = options?.onProgress

    if (signal?.aborted) {
      return null
    }

    const hasher = sha256.create()
    let offset = 0

    if (totalBytes === 0) {
      return bytesToHex(hasher.digest())
    }

    while (offset < totalBytes) {
      if (signal?.aborted) {
        return null
      }

      const end = Math.min(offset + chunkSize, totalBytes)
      const chunk = file.slice(offset, end)
      const buffer = await chunk.arrayBuffer()
      hasher.update(new Uint8Array(buffer))

      offset = end
      onProgress?.(offset, totalBytes)
    }

    return bytesToHex(hasher.digest())
  } catch {
    return null
  }
}
