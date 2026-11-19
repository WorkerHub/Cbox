import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import type { Me } from "@/lib/api-types"
import { accountInitial } from "@/lib/user-identity"

type UserAvatarProps = {
  user: Pick<Me, "displayName" | "email"> | null
  className?: string
}

export function UserAvatar({ user, className }: UserAvatarProps) {
  return (
    <Avatar className={className}>
      <AvatarFallback className="bg-muted text-xs font-medium text-foreground">
        {accountInitial(user)}
      </AvatarFallback>
    </Avatar>
  )
}
