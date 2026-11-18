/**
 * 上传前用 Web Crypto 计算文件 SHA-256 哈希（规格 §5.2、§6）。
 * 遇到巨大文件或异常时捕获并返回 null，留空随上传提交，绝不阻塞用户上传。
 */
export async function calculateFileSha256(file: File): Promise<string | null> {
  try {
    if (typeof crypto === "undefined" || !crypto.subtle) {
      return null
    }
    const buffer = await file.arrayBuffer()
    const digestBuffer = await crypto.subtle.digest("SHA-256", buffer)
    const bytes = new Uint8Array(digestBuffer)
    let hex = ""
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, "0")
    }
    return hex
  } catch {
    return null
  }
}
