import { describe, expect, it } from "vitest"
import { calculateFileSha256 } from "./crypto"

describe("calculateFileSha256", () => {
  it("计算文件内容正确的 SHA-256", async () => {
    const file = new File(["hello world"], "test.txt", { type: "text/plain" })
    const hash = await calculateFileSha256(file)
    // sha256 of "hello world" is b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
    expect(hash).toBe(
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
    )
  })

  it("空文件哈希计算正确", async () => {
    const file = new File([], "empty.txt", { type: "text/plain" })
    const hash = await calculateFileSha256(file)
    // sha256 of empty string is e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    expect(hash).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    )
  })

  it("当 arrayBuffer 抛错时返回 null，不阻塞", async () => {
    const brokenFile = {
      arrayBuffer: () => Promise.reject(new Error("OOM"))
    } as unknown as File

    const hash = await calculateFileSha256(brokenFile)
    expect(hash).toBeNull()
  })
})
