import { FolderPlusIcon, RefreshCwIcon, UploadIcon } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { useSearchParams } from "react-router"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { BreadcrumbNav } from "@/components/workbench/breadcrumb-nav"
import { CreateFolderDialog } from "@/components/workbench/create-folder-dialog"
import {
  DeleteConfirmDialog,
  type DeleteTarget
} from "@/components/workbench/delete-confirm-dialog"
import { EditExpirationDialog } from "@/components/workbench/edit-expiration-dialog"
import { FileTable } from "@/components/workbench/file-table"
import { MoveFileDialog } from "@/components/workbench/move-file-dialog"
import { RenameFileDialog } from "@/components/workbench/rename-file-dialog"
import { ShareDialog } from "@/components/workbench/share-dialog"
import { UploadDialog } from "@/components/workbench/upload-dialog"
import { UsageBar } from "@/components/workbench/usage-bar"
import { foldersApi } from "@/lib/api"
import { describeApiError } from "@/lib/api-errors"
import type {
  BreadcrumbItem,
  FileItem,
  FolderItem,
  UsageInfo
} from "@/lib/api-types"

export function WorkbenchPage() {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  const currentFolderId = searchParams.get("folder") || null

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([])
  const [folders, setFolders] = useState<FolderItem[]>([])
  const [files, setFiles] = useState<FileItem[]>([])
  const [usage, setUsage] = useState<UsageInfo>({
    usedBytes: 0,
    quotaBytes: 0,
    singleMaxBytes: 0
  })

  const [createFolderOpen, setCreateFolderOpen] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [shareFile, setShareFile] = useState<FileItem | null>(null)
  const [renameFile, setRenameFile] = useState<FileItem | null>(null)
  const [moveFile, setMoveFile] = useState<FileItem | null>(null)
  const [editExpFile, setEditExpFile] = useState<FileItem | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>(null)

  const loadData = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const data = await foldersApi.list(currentFolderId)
      setBreadcrumbs(data.breadcrumbs)
      setFolders(data.folders)
      setFiles(data.files)
      setUsage(data.usage)
    } catch (err) {
      setError(describeApiError(t, err))
    } finally {
      setLoading(false)
    }
  }, [currentFolderId, t])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const handleSelectFolder = (folderId: string | null) => {
    if (folderId === null) {
      setSearchParams({})
    } else {
      setSearchParams({ folder: folderId })
    }
  }

  return (
    <div
      className="flex h-full flex-col gap-4 p-4 sm:p-6"
      data-testid="workbench-page"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <BreadcrumbNav
          breadcrumbs={breadcrumbs}
          onSelect={handleSelectFolder}
        />

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setCreateFolderOpen(true)}
          >
            <FolderPlusIcon className="mr-1.5 h-4 w-4" />
            {t("workbench.actions.newFolder")}
          </Button>

          <Button type="button" size="sm" onClick={() => setUploadOpen(true)}>
            <UploadIcon className="mr-1.5 h-4 w-4" />
            {t("workbench.actions.upload")}
          </Button>
        </div>
      </div>
      <div className="flex-1">
        {loading ? (
          <div className="flex flex-col gap-2 p-4">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : error ? (
          <div className="flex h-48 flex-col items-center justify-center gap-3 rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-center">
            <p className="text-xs text-destructive">{error}</p>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={loadData}
            >
              <RefreshCwIcon className="mr-1.5 h-3.5 w-3.5" />
              {t("common.actions.retry")}
            </Button>
          </div>
        ) : (
          <FileTable
            folders={folders}
            files={files}
            onOpenFolder={handleSelectFolder}
            onDeleteFolder={(f) => setDeleteTarget({ type: "folder", item: f })}
            onShareFile={(file) => setShareFile(file)}
            onRenameFile={(file) => setRenameFile(file)}
            onMoveFile={(file) => setMoveFile(file)}
            onEditExpiration={(file) => setEditExpFile(file)}
            onDeleteFile={(file) =>
              setDeleteTarget({ type: "file", item: file })
            }
          />
        )}
      </div>
      <UsageBar
        usedBytes={usage.usedBytes}
        quotaBytes={usage.quotaBytes}
        singleMaxBytes={usage.singleMaxBytes}
      />
      <CreateFolderDialog
        open={createFolderOpen}
        onOpenChange={setCreateFolderOpen}
        currentFolderId={currentFolderId}
        onSuccess={loadData}
      />

      <UploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        currentFolderId={currentFolderId}
        onSuccess={loadData}
      />

      <ShareDialog
        open={Boolean(shareFile)}
        onOpenChange={(open) => {
          if (!open) setShareFile(null)
        }}
        file={shareFile}
      />

      <RenameFileDialog
        open={Boolean(renameFile)}
        onOpenChange={(open) => {
          if (!open) setRenameFile(null)
        }}
        file={renameFile}
        onSuccess={loadData}
      />

      <MoveFileDialog
        open={Boolean(moveFile)}
        onOpenChange={(open) => {
          if (!open) setMoveFile(null)
        }}
        file={moveFile}
        onSuccess={loadData}
      />

      <EditExpirationDialog
        open={Boolean(editExpFile)}
        onOpenChange={(open) => {
          if (!open) setEditExpFile(null)
        }}
        file={editExpFile}
        onSuccess={loadData}
      />

      <DeleteConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        target={deleteTarget}
        onSuccess={loadData}
      />
    </div>
  )
}
