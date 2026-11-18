/**
 * API 客户端：所有页面只经这里说话。
 *
 * 约定（与单 B 冻结的契约一致）：
 * - Cookie 会话（`credentials: "include"`）；私有接口 401 清本地用户态（由
 *   RequireAuth 送回登录页），公开鉴权端点的 401 只交回调用方；
 * - 非 2xx 一律抛 ApiError，保留 status / code / retryAfter / detail，
 *   页面用 api-errors.ts 按 code 翻译，不直出后端文案；
 * - 只有带 body 的请求才设 Content-Type，GET 与 204 不碰。
 */
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
    // 会话中途失效：清掉本地用户态，RequireAuth 会把人送回登录页。
    // 登录/找回等公开鉴权端点的 401 是业务结果，不动全局状态。
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

/* 公开数据 */

export const publicApi = {
  get: () => request<PublicInfo>("/public")
}

/* setup（密钥只走请求头） */

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

/* 鉴权 */

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

/* 当前用户 */

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

/* 系统管理 */

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

/* 文件与文件夹管理（规格 §5、§6、§7、§10） */

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

export interface UploadFileOptions {
  folderId?: string | null
  expiresIn?: string | null
  sha256?: string | null
}

export const filesApi = {
  upload: (
    file: File,
    options?: UploadFileOptions,
    onProgress?: (percent: number) => void
  ): Promise<FileItem> => {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open("POST", `${BASE}/files`)
      xhr.withCredentials = true

      if (xhr.upload && onProgress) {
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable && event.total > 0) {
            const percent = Math.min(
              100,
              Math.max(0, Math.round((event.loaded / event.total) * 100))
            )
            onProgress(percent)
          }
        }
      }

      xhr.onload = () => {
        let envelope: ErrorEnvelope = {}
        try {
          envelope = JSON.parse(xhr.responseText || "{}") as ErrorEnvelope
        } catch {
          // ignore json parse error
        }

        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(envelope as unknown as FileItem)
          return
        }

        if (xhr.status === 401) {
          void import("@/stores/auth").then(({ useAuthStore }) => {
            useAuthStore.setState({ user: null, status: "ready" })
          })
        }

        reject(
          new ApiError({
            status: xhr.status,
            message: envelope.error ?? xhr.statusText,
            code: envelope.code,
            retryAfter: envelope.retryAfter,
            detail: envelope.detail
          })
        )
      }

      xhr.onerror = () => {
        reject(new ApiError({ status: 0, message: "Network error" }))
      }

      const formData = new FormData()
      formData.append("file", file)
      if (options?.folderId) {
        formData.append("folderId", options.folderId)
      }
      if (options?.expiresIn) {
        formData.append("expiresIn", options.expiresIn)
      }
      if (options?.sha256) {
        formData.append("sha256", options.sha256)
      }

      xhr.send(formData)
    })
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
