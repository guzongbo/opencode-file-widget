import { Plugin } from "@opencode/plugin"
import { Files } from "./rpc.js"
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { randomUUID } from "node:crypto"

const DEFAULT_UPLOAD_ROOT = "/tmp/opencode/uploads"
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024
const DEFAULT_TTL_HOURS = 24
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000

type Options = {
  uploadRoot?: string
  allowRoots?: string[]
  maxBytes?: number
  ttlHours?: number
  binaryEnabled?: boolean
}

type PendingUpload = {
  id: string
  directory: string
  file: string
  name: string
  size: number
  createdAt: number
}

function inside(root: string, file: string) {
  const normalizedRoot = resolve(root)
  const normalizedFile = resolve(file)
  if (normalizedRoot === sep) return normalizedFile.startsWith(sep)
  return normalizedFile === normalizedRoot || normalizedFile.startsWith(normalizedRoot + sep)
}

function safeName(input: string) {
  const base = basename(input.normalize("NFKC"))
    .replace(/[\/\\?%*:|"<>]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^\.+/, "")
  const cleaned = base || "file"
  if (cleaned.length <= 80) return cleaned
  const extension = extname(cleaned).slice(0, 16)
  return cleaned.slice(0, Math.max(1, 80 - extension.length)) + extension
}

function positive(value: unknown, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

async function resolveRoots(roots: string[]) {
  const resolved: string[] = []
  for (const root of roots) {
    try {
      resolved.push(await realpath(resolve(root)))
    } catch {
      // A configured root may not exist yet; skip it rather than allowing it.
    }
  }
  return [...new Set(resolved)]
}

async function cleanup(root: string, ttlHours: number) {
  const cutoff = Date.now() - ttlHours * 60 * 60 * 1000
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const directory = join(root, entry.name)
    const info = await stat(directory).catch(() => undefined)
    if (!info) continue
    if (info.mtimeMs < cutoff) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

export default Plugin.define({
  id: "acme.files",
  async setup(ctx) {
    const options = ctx.options as Options
    const uploadRoot = resolve(options.uploadRoot ?? DEFAULT_UPLOAD_ROOT)
    const maxBytes = positive(options.maxBytes, DEFAULT_MAX_BYTES)
    const ttlHours = positive(options.ttlHours, DEFAULT_TTL_HOURS)
    const binaryEnabled = options.binaryEnabled !== false
    const pendingUploads = new Map<string, PendingUpload>()

    await mkdir(uploadRoot, { recursive: true, mode: 0o700 })

    const configuredRoots =
      options.allowRoots && options.allowRoots.length > 0
        ? options.allowRoots
        : [ctx.location.directory, uploadRoot]
    const roots = await resolveRoots([...configuredRoots, uploadRoot])

    await ctx.rpc.register(Files, {
      info: async () => ({
        version: ctx.app.version,
        maxBytes,
        ttlHours,
        modes: binaryEnabled ? ["basic", "binary"] : ["basic"],
        uploadRoot,
      }),

      upload: async (input) => {
        const { name, data } = input as { name: string; data: string }
        const maxEncoded = Math.ceil(maxBytes / 3) * 4 + 4
        if (data.length > maxEncoded) {
          throw new Error(`文件超过限制（${maxBytes} 字节）`)
        }
        const bytes = Buffer.from(data, "base64")
        if (bytes.byteLength === 0) throw new Error("拒绝空文件")
        if (bytes.byteLength > maxBytes) {
          throw new Error(`文件超过限制（${maxBytes} 字节）`)
        }

        const id = randomUUID().slice(0, 8)
        const directory = join(uploadRoot, id)
        const file = join(directory, safeName(name))

        await mkdir(directory, { recursive: true, mode: 0o700 })
        await writeFile(file, bytes, { mode: 0o600, flag: "wx" })

        return { path: file, name: basename(file), size: bytes.byteLength }
      },

      download: async (input) => {
        const { path: requested } = input as { path: string }
        const file = await realpath(requested).catch(() => {
          throw new Error(`文件不存在: ${requested}`)
        })

        if (!roots.some((root) => inside(root, file))) {
          throw new Error("路径不在允许范围内")
        }

        const info = await stat(file)
        if (!info.isFile()) throw new Error("不是普通文件")
        if (info.size > maxBytes) {
          throw new Error(`文件超过限制（${maxBytes} 字节）`)
        }

        const bytes = await readFile(file)
        return {
          name: basename(file),
          data: bytes.toString("base64"),
          size: bytes.byteLength,
        }
      },

      prepareUpload: async (input) => {
        if (!binaryEnabled) throw new Error("二进制传输已禁用")
        const { name, size } = input as { name: string; size: number }
        if (!Number.isFinite(size) || size <= 0) throw new Error("拒绝空文件")
        if (size > maxBytes) {
          throw new Error(`文件超过限制（${maxBytes} 字节）`)
        }

        const id = randomUUID()
        const directory = join(uploadRoot, id)
        const file = join(directory, safeName(name))
        await mkdir(directory, { recursive: true, mode: 0o700 })
        pendingUploads.set(id, {
          id,
          directory,
          file,
          name: basename(file),
          size,
          createdAt: Date.now(),
        })

        return { id, path: file, name: basename(file), size }
      },

      finishUpload: async (input) => {
        if (!binaryEnabled) throw new Error("二进制传输已禁用")
        const { id } = input as { id: string }
        const pending = pendingUploads.get(id)
        if (!pending) throw new Error("上传会话不存在或已过期")

        const file = await realpath(pending.file).catch(() => undefined)
        if (!file || !inside(uploadRoot, file)) {
          pendingUploads.delete(id)
          await rm(pending.directory, { recursive: true, force: true }).catch(() => undefined)
          throw new Error("上传路径不在允许范围内")
        }

        const info = await stat(file).catch(() => undefined)
        if (!info || !info.isFile()) {
          pendingUploads.delete(id)
          await rm(pending.directory, { recursive: true, force: true }).catch(() => undefined)
          throw new Error("上传文件不存在")
        }
        if (info.size !== pending.size || info.size > maxBytes) {
          pendingUploads.delete(id)
          await rm(pending.directory, { recursive: true, force: true }).catch(() => undefined)
          throw new Error("上传文件大小不匹配")
        }

        await chmod(file, 0o600)
        pendingUploads.delete(id)
        return { path: file, name: basename(file), size: info.size }
      },

      abortUpload: async (input) => {
        const { id } = input as { id: string }
        const pending = pendingUploads.get(id)
        if (pending) {
          pendingUploads.delete(id)
          await rm(pending.directory, { recursive: true, force: true }).catch(() => undefined)
        }
        return { ok: true }
      },

      prepareDownload: async (input) => {
        if (!binaryEnabled) throw new Error("二进制传输已禁用")
        const { path: requested } = input as { path: string }
        const file = await realpath(requested).catch(() => {
          throw new Error(`文件不存在: ${requested}`)
        })

        const root = roots.find((candidate) => inside(candidate, file))
        if (!root) throw new Error("路径不在允许范围内")

        const info = await stat(file)
        if (!info.isFile()) throw new Error("不是普通文件")
        if (info.size > maxBytes) {
          throw new Error(`文件超过限制（${maxBytes} 字节）`)
        }

        const relativePath = relative(root, file)
        if (
          !relativePath ||
          relativePath === ".." ||
          relativePath.startsWith(".." + sep) ||
          isAbsolute(relativePath)
        ) {
          throw new Error("路径不在允许范围内")
        }

        return {
          name: basename(file),
          size: info.size,
          root,
          relativePath,
        }
      },
    })

    const timer = setInterval(() => {
      void cleanup(uploadRoot, ttlHours)
      const cutoff = Date.now() - ttlHours * 60 * 60 * 1000
      for (const [id, pending] of pendingUploads) {
        if (pending.createdAt < cutoff) {
          pendingUploads.delete(id)
          void rm(pending.directory, { recursive: true, force: true }).catch(() => undefined)
        }
      }
    }, CLEANUP_INTERVAL_MS) as NodeJS.Timeout & { unref?: () => void }
    timer.unref?.()

    return () => clearInterval(timer)
  },
})
