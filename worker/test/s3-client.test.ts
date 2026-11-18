import { describe, expect, it } from "vitest"
import {
  R2_BUCKET_NAME,
  abortMultipartUpload,
  assertS3Configured,
  completeMultipartUpload,
  getBucketUrl,
  getPresignedPartPutUrl,
  getPresignedPutUrl,
  getS3Endpoint,
  initiateMultipartUpload,
  isS3Configured
} from "../src/lib/s3"
import type { Env } from "../src/types"

describe("S3 Client & SigV4 Helper (s3.ts)", () => {
  const dummyEnv: Env = {
    DB: {} as any,
    FILES: {} as any,
    ASSETS: {} as any,
    R2_ACCESS_KEY_ID: "dummy-access-key-id",
    R2_SECRET_ACCESS_KEY: "dummy-secret-access-key-value",
    CLOUDFLARE_ACCOUNT_ID: "dummy-account-id"
  }

  it("isS3Configured 判定与 assertS3Configured 抛错", () => {
    expect(isS3Configured(dummyEnv)).toBe(true)

    const incompleteEnv: Env = { ...dummyEnv, R2_ACCESS_KEY_ID: undefined }
    expect(isS3Configured(incompleteEnv)).toBe(false)
    expect(() => assertS3Configured(incompleteEnv)).toThrow("not configured")
  })

  it("S3 Endpoint 与 Bucket URL 正确推导", () => {
    expect(getS3Endpoint(dummyEnv)).toBe(
      "https://dummy-account-id.r2.cloudflarestorage.com"
    )
    expect(getBucketUrl(dummyEnv)).toBe(
      `https://dummy-account-id.r2.cloudflarestorage.com/${R2_BUCKET_NAME}`
    )
  })

  it("getPresignedPutUrl 生成单文件上传预签名 URL（仅绑定 Content-Length，不绑定 Content-Type）", async () => {
    const key = "u1/test-file.png"
    const sizeBytes = 1048576 // 1 MiB

    const urlStr = await getPresignedPutUrl(dummyEnv, key, sizeBytes)
    const url = new URL(urlStr)

    expect(url.origin).toBe("https://dummy-account-id.r2.cloudflarestorage.com")
    expect(url.pathname).toBe(`/${R2_BUCKET_NAME}/${key}`)
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900")
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256")
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy()

    // 关键断言：X-Amz-SignedHeaders 必须包含 content-length，且不得包含 content-type
    const signedHeaders = url.searchParams.get("X-Amz-SignedHeaders")
    expect(signedHeaders).toContain("content-length")
    expect(signedHeaders).not.toContain("content-type")
    expect(signedHeaders).toContain("host")
  })

  it("getPresignedPartPutUrl 生成分片预签名 URL（包含 partNumber 与 uploadId 参数）", async () => {
    const key = "u1/multipart-file.zip"
    const uploadId = "upload-123456"
    const partNumber = 3

    const urlStr = await getPresignedPartPutUrl(
      dummyEnv,
      key,
      uploadId,
      partNumber
    )
    const url = new URL(urlStr)

    expect(url.origin).toBe("https://dummy-account-id.r2.cloudflarestorage.com")
    expect(url.pathname).toBe(`/${R2_BUCKET_NAME}/${key}`)
    expect(url.searchParams.get("partNumber")).toBe("3")
    expect(url.searchParams.get("uploadId")).toBe("upload-123456")
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900")
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy()
  })

  it("initiateMultipartUpload 发起分片任务并提取 UploadId", async () => {
    const mockXml = `<?xml version="1.0" encoding="UTF-8"?>
<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>${R2_BUCKET_NAME}</Bucket>
  <Key>u1/big.iso</Key>
  <UploadId>mp-upload-id-xyz-789</UploadId>
</InitiateMultipartUploadResult>`

    let capturedReq: Request | null = null
    const customFetch: typeof fetch = async (
      req: RequestInfo | URL,
      init?: RequestInit
    ) => {
      capturedReq = new Request(req, init)
      return new Response(mockXml, {
        status: 200,
        headers: { "Content-Type": "application/xml" }
      })
    }

    const uploadId = await initiateMultipartUpload(
      dummyEnv,
      "u1/big.iso",
      "application/octet-stream",
      customFetch
    )

    expect(uploadId).toBe("mp-upload-id-xyz-789")
    expect(capturedReq).not.toBeNull()
    const reqUrl = new URL(capturedReq!.url)
    expect(reqUrl.searchParams.has("uploads")).toBe(true)
    expect(capturedReq!.method).toBe("POST")
  })

  it("completeMultipartUpload 组装 XML 并完成分片任务", async () => {
    let capturedReq: Request | null = null
    const customFetch: typeof fetch = async (
      req: RequestInfo | URL,
      init?: RequestInit
    ) => {
      capturedReq = new Request(req, init)
      return new Response(
        `<CompleteMultipartUploadResult><Location>loc</Location></CompleteMultipartUploadResult>`,
        { status: 200, headers: { "Content-Type": "application/xml" } }
      )
    }

    const parts = [
      { partNumber: 2, etag: '"etag-2"' },
      { partNumber: 1, etag: "etag-1" } // 未带引号应被自动包装
    ]

    await completeMultipartUpload(
      dummyEnv,
      "u1/big.iso",
      "mp-upload-id-xyz-789",
      parts,
      customFetch
    )

    expect(capturedReq).not.toBeNull()
    const reqUrl = new URL(capturedReq!.url)
    expect(reqUrl.searchParams.get("uploadId")).toBe("mp-upload-id-xyz-789")
    expect(capturedReq!.method).toBe("POST")
    const body = await capturedReq!.text()

    // 必须包含按 partNumber 排序的 XML 结构
    expect(body).toContain("<CompleteMultipartUpload>")
    expect(body).toContain("<PartNumber>1</PartNumber>")
    expect(body).toContain('<ETag>"etag-1"</ETag>')
    expect(body).toContain("<PartNumber>2</PartNumber>")
    expect(body).toContain('<ETag>"etag-2"</ETag>')
    // 检查排序（1 在 2 前面）
    expect(body.indexOf("<PartNumber>1</PartNumber>")).toBeLessThan(
      body.indexOf("<PartNumber>2</PartNumber>")
    )
  })

  it("abortMultipartUpload 发送 DELETE 中止任务", async () => {
    let capturedReq: Request | null = null
    const customFetch: typeof fetch = async (
      req: RequestInfo | URL,
      init?: RequestInit
    ) => {
      capturedReq = new Request(req, init)
      return new Response(null, { status: 204 })
    }

    await abortMultipartUpload(
      dummyEnv,
      "u1/big.iso",
      "mp-upload-id-xyz-789",
      customFetch
    )

    expect(capturedReq).not.toBeNull()
    const reqUrl = new URL(capturedReq!.url)
    expect(reqUrl.searchParams.get("uploadId")).toBe("mp-upload-id-xyz-789")
    expect(capturedReq!.method).toBe("DELETE")
  })
})
