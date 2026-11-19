import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { UploadDialog } from "@/components/workbench/upload-dialog"
import { filesApi } from "@/lib/api"
import type { FileItem } from "@/lib/api-types"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    filesApi: {
      ...actual.filesApi,
      upload: vi.fn(),
      abortUpload: vi.fn()
    }
  }
})

describe("UploadDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("选择文件后展示文件名与字节大小，点击上传完成调用", async () => {
    const user = userEvent.setup()
    const handleSuccess = vi.fn()
    const handleOpenChange = vi.fn()

    const mockFileItem: FileItem = {
      id: "file-123",
      folderId: null,
      name: "report.pdf",
      sizeBytes: 1024,
      contentType: "application/pdf",
      sha256: "hash-123",
      expiresAt: null,
      createdAt: new Date().toISOString(),
      expired: false
    }

    vi.mocked(filesApi.upload).mockImplementation(
      async (_file, _options, onProgress) => {
        onProgress?.({ loaded: 512, total: 1024, percent: 50 })
        onProgress?.({ loaded: 1024, total: 1024, percent: 100 })
        return mockFileItem
      }
    )

    render(
      <UploadDialog
        open={true}
        onOpenChange={handleOpenChange}
        currentFolderId={null}
        onSuccess={handleSuccess}
      />
    )

    expect(screen.getByText("上传文件")).toBeInTheDocument()

    const file = new File(["a".repeat(1024)], "report.pdf", {
      type: "application/pdf"
    })
    const fileInput = document.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement
    await user.upload(fileInput, file)

    expect(await screen.findByText(/report\.pdf \(1 KB\)/)).toBeInTheDocument()

    const submitBtn = screen.getByRole("button", { name: "开始上传" })
    await user.click(submitBtn)

    await waitFor(() => {
      expect(filesApi.upload).toHaveBeenCalled()
      expect(handleSuccess).toHaveBeenCalled()
      expect(handleOpenChange).toHaveBeenCalledWith(false)
    })
  })

  it("上传中可点击取消按钮中断上传", async () => {
    const user = userEvent.setup()
    const handleSuccess = vi.fn()
    const handleOpenChange = vi.fn()

    let caughtSignal: AbortSignal | undefined

    vi.mocked(filesApi.upload).mockImplementation(
      async (_file, options, onProgress) => {
        caughtSignal = options?.signal
        onProgress?.({ loaded: 100, total: 1000, percent: 10 })
        return new Promise((_resolve, reject) => {
          caughtSignal?.addEventListener("abort", () => {
            reject(
              new DOMException("The user aborted a request.", "AbortError")
            )
          })
        })
      }
    )

    render(
      <UploadDialog
        open={true}
        onOpenChange={handleOpenChange}
        currentFolderId={null}
        onSuccess={handleSuccess}
      />
    )

    const file = new File(["a".repeat(1000)], "large.zip", {
      type: "application/zip"
    })
    const fileInput = document.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement
    await user.upload(fileInput, file)

    const submitBtn = screen.getByRole("button", { name: "开始上传" })
    await user.click(submitBtn)

    expect(await screen.findByText(/100 B \/ 1000 B/)).toBeInTheDocument()

    const cancelBtn = screen.getByRole("button", { name: "取消" })
    await user.click(cancelBtn)

    await waitFor(() => {
      expect(caughtSignal?.aborted).toBe(true)
      expect(handleOpenChange).toHaveBeenCalledWith(false)
      expect(handleSuccess).not.toHaveBeenCalled()
    })
  })

  it("上传成功且响应带 share 时进入完成态：展示完整链接与复制按钮，点「完成」关闭并刷新", async () => {
    const user = userEvent.setup()
    const handleSuccess = vi.fn()
    const handleOpenChange = vi.fn()

    const mockFileItem: FileItem = {
      id: "file-123",
      folderId: null,
      name: "report.pdf",
      sizeBytes: 1024,
      contentType: "application/pdf",
      sha256: "hash-123",
      expiresAt: null,
      createdAt: new Date().toISOString(),
      expired: false,
      share: { token: "AbCd1234", expiresAt: null }
    }

    vi.mocked(filesApi.upload).mockImplementation(
      async (_file, _options, onProgress) => {
        onProgress?.({ loaded: 1024, total: 1024, percent: 100 })
        return mockFileItem
      }
    )

    render(
      <UploadDialog
        open={true}
        onOpenChange={handleOpenChange}
        currentFolderId={null}
        onSuccess={handleSuccess}
      />
    )

    const file = new File(["a".repeat(1024)], "report.pdf", {
      type: "application/pdf"
    })
    const fileInput = document.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement
    await user.upload(fileInput, file)

    const submitBtn = screen.getByRole("button", { name: "开始上传" })
    await user.click(submitBtn)

    expect(
      await screen.findByDisplayValue("http://localhost:3000/s/AbCd1234")
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "复制直链" })).toBeInTheDocument()
    expect(handleOpenChange).not.toHaveBeenCalledWith(false)
    expect(handleSuccess).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "完成" }))
    await waitFor(() => {
      expect(handleOpenChange).toHaveBeenCalledWith(false)
      expect(handleSuccess).toHaveBeenCalled()
    })
  })
})
