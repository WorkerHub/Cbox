import { useContext, useEffect } from "react"
import { useTranslation } from "react-i18next"
import { UNSAFE_DataRouterContext, useBlocker } from "react-router"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"

function DataRouterUnsavedChangesGuard({ isDirty }: { isDirty: boolean }) {
  const { t } = useTranslation()

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      isDirty && currentLocation.pathname !== nextLocation.pathname
  )

  return (
    <Dialog
      open={blocker.state === "blocked"}
      onOpenChange={(open) => {
        if (!open && blocker.state === "blocked") {
          blocker.reset?.()
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("common.unsavedChanges.title")}</DialogTitle>
          <DialogDescription>
            {t("common.unsavedChanges.description")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => blocker.reset?.()}
          >
            {t("common.unsavedChanges.stay")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => blocker.proceed?.()}
          >
            {t("common.unsavedChanges.discard")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function UnsavedChangesGuard({ isDirty }: { isDirty: boolean }) {
  const hasDataRouter = Boolean(useContext(UNSAFE_DataRouterContext))

  useEffect(() => {
    if (!isDirty) return
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
    }
    window.addEventListener("beforeunload", handleBeforeUnload)
    return () => window.removeEventListener("beforeunload", handleBeforeUnload)
  }, [isDirty])

  if (!hasDataRouter) {
    return null
  }

  return <DataRouterUnsavedChangesGuard isDirty={isDirty} />
}
