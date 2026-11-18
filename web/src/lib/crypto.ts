import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"

export interface CalculateFileSha256Options {
  chunkSize?: number
  signal?: AbortSignal
  onProgress?: (processedBytes: number, totalBytes: number) => void
}

const DEFAULT_CHUNK_SIZE = 2 * 1024 * 1024 // 2 MiB 滚动分片

/**
 * 上传前用增量分片计算文件 SHA-256 哈希（规格 §5.2、§6）。
 * 文件读取一律通过 Blob.slice 分片滚动读取，不得整文件读入内存。
 * 遇到异常或被中断时捕获并返回 null，留空随上传提交，绝不阻塞用户上传。
 */
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
