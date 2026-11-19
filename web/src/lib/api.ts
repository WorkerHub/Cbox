import type {
  AdminChangeRoleInput,
  AdminCreateUserInput,
  AdminCreateUserResult,
  AdminResetPasswordResult,
  AdminSettings,
  AdminSettingsUpdate,
  AdminUser,
  AdminUserActionResult,
  CreateShareResult,
  DeleteFolderResult,
  FileItem,
  FolderItem,
  FolderListResponse,
  LoginResult,
  Me,
  MeUpdateInput,
  MigrationResult,
  PasskeySummary,
  PublicInfo,
  RegisterResult,
  SetupOwnerInput,
  SetupResult,
  SetupState,
  ShareItem,
  TwoFactorMethod,
  UploadCompletedPart,
  UploadCompleteInput,
  UploadInitInput,
  UploadInitResponse,
  UploadPartUrlsResponse,
  UsageInfo,
  UserLimitsResponse,
  UserLimitsUpdateInput
} from "@/lib/api-types"

const BASE = "/api"

export class ApiError extends Error {
  status: number
  code?: string
  retryAfter?: number
  detail?: string

  constructor(options: {
    status: number
    message: string
    code?: string
    retryAfter?: number
    detail?: string
  }) {
    super(options.message)
    this.name = "ApiError"
    this.status = options.status
    this.code = options.code
    this.retryAfter = options.retryAfter
    this.detail = options.detail
  }
}

interface ErrorEnvelope {
  error?: string
  code?: string
  retryAfter?: number
  detail?: string
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  body?: unknown
  headers?: Record<string, string>
}

async function request<T>(
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  const { body, headers, method = "GET" } = options
  const init: RequestInit = {
    method,
    credentials: "include",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }

  let response: Response
  try {
    response = await fetch(`${BASE}${path}`, init)
  } catch {
    throw new ApiError({ status: 0, message: "Network error" })
  }

  if (!response.ok) {
    const envelope = (await response.json().catch(() => ({}))) as ErrorEnvelope

    if (response.status === 401 && !path.startsWith("/auth/")) {
      void import("@/stores/auth").then(({ useAuthStore }) => {
        useAuthStore.setState({ user: null, status: "ready" })
      })
    }
    throw new ApiError({
      status: response.status,
      message: envelope.error ?? response.statusText,
      code: envelope.code,
      retryAfter: envelope.retryAfter,
      detail: envelope.detail
    })
  }

  if (response.status === 204) return undefined as T
  const text = await response.text()
  if (!text) return undefined as T
  return JSON.parse(text) as T
}

export const publicApi = {
  get: () => request<PublicInfo>("/public")
}

export const setupApi = {
  state: () => request<SetupState>("/setup/state"),
  run: (secret: string) =>
    request<SetupResult>("/setup", {
      method: "POST",
      headers: { "X-Setup-Secret": secret }
    }),
  createOwner: (secret: string, input: SetupOwnerInput) =>
    request<{ success: true }>("/setup/owner", {
      method: "POST",
      headers: { "X-Setup-Secret": secret },
      body: input
    })
}

export const authApi = {
  register: (input: { email: string; password: string; language: string }) =>
    request<RegisterResult>("/auth/register", { method: "POST", body: input }),

  login: (input: { email: string; password: string }) =>
    request<LoginResult>("/auth/login", { method: "POST", body: input }),

  verifySecondFactor: (input: {
    tempToken: string
    method: TwoFactorMethod
    code: string
  }) =>
    request<{ success: true; user: Me }>("/auth/2fa/verify", {
      method: "POST",
      body: input
    }),

  passkeyLoginOptions: (tempToken: string) =>
    request<Record<string, unknown>>("/auth/2fa/passkey/options", {
      method: "POST",
      body: { tempToken }
    }),

  passkeyLoginVerify: (tempToken: string, credential: unknown) =>
    request<{ success: true; user: Me }>("/auth/2fa/passkey/verify", {
      method: "POST",
      body: { tempToken, credential }
    }),

  logout: () => request<{ success: true }>("/auth/logout", { method: "POST" }),

  forgotPassword: (input: { email: string; language: string }) =>
    request<{ success: true }>("/auth/password/forgot", {
      method: "POST",
      body: input
    }),

  resetPassword: (input: { email: string; code: string; password: string }) =>
    request<{ success: true }>("/auth/password/reset", {
      method: "POST",
      body: input
    }),

  verifyEmail: (input: { email: string; code: string }) =>
    request<{ success: true }>("/auth/email/verify", {
      method: "POST",
      body: input
    }),

  resendEmail: (input: { email: string; language: string }) =>
    request<{ success: true }>("/auth/email/resend", {
      method: "POST",
      body: input
    }),

  totpSetup: () =>
    request<{ secret: string; otpauthUrl: string }>("/auth/2fa/totp/setup", {
      method: "POST"
    }),

  totpEnable: (code: string) =>
    request<{ success: true }>("/auth/2fa/totp/enable", {
      method: "POST",
      body: { code }
    }),

  totpDisable: (password: string) =>
    request<{ success: true }>("/auth/2fa/totp/disable", {
      method: "POST",
      body: { password }
    }),

  passkeyRegisterOptions: (password: string) =>
    request<Record<string, unknown>>("/auth/2fa/passkey/register/options", {
      method: "POST",
      body: { password }
    }),

  passkeyRegisterVerify: (credential: unknown) =>
    request<{ success: true }>("/auth/2fa/passkey/register/verify", {
      method: "POST",
      body: { credential }
    }),

  emailTwoFactorSend: (tempToken: string) =>
    request<{ success: true }>("/auth/2fa/email/send", {
      method: "POST",
      body: { tempToken }
    }),

  emailTwoFactorEnableSend: () =>
    request<{ success: true }>("/auth/2fa/email/enable/send", {
      method: "POST"
    }),

  emailTwoFactorEnable: (code: string) =>
    request<{ success: true }>("/auth/2fa/email/enable", {
      method: "POST",
      body: { code }
    }),

  emailTwoFactorDisable: (password: string) =>
    request<{ success: true }>("/auth/2fa/email/disable", {
      method: "POST",
      body: { password }
    })
}

export const meApi = {
  get: () => request<Me>("/me"),

  update: (input: MeUpdateInput) =>
    request<Me>("/me", { method: "PUT", body: input }),

  changePassword: (input: { currentPassword: string; newPassword: string }) =>
    request<{ success: true }>("/me/password", { method: "PUT", body: input }),

  passkeys: () => request<{ items: PasskeySummary[] }>("/me/passkeys"),

  deletePasskey: (id: number, password: string) =>
    request<{ success: true }>(`/me/passkeys/${id}`, {
      method: "DELETE",
      body: { password }
    }),

  usage: () => request<UsageInfo>("/me/usage")
}

export interface AdminSetupResult extends SetupResult {
  migrations: MigrationResult[]
}

export const adminApi = {
  settings: () => request<AdminSettings>("/admin/settings"),

  updateSettings: (input: AdminSettingsUpdate) =>
    request<AdminSettings>("/admin/settings", { method: "PUT", body: input }),

  testEmail: (to: string) =>
    request<{ success: true }>("/admin/settings/test-email", {
      method: "POST",
      body: { to }
    }),

  createUser: (input: AdminCreateUserInput) =>
    request<AdminCreateUserResult>("/admin/users", {
      method: "POST",
      body: input
    }),

  users: () => request<{ items: AdminUser[] }>("/admin/users"),

  approveUser: (id: number) =>
    request<{ success: true }>(`/admin/users/${id}/approve`, {
      method: "POST"
    }),

  rejectUser: (id: number) =>
    request<{ success: true }>(`/admin/users/${id}/reject`, { method: "POST" }),

  resetUserPassword: (id: number) =>
    request<AdminResetPasswordResult>(`/admin/users/${id}/reset-password`, {
      method: "POST"
    }),

  disableUser: (id: number) =>
    request<AdminUserActionResult>(`/admin/users/${id}/disable`, {
      method: "POST"
    }),

  enableUser: (id: number) =>
    request<AdminUserActionResult>(`/admin/users/${id}/enable`, {
      method: "POST"
    }),

  changeUserRole: (id: number, input: AdminChangeRoleInput) =>
    request<AdminUserActionResult>(`/admin/users/${id}/role`, {
      method: "POST",
      body: input
    }),

  deleteUser: (id: number) =>
    request<AdminUserActionResult>(`/admin/users/${id}/delete`, {
      method: "POST"
    }),

  getUserLimits: (id: number) =>
    request<UserLimitsResponse>(`/admin/users/${id}/limits`),

  updateUserLimits: (id: number, input: UserLimitsUpdateInput) =>
    request<{ success: true; limits: UserLimitsResponse }>(
      `/admin/users/${id}/limits`,
      {
        method: "PUT",
        body: input
      }
    ),

  runSetup: () => request<AdminSetupResult>("/admin/setup", { method: "POST" })
}

export const foldersApi = {
  list: (parentId?: string | null) =>
    request<FolderListResponse>(
      parentId
        ? `/folders?parentId=${encodeURIComponent(parentId)}`
        : "/folders"
    ),

  create: (input: { parentId?: string | null; name: string }) =>
    request<FolderItem>("/folders", { method: "POST", body: input }),

  delete: (id: string) =>
    request<DeleteFolderResult>(`/folders/${encodeURIComponent(id)}`, {
      method: "DELETE"
    })
}

export interface UploadProgress {
  loaded: number
  total: number
  percent: number
}

export interface UploadFileOptions {
  folderId?: string | null
  expiresIn?: string | null
  sha256?: string | null
  signal?: AbortSignal
}

function uploadChunkWithProgress(
  url: string,
  chunk: Blob,
  signal?: AbortSignal,
  onProgress?: (loaded: number) => void
): Promise<{ etag: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The user aborted a request.", "AbortError"))
      return
    }

    let settled = false
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      xhr.abort()
      reject(new DOMException("The user aborted a request.", "AbortError"))
    }

    const cleanup = () => {
      if (signal) {
        signal.removeEventListener("abort", onAbort)
      }
    }

    const xhr = new XMLHttpRequest()
    xhr.open("PUT", url)

    if (xhr.upload && onProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          onProgress(event.loaded)
        }
      }
    }

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true })
    }

    xhr.onload = () => {
      if (settled) return
      settled = true
      cleanup()
      if (xhr.status >= 200 && xhr.status < 300) {
        let etag = xhr.getResponseHeader("ETag") ?? ""
        if (etag.startsWith('"') && etag.endsWith('"')) {
          etag = etag.slice(1, -1)
        }
        resolve({ etag })
      } else {
        reject(
          new ApiError({
            status: xhr.status,
            message: `Upload failed: ${xhr.statusText || xhr.status}`
          })
        )
      }
    }

    xhr.onerror = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(
        new ApiError({ status: 0, message: "Network error during upload" })
      )
    }

    xhr.onabort = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(new DOMException("The user aborted a request.", "AbortError"))
    }

    xhr.send(chunk)
  })
}

async function uploadPartWithRetry(
  url: string,
  chunk: Blob,
  signal?: AbortSignal,
  onProgress?: (loaded: number) => void,
  maxRetries = 3
): Promise<{ etag: string }> {
  let retries = 0
  while (true) {
    if (signal?.aborted) {
      throw new DOMException("The user aborted a request.", "AbortError")
    }
    try {
      return await uploadChunkWithProgress(url, chunk, signal, onProgress)
    } catch (err: unknown) {
      if (
        signal?.aborted ||
        (err instanceof DOMException && err.name === "AbortError")
      ) {
        throw err
      }
      retries++
      if (retries > maxRetries) {
        throw err
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
}

export const filesApi = {
  initUpload: (input: UploadInitInput) =>
    request<UploadInitResponse>("/files/uploads/init", {
      method: "POST",
      body: {
        filename: input.filename,
        declaredSizeBytes: input.declaredSizeBytes,
        folderId: input.folderId,
        expiresIn: input.expiresIn
      }
    }),

  getUploadPartUrls: (id: string, partNumbers: number[]) =>
    request<UploadPartUrlsResponse>(
      `/files/uploads/${encodeURIComponent(id)}/part-urls`,
      {
        method: "POST",
        body: { partNumbers }
      }
    ),

  completeUpload: (id: string, body: UploadCompleteInput) =>
    request<FileItem>(`/files/uploads/${encodeURIComponent(id)}/complete`, {
      method: "POST",
      body
    }),

  abortUpload: (id: string) =>
    request<{ success: true }>(`/files/uploads/${encodeURIComponent(id)}`, {
      method: "DELETE"
    }),

  upload: async (
    file: File,
    options?: UploadFileOptions,
    onProgress?: (progress: UploadProgress) => void
  ): Promise<FileItem> => {
    const signal = options?.signal
    if (signal?.aborted) {
      throw new DOMException("The user aborted a request.", "AbortError")
    }

    const initRes = await filesApi.initUpload({
      filename: file.name,
      declaredSizeBytes: file.size,
      folderId: options?.folderId,
      expiresIn: options?.expiresIn
    })

    const uploadId = initRes.uploadId

    if (initRes.mode === "single") {
      try {
        await uploadPartWithRetry(
          initRes.url,
          file,
          signal,
          (loaded) => {
            const total = file.size
            const percent =
              total > 0
                ? Math.min(100, Math.round((loaded / total) * 100))
                : 100
            onProgress?.({ loaded, total, percent })
          },
          3
        )
      } catch (err) {
        try {
          await filesApi.abortUpload(uploadId)
        } catch {}
        throw err
      }

      return await filesApi.completeUpload(uploadId, {
        sha256: options?.sha256
      })
    }

    const partSize = initRes.partSize
    const totalParts = Math.max(1, Math.ceil(file.size / partSize))
    const parts: UploadCompletedPart[] = []
    const partBytesLoaded = new Array<number>(totalParts).fill(0)
    let maxReportedLoaded = 0

    const reportProgress = () => {
      const sumLoaded = partBytesLoaded.reduce((acc, curr) => acc + curr, 0)
      const loaded = Math.min(file.size, Math.max(maxReportedLoaded, sumLoaded))
      maxReportedLoaded = loaded
      const total = file.size
      const percent =
        total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 100
      onProgress?.({ loaded, total, percent })
    }

    try {
      const partNumberBatches: number[][] = []
      for (let i = 1; i <= totalParts; i += 50) {
        const batch: number[] = []
        for (let j = i; j < i + 50 && j <= totalParts; j++) {
          batch.push(j)
        }
        partNumberBatches.push(batch)
      }

      const partUrlMap = new Map<number, string>()
      for (const batch of partNumberBatches) {
        if (signal?.aborted) {
          throw new DOMException("The user aborted a request.", "AbortError")
        }
        const res = await filesApi.getUploadPartUrls(uploadId, batch)
        for (const item of res.parts) {
          partUrlMap.set(item.partNumber, item.url)
        }
      }

      for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
        if (signal?.aborted) {
          throw new DOMException("The user aborted a request.", "AbortError")
        }
        const url = partUrlMap.get(partNumber)
        if (!url) {
          throw new Error(`Missing upload URL for part ${partNumber}`)
        }
        const start = (partNumber - 1) * partSize
        const end = Math.min(start + partSize, file.size)
        const chunk = file.slice(start, end)

        const { etag } = await uploadPartWithRetry(
          url,
          chunk,
          signal,
          (loaded) => {
            partBytesLoaded[partNumber - 1] = Math.max(
              partBytesLoaded[partNumber - 1],
              loaded
            )
            reportProgress()
          },
          3
        )

        partBytesLoaded[partNumber - 1] = chunk.size
        reportProgress()

        parts.push({ partNumber, etag })
      }

      return await filesApi.completeUpload(uploadId, {
        sha256: options?.sha256,
        parts
      })
    } catch (err) {
      try {
        await filesApi.abortUpload(uploadId)
      } catch {}
      throw err
    }
  },

  patchExpiration: (id: string, expiresIn?: string | null) =>
    request<{ id: string; expiresAt: string | null }>(
      `/files/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: { expiresIn: expiresIn ?? "never" }
      }
    ),

  delete: (id: string) =>
    request<{ success: true }>(`/files/${encodeURIComponent(id)}`, {
      method: "DELETE"
    }),

  downloadUrl: (id: string) =>
    `${BASE}/files/${encodeURIComponent(id)}/download`
}

export const sharesApi = {
  create: (fileId: string, expiresIn?: string | null) =>
    request<CreateShareResult>(`/files/${encodeURIComponent(fileId)}/shares`, {
      method: "POST",
      body: { expiresIn: expiresIn || "24h" }
    }),

  list: (fileId: string) =>
    request<{ items: ShareItem[] }>(
      `/files/${encodeURIComponent(fileId)}/shares`
    ),

  delete: (id: string) =>
    request<{ success: true }>(`/shares/${encodeURIComponent(id)}`, {
      method: "DELETE"
    })
}
