import { CheckIcon, FolderIcon, Loader2Icon } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { cn } from "cn"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { filesApi, foldersApi } from "@/lib/api"
import { describeApiError } from "@/lib/api-errors"
import type { FileItem } from "@/lib/api-types"

interface MoveFileDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  file: FileItem | null
  onSuccess: () => void
}

interface FolderTreeNode {
  id: string
  name: string
  parentId: string | null
  children: FolderTreeNode[]
}

interface FlatFolderItem {
  id: string | null
  name: string
  depth: number
}

function flattenTree(nodes: FolderTreeNode[], depth = 1): FlatFolderItem[] {
  const result: FlatFolderItem[] = []
  for (const node of nodes) {
    result.push({ id: node.id, name: node.name, depth })
    if (node.children && node.children.length > 0) {
      result.push(...flattenTree(node.children, depth + 1))
    }
  }
  return result
}

export function MoveFileDialog({
  open,
  onOpenChange,
  file,
  onSuccess
}: MoveFileDialogProps) {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [folders, setFolders] = useState<FolderTreeNode[]>([])
  const [selectedFolderId, setSelectedFolderId] = useState<
    string | null | undefined
  >(undefined)

  const loadTree = useCallback(async () => {
    setLoading(true)
    setError("")
    setSelectedFolderId(undefined)
    const visited = new Set<string>()

    async function getSubTree(parentId: string): Promise<FolderTreeNode[]> {
      try {
        const res = await foldersApi.list(parentId)
        const validFolders = (res.folders || []).filter(
          (f) => f.parentId === parentId && !visited.has(f.id)
        )
        for (const f of validFolders) {
          visited.add(f.id)
        }
        return await Promise.all(
          validFolders.map(async (f) => ({
            id: f.id,
            name: f.name,
            parentId: f.parentId,
            children: await getSubTree(f.id)
          }))
        )
      } catch {
        return []
      }
    }

    try {
      const res = await foldersApi.list(null)
      const validFolders = (res.folders || []).filter(
        (f) => f.parentId === null && !visited.has(f.id)
      )
      for (const f of validFolders) {
        visited.add(f.id)
      }
      const rootFolders = await Promise.all(
        validFolders.map(async (f) => ({
          id: f.id,
          name: f.name,
          parentId: f.parentId,
          children: await getSubTree(f.id)
        }))
      )
      setFolders(rootFolders)
    } catch (err) {
      setError(describeApiError(t, err))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    if (open && file) {
      void loadTree()
    } else if (!open) {
      setSelectedFolderId(undefined)
      setError("")
      setFolders([])
      setBusy(false)
    }
  }, [open, file, loadTree])

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setSelectedFolderId(undefined)
      setError("")
      setFolders([])
      setBusy(false)
    }
    onOpenChange(nextOpen)
  }

  const handleSelect = (folderId: string | null) => {
    if (!file || file.folderId === folderId) return
    setSelectedFolderId(folderId)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (
      !file ||
      selectedFolderId === undefined ||
      selectedFolderId === file.folderId
    ) {
      return
    }

    setBusy(true)
    setError("")

    try {
      await filesApi.patch(file.id, { folderId: selectedFolderId })
      handleOpenChange(false)
      onSuccess()
    } catch (err) {
      setError(describeApiError(t, err))
    } finally {
      setBusy(false)
    }
  }

  const rootItem: FlatFolderItem = {
    id: null,
    name: t("workbench.moveDialog.rootDir"),
    depth: 0
  }
  const allItems: FlatFolderItem[] = [rootItem, ...flattenTree(folders)]

  const canSubmit =
    !busy &&
    !loading &&
    file !== null &&
    selectedFolderId !== undefined &&
    selectedFolderId !== file.folderId

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("workbench.moveDialog.title")}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto rounded-md border border-border/60 p-1">
            {loading ? (
              <div className="flex items-center justify-center gap-2 p-6 text-xs text-muted-foreground">
                <Loader2Icon className="h-4 w-4 animate-spin" />
                <span>{t("workbench.moveDialog.loading")}</span>
              </div>
            ) : (
              allItems.map((item) => {
                const isCurrent = file ? file.folderId === item.id : false
                const isSelected = selectedFolderId === item.id

                return (
                  <button
                    key={item.id ?? "root"}
                    type="button"
                    disabled={isCurrent || busy}
                    onClick={() => handleSelect(item.id)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors",
                      isSelected &&
                        "bg-accent text-accent-foreground font-medium",
                      !isSelected &&
                        !isCurrent &&
                        "hover:bg-muted/60 text-foreground",
                      isCurrent &&
                        "cursor-not-allowed opacity-50 text-muted-foreground"
                    )}
                    style={{ paddingLeft: `${10 + item.depth * 16}px` }}
                    data-testid={`move-target-${item.id ?? "root"}`}
                  >
                    <FolderIcon className="h-4 w-4 shrink-0 text-amber-500" />
                    <span className="truncate">{item.name}</span>
                    {isCurrent && (
                      <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                        ({t("workbench.moveDialog.currentFolder")})
                      </span>
                    )}
                    {isSelected && !isCurrent && (
                      <CheckIcon className="ml-auto h-3.5 w-3.5 shrink-0 text-primary" />
                    )}
                  </button>
                )
              })
            )}
          </div>

          {error && (
            <p className="text-xs text-destructive" data-testid="move-error">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={busy}
            >
              {t("common.actions.cancel")}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {busy
                ? t("common.actions.saving")
                : t("workbench.moveDialog.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
