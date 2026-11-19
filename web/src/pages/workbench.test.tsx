import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError, filesApi, foldersApi, sharesApi } from "@/lib/api"
import type { FolderListResponse, ShareItem } from "@/lib/api-types"
import { WorkbenchPage } from "@/pages/workbench"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    foldersApi: {
      ...actual.foldersApi,
      list: vi.fn(),
      create: vi.fn(),
      delete: vi.fn()
    },
    filesApi: {
      ...actual.filesApi,
      upload: vi.fn(),
      patch: vi.fn(),
      patchExpiration: vi.fn(),
      delete: vi.fn()
    },
    sharesApi: {
      ...actual.sharesApi,
      create: vi.fn(),
      list: vi.fn(),
      delete: vi.fn()
    }
  }
})

const futureIso = (hours = 48) =>
  new Date(Date.now() + hours * 3600 * 1000).toISOString()
const pastIso = (hours = 1) =>
  new Date(Date.now() - hours * 3600 * 1000).toISOString()

const buildMockFolderData = (): FolderListResponse => ({
  folder: null,
  breadcrumbs: [{ id: null, name: "Root" }],
  folders: [
    {
      id: "f1",
      parentId: null,
      name: "subfolder-1",
      createdAt: pastIso(2)
    }
  ],
  files: [
    {
      id: "file-1",
      folderId: null,
      name: "app.jar",
      sizeBytes: 1048576,
      contentType: "application/java-archive",
      sha256:
        "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
      expiresAt: futureIso(48),
      createdAt: pastIso(2),
      expired: false
    }
  ],
  usage: {
    usedBytes: 1048576,
    quotaBytes: 104857600,
    singleMaxBytes: 104857600
  }
})

describe("WorkbenchPage", () => {
  let mockFolderData: FolderListResponse

  beforeEach(() => {
    vi.clearAllMocks()
    mockFolderData = buildMockFolderData()
    vi.mocked(foldersApi.list).mockResolvedValue(mockFolderData)
    vi.mocked(sharesApi.list).mockResolvedValue({ items: [] })
  })

  it("渲染面包屑、文件夹、文件与用量条", async () => {
    render(
      <MemoryRouter>
        <WorkbenchPage />
      </MemoryRouter>
    )

    expect(await screen.findByText("subfolder-1")).toBeInTheDocument()
    expect(screen.getByText("app.jar")).toBeInTheDocument()
    expect(screen.getByText("1 MB")).toBeInTheDocument()
    expect(screen.getByText("空间用量")).toBeInTheDocument()
    expect(screen.getByText("单文件上限 100 MB")).toBeInTheDocument()
    expect(screen.getByText("1 MB / 100 MB")).toBeInTheDocument()
  })

  it("空文件夹显示空态", async () => {
    vi.mocked(foldersApi.list).mockResolvedValue({
      folder: null,
      breadcrumbs: [{ id: null, name: "Root" }],
      folders: [],
      files: [],
      usage: { usedBytes: 0, quotaBytes: 104857600, singleMaxBytes: 104857600 }
    })

    render(
      <MemoryRouter>
        <WorkbenchPage />
      </MemoryRouter>
    )

    expect(await screen.findByText("暂无内容")).toBeInTheDocument()
  })

  it("新建文件夹弹窗可提交并刷新列表", async () => {
    const user = userEvent.setup()
    vi.mocked(foldersApi.create).mockResolvedValue({
      id: "f2",
      parentId: null,
      name: "new-folder",
      createdAt: pastIso(1)
    })

    render(
      <MemoryRouter>
        <WorkbenchPage />
      </MemoryRouter>
    )

    await screen.findByText("subfolder-1")
    await user.click(screen.getByRole("button", { name: "新建文件夹" }))

    const input = screen.getByPlaceholderText("文件夹名称")
    await user.type(input, "new-folder")
    await user.click(screen.getByRole("button", { name: "创建" }))

    await waitFor(() => {
      expect(foldersApi.create).toHaveBeenCalledWith({
        parentId: null,
        name: "new-folder"
      })
    })
  })

  it("分享弹窗可展示 SHA-256 并生成公开直链", async () => {
    const user = userEvent.setup()
    const mockShare: ShareItem = {
      id: "s1",
      fileId: "file-1",
      token: "abcd1234",
      expiresAt: futureIso(48),
      downloadCount: 3,
      lastDownloadedAt: pastIso(1),
      createdAt: pastIso(2),
      expired: false
    }

    vi.mocked(sharesApi.list).mockResolvedValue({ items: [mockShare] })
    vi.mocked(sharesApi.create).mockResolvedValue({
      id: "s2",
      url: "https://example.com/s/secret-token-1234",
      expires_at: futureIso(48),
      tokenSuffix: "1234"
    })

    render(
      <MemoryRouter>
        <WorkbenchPage />
      </MemoryRouter>
    )

    await screen.findByText("app.jar")

    await user.click(screen.getByTestId("file-menu-file-1"))

    const shareMenuItem = await screen.findByText("分享")
    await user.click(shareMenuItem)

    expect(await screen.findByText("文件 SHA-256")).toBeInTheDocument()
    expect(
      screen.getByText(
        /aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899/
      )
    ).toBeInTheDocument()
    expect(
      screen.getByDisplayValue("http://localhost:3000/s/abcd1234")
    ).toBeInTheDocument()
    expect(screen.getByText("3 次下载")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "生成分享直链" }))

    await waitFor(() => {
      expect(sharesApi.create).toHaveBeenCalledWith("file-1", "file")
    })
    expect(
      await screen.findByDisplayValue("https://example.com/s/secret-token-1234")
    ).toBeInTheDocument()
  })

  it("存量旧分享（token 为 null）不展示链接行与复制按钮", async () => {
    const user = userEvent.setup()
    const legacyShare: ShareItem = {
      id: "s-legacy",
      fileId: "file-1",
      token: null,
      expiresAt: futureIso(48),
      downloadCount: 5,
      lastDownloadedAt: pastIso(1),
      createdAt: pastIso(2),
      expired: false
    }

    vi.mocked(sharesApi.list).mockResolvedValue({ items: [legacyShare] })

    render(
      <MemoryRouter>
        <WorkbenchPage />
      </MemoryRouter>
    )

    await screen.findByText("app.jar")
    await user.click(screen.getByTestId("file-menu-file-1"))
    await user.click(await screen.findByText("分享"))

    expect(await screen.findByText("5 次下载")).toBeInTheDocument()
    expect(
      screen.queryByDisplayValue(/localhost:3000\/s\//)
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "复制链接" })
    ).not.toBeInTheDocument()
    expect(screen.getByTitle("撤销")).toBeInTheDocument()
  })

  it("修改文件过期时间弹窗可提交", async () => {
    const user = userEvent.setup()
    vi.mocked(filesApi.patchExpiration).mockResolvedValue({
      id: "file-1",
      expiresAt: null
    })

    render(
      <MemoryRouter>
        <WorkbenchPage />
      </MemoryRouter>
    )

    await screen.findByText("app.jar")
    await user.click(screen.getByTestId("file-menu-file-1"))

    const changeExpItem = await screen.findByText("修改过期")
    await user.click(changeExpItem)

    expect(await screen.findByText("修改文件过期时间")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "保存" }))

    await waitFor(() => {
      expect(filesApi.patchExpiration).toHaveBeenCalledWith("file-1", "never")
    })
  })

  it("删除文件有二次确认弹窗", async () => {
    const user = userEvent.setup()
    vi.mocked(filesApi.delete).mockResolvedValue({ success: true })

    render(
      <MemoryRouter>
        <WorkbenchPage />
      </MemoryRouter>
    )

    await screen.findByText("app.jar")
    await user.click(screen.getByTestId("file-menu-file-1"))

    const deleteItem = await screen.findByText("删除")
    await user.click(deleteItem)

    expect(
      await screen.findByText("确定删除该文件？已生成的分享直链将一并失效。")
    ).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "确定删除" }))

    await waitFor(() => {
      expect(filesApi.delete).toHaveBeenCalledWith("file-1")
    })
  })

  it("接口报错时区分显示错误信息", async () => {
    vi.mocked(foldersApi.list).mockRejectedValue(
      new ApiError({
        status: 413,
        code: "FILE_TOO_LARGE",
        message: "File exceeds single file size limit"
      })
    )

    render(
      <MemoryRouter>
        <WorkbenchPage />
      </MemoryRouter>
    )

    expect(
      await screen.findByText("文件大小超过单文件上限")
    ).toBeInTheDocument()
  })

  it("重命名弹窗预填文件名并默认选中扩展名前缀，提交调用 patch name", async () => {
    const user = userEvent.setup()
    vi.mocked(filesApi.patch).mockResolvedValue({
      ...mockFolderData.files[0],
      name: "renamed.jar"
    })

    render(
      <MemoryRouter>
        <WorkbenchPage />
      </MemoryRouter>
    )

    await screen.findByText("app.jar")
    await user.click(screen.getByTestId("file-menu-file-1"))

    const renameItem = await screen.findByText("重命名")
    await user.click(renameItem)

    expect(await screen.findByText("重命名文件")).toBeInTheDocument()
    const input = screen.getByTestId("rename-file-input") as HTMLInputElement
    await waitFor(() => {
      expect(input.selectionStart).toBe(0)
      expect(input.selectionEnd).toBe(3)
    })

    await user.clear(input)
    await user.type(input, "renamed.jar")
    await user.click(screen.getByRole("button", { name: "保存" }))

    await waitFor(() => {
      expect(filesApi.patch).toHaveBeenCalledWith("file-1", {
        name: "renamed.jar"
      })
    })
  })

  it("重命名冲突（409）时弹窗内报错且不关闭弹窗", async () => {
    const user = userEvent.setup()
    vi.mocked(filesApi.patch).mockRejectedValue(
      new ApiError({
        status: 409,
        code: "FILE_NAME_CONFLICT",
        message: "A file with the same name already exists in this folder"
      })
    )

    render(
      <MemoryRouter>
        <WorkbenchPage />
      </MemoryRouter>
    )

    await screen.findByText("app.jar")
    await user.click(screen.getByTestId("file-menu-file-1"))
    await user.click(await screen.findByText("重命名"))

    const input = screen.getByTestId("rename-file-input")
    await user.clear(input)
    await user.type(input, "conflict.jar")
    await user.click(screen.getByRole("button", { name: "保存" }))

    expect(
      await screen.findByText("当前文件夹下已存在同名文件")
    ).toBeInTheDocument()
    expect(screen.getByText("重命名文件")).toBeInTheDocument()
  })

  it("移动文件弹窗展示根目录与文件夹树，当前所在标注且不可选，提交 patch folderId", async () => {
    const user = userEvent.setup()
    vi.mocked(filesApi.patch).mockResolvedValue({
      ...mockFolderData.files[0],
      folderId: "f1"
    })

    render(
      <MemoryRouter>
        <WorkbenchPage />
      </MemoryRouter>
    )

    await screen.findByText("app.jar")
    await user.click(screen.getByTestId("file-menu-file-1"))

    const moveItem = await screen.findByText("移动到")
    await user.click(moveItem)

    expect(await screen.findByText("移动文件")).toBeInTheDocument()
    expect(await screen.findByText("根目录")).toBeInTheDocument()
    expect(screen.getByTestId("move-target-f1")).toHaveTextContent(
      "subfolder-1"
    )

    // 文件当前在根目录（folderId 为 null），根目录被标注且 disabled
    const rootBtn = screen.getByTestId("move-target-root")
    expect(rootBtn).toBeDisabled()
    expect(rootBtn).toHaveTextContent("当前文件夹")

    const subfolderBtn = screen.getByTestId("move-target-f1")
    expect(subfolderBtn).not.toBeDisabled()

    await user.click(subfolderBtn)
    await user.click(screen.getByRole("button", { name: "移动" }))

    await waitFor(() => {
      expect(filesApi.patch).toHaveBeenCalledWith("file-1", {
        folderId: "f1"
      })
    })
  })

  it("文件在子文件夹中时移动到根目录提交 folderId 为 null", async () => {
    const user = userEvent.setup()
    const folderDataWithFileInSubfolder: FolderListResponse = {
      ...mockFolderData,
      files: [
        {
          ...mockFolderData.files[0],
          folderId: "f1"
        }
      ]
    }
    vi.mocked(foldersApi.list).mockResolvedValue(folderDataWithFileInSubfolder)
    vi.mocked(filesApi.patch).mockResolvedValue({
      ...folderDataWithFileInSubfolder.files[0],
      folderId: null
    })

    render(
      <MemoryRouter>
        <WorkbenchPage />
      </MemoryRouter>
    )

    await screen.findByText("app.jar")
    await user.click(screen.getByTestId("file-menu-file-1"))
    await user.click(await screen.findByText("移动到"))

    expect(await screen.findByText("移动文件")).toBeInTheDocument()
    const subfolderBtn = await screen.findByTestId("move-target-f1")
    expect(subfolderBtn).toBeDisabled()
    expect(subfolderBtn).toHaveTextContent("当前文件夹")

    const rootBtn = screen.getByTestId("move-target-root")
    expect(rootBtn).not.toBeDisabled()

    await user.click(rootBtn)
    await user.click(screen.getByRole("button", { name: "移动" }))

    await waitFor(() => {
      expect(filesApi.patch).toHaveBeenCalledWith("file-1", {
        folderId: null
      })
    })
  })

  it("移动弹窗在根目录文件夹列表拉取失败时呈现错误提示", async () => {
    const user = userEvent.setup()
    vi.mocked(foldersApi.list)
      .mockResolvedValueOnce(mockFolderData)
      .mockRejectedValueOnce(
        new ApiError({
          status: 500,
          code: "INTERNAL_ERROR",
          message: "Database error"
        })
      )

    render(
      <MemoryRouter>
        <WorkbenchPage />
      </MemoryRouter>
    )

    await screen.findByText("app.jar")
    await user.click(screen.getByTestId("file-menu-file-1"))
    await user.click(await screen.findByText("移动到"))

    expect(await screen.findByText("移动文件")).toBeInTheDocument()
    const errorEl = await screen.findByTestId("move-error")
    expect(errorEl).toBeInTheDocument()
    expect(errorEl.textContent).toBeTruthy()
    expect(screen.getByRole("button", { name: "移动" })).toBeDisabled()
  })

  it("用量条在 ≥90% 时使用红色警示样式", async () => {
    const highUsageData: FolderListResponse = {
      ...mockFolderData,
      usage: {
        usedBytes: 95 * 1048576,
        quotaBytes: 100 * 1048576,
        singleMaxBytes: 100 * 1048576
      }
    }
    vi.mocked(foldersApi.list).mockResolvedValue(highUsageData)

    render(
      <MemoryRouter>
        <WorkbenchPage />
      </MemoryRouter>
    )

    await screen.findByText("app.jar")
    const usageBar = screen.getByTestId("usage-bar")
    expect(usageBar).toBeInTheDocument()
    expect(usageBar.querySelector(".bg-destructive")).toBeInTheDocument()
  })
})
