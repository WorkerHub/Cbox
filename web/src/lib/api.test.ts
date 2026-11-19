import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { adminApi, ApiError, authApi, filesApi, meApi } from "@/lib/api"
import type { FileItem } from "@/lib/api-types"
import { useAuthStore } from "@/stores/auth"
import { me } from "@/test/fixtures"

function respond(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: async () => body,
    text: async () => JSON.stringify(body)
  }
}

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => respond(status, body))
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  useAuthStore.setState({ user: null, status: "loading" })
})

describe("401 处理", () => {
  it("私有接口 401 时清掉本地会话", async () => {
    useAuthStore.setState({ user: me(), status: "ready" })
    stubFetch(401, { error: "Unauthorized" })

    await expect(meApi.get()).rejects.toBeInstanceOf(ApiError)
    await vi.waitFor(() => {
      expect(useAuthStore.getState().user).toBeNull()
    })
  })

  it("登录失败的 401 不动已有用户态", async () => {
    useAuthStore.setState({ user: me(), status: "ready" })
    stubFetch(401, {
      error: "Invalid credentials",
      code: "INVALID_CREDENTIALS"
    })

    await expect(
      authApi.login({ email: "owner@example.com", password: "wrong" })
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" })
    await Promise.resolve()
    expect(useAuthStore.getState().user).not.toBeNull()
  })
})

describe("用户管理操作列端点", () => {
  function recordFetch() {
    const calls: Array<{ url: string; method: string; body: unknown }> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({
          url,
          method: init.method ?? "GET",
          body: init.body
        })
        return respond(200, { success: true })
      })
    )
    return calls
  }

  it("重置密码 / 停用 / 启用 / 删除走 POST 且无请求体", async () => {
    const calls = recordFetch()

    await adminApi.resetUserPassword(7)
    await adminApi.disableUser(7)
    await adminApi.enableUser(7)
    await adminApi.deleteUser(7)

    expect(calls).toEqual([
      {
        url: "/api/admin/users/7/reset-password",
        method: "POST",
        body: undefined
      },
      { url: "/api/admin/users/7/disable", method: "POST", body: undefined },
      { url: "/api/admin/users/7/enable", method: "POST", body: undefined },
      { url: "/api/admin/users/7/delete", method: "POST", body: undefined }
    ])
  })

  it("变更角色把目标角色放进请求体", async () => {
    const calls = recordFetch()

    await adminApi.changeUserRole(7, { role: "admin" })

    expect(calls).toEqual([
      {
        url: "/api/admin/users/7/role",
        method: "POST",
        body: JSON.stringify({ role: "admin" })
      }
    ])
  })
})

describe("filesApi 直传与分片上传", () => {
  const origXhr = globalThis.XMLHttpRequest

  class MockXHR {
    static instances: MockXHR[] = []
    url = ""
    method = ""
    status = 200
    statusText = "OK"
    headers: Record<string, string> = {}
    responseHeaders: Record<string, string> = { etag: '"etag-mock"' }
    upload = {
      onprogress: null as ((e: ProgressEvent) => void) | null
    }
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    onabort: (() => void) | null = null
    sentBody: unknown = null

    static shouldFail = false
    static failStatus = 500

    open(method: string, url: string) {
      this.method = method
      this.url = url
    }

    setRequestHeader(header: string, value: string) {
      this.headers[header] = value
    }

    getResponseHeader(name: string) {
      return this.responseHeaders[name.toLowerCase()] ?? null
    }

    send(body: unknown) {
      this.sentBody = body
      MockXHR.instances.push(this)

      setTimeout(() => {
        if (MockXHR.shouldFail) {
          this.status = MockXHR.failStatus
          this.statusText = "Upload Failed"
          this.onload?.()
          return
        }

        const size =
          body instanceof Blob
            ? body.size
            : typeof body === "string"
              ? body.length
              : 100
        if (this.upload.onprogress) {
          this.upload.onprogress({
            lengthComputable: true,
            loaded: size,
            total: size
          } as ProgressEvent)
        }
        this.onload?.()
      }, 0)
    }

    abort() {
      this.onabort?.()
    }
  }

  beforeEach(() => {
    MockXHR.instances = []
    MockXHR.shouldFail = false
    MockXHR.failStatus = 500
    globalThis.XMLHttpRequest = MockXHR as unknown as typeof XMLHttpRequest
  })

  afterEach(() => {
    globalThis.XMLHttpRequest = origXhr
  })

  it("initUpload, getUploadPartUrls, completeUpload, abortUpload 请求符合契约", async () => {
    const fetchCalls: Array<{ url: string; method: string; body: unknown }> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        fetchCalls.push({
          url,
          method: init.method ?? "GET",
          body: init.body ? JSON.parse(init.body as string) : undefined
        })
        return respond(200, { success: true, parts: [] })
      })
    )

    await filesApi.initUpload({
      filename: "test.png",
      declaredSizeBytes: 1024,
      folderId: "f-1",
      expiresIn: "7d"
    })
    await filesApi.getUploadPartUrls("up-123", [1, 2])
    await filesApi.completeUpload("up-123", {
      sha256: "dummy-hash",
      parts: [{ partNumber: 1, etag: "e1" }]
    })
    await filesApi.abortUpload("up-123")

    expect(fetchCalls).toEqual([
      {
        url: "/api/files/uploads/init",
        method: "POST",
        body: {
          filename: "test.png",
          declaredSizeBytes: 1024,
          folderId: "f-1",
          expiresIn: "7d"
        }
      },
      {
        url: "/api/files/uploads/up-123/part-urls",
        method: "POST",
        body: { partNumbers: [1, 2] }
      },
      {
        url: "/api/files/uploads/up-123/complete",
        method: "POST",
        body: {
          sha256: "dummy-hash",
          parts: [{ partNumber: 1, etag: "e1" }]
        }
      },
      {
        url: "/api/files/uploads/up-123",
        method: "DELETE",
        body: undefined
      }
    ])
  })

  it("upload 单文件模式 (<=100 MiB) 直传成功并上报进度", async () => {
    const file = new File(["hello world"], "hello.txt", { type: "text/plain" })
    const mockFileItem: FileItem = {
      id: "f-1",
      folderId: null,
      name: "hello.txt",
      sizeBytes: file.size,
      contentType: "text/plain",
      sha256: "sha256-hello",
      expiresAt: null,
      createdAt: new Date().toISOString(),
      expired: false
    }

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, _init: RequestInit = {}) => {
        if (url === "/api/files/uploads/init") {
          return respond(200, {
            uploadId: "upload-single-1",
            mode: "single",
            partSize: 10485760,
            url: "https://r2.example.com/single-put"
          })
        }
        if (url === "/api/files/uploads/upload-single-1/complete") {
          return respond(200, mockFileItem)
        }
        return respond(404, {})
      })
    )

    const progressUpdates: Array<{
      loaded: number
      total: number
      percent: number
    }> = []

    const result = await filesApi.upload(
      file,
      {
        sha256: "sha256-hello"
      },
      (p) => progressUpdates.push(p)
    )

    expect(result).toEqual(mockFileItem)
    expect(MockXHR.instances).toHaveLength(1)
    expect(MockXHR.instances[0].url).toBe("https://r2.example.com/single-put")
    expect(MockXHR.instances[0].method).toBe("PUT")
    expect(progressUpdates.length).toBeGreaterThan(0)
    expect(progressUpdates[progressUpdates.length - 1].percent).toBe(100)
  })

  it("upload 分片模式 (>100 MiB) 按分片批量签 URL、PUT 并完成", async () => {
    const content = "0123456789012345678901234"
    const file = new File([content], "big.bin", {
      type: "application/octet-stream"
    })

    const mockFileItem: FileItem = {
      id: "f-big",
      folderId: null,
      name: "big.bin",
      sizeBytes: file.size,
      contentType: "application/octet-stream",
      sha256: "hash-big",
      expiresAt: null,
      createdAt: new Date().toISOString(),
      expired: false
    }

    let completePayload: unknown = null

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        if (url === "/api/files/uploads/init") {
          return respond(200, {
            uploadId: "upload-multi-1",
            mode: "multipart",
            partSize: 10
          })
        }
        if (url === "/api/files/uploads/upload-multi-1/part-urls") {
          return respond(200, {
            parts: [
              { partNumber: 1, url: "https://r2.example.com/part-1" },
              { partNumber: 2, url: "https://r2.example.com/part-2" },
              { partNumber: 3, url: "https://r2.example.com/part-3" }
            ]
          })
        }
        if (url === "/api/files/uploads/upload-multi-1/complete") {
          completePayload = JSON.parse(init.body as string)
          return respond(200, mockFileItem)
        }
        return respond(404, {})
      })
    )

    const progressUpdates: Array<{
      loaded: number
      total: number
      percent: number
    }> = []

    const result = await filesApi.upload(
      file,
      {
        sha256: "hash-big"
      },
      (p) => progressUpdates.push(p)
    )

    expect(result).toEqual(mockFileItem)
    expect(MockXHR.instances).toHaveLength(3)
    expect(MockXHR.instances[0].url).toBe("https://r2.example.com/part-1")
    expect(MockXHR.instances[1].url).toBe("https://r2.example.com/part-2")
    expect(MockXHR.instances[2].url).toBe("https://r2.example.com/part-3")
    expect(completePayload).toEqual({
      sha256: "hash-big",
      parts: [
        { partNumber: 1, etag: "etag-mock" },
        { partNumber: 2, etag: "etag-mock" },
        { partNumber: 3, etag: "etag-mock" }
      ]
    })
    expect(progressUpdates[progressUpdates.length - 1].percent).toBe(100)
  })

  it("upload 发生错误时调用 abortUpload 清理 pending 记录", async () => {
    const file = new File(["content"], "fail.txt", { type: "text/plain" })
    let abortCalledWith: string | null = null

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        if (url === "/api/files/uploads/init") {
          return respond(200, {
            uploadId: "upload-fail-1",
            mode: "single",
            partSize: 10485760,
            url: "https://r2.example.com/fail-put"
          })
        }
        if (
          url === "/api/files/uploads/upload-fail-1" &&
          init.method === "DELETE"
        ) {
          abortCalledWith = "upload-fail-1"
          return respond(200, { success: true })
        }
        return respond(404, {})
      })
    )

    MockXHR.shouldFail = true

    await expect(filesApi.upload(file)).rejects.toThrow()
    expect(abortCalledWith).toBe("upload-fail-1")
  })

  it("upload 信号中止 (signal abort) 时调用 abortUpload 清理 pending 记录", async () => {
    const file = new File(["content"], "abort.txt", { type: "text/plain" })
    let abortCalledWith: string | null = null
    const controller = new AbortController()

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        if (url === "/api/files/uploads/init") {
          return respond(200, {
            uploadId: "upload-abort-1",
            mode: "single",
            partSize: 10485760,
            url: "https://r2.example.com/abort-put"
          })
        }
        if (
          url === "/api/files/uploads/upload-abort-1" &&
          init.method === "DELETE"
        ) {
          abortCalledWith = "upload-abort-1"
          return respond(200, { success: true })
        }
        return respond(404, {})
      })
    )

    const uploadPromise = filesApi.upload(file, { signal: controller.signal })

    controller.abort()

    await expect(uploadPromise).rejects.toThrow()
    expect(abortCalledWith).toBe("upload-abort-1")
  })
})
