import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = path.resolve(process.cwd(), "src")
const CJK = /[\u4e00-\u9fff]/

function stripComments(source: string): string {
  let output = ""
  let index = 0
  let quote: string | null = null

  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]

    if (quote) {
      output += char
      if (char === "\\") {
        output += next ?? ""
        index += 2
        continue
      }
      if (char === quote) quote = null
      index += 1
      continue
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char
      output += char
      index += 1
      continue
    }

    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1
      continue
    }

    if (char === "/" && next === "*") {
      index += 2
      while (
        index < source.length &&
        !(source[index] === "*" && source[index + 1] === "/")
      ) {
        index += 1
      }
      index += 2
      continue
    }

    output += char
    index += 1
  }

  return output
}

function collect(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === "locales") continue
      collect(full, files)
      continue
    }
    if (!/\.(ts|tsx|json)$/.test(entry)) continue
    if (/\.test\.(ts|tsx)$/.test(entry)) continue
    if (full.includes(`${path.sep}test${path.sep}`)) continue
    files.push(full)
  }
  return files
}

describe("界面文案", () => {
  it("组件源码里没有硬编码的中文文案", () => {
    const offenders: string[] = []
    for (const file of collect(ROOT)) {
      const raw = readFileSync(file, "utf8")
      const source = file.endsWith(".json") ? raw : stripComments(raw)
      source.split("\n").forEach((line, index) => {
        if (CJK.test(line)) {
          offenders.push(
            `${path.relative(ROOT, file)}:${index + 1}: ${line.trim()}`
          )
        }
      })
    }
    expect(offenders).toEqual([])
  })
})
