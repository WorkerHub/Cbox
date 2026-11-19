import {
  BanIcon,
  CircleCheckIcon,
  CopyIcon,
  EllipsisIcon,
  KeyRoundIcon,
  ShieldCheckIcon,
  SlidersIcon,
  Trash2Icon,
  UserIcon
} from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table"
import { currentLanguage } from "@/i18n"
import { adminApi } from "@/lib/api"
import { describeApiError } from "@/lib/api-errors"
import type {
  AdminResetPasswordResult,
  AdminUser,
  FileLimitSettings,
  UserRole
} from "@/lib/api-types"
import { intlLocale } from "@/lib/language"
import { UserLimitsDialog } from "@/pages/admin/user-limits-dialog"
import { useAuthStore } from "@/stores/auth"

const ROLE_VARIANT = { admin: "secondary", user: "outline" } as const
const STATUS_VARIANT = {
  active: "secondary",
  pending: "default",
  disabled: "outline"
} as const

export function UsersSection({
  globalLimits
}: {
  globalLimits?: FileLimitSettings
} = {}) {
  const { t } = useTranslation()
  const selfId = useAuthStore((state) => state.user?.id)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [error, setError] = useState("")
  const [resetResult, setResetResult] =
    useState<AdminResetPasswordResult | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<AdminUser | null>(null)
  const [deleteError, setDeleteError] = useState("")
  const [limitsTarget, setLimitsTarget] = useState<AdminUser | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const result = await adminApi.users()
      setUsers(result.items)
    } catch (loadError) {
      setError(describeApiError(t, loadError))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  const act = async (user: AdminUser, action: "approve" | "reject") => {
    setBusyId(user.id)
    setError("")
    try {
      if (action === "approve") await adminApi.approveUser(user.id)
      else await adminApi.rejectUser(user.id)
      toast.success(
        t(
          action === "approve" ? "admin.users.approved" : "admin.users.rejected"
        )
      )
      await load()
    } catch (actionError) {
      setError(describeApiError(t, actionError))
    } finally {
      setBusyId(null)
    }
  }

  const resetPassword = async (user: AdminUser) => {
    setBusyId(user.id)
    setError("")
    try {
      setResetResult(await adminApi.resetUserPassword(user.id))
    } catch (actionError) {
      setError(describeApiError(t, actionError))
    } finally {
      setBusyId(null)
    }
  }

  const run = async (
    user: AdminUser,
    action: "disable" | "enable" | "role",
    role?: UserRole
  ) => {
    if (action === "role" && (!role || role === user.role)) return
    setBusyId(user.id)
    setError("")
    try {
      if (action === "disable") await adminApi.disableUser(user.id)
      else if (action === "enable") await adminApi.enableUser(user.id)
      else if (role) await adminApi.changeUserRole(user.id, { role })
      toast.success(
        t(
          action === "disable"
            ? "admin.users.disabled"
            : action === "enable"
              ? "admin.users.enabled"
              : "admin.users.roleChanged"
        )
      )
      await load()
    } catch (actionError) {
      setError(describeApiError(t, actionError))
    } finally {
      setBusyId(null)
    }
  }

  const copyPassword = async () => {
    if (!resetResult) return
    try {
      await navigator.clipboard.writeText(resetResult.temporaryPassword)
      toast.success(t("admin.users.create.copied"))
    } catch {
      toast.error(t("admin.users.create.copyFailed"))
    }
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    setBusyId(deleteTarget.id)
    setDeleteError("")
    try {
      await adminApi.deleteUser(deleteTarget.id)
      setDeleteTarget(null)
      toast.success(t("admin.users.delete.done"))
      await load()
    } catch (actionError) {
      setDeleteError(describeApiError(t, actionError))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section className="space-y-3 rounded-xl border bg-card p-4">
      <h3 className="font-heading text-sm font-semibold">
        {t("admin.users.title")}
      </h3>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {loading ? (
        <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
      ) : users.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("admin.users.empty")}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("common.email")}</TableHead>
              <TableHead className="hidden sm:table-cell">
                {t("admin.users.displayName")}
              </TableHead>
              <TableHead className="hidden md:table-cell">
                {t("admin.users.role")}
              </TableHead>
              <TableHead>{t("admin.users.status")}</TableHead>
              <TableHead className="text-right">
                {t("admin.users.actions")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((user) => (
              <TableRow key={user.id}>
                <TableCell className="max-w-48">
                  <div className="flex flex-col">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate">{user.email}</span>
                      {user.id === selfId ? (
                        <Badge variant="outline">{t("admin.users.self")}</Badge>
                      ) : null}
                      {user.emailVerified ? null : (
                        <Badge variant="outline">
                          {t("admin.users.emailUnverified")}
                        </Badge>
                      )}
                      {user.limits?.quotaMB != null ||
                      user.limits?.singleMaxMB != null ? (
                        <Badge variant="outline">
                          {t("admin.users.limits.badge")}
                        </Badge>
                      ) : null}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t("admin.users.createdAt", {
                        date: new Date(user.createdAt).toLocaleString(
                          intlLocale(currentLanguage())
                        )
                      })}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  <span>{user.displayName || "—"}</span>
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  <Badge variant={ROLE_VARIANT[user.role]}>
                    {t(`common.role.${user.role}`)}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[user.status]}>
                    {t(`common.status.${user.status}`)}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-2">
                    {user.status === "pending" ? (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          disabled={busyId === user.id}
                          onClick={() => void act(user, "approve")}
                        >
                          {t("admin.users.approve")}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={busyId === user.id}
                          onClick={() => void act(user, "reject")}
                        >
                          {t("admin.users.reject")}
                        </Button>
                      </>
                    ) : null}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          disabled={busyId === user.id}
                          aria-label={t("admin.users.actionsFor", {
                            email: user.email
                          })}
                        >
                          <EllipsisIcon aria-hidden="true" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-40">
                        <DropdownMenuItem
                          disabled={busyId === user.id}
                          onSelect={() => void resetPassword(user)}
                        >
                          <KeyRoundIcon aria-hidden="true" />
                          {t("admin.users.reset.title")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={busyId === user.id}
                          onSelect={() => setLimitsTarget(user)}
                        >
                          <SlidersIcon aria-hidden="true" />
                          {t("admin.users.limits.action")}
                        </DropdownMenuItem>
                        {user.status === "disabled" ? (
                          <DropdownMenuItem
                            disabled={busyId === user.id}
                            onSelect={() => void run(user, "enable")}
                          >
                            <CircleCheckIcon aria-hidden="true" />
                            {t("admin.users.enable")}
                          </DropdownMenuItem>
                        ) : user.status === "active" && user.id !== selfId ? (
                          <DropdownMenuItem
                            disabled={busyId === user.id}
                            onSelect={() => void run(user, "disable")}
                          >
                            <BanIcon aria-hidden="true" />
                            {t("admin.users.disable")}
                          </DropdownMenuItem>
                        ) : null}
                        <DropdownMenuItem
                          disabled={busyId === user.id}
                          onSelect={() =>
                            void run(
                              user,
                              "role",
                              user.role === "admin" ? "user" : "admin"
                            )
                          }
                        >
                          {user.role === "admin" ? (
                            <UserIcon aria-hidden="true" />
                          ) : (
                            <ShieldCheckIcon aria-hidden="true" />
                          )}
                          {t(
                            user.role === "admin"
                              ? "admin.users.demote"
                              : "admin.users.promote"
                          )}
                        </DropdownMenuItem>
                        {user.id === selfId ? null : (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              disabled={busyId === user.id}
                              onSelect={() => {
                                setDeleteError("")
                                setDeleteTarget(user)
                              }}
                            >
                              <Trash2Icon aria-hidden="true" />
                              {t("admin.users.delete.title")}
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog
        open={resetResult !== null}
        onOpenChange={(open) => {
          if (!open) setResetResult(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("admin.users.reset.title")}</DialogTitle>
            <DialogDescription>{resetResult?.email}</DialogDescription>
          </DialogHeader>
          {resetResult ? (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">
                {t("admin.users.reset.password")}
              </p>
              <p className="font-mono break-all select-all">
                {resetResult.temporaryPassword}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("admin.users.create.passwordOnce")}
              </p>
            </div>
          ) : null}
          <DialogFooter>
            {resetResult ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void copyPassword()}
              >
                <CopyIcon aria-hidden="true" />
                {t("admin.users.create.copy")}
              </Button>
            ) : null}
            <DialogClose asChild>
              <Button type="button" size="sm">
                {t("common.actions.close")}
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null)
            setDeleteError("")
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("admin.users.delete.title")}</DialogTitle>
            <DialogDescription>
              {t("admin.users.delete.description", {
                email: deleteTarget?.email ?? "",
                name: deleteTarget?.displayName || "—"
              })}
            </DialogDescription>
          </DialogHeader>
          {deleteError ? (
            <p role="alert" className="text-sm text-destructive">
              {deleteError}
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" size="sm" variant="outline">
                {t("common.actions.cancel")}
              </Button>
            </DialogClose>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={busyId === deleteTarget?.id}
              onClick={() => void confirmDelete()}
            >
              {t("admin.users.delete.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <UserLimitsDialog
        user={limitsTarget}
        globalLimits={globalLimits}
        onClose={() => setLimitsTarget(null)}
        onSaved={load}
      />
    </section>
  )
}
