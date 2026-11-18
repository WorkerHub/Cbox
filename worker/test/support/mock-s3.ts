import type { MockR2Bucket } from "./mock-r2"

interface MultipartUploadSession {
  key: string
  parts: Map<number, Uint8Array>
}

/**
 * 创建针对测试环境的 S3 交互 mock fetch。
 * 支持：
 * - initiateMultipartUpload (POST ?uploads)
 * - uploadPart (PUT ?partNumber=X&uploadId=Y)
 * - completeMultipartUpload (POST ?uploadId=Y)
 * - abortMultipartUpload (DELETE ?uploadId=Y)
 * - presigned single put (PUT /bucket/key)
 */
export function createMockS3Fetch(r2: MockR2Bucket): typeof fetch {
  const multipartSessions = new Map<string, MultipartUploadSession>()

  return (async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const req =
      input instanceof Request ? input : new Request(input.toString(), init)

    const url = new URL(req.url)
    const searchParams = url.searchParams
    const pathname = url.pathname // e.g. /bucket-name/u1/file-id

    // 解析 key：去掉第一段 /bucket/
    const parts = pathname.replace(/^\/+/, "").split("/")
    // parts[0] is bucket name, remaining is key
    const key = parts.slice(1).join("/")

    // 1. Initiate Multipart: POST ?uploads
    if (req.method === "POST" && searchParams.has("uploads")) {
      const uploadId = `mock-upload-${crypto.randomUUID()}`
      multipartSessions.set(uploadId, {
        key,
        parts: new Map()
      })

      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>${parts[0]}</Bucket>
  <Key>${key}</Key>
  <UploadId>${uploadId}</UploadId>
</InitiateMultipartUploadResult>`

      return new Response(xml, {
        status: 200,
        headers: { "Content-Type": "application/xml" }
      })
    }

    // 2. Upload Part: PUT ?partNumber=X&uploadId=Y
    if (
      req.method === "PUT" &&
      searchParams.has("uploadId") &&
      searchParams.has("partNumber")
    ) {
      const uploadId = searchParams.get("uploadId")!
      const partNumber = parseInt(searchParams.get("partNumber")!, 10)
      const session = multipartSessions.get(uploadId)
      if (!session) {
        return new Response("Upload session not found", { status: 404 })
      }

      const bodyBuffer = await req.arrayBuffer()
      session.parts.set(partNumber, new Uint8Array(bodyBuffer))

      return new Response(null, {
        status: 200,
        headers: {
          ETag: `"mock-etag-${partNumber}"`
        }
      })
    }

    // 3. Complete Multipart: POST ?uploadId=Y
    if (req.method === "POST" && searchParams.has("uploadId")) {
      const uploadId = searchParams.get("uploadId")!
      const session = multipartSessions.get(uploadId)
      if (!session) {
        return new Response("Upload session not found", { status: 404 })
      }

      // 按 partNumber 排序拼接
      const sortedPartNumbers = Array.from(session.parts.keys()).sort(
        (a, b) => a - b
      )
      let totalLength = 0
      for (const p of sortedPartNumbers) {
        totalLength += session.parts.get(p)!.byteLength
      }
      const combined = new Uint8Array(totalLength)
      let offset = 0
      for (const p of sortedPartNumbers) {
        const chunk = session.parts.get(p)!
        combined.set(chunk, offset)
        offset += chunk.byteLength
      }

      await r2.put(key, combined)
      multipartSessions.delete(uploadId)

      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Location>https://${url.host}/${parts[0]}/${key}</Location>
  <Bucket>${parts[0]}</Bucket>
  <Key>${key}</Key>
  <ETag>"mock-complete-etag"</ETag>
</CompleteMultipartUploadResult>`

      return new Response(xml, {
        status: 200,
        headers: { "Content-Type": "application/xml" }
      })
    }

    // 4. Abort Multipart: DELETE ?uploadId=Y
    if (req.method === "DELETE" && searchParams.has("uploadId")) {
      const uploadId = searchParams.get("uploadId")!
      multipartSessions.delete(uploadId)
      return new Response(null, { status: 204 })
    }

    // 5. Presigned Single PUT: PUT /bucket/key
    if (req.method === "PUT") {
      const bodyBuffer = await req.arrayBuffer()
      await r2.put(key, new Uint8Array(bodyBuffer), {
        httpMetadata: {
          contentType: req.headers.get("Content-Type") || undefined
        }
      })
      return new Response(null, {
        status: 200,
        headers: {
          ETag: `"mock-etag"`
        }
      })
    }

    return new Response("Not found in mock S3", { status: 404 })
  }) as typeof fetch
}
