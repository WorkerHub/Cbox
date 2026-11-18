import {
  CalendarClockIcon,
  DownloadIcon,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
  MoreHorizontalIcon,
  Share2Icon,
  Trash2Icon
} from "lucide-react"
import { useTranslation } from "react-i18next"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
import { filesApi } from "@/lib/api"
import type { FileItem, FolderItem } from "@/lib/api-types"
import { formatBytes, formatDateTime, isExpired } from "@/lib/format"

interface FileTableProps {
  folders: FolderItem[]
  files: FileItem[]
  onOpenFolder: (folderId: string) => void
  onDeleteFolder: (folder: FolderItem) => void
  onShareFile: (file: FileItem) => void
  onEditExpiration: (file: FileItem) => void
  onDeleteFile: (file: FileItem) => void
}

export function FileTable({
  folders,
  files,
  onOpenFolder,
  onDeleteFolder,
  onShareFile,
  onEditExpiration,
  onDeleteFile
}: FileTableProps) {
  const { t } = useTranslation()

  const isEmpty = folders.length === 0 && files.length === 0

  const handleDownload = (file: FileItem) => {
    const url = filesApi.downloadUrl(file.id)
    const link = document.createElement("a")
    link.href = url
    link.download = file.name
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  return (
    <div className="rounded-lg border border-border/60 bg-card overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-[45%] min-w-[180px]">
              {t("workbench.table.name")}
            </TableHead>
            <TableHead className="w-[20%] min-w-[90px]">
              {t("workbench.table.size")}
            </TableHead>
            <TableHead className="w-[25%] min-w-[140px]">
              {t("workbench.table.expires")}
            </TableHead>
            <TableHead className="w-[10%] min-w-[60px] text-right">
              {t("workbench.table.actions")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isEmpty ? (
            <TableRow>
              <TableCell
                colSpan={4}
                className="h-32 text-center text-xs text-muted-foreground"
              >
                {t("workbench.table.empty")}
              </TableCell>
            </TableRow>
          ) : (
            <>
              {folders.map((folder) => (
                <TableRow
                  key={`folder-${folder.id}`}
                  className="group hover:bg-muted/40 cursor-pointer"
                  onClick={() => onOpenFolder(folder.id)}
                >
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      <FolderIcon className="h-4 w-4 shrink-0 text-amber-500" />
                      <span className="truncate">{folder.name}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    -
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    -
                  </TableCell>
                  <TableCell
                    className="text-right"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="opacity-70 group-hover:opacity-100"
                          data-testid={`folder-menu-${folder.id}`}
                        >
                          <MoreHorizontalIcon className="h-3.5 w-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="text-xs">
                        <DropdownMenuItem
                          onClick={() => onOpenFolder(folder.id)}
                        >
                          <FolderOpenIcon className="mr-2 h-3.5 w-3.5" />
                          {t("workbench.actions.open")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={() => onDeleteFolder(folder)}
                          className="text-destructive focus:text-destructive"
                        >
                          <Trash2Icon className="mr-2 h-3.5 w-3.5" />
                          {t("workbench.actions.delete")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}

              {files.map((file) => {
                const expired = isExpired(file.expiresAt)
                return (
                  <TableRow
                    key={`file-${file.id}`}
                    className="group hover:bg-muted/40"
                  >
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <FileIcon className="h-4 w-4 shrink-0 text-blue-500" />
                        <span className="truncate">{file.name}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatBytes(file.sizeBytes)}
                    </TableCell>
                    <TableCell className="text-xs">
                      {expired ? (
                        <Badge
                          variant="destructive"
                          className="text-[10px] font-normal"
                        >
                          {t("workbench.status.expired")}
                        </Badge>
                      ) : file.expiresAt ? (
                        <span className="text-muted-foreground">
                          {formatDateTime(file.expiresAt)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">
                          {t("workbench.status.never")}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="opacity-70 group-hover:opacity-100"
                            data-testid={`file-menu-${file.id}`}
                          >
                            <MoreHorizontalIcon className="h-3.5 w-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="text-xs">
                          <DropdownMenuItem
                            onClick={() => handleDownload(file)}
                            disabled={expired}
                          >
                            <DownloadIcon className="mr-2 h-3.5 w-3.5" />
                            {t("workbench.actions.download")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => onShareFile(file)}
                            disabled={expired}
                          >
                            <Share2Icon className="mr-2 h-3.5 w-3.5" />
                            {t("workbench.actions.share")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => onEditExpiration(file)}
                          >
                            <CalendarClockIcon className="mr-2 h-3.5 w-3.5" />
                            {t("workbench.actions.changeExpiration")}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => onDeleteFile(file)}
                            className="text-destructive focus:text-destructive"
                          >
                            <Trash2Icon className="mr-2 h-3.5 w-3.5" />
                            {t("workbench.actions.delete")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                )
              })}
            </>
          )}
        </TableBody>
      </Table>
    </div>
  )
}
