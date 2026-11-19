import type { Me } from "@/lib/api-types"

type AccountIdentity = Pick<Me, "displayName" | "email">

export function accountPrimaryLabel(
  user: AccountIdentity | null | undefined
): string {
  if (!user) return ""
  return user.displayName || user.email || ""
}

export function accountInitial(
  user: AccountIdentity | null | undefined
): string {
  return Array.from(accountPrimaryLabel(user))[0]?.toUpperCase() ?? ""
}
