export type AppMode = "multi" | "single"

export interface PublicInfo {
  name: string
  repositoryUrl: string
  version: string
  appMode: AppMode
  registrationEnabled: boolean
  emailConfigured: boolean
}

export interface SetupState {
  enabled: boolean
  ownerExists: boolean
  tablePrefix: string
}

export interface MigrationResult {
  name: string
  status: "applied" | "skipped"
}

export interface SetupResult {
  success: true
  tablePrefix: string
  migrations: MigrationResult[]
}

export interface SetupOwnerInput {
  email: string
  password: string
  displayName: string
  language: string
}

export type TwoFactorMethod = "totp" | "passkey" | "email"

export type UserRole = "admin" | "user"

export interface Me {
  id: number
  email: string
  displayName: string
  role: UserRole
  status: "active" | "pending" | "disabled"
  emailVerified: boolean

  mustChangePassword: boolean
  language: string
  timezone: string
  totpEnabled: boolean
  emailTwoFactorEnabled: boolean
  passkeyCount: number

  profileLocks: {
    displayNameLocked: boolean
  }
}

export type LoginResult =
  | { success: true; user: Me }
  | { requires2fa: true; tempToken: string; methods: TwoFactorMethod[] }

export interface RegisterResult {
  requiresApproval: boolean
  requiresEmailVerification: boolean
}

export interface MeUpdateInput {
  displayName?: string
  language?: string
  timezone?: string
}

export interface PasskeySummary {
  id: number
  createdAt: string
  lastUsedAt: string | null
  transports?: string[]
}

export type EmailProvider = "none" | "smtp" | "resend"

export interface SmtpSettings {
  host: string
  port: string
  username: string

  passwordSet: boolean
  from: string
  fromName: string
}

export interface ResendSettings {
  apiKeySet: boolean
  from: string
  fromName: string
}

export interface EmailSettings {
  provider: EmailProvider
  smtp: SmtpSettings
  resend: ResendSettings
  configured: boolean
}

export interface RegistrationSettings {
  enabled: boolean
  approvalRequired: boolean
  emailVerification: boolean
}

export interface FileLimitSettings {
  defaultQuotaBytes: number
  defaultSingleMaxBytes: number
  defaultQuotaMB: number
  defaultSingleMaxMB: number
}

export interface AdminSettings {
  registration: RegistrationSettings | null
  profileLocks: {
    displayNameLocked: boolean
  }
  setupPageEnabled: boolean
  tablePrefix: string
  email: EmailSettings
  fileLimits: FileLimitSettings
}

export interface SmtpUpdateInput {
  host: string
  port: string
  username: string

  password?: string
  from: string
  fromName: string
}

export interface ResendUpdateInput {
  from: string
  fromName: string

  apiKey?: string
}

export interface AdminSettingsUpdate {
  registration?: RegistrationSettings
  profileLocks?: {
    displayNameLocked?: boolean
  }
  setupPageEnabled?: boolean
  email?: {
    provider: EmailProvider
    smtp: SmtpUpdateInput
    resend: ResendUpdateInput
  }
  fileLimits?: {
    defaultQuotaMB?: number
    defaultSingleMaxMB?: number
  }
}

export interface UserLimitsSummary {
  quotaBytes: number | null
  singleMaxBytes: number | null
  quotaMB: number | null
  singleMaxMB: number | null
  effectiveQuotaBytes: number
  effectiveSingleMaxBytes: number
  effectiveQuotaMB: number
  effectiveSingleMaxMB: number
}

export interface AdminUser {
  id: number
  email: string
  displayName: string
  role: UserRole
  status: "active" | "pending" | "disabled"
  emailVerified: boolean
  createdAt: string
  limits?: UserLimitsSummary
}

export interface UserLimitsResponse extends UserLimitsSummary {
  userId: number
}

export interface UserLimitsUpdateInput {
  quotaMB?: number | null | ""
  singleMaxMB?: number | null | ""
}

export interface AdminCreateUserInput {
  email: string
  role: UserRole

  displayName?: string

  language?: string

  timezone?: string
}

export interface AdminCreateUserResult {
  id: number
  email: string
  role: UserRole
  status: "active"

  temporaryPassword: string
}

export interface AdminResetPasswordResult {
  id: number
  email: string

  temporaryPassword: string
}

export interface AdminChangeRoleInput {
  role: UserRole
}

export interface AdminUserActionResult {
  success: true
}

export interface UsageInfo {
  usedBytes: number
  quotaBytes: number
  singleMaxBytes: number
}

export interface FolderItem {
  id: string
  parentId: string | null
  name: string
  createdAt: string
}

export interface BreadcrumbItem {
  id: string | null
  name: string
}

export interface FileItem {
  id: string
  folderId: string | null
  name: string
  sizeBytes: number
  contentType: string
  sha256: string | null
  expiresAt: string | null
  createdAt: string
  expired: boolean

  share?: {
    token: string
    expiresAt: string | null
  }
}

export interface FolderListResponse {
  folder: FolderItem | null
  breadcrumbs: BreadcrumbItem[]
  folders: FolderItem[]
  files: FileItem[]
  usage: UsageInfo
}

export interface ShareItem {
  id: string
  fileId: string
  token: string | null
  expiresAt: string | null
  downloadCount: number
  lastDownloadedAt: string | null
  createdAt: string
  expired: boolean
}

export interface CreateShareResult {
  id: string
  url: string
  expires_at: string | null
  token: string | null
}

export interface DeleteFolderResult {
  success: boolean
  deletedFolders: number
  deletedFiles: number
  deletedBytes: number
}

export interface UploadInitInput {
  filename: string
  declaredSizeBytes: number
  folderId?: string | null
  expiresIn?: string | null
}

export type UploadInitResponse =
  | {
      uploadId: string
      mode: "single"
      url: string
    }
  | {
      uploadId: string
      mode: "multipart"
      partSize: number
    }

export interface UploadPartUrlsInput {
  partNumbers: number[]
}

export interface UploadPartItem {
  partNumber: number
  url: string
}

export interface UploadPartUrlsResponse {
  parts: UploadPartItem[]
}

export interface UploadCompletedPart {
  partNumber: number
  etag: string
}

export type UploadCompleteSingleInput = {
  sha256?: string | null
  parts?: never
}

export type UploadCompleteMultipartInput = {
  sha256?: string | null
  parts: UploadCompletedPart[]
}

export type UploadCompleteInput =
  | UploadCompleteSingleInput
  | UploadCompleteMultipartInput
