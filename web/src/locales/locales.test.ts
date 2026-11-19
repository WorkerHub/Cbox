import { describe, expect, it } from "vitest"
import en from "@/locales/en.json"
import zh from "@/locales/zh.json"

type Bundle = { [key: string]: string | Bundle }

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/

function flatten(bundle: Bundle, prefix = ""): Map<string, string> {
  const entries = new Map<string, string>()
  for (const [key, value] of Object.entries(bundle)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === "string") entries.set(path, value)
    else
      for (const [child, text] of flatten(value, path)) entries.set(child, text)
  }
  return entries
}

function baseKeys(bundle: Bundle): string[] {
  return [
    ...new Set(
      [...flatten(bundle).keys()].map((key) => key.replace(PLURAL_SUFFIX, ""))
    )
  ].sort()
}

const zhEntries = flatten(zh as Bundle)
const enEntries = flatten(en as Bundle)

describe("语言资源", () => {
  it("中英两份资源的 key 集合完全一致", () => {
    expect(baseKeys(en as Bundle)).toEqual(baseKeys(zh as Bundle))
  })

  it("每条都有非空文案", () => {
    for (const [key, value] of [...zhEntries, ...enEntries]) {
      expect(value.trim(), key).not.toBe("")
    }
  })

  it("英文资源没有漏翻的中文（语言自称除外）", () => {
    const leftovers = [...enEntries]
      .filter(([key]) => !key.startsWith("common.languages."))
      .filter(([, value]) => /[\u4e00-\u9fff]/.test(value))
      .map(([key]) => key)
    expect(leftovers).toEqual([])
  })
})
