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

  it("支持多分片滚动计算且结果与单片一致", async () => {
    const content = "a".repeat(1024 * 10)
    const file = new File([content], "large.txt", { type: "text/plain" })
    const singleHash = await calculateFileSha256(file, { chunkSize: 1024 * 100 })
    const chunkedHash = await calculateFileSha256(file, { chunkSize: 1024 })
    expect(chunkedHash).toBe(singleHash)
  })

  it("支持传入 AbortSignal 中断计算并返回 null", async () => {
    const content = "b".repeat(1024 * 10)
    const file = new File([content], "abort.txt", { type: "text/plain" })
    const controller = new AbortController()
    controller.abort()
    const hash = await calculateFileSha256(file, { signal: controller.signal })
    expect(hash).toBeNull()
  })

  it("当 slice 或 arrayBuffer 抛错时返回 null，不阻塞", async () => {
    const brokenFile = {
      size: 100,
      slice: () => {
        throw new Error("Disk error")
      }
    } as unknown as File

    const hash = await calculateFileSha256(brokenFile)
    expect(hash).toBeNull()
  })
})
