/** @jsxRuntime automatic */
/** @jsxImportSource @opentui/solid */
import { createSignal, For, Show } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import { Files } from "./rpc.js"
import { execFile, execFileSync } from "node:child_process"
import { promisify } from "node:util"
import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path"
import { randomUUID } from "node:crypto"

type Direction = "upload" | "download"
type HistoryStatus = "success" | "error"

type HistoryItem = {
  id: string
  direction: Direction
  status?: HistoryStatus
  name: string
  serverPath: string
  localPath?: string
  size: number
  at: number
  message?: string
}

type HistoryState = { items: HistoryItem[] }
type HistoryUpdate = (mutation: (draft: HistoryState) => void) => Promise<void>

type UploadResult = { path: string; name: string; size: number }
type DownloadResult = { name: string; data: string; size: number }
type DownloadBytes = { name: string; data: Uint8Array; size: number }

type TransferMode = "auto" | "basic" | "binary"
type CopyFormat = "mention" | "path"

type ClientSettings = {
  downloadDir?: string
  autoCopy: boolean
  showRecent: boolean
  recentCount: number
  transferMode: TransferMode
  revealAfterDownload: boolean
  copyFormat: CopyFormat
  showFileSize: boolean
}

type SettingsUpdate = (mutation: (draft: ClientSettings) => void) => Promise<void>

type ServerInfo = {
  version: string
  maxBytes: number
  ttlHours: number
  modes: Array<"basic" | "binary">
  uploadRoot: string
}

const DEFAULT_CLIENT_SETTINGS: ClientSettings = {
  autoCopy: false,
  showRecent: true,
  recentCount: 5,
  transferMode: "auto",
  revealAfterDownload: false,
  copyFormat: "mention",
  showFileSize: false,
}

type PickerChoice =
  | { type: "up" }
  | { type: "dir"; path: string }
  | { type: "file"; path: string }

const COLOR_UPLOAD = "#7fd88f"
const COLOR_DOWNLOAD = "#5c9cf5"
const COLOR_SUCCESS = "#7fd88f"
const COLOR_ERROR = "#f56c6c"
const COLOR_MUTED = "#9ca3af"
const COLOR_DIVIDER = "#4b5563"
const COLOR_UPLOAD_BG = "#1e3a5f"

function succeeded(item: HistoryItem) {
  return (item.status ?? "success") === "success"
}

function statusColor(item: HistoryItem) {
  return succeeded(item) ? COLOR_SUCCESS : COLOR_ERROR
}

function directionColor(direction: Direction) {
  return direction === "upload" ? COLOR_UPLOAD : COLOR_DOWNLOAD
}

/* -------------------------------------------------------------------------- */
/* Platform helpers                                                           */
/* -------------------------------------------------------------------------- */

const execFileAsync = promisify(execFile)

async function pickLocalFile(): Promise<string | undefined> {
  if (process.platform === "darwin") {
    try {
      const { stdout } = (await execFileAsync(
        "osascript",
        [
          "-e",
          'activate\nPOSIX path of (choose file with prompt "选择要上传的文件")',
        ],
        { encoding: "utf8" },
      )) as { stdout: string }
      return stdout.trim() || undefined
    } catch {
      return undefined
    }
  }

  if (process.platform === "linux") {
    for (const [command, args] of [
      ["zenity", ["--file-selection"]],
      ["kdialog", ["--getopenfilename"]],
    ] as const) {
      try {
        const { stdout } = (await execFileAsync(command, args as unknown as string[], {
          encoding: "utf8",
        })) as { stdout: string }
        const value = stdout.trim()
        if (value) return value
      } catch {
        // try the next dialog provider
      }
    }
  }

  if (process.platform === "win32") {
    try {
      const { stdout } = (await execFileAsync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.OpenFileDialog; if ($d.ShowDialog() -eq 'OK') { $d.FileName }",
        ],
        { encoding: "utf8" },
      )) as { stdout: string }
      return stdout.trim() || undefined
    } catch {
      return undefined
    }
  }

  return undefined
}

function copyText(text: string) {
  if (process.platform === "darwin") {
    execFileSync("pbcopy", { input: text })
    return
  }

  if (process.platform === "linux") {
    try {
      execFileSync("wl-copy", { input: text })
      return
    } catch {
      // fall through to X11
    }
    execFileSync("xclip", ["-selection", "clipboard"], { input: text })
    return
  }

  if (process.platform === "win32") {
    execFileSync("clip", { input: text })
    return
  }

  throw new Error("当前平台不支持剪贴板")
}

function revealInFileManager(path: string) {
  if (process.platform === "darwin") {
    execFileSync("open", ["-R", path])
    return
  }
  if (process.platform === "linux") {
    execFileSync("xdg-open", [dirname(path)])
    return
  }
  if (process.platform === "win32") {
    execFileSync("explorer", ["/select,", path])
  }
}

/* -------------------------------------------------------------------------- */
/* History                                                                    */
/* -------------------------------------------------------------------------- */

async function record(update: HistoryUpdate, item: HistoryItem) {
  await update((draft) => {
    draft.items.unshift(item)
    if (draft.items.length > 100) draft.items.splice(100)
  })
}

/* -------------------------------------------------------------------------- */
/* Download                                                                   */
/* -------------------------------------------------------------------------- */

function message(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (!error || typeof error !== "object") return String(error)
  const source = error as { message?: unknown; error?: unknown; cause?: unknown }
  for (const value of [source.message, source.error, source.cause]) {
    if (value === undefined || value === error) continue
    const text = message(value)
    if (text && text !== "[object Object]") return text
  }
  try {
    const text = JSON.stringify(error)
    if (text && text !== "{}") return text
  } catch {
    // fall back to String below
  }
  return String(error)
}

function truncate(value: string, max: number) {
  return value.length <= max ? value : value.slice(0, Math.max(1, max - 1)) + "…"
}

function formatTime(at: number) {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

function safeLocalName(name: string) {
  const base = basename(name)
    .replace(/[\/\\?%*:|"<>]/g, "_")
    .trim()
  return base && base !== "." && base !== ".." ? base : "download"
}

async function uniquePath(directory: string, name: string) {
  const extension = extname(name)
  const stem = basename(name, extension)
  let candidate = join(directory, name)
  for (let index = 1; ; index++) {
    try {
      await access(candidate)
      candidate = join(directory, `${stem}-${index}${extension}`)
    } catch {
      return candidate
    }
  }
}

function resolveConfiguredDirectory(value: unknown) {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (trimmed === "~") return homedir()
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2))
  return resolve(trimmed)
}

function downloadDirectory(context: any, settings?: ClientSettings) {
  return (
    resolveConfiguredDirectory(settings?.downloadDir) ??
    resolveConfiguredDirectory(context.options?.downloadDir) ??
    resolveConfiguredDirectory(process.env.OPENCODE_FILE_WIDGET_DOWNLOAD_DIR) ??
    join(homedir(), "Downloads")
  )
}

async function saveDownload(
  context: any,
  name: string,
  bytes: Uint8Array,
  expectedSize: number,
  settings?: ClientSettings,
) {
  const directory = downloadDirectory(context, settings)
  await mkdir(directory, { recursive: true })
  const safeName = safeLocalName(name)
  const destination = await uniquePath(directory, safeName)
  if (bytes.byteLength !== expectedSize) throw new Error("下载数据不完整")
  await writeFile(destination, bytes, { mode: 0o600 })
  return destination
}

function formatSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index++
  }
  return `${index === 0 || value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[index]}`
}

function copyValue(serverPath: string, settings: ClientSettings) {
  return (settings.copyFormat ?? "mention") === "path" ? serverPath : `@${serverPath}`
}

function chooseTransferMode(settings: ClientSettings, info: ServerInfo | undefined) {
  const preferred = settings.transferMode ?? "auto"
  const binary = info?.modes?.includes("binary") ?? false
  if (preferred === "basic") return { mode: "basic" as const }
  if (preferred === "binary" && !binary) {
    return { mode: "basic" as const, fallback: "二进制传输不可用，已回退基础方案" }
  }
  if (preferred === "binary") return { mode: "binary" as const }
  return { mode: binary ? ("binary" as const) : ("basic" as const) }
}

async function resolveServerPath(context: any, raw: string): Promise<string | undefined> {
  const location = context.location ?? context.data.location.default()
  let value = raw.trim()
  if (value.startsWith("@")) value = value.slice(1)
  value = value.replace(/#\d+(?:-\d*)?$/, "")
  if (!value) return undefined

  if (isAbsolute(value)) return value

  const exact = resolve(location.directory, value)
  if (value.includes("/") || value.startsWith(".")) return exact

  const client = context.client as any
  const found = await client.file
    .find({ query: value, limit: 10, location })
    .catch(() => undefined)
  const hit = found?.data?.find((item: any) => item.type === "file")
  if (hit) return resolve(found.location.directory, hit.path)
  return exact
}

async function pickServerFile(context: any): Promise<string | undefined> {
  const client = context.client as any
  const location = context.location ?? context.data.location.default()
  let directory = location.directory

  while (true) {
    const result = await client.file.list({ location, path: directory })
    const base = result.location?.directory ?? directory
    const entries: any[] = result.data ?? []

    const options: Array<{ title: string; value: PickerChoice }> = []
    if (dirname(directory) !== directory) {
      options.push({ title: "..", value: { type: "up" } })
    }

    for (const entry of entries) {
      if (entry.type === "directory") {
        options.push({
          title: `${entry.path}/`,
          value: { type: "dir", path: resolve(base, entry.path) },
        })
      }
    }
    for (const entry of entries) {
      if (entry.type === "file") {
        options.push({
          title: entry.path,
          value: { type: "file", path: resolve(base, entry.path) },
        })
      }
    }

    if (options.length === 0) {
      context.ui.toast.show({ message: "目录为空", variant: "info" })
      return undefined
    }

    const choice = await context.ui.dialog.select({
      title: `选择服务器文件: ${directory}`,
      options,
      search: (query: string, all: Array<{ title: string; value: PickerChoice }>) =>
        all.filter((option) => option.title.toLowerCase().includes(query.toLowerCase())),
    })

    if (!choice) return undefined
    if (choice.type === "up") {
      directory = dirname(directory)
      continue
    }
    if (choice.type === "dir") {
      directory = choice.path
      continue
    }
    return choice.path
  }
}

async function uploadBasic(context: any, name: string, bytes: Uint8Array) {
  const client = context.client as any
  return (await client.rpc(Files).upload({
    name,
    data: Buffer.from(bytes).toString("base64"),
  })) as UploadResult
}

async function uploadBinary(context: any, name: string, bytes: Uint8Array) {
  const client = context.client as any
  const prepared = (await client.rpc(Files).prepareUpload({
    name,
    size: bytes.byteLength,
  })) as { id: string; path: string; name: string; size: number }

  try {
    const write = client.experimental?.file?.write
    if (typeof write !== "function") throw new Error("当前客户端不支持二进制上传")
    await write({ path: prepared.path, payload: bytes })
    return (await client.rpc(Files).finishUpload({ id: prepared.id })) as UploadResult
  } catch (error) {
    await client.rpc(Files).abortUpload({ id: prepared.id }).catch(() => undefined)
    throw error
  }
}

async function downloadBasic(context: any, target: string): Promise<DownloadBytes> {
  const client = context.client as any
  const result = (await client.rpc(Files).download({ path: target })) as DownloadResult
  const bytes = Buffer.from(result.data, "base64")
  if (bytes.byteLength !== result.size) throw new Error("下载数据不完整")
  return { name: result.name, data: bytes, size: result.size }
}

async function downloadBinary(context: any, target: string): Promise<DownloadBytes> {
  const client = context.client as any
  const prepared = (await client.rpc(Files).prepareDownload({ path: target })) as {
    name: string
    size: number
    root: string
    relativePath: string
  }

  const read = client.file?.read
  if (typeof read !== "function") throw new Error("当前客户端不支持二进制下载")
  const bytes = (await read({
    location: { directory: prepared.root },
    path: prepared.relativePath,
  })) as Uint8Array
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (data.byteLength !== prepared.size) throw new Error("下载数据不完整")
  return { name: prepared.name, data, size: data.byteLength }
}

async function uploadCommand(
  context: any,
  updateHistory: HistoryUpdate,
  raw: string,
  settings: ClientSettings,
  getServerInfo: () => ServerInfo | undefined,
) {
  let localPath: string | undefined
  let serverPath = ""
  let recorded = false
  try {
    let value = raw.trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (value.startsWith("@")) value = value.slice(1)
    if (value === "~") value = homedir()
    else if (value.startsWith("~/")) value = join(homedir(), value.slice(2))

    localPath = value || (await pickLocalFile())
    if (!localPath) return

    const bytes = await readFile(localPath)
    const name = basename(localPath)
    const choice = chooseTransferMode(settings, getServerInfo())
    if (choice.fallback) {
      context.ui.toast.show({ message: choice.fallback, variant: "warning" })
    }

    let result: UploadResult
    if (choice.mode === "binary") {
      try {
        result = await uploadBinary(context, name, bytes)
      } catch (error) {
        if ((settings.transferMode ?? "auto") === "basic") throw error
        context.ui.toast.show({
          message: `二进制上传失败，已回退基础方案: ${message(error)}`,
          variant: "warning",
        })
        result = await uploadBasic(context, name, bytes)
      }
    } else {
      result = await uploadBasic(context, name, bytes)
    }

    serverPath = result.path
    await record(updateHistory, {
      id: randomUUID(),
      direction: "upload",
      status: "success",
      name: result.name,
      serverPath: result.path,
      localPath,
      size: result.size,
      at: Date.now(),
    })
    recorded = true

    if (settings.autoCopy ?? false) {
      try {
        const copied = copyValue(result.path, settings)
        copyText(copied)
        context.ui.toast.show({
          message: `已上传并复制: ${copied}`,
          variant: "success",
        })
      } catch (error) {
        context.ui.toast.show({
          message: `已上传，但复制失败: ${message(error)}`,
          variant: "warning",
        })
      }
    } else {
      context.ui.toast.show({
        message: `已上传: ${result.path}`,
        variant: "success",
      })
    }
  } catch (error) {
    if (!recorded) {
      await record(updateHistory, {
        id: randomUUID(),
        direction: "upload",
        status: "error",
        name: localPath ? basename(localPath) : "上传",
        serverPath,
        localPath,
        size: 0,
        at: Date.now(),
        message: message(error),
      }).catch(() => undefined)
    }
    context.ui.toast.show({
      message: `上传失败: ${message(error)}`,
      variant: "error",
    })
  }
}

async function downloadCommand(
  context: any,
  updateHistory: HistoryUpdate,
  raw: string,
  settings: ClientSettings,
  getServerInfo: () => ServerInfo | undefined,
) {
  let target: string | undefined
  let recorded = false
  try {
    target = raw.trim()
      ? await resolveServerPath(context, raw)
      : await pickServerFile(context)
    if (!target) return

    const choice = chooseTransferMode(settings, getServerInfo())
    if (choice.fallback) {
      context.ui.toast.show({ message: choice.fallback, variant: "warning" })
    }

    let result: DownloadBytes
    if (choice.mode === "binary") {
      try {
        result = await downloadBinary(context, target)
      } catch (error) {
        if ((settings.transferMode ?? "auto") === "basic") throw error
        context.ui.toast.show({
          message: `二进制下载失败，已回退基础方案: ${message(error)}`,
          variant: "warning",
        })
        result = await downloadBasic(context, target)
      }
    } else {
      result = await downloadBasic(context, target)
    }

    const localPath = await saveDownload(context, result.name, result.data, result.size, settings)
    await record(updateHistory, {
      id: randomUUID(),
      direction: "download",
      status: "success",
      name: result.name,
      serverPath: target,
      localPath,
      size: result.size,
      at: Date.now(),
    })
    recorded = true

    context.ui.toast.show({
      message: `已下载到 ${localPath}`,
      variant: "success",
    })

    if (settings.revealAfterDownload ?? false) {
      try {
        revealInFileManager(localPath)
      } catch (error) {
        context.ui.toast.show({
          message: `已下载，但无法打开文件管理器: ${message(error)}`,
          variant: "warning",
        })
      }
    }
  } catch (error) {
    if (!recorded) {
      const requested = target ?? raw.trim()
      await record(updateHistory, {
        id: randomUUID(),
        direction: "download",
        status: "error",
        name: requested ? basename(requested) : "下载",
        serverPath: requested,
        size: 0,
        at: Date.now(),
        message: message(error),
      }).catch(() => undefined)
    }
    context.ui.toast.show({
      message: `下载失败: ${message(error)}`,
      variant: "error",
    })
  }
}

/* -------------------------------------------------------------------------- */
/* Sidebar widget                                                             */
/* -------------------------------------------------------------------------- */

function onHistoryItem(context: any, item: HistoryItem, settings: ClientSettings) {
  try {
    if (!succeeded(item)) {
      const label = item.direction === "upload" ? "上传" : "下载"
      context.ui.toast.show({
        message: item.message ? `${label}失败: ${item.message}` : `${label}失败`,
        variant: "error",
      })
      return
    }
    if (item.direction === "upload") {
      const copied = copyValue(item.serverPath, settings)
      copyText(copied)
      context.ui.toast.show({
        message: (settings.copyFormat ?? "mention") === "path"
          ? "已复制服务器路径"
          : "已复制 @服务器路径，去输入框粘贴",
        variant: "success",
      })
      return
    }
    if (item.localPath) {
      revealInFileManager(item.localPath)
    } else {
      copyText(copyValue(item.serverPath, settings))
      context.ui.toast.show({
        message: (settings.copyFormat ?? "mention") === "path"
          ? "已复制服务器路径"
          : "已复制 @服务器路径",
        variant: "success",
      })
    }
  } catch (error) {
    context.ui.toast.show({ message: message(error), variant: "error" })
  }
}

async function showAllHistory(context: any, history: HistoryState, settings: ClientSettings) {
  const items = [...history.items]
  if (items.length === 0) {
    context.ui.toast.show({ message: "还没有文件历史", variant: "info" })
    return
  }

  const selected = await context.ui.dialog.select({
    title: "上传 / 下载历史",
    options: items.map((item) => ({
      title: `${succeeded(item) ? "✓" : "✗"} ${item.direction === "upload" ? "↑" : "↓"} ${item.name}  ${formatTime(item.at)}`,
      value: item,
    })),
    search: (query: string, all: Array<{ title: string; value: HistoryItem }>) =>
      all.filter((option) => option.title.toLowerCase().includes(query.toLowerCase())),
  })

  if (selected) onHistoryItem(context, selected, settings)
}

function transferModeLabel(mode: TransferMode) {
  if (mode === "binary") return "二进制（实验性）"
  if (mode === "basic") return "基础（base64 JSON）"
  return "自动（优先二进制）"
}

function snapshotSettings(settings: ClientSettings): ClientSettings {
  return {
    downloadDir: settings.downloadDir ?? "",
    autoCopy: settings.autoCopy ?? false,
    showRecent: settings.showRecent ?? true,
    recentCount: settings.recentCount ?? 5,
    transferMode: settings.transferMode ?? "auto",
    revealAfterDownload: settings.revealAfterDownload ?? false,
    copyFormat: settings.copyFormat ?? "mention",
    showFileSize: settings.showFileSize ?? false,
  }
}

function SettingsPanel(props: {
  context: any
  panel: any
  settings: ClientSettings
  updateSettings: SettingsUpdate
  history: HistoryState
  updateHistory: HistoryUpdate
  serverInfo: () => ServerInfo | undefined
  refreshServerInfo: () => Promise<ServerInfo | undefined>
}) {
  const [draft, setDraft] = createSignal(snapshotSettings(props.settings))
  const [saving, setSaving] = createSignal(false)
  const info = () => props.serverInfo()
  const binaryAvailable = () => info()?.modes?.includes("binary") ?? false
  const panelWidth = () => Math.max(34, Math.min(52, props.panel?.width ?? 46))
  const valueWidth = () => Math.max(12, panelWidth() - 24)
  const dirty = () =>
    JSON.stringify(draft()) !== JSON.stringify(snapshotSettings(props.settings))

  void props.refreshServerInfo()

  function patch(values: Partial<ClientSettings>) {
    setDraft((current) => ({ ...current, ...values }))
  }

  function toggle(key: "autoCopy" | "showRecent" | "revealAfterDownload" | "showFileSize") {
    setDraft((current) => ({ ...current, [key]: !current[key] }))
  }

  async function save() {
    if (saving()) return
    setSaving(true)
    const next = snapshotSettings(draft())
    try {
      await props.updateSettings((target) => {
        target.downloadDir = next.downloadDir
        target.autoCopy = next.autoCopy
        target.showRecent = next.showRecent
        target.recentCount = next.recentCount
        target.transferMode = next.transferMode
        target.revealAfterDownload = next.revealAfterDownload
        target.copyFormat = next.copyFormat
        target.showFileSize = next.showFileSize
      })
      props.context.ui.toast.show({ message: "设置已保存", variant: "success" })
      props.panel.close()
    } catch (error) {
      props.context.ui.toast.show({
        message: `保存设置失败: ${message(error)}`,
        variant: "error",
      })
    } finally {
      setSaving(false)
    }
  }

  function discard() {
    props.panel.close()
  }

  async function chooseDownloadDir() {
    const value = await props.context.ui.dialog.prompt({
      title: "默认下载位置",
      description: "支持 ~ 和 ~/...；留空恢复默认",
      value: draft().downloadDir || downloadDirectory(props.context, props.settings),
    })
    if (value !== undefined) patch({ downloadDir: value.trim() })
  }

  async function chooseTransferMode() {
    const mode = (await props.context.ui.dialog.select({
      title: "传输方案",
      current: draft().transferMode,
      options: [
        {
          title: "自动（优先二进制，失败回退）",
          value: "auto",
          description: "推荐；服务端不支持时自动使用基础方案",
        },
        {
          title: "基础（base64 JSON）",
          value: "basic",
          description: "兼容性最好，适合小文件和旧版本",
        },
        {
          title: binaryAvailable() ? "二进制（实验性，高性能）" : "二进制（服务端未启用）",
          value: "binary",
          disabled: !binaryAvailable(),
          description: "直接使用 OpenCode 二进制文件 API，不经过 base64",
        },
      ],
    })) as TransferMode | undefined
    if (mode !== undefined) patch({ transferMode: mode })
  }

  async function chooseCopyFormat() {
    const format = (await props.context.ui.dialog.select({
      title: "复制格式",
      current: draft().copyFormat,
      options: [
        { title: "@路径", value: "mention", description: "复制 @服务器路径，适合直接粘贴到输入框" },
        { title: "纯路径", value: "path", description: "只复制服务器绝对路径" },
      ],
    })) as CopyFormat | undefined
    if (format !== undefined) patch({ copyFormat: format })
  }

  async function chooseRecentCount() {
    const count = (await props.context.ui.dialog.select({
      title: "近期记录条数",
      current: draft().recentCount,
      options: [3, 5, 8, 10].map((value) => ({ title: `${value} 条`, value })),
    })) as number | undefined
    if (count !== undefined) patch({ recentCount: count })
  }

  async function showServerInfo() {
    const latest = (await props.refreshServerInfo()) ?? info()
    await props.context.ui.dialog.alert({
      title: "服务器信息",
      message: latest
        ? [
            `版本: ${latest.version}`,
            `最大文件: ${formatSize(latest.maxBytes)}`,
            `保留时长: ${latest.ttlHours} 小时`,
            `传输模式: ${latest.modes.join(", ")}`,
            `上传目录: ${latest.uploadRoot}`,
          ].join("\n")
        : "无法获取服务器信息，可能服务端插件未加载或连接已断开。",
    })
  }

  async function clearHistory() {
    const confirmed = await props.context.ui.dialog.confirm({
      title: "清空上传 / 下载历史",
      message: `将立即删除 ${props.history.items.length} 条本地历史记录，是否继续？`,
      label: { confirm: "清空", cancel: "取消" },
    })
    if (!confirmed) return
    await props.updateHistory((target) => {
      target.items.splice(0)
    })
    props.context.ui.toast.show({ message: "历史已清空", variant: "success" })
  }

  async function resetDefaults() {
    const confirmed = await props.context.ui.dialog.confirm({
      title: "恢复默认设置",
      message: "将重置草稿中的客户端设置，点击“保存并关闭”后生效。",
      label: { confirm: "恢复", cancel: "取消" },
    })
    if (confirmed) {
      setDraft({ ...DEFAULT_CLIENT_SETTINGS, downloadDir: "" })
    }
  }

  props.context.keymap.layer(() => ({
    commands: [
      {
        id: "acme.files.settings.close",
        title: "关闭文件小组件设置",
        bind: "escape",
        run: discard,
      },
      {
        id: "acme.files.settings.save",
        title: "保存文件小组件设置",
        bind: "ctrl+s",
        run: () => save(),
      },
    ],
  }))

  function Row(props: {
    label: string
    value: string
    onActivate?: () => void
    muted?: boolean
    hint?: string
  }) {
    return (
      <box
        flexDirection="row"
        justifyContent="space-between"
        onMouseUp={props.onActivate}
      >
        <text>• {props.label}</text>
        <text fg={props.muted ? COLOR_MUTED : "#d1d5db"}>
          {truncate(
            props.hint ? `${props.value}  ${props.hint}` : props.value,
            valueWidth(),
          )}
        </text>
      </box>
    )
  }

  function ToggleRow(props: {
    label: string
    value: boolean
    onToggle: () => void
  }) {
    return (
      <box flexDirection="row" justifyContent="space-between" onMouseUp={props.onToggle}>
        <text>• {props.label}</text>
        <text fg={props.value ? COLOR_SUCCESS : COLOR_MUTED}>
          {props.value ? "[ 开 ]" : "[ 关 ]"}
        </text>
      </box>
    )
  }

  function Section(props: { title: string; children: any }) {
    return (
      <box flexDirection="column" gap={0}>
        <text fg={COLOR_DOWNLOAD}>{props.title}</text>
        {props.children}
      </box>
    )
  }

  return (
    <box flexDirection="column" gap={1} padding={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg="#e5e7eb">⚙ 文件小组件高级设置</text>
        <text fg={dirty() ? COLOR_UPLOAD : COLOR_MUTED}>{dirty() ? "● 未保存" : "esc"}</text>
      </box>

      <Section title="[存储与路径]">
        <Row
          label="下载目录"
          value={draft().downloadDir || downloadDirectory(props.context, props.settings)}
          onActivate={() => void chooseDownloadDir()}
          hint="›"
        />
        <Row
          label="上传根目录"
          value={info()?.uploadRoot ?? "未知"}
          onActivate={() => void showServerInfo()}
          muted
        />
        <Row
          label="单文件上限"
          value={info() ? `${formatSize(info()!.maxBytes)}（服务端只读）` : "未知（服务端只读）"}
          onActivate={() => void showServerInfo()}
          muted
        />
      </Section>

      <Section title="[传输与行为]">
        <Row
          label="传输方案"
          value={transferModeLabel(draft().transferMode)}
          onActivate={() => void chooseTransferMode()}
          hint="›"
        />
        <Row
          label="复制格式"
          value={(draft().copyFormat ?? "mention") === "path" ? "纯路径" : "@路径"}
          onActivate={() => void chooseCopyFormat()}
          hint="›"
        />
        <ToggleRow
          label="自动复制"
          value={draft().autoCopy}
          onToggle={() => toggle("autoCopy")}
        />
        <ToggleRow
          label="定位文件"
          value={draft().revealAfterDownload}
          onToggle={() => toggle("revealAfterDownload")}
        />
        <ToggleRow
          label="显示大小"
          value={draft().showFileSize}
          onToggle={() => toggle("showFileSize")}
        />
      </Section>

      <Section title="[历史与维护]">
        <ToggleRow
          label="近期记录"
          value={draft().showRecent}
          onToggle={() => toggle("showRecent")}
        />
        <Row
          label="显示条数"
          value={`${draft().recentCount} 条`}
          onActivate={() => void chooseRecentCount()}
          hint="›"
        />
        <Row
          label="清空历史"
          value={`当前 ${props.history.items.length} 条记录`}
          onActivate={() => void clearHistory()}
        />
        <Row
          label="恢复默认"
          value="重置所有偏好设置"
          onActivate={() => void resetDefaults()}
        />
      </Section>

      <text fg={COLOR_DIVIDER}>{"─".repeat(Math.max(20, panelWidth() - 4))}</text>

      <box flexDirection="row" justifyContent="space-between">
        <box onMouseUp={() => void save()}>
          <text fg={COLOR_SUCCESS}>{saving() ? "[ 保存中... ]" : "[ 保存并关闭 ]"}</text>
        </box>
        <box onMouseUp={discard}>
          <text fg={COLOR_MUTED}>[ 放弃修改 ]</text>
        </box>
      </box>
    </box>
  )
}

function FilesWidget(props: {
  context: any
  history: HistoryState
  updateHistory: HistoryUpdate
  settings: ClientSettings
  serverInfo: () => ServerInfo | undefined
}) {
  const [busy, setBusy] = createSignal(false)
  const lastUpload = () =>
    props.history.items.find(
      (item) => item.direction === "upload" && succeeded(item),
    )
  const totalHistory = () => props.history.items.length
  const copyLabel = () =>
    (props.settings.copyFormat ?? "mention") === "path" ? "[复制路径]" : "[复制 @]"

  async function upload() {
    if (busy()) return
    setBusy(true)
    try {
      await uploadCommand(
        props.context,
        props.updateHistory,
        "",
        props.settings,
        props.serverInfo,
      )
    } finally {
      setBusy(false)
    }
  }

  function copyLast() {
    const item = lastUpload()
    if (!item) {
      props.context.ui.toast.show({ message: "还没有成功的上传记录", variant: "info" })
      return
    }
    try {
      const copied = copyValue(item.serverPath, props.settings)
      copyText(copied)
      props.context.ui.toast.show({
        message: (props.settings.copyFormat ?? "mention") === "path"
          ? "已复制服务器路径"
          : "已复制 @服务器路径，去输入框粘贴",
        variant: "success",
      })
    } catch (error) {
      props.context.ui.toast.show({ message: message(error), variant: "error" })
    }
  }

  function openFileSettings() {
    const opened = props.context.ui.panel.open("acme.files.settings")
    if (!opened) {
      props.context.ui.toast.show({ message: "请在会话中打开设置", variant: "info" })
    }
  }

  return (
    <box flexDirection="column" gap={1}>
      <text fg={COLOR_DIVIDER}>{"─".repeat(30)}</text>

      <box flexDirection="row" justifyContent="space-between">
        <text>📦 文件传输</text>
        <box onMouseUp={openFileSettings}>
          <text fg={COLOR_MUTED}>⚙ 设置</text>
        </box>
      </box>

      <box
        onMouseUp={() => void upload()}
        backgroundColor={COLOR_UPLOAD_BG}
        paddingX={1}
      >
        <text fg="#dbeafe">{busy() ? "上传中..." : "⇡ 点击选择并上传文件"}</text>
      </box>

      <box flexDirection="column">
        <box flexDirection="row" justifyContent="space-between">
          <text>最新服务器路径:</text>
          <Show
            when={props.settings.autoCopy ?? false}
            fallback={
              <box onMouseUp={copyLast}>
                <text fg={COLOR_SUCCESS}>{copyLabel()}</text>
              </box>
            }
          >
            <text fg={COLOR_SUCCESS}>已开启自动复制</text>
          </Show>
        </box>
        <text>
          {lastUpload()
            ? truncate(lastUpload()!.serverPath, 34)
            : "还没有上传文件"}
        </text>
      </box>

      <Show when={props.settings.showRecent ?? true}>
        <box flexDirection="column" gap={1}>
          <box
            flexDirection="row"
            justifyContent="space-between"
            onMouseUp={() =>
              setTimeout(
                () => void showAllHistory(props.context, props.history, props.settings),
                0,
              )
            }
          >
            <text>近期记录</text>
            <text fg={COLOR_MUTED}>全部 ({totalHistory()})</text>
          </box>

          <For each={props.history.items.slice(0, props.settings.recentCount ?? 5)}>
            {(item) => (
              <box
                onMouseUp={() => onHistoryItem(props.context, item, props.settings)}
                flexDirection="row"
                justifyContent="space-between"
              >
                <box flexDirection="row" gap={1}>
                  <text fg={statusColor(item)}>●</text>
                  <text fg={directionColor(item.direction)}>
                    {item.direction === "upload" ? "↑" : "↓"}
                  </text>
                  <text>{truncate(item.name, 18)}</text>
                </box>
                <text fg={COLOR_MUTED}>
                  {props.settings.showFileSize
                    ? `${formatSize(item.size)}  ${formatTime(item.at)}`
                    : formatTime(item.at)}
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}

/* -------------------------------------------------------------------------- */
/* Plugin                                                                     */
/* -------------------------------------------------------------------------- */

export default Plugin.define({
  id: "acme.files.tui",
  setup(context) {
    const [history, updateHistory] = context.storage.store("acme.files.history", {
      initial: { items: [] as HistoryItem[] },
    })
    const [settings, updateSettings] = context.storage.store("acme.files.settings", {
      initial: { ...DEFAULT_CLIENT_SETTINGS } as ClientSettings,
    })
    const [serverInfo, setServerInfo] = createSignal<ServerInfo | undefined>()

    async function refreshServerInfo(): Promise<ServerInfo | undefined> {
      try {
        const client = context.client as any
        const info = (await client.rpc(Files).info({})) as ServerInfo
        setServerInfo(info)
        return info
      } catch {
        setServerInfo(undefined)
        return undefined
      }
    }

    void refreshServerInfo()

    const openFileSettings = () => {
      const opened = context.ui.panel.open("acme.files.settings")
      if (!opened) {
        context.ui.toast.show({ message: "请在会话中打开设置", variant: "info" })
      }
    }

    const disposeSlot = context.ui.slot({
      append: "sidebar.content",
      render: () => (
        <FilesWidget
          context={context}
          history={history}
          updateHistory={updateHistory}
          settings={settings}
          serverInfo={serverInfo}
        />
      ),
    })

    const disposeSettingsPanel = context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === "acme.files.settings"}>
          <SettingsPanel
            context={context}
            panel={panel}
            settings={settings}
            updateSettings={updateSettings}
            history={history}
            updateHistory={updateHistory}
            serverInfo={serverInfo}
            refreshServerInfo={refreshServerInfo}
          />
        </Show>
      ),
    })

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "acme.upload",
          title: "上传本地文件",
          group: "文件",
          palette: true,
          slash: { name: "upload", arguments: true },
          run: (input) =>
            uploadCommand(context, updateHistory, input ?? "", settings, serverInfo),
        },
        {
          id: "acme.download",
          title: "下载服务器文件",
          group: "文件",
          palette: true,
          slash: { name: "download", arguments: true },
          run: (input) =>
            downloadCommand(context, updateHistory, input ?? "", settings, serverInfo),
        },
        {
          id: "acme.files.settings",
          title: "文件小组件设置",
          group: "文件",
          palette: true,
          slash: { name: "files-settings" },
          run: () => openFileSettings(),
        },
      ],
    }))

    return () => {
      disposeSlot()
      disposeSettingsPanel()
    }
  },
})
