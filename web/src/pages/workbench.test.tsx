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

const mockFolderData: FolderListResponse = {
  folder: null,
  breadcrumbs: [{ id: null, name: "Root" }],
  folders: [
    {
      id: "f1",
      parentId: null,
      name: "subfolder-1",
      createdAt: "2026-11-18T10:00:00Z"
    }
  ],
  files: [
    {
      id: "file-1",
      folderId: null,
      name: "app.jar",
      sizeBytes: 1048576, // 1 MB
      contentType: "application/java-archive",
      sha256:
        "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
      expiresAt: "2026-11-19T10:00:00Z",
      createdAt: "2026-11-18T10:00:00Z",
      expired: false
    }
  ],
  usage: {
    usedBytes: 1048576,
    quotaBytes: 104857600, // 100 MB
    singleMaxBytes: 104857600
  }
}

describe("WorkbenchPage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
      createdAt: "2026-11-18T11:00:00Z"
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
      tokenSuffix: "abcd",
      expiresAt: "2026-11-19T10:00:00Z",
      downloadCount: 3,
      lastDownloadedAt: "2026-11-18T12:00:00Z",
      createdAt: "2026-11-18T10:30:00Z",
      expired: false
    }

    vi.mocked(sharesApi.list).mockResolvedValue({ items: [mockShare] })
    vi.mocked(sharesApi.create).mockResolvedValue({
      id: "s2",
      url: "https://example.com/s/secret-token-1234",
      expires_at: "2026-11-19T10:00:00Z",
      tokenSuffix: "1234"
    })

    render(
      <MemoryRouter>
        <WorkbenchPage />
      </MemoryRouter>
    )

    await screen.findByText("app.jar")
    // 打开文件行操作菜单
    await user.click(screen.getByTestId("file-menu-file-1"))

    // 点击分享
    const shareMenuItem = await screen.findByText("分享")
    await user.click(shareMenuItem)

    // 分享弹窗打开，应包含文件 SHA-256
    expect(await screen.findByText("文件 SHA-256")).toBeInTheDocument()
    expect(
      screen.getByText(
        /aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899/
      )
    ).toBeInTheDocument()
    expect(screen.getByText("尾号 abcd")).toBeInTheDocument()
    expect(screen.getByText("3 次下载")).toBeInTheDocument()

    // 点击生成分享直链
    await user.click(screen.getByRole("button", { name: "生成分享直链" }))

    await waitFor(() => {
      expect(sharesApi.create).toHaveBeenCalledWith("file-1", "24h")
    })
    expect(
      await screen.findByDisplayValue("https://example.com/s/secret-token-1234")
    ).toBeInTheDocument()
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
})
