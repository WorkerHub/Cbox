import { describe, expect, it } from "vitest"
import { formatBytes, formatDateTime, isExpired } from "./format"

describe("formatBytes", () => {
  it("正确格式化 0 及负数", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(-10)).toBe("0 B")
  })

  it("正确格式化 B / KB / MB / GB", () => {
    expect(formatBytes(500)).toBe("500 B")
    expect(formatBytes(1024)).toBe("1 KB")
    expect(formatBytes(1536)).toBe("1.5 KB")
    expect(formatBytes(1048576)).toBe("1 MB")
    expect(formatBytes(104857600)).toBe("100 MB")
    expect(formatBytes(1073741824)).toBe("1 GB")
  })
})

describe("formatDateTime", () => {
  it("处理空值与无效日期", () => {
    expect(formatDateTime(null)).toBe("-")
    expect(formatDateTime("invalid")).toBe("-")
  })

  it("正确格式化有效时间", () => {
    const iso = "2026-11-18T10:30:00Z"
    const formatted = formatDateTime(iso)
    expect(formatted).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })
})

describe("isExpired", () => {
  it("永不过期返回 false", () => {
    expect(isExpired(null)).toBe(false)
    expect(isExpired(undefined)).toBe(false)
  })

  it("正确判断过去与未来时间", () => {
    const past = new Date(Date.now() - 10000).toISOString()
    const future = new Date(Date.now() + 10000).toISOString()
    expect(isExpired(past)).toBe(true)
    expect(isExpired(future)).toBe(false)
  })
})
