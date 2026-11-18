import { AwsClient } from "aws4fetch"
import { PROJECT_SLUG } from "../config/project"
import type { Env } from "../types"

export const R2_BUCKET_NAME = `${PROJECT_SLUG}-files`
export const PRESIGNED_URL_EXPIRES_SECONDS = 900 // 15 minutes

export function isS3Configured(env: Env): boolean {
  return Boolean(
    env.R2_ACCESS_KEY_ID &&
      env.R2_SECRET_ACCESS_KEY &&
      env.CLOUDFLARE_ACCOUNT_ID
  )
}

export function assertS3Configured(env: Env): void {
  if (!isS3Configured(env)) {
    throw new Error(
      "S3 credentials (R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, CLOUDFLARE_ACCOUNT_ID) are not configured"
    )
  }
}

export function getS3Endpoint(env: Env): string {
  assertS3Configured(env)
  return `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`
}

export function getBucketUrl(env: Env): string {
  return `${getS3Endpoint(env)}/${R2_BUCKET_NAME}`
}

export function getS3Client(env: Env): AwsClient {
  assertS3Configured(env)
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID!,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    service: "s3",
    region: "auto"
  })
}

/**
 * 为单文件直传生成预签名 PUT URL（15 分钟有效）。
 * 强制绑定 Content-Length（防止篡改与限额突破）与 Content-Type。
 */
export async function getPresignedPutUrl(
  env: Env,
  key: string,
  sizeBytes: number,
  contentType: string,
  expiresInSeconds: number = PRESIGNED_URL_EXPIRES_SECONDS
): Promise<string> {
  const client = getS3Client(env)
  const url = `${getBucketUrl(env)}/${key}?X-Amz-Expires=${expiresInSeconds}`
  const req = new Request(url, {
    method: "PUT",
    headers: {
      "Content-Length": String(sizeBytes),
      "Content-Type": contentType
    }
  })
  const signed = await client.sign(req, {
    aws: {
      signQuery: true,
      allHeaders: true
    }
  })
  return signed.url
}

/**
 * 发起分片上传任务（S3 InitiateMultipartUpload）。
 * 返回 R2 生成的 uploadId。
 */
export async function initiateMultipartUpload(
  env: Env,
  key: string,
  contentType: string,
  customFetch?: typeof fetch
): Promise<string> {
  const client = getS3Client(env)
  const url = `${getBucketUrl(env)}/${key}?uploads`
  const req = new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": contentType
    }
  })
  const signedReq = await client.sign(req)
  const doFetch = customFetch ?? env.S3_FETCH ?? fetch
  const res = await doFetch(signedReq)
  if (!res.ok) {
    const text = await res.text()
    throw new Error(
      `Failed to initiate multipart upload (${res.status}): ${text}`
    )
  }

  const xml = await res.text()
  const match = xml.match(/<UploadId>([\s\S]*?)<\/UploadId>/i)
  if (!match?.[1]?.trim()) {
    throw new Error(
      "Failed to initiate multipart upload: UploadId not found in XML response"
    )
  }
  return match[1].trim()
}

/**
 * 为分片上传的单分片生成预签名 PUT URL（15 分钟有效）。
 */
export async function getPresignedPartPutUrl(
  env: Env,
  key: string,
  uploadId: string,
  partNumber: number,
  expiresInSeconds: number = PRESIGNED_URL_EXPIRES_SECONDS
): Promise<string> {
  const client = getS3Client(env)
  const url = `${getBucketUrl(env)}/${key}?partNumber=${partNumber}&uploadId=${encodeURIComponent(uploadId)}&X-Amz-Expires=${expiresInSeconds}`
  const req = new Request(url, {
    method: "PUT"
  })
  const signed = await client.sign(req, {
    aws: {
      signQuery: true
    }
  })
  return signed.url
}

export interface CompletedPart {
  partNumber: number
  etag: string
}

/**
 * 完成分片上传任务（S3 CompleteMultipartUpload）。
 */
export async function completeMultipartUpload(
  env: Env,
  key: string,
  uploadId: string,
  parts: CompletedPart[],
  customFetch?: typeof fetch
): Promise<void> {
  const client = getS3Client(env)
  const url = `${getBucketUrl(env)}/${key}?uploadId=${encodeURIComponent(uploadId)}`

  // S3 规范要求 parts 必须严格按 partNumber 升序排列
  const sortedParts = [...parts].sort((a, b) => a.partNumber - b.partNumber)
  const partsXml = sortedParts
    .map((p) => {
      const etag =
        p.etag.startsWith('"') && p.etag.endsWith('"') ? p.etag : `"${p.etag}"`
      return `    <Part>\n      <PartNumber>${p.partNumber}</PartNumber>\n      <ETag>${etag}</ETag>\n    </Part>`
    })
    .join("\n")

  const body = `<CompleteMultipartUpload>\n${partsXml}\n</CompleteMultipartUpload>`

  const req = new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/xml"
    },
    body
  })

  const signedReq = await client.sign(req)
  const doFetch = customFetch ?? env.S3_FETCH ?? fetch
  const res = await doFetch(signedReq)
  if (!res.ok) {
    const text = await res.text()
    throw new Error(
      `Failed to complete multipart upload (${res.status}): ${text}`
    )
  }
}

/**
 * 中止并清理分片上传任务（S3 AbortMultipartUpload）。
 */
export async function abortMultipartUpload(
  env: Env,
  key: string,
  uploadId: string,
  customFetch?: typeof fetch
): Promise<void> {
  const client = getS3Client(env)
  const url = `${getBucketUrl(env)}/${key}?uploadId=${encodeURIComponent(uploadId)}`

  const req = new Request(url, {
    method: "DELETE"
  })

  const signedReq = await client.sign(req)
  const doFetch = customFetch ?? env.S3_FETCH ?? fetch
  const res = await doFetch(signedReq)
  if (!res.ok && res.status !== 404) {
    const text = await res.text()
    throw new Error(`Failed to abort multipart upload (${res.status}): ${text}`)
  }
}
