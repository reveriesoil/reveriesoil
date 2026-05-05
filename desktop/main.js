/**
 * Electron 主进程
 * 负责：启动 Python 后端 → 等待就绪 → 创建窗口 → 通过 app:// 协议代理所有请求
 */
const { app, BrowserWindow, dialog, protocol, net, shell } = require('electron')
const path = require('path')
const { spawn } = require('child_process')
const http = require('http')
const net2 = require('net')   // 用于端口探测（与 Electron net 模块区分）
const fs = require('fs')

// ── 必须在 app.ready 之前声明自定义协议 ──────────────────────────────────────
protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: false,
    stream: true,
  },
}])

// ── 常量 ─────────────────────────────────────────────────────────────────────
const isDev            = !app.isPackaged
const PREFERRED_PORT   = 59876       // 首选端口（不常用，减少冲突概率）
const STARTUP_TIMEOUT_MS = 20000     // 后端启动超时 20 秒

let mainWindow     = null
let backendProcess = null
let actualPort     = PREFERRED_PORT  // 运行时确定的真实端口

// ── 查找可用端口 ──────────────────────────────────────────────────────────────
// 从 preferred 开始依次尝试，直到找到一个未被占用的端口
function findFreePort(preferred = PREFERRED_PORT) {
  return new Promise((resolve) => {
    const tryPort = (port) => {
      const server = net2.createServer()
      server.once('error', () => {
        // 端口被占用，尝试下一个（最多尝试 20 个）
        if (port - preferred < 20) {
          tryPort(port + 1)
        } else {
          resolve(preferred + Math.floor(Math.random() * 100) + 50)
        }
      })
      server.once('listening', () => {
        server.close(() => resolve(port))
      })
      server.listen(port, '127.0.0.1')
    }
    tryPort(preferred)
  })
}

// ── MIME 映射 ─────────────────────────────────────────────────────────────────
const MIME_MAP = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
}
function getMime(p) {
  return MIME_MAP[path.extname(p).toLowerCase()] || 'application/octet-stream'
}

// ── 用户数据目录 ───────────────────────────────────────────────────────────────
function getUserDataPaths() {
  const base      = app.getPath('userData')
  const staticDir = path.join(base, 'static')
  const logDir    = path.join(base, 'logs')
  fs.mkdirSync(staticDir, { recursive: true })
  fs.mkdirSync(logDir,    { recursive: true })
  return {
    dbPath:    path.join(base, 'dreamit.db'),
    staticDir,
    logFile:   path.join(logDir, 'backend.log'),
    mainLog:   path.join(logDir, 'main.log'),
  }
}

// ── 获取打包后的后端可执行文件路径 ────────────────────────────────────────────
function getBackendExe() {
  if (isDev) return null
  const ext = process.platform === 'win32' ? '.exe' : ''
  return path.join(process.resourcesPath, 'backend', 'server', `server${ext}`)
}

// ── 启动 Python 后端子进程 ────────────────────────────────────────────────────
async function startBackend() {
  const exe = getBackendExe()
  if (!exe) {
    console.log('[main] Dev mode: assuming backend is already running')
    return
  }
  if (!fs.existsSync(exe)) {
    console.error('[main] Backend executable not found:', exe)
    return
  }

  const { dbPath, staticDir, logFile } = getUserDataPaths()
  const dbUrl = `sqlite+aiosqlite:///${dbPath.replace(/\\/g, '/')}`

  // 落盘日志：便于打包后排障（用户可在 %APPDATA%/<AppName>/logs/backend.log 查看）
  let logStream = null
  try { logStream = fs.createWriteStream(logFile, { flags: 'a' }) } catch (e) { console.error('open log failed:', e) }
  const writeLog = (prefix, chunk) => {
    const line = prefix + chunk
    process.stdout.write(line)
    if (logStream) { try { logStream.write(line) } catch {} }
  }

  backendProcess = spawn(exe, [], {
    env: {
      ...process.env,
      DATABASE_URL:        dbUrl,
      STATIC_DIR:          staticDir,
      FRONTEND_URL:        'app://',
      CORS_ALLOW_ORIGINS:  '*',
      PORT:                String(actualPort),
      LOG_FILE:            logFile,
      PYTHONIOENCODING:    'utf-8',
      PYTHONUNBUFFERED:    '1',
    },
    stdio:       ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached:    false,
  })

  backendProcess.stdout.on('data', d => writeLog('[backend] ', d.toString()))
  backendProcess.stderr.on('data', d => writeLog('[backend!] ', d.toString()))
  backendProcess.on('exit', code => writeLog('[main] ', `Backend exited: ${code}\n`))
}

// ── 轮询等待后端健康检查 ──────────────────────────────────────────────────────
function waitForBackend() {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const check = () => {
      const req = http.get(
        `http://127.0.0.1:${actualPort}/health`,
        res => { res.statusCode < 500 ? resolve() : retry() }
      )
      req.on('error', retry)
      req.setTimeout(600, () => { req.destroy(); retry() })
    }
    const retry = () => {
      Date.now() - start > STARTUP_TIMEOUT_MS
        ? reject(new Error('Backend startup timeout'))
        : setTimeout(check, 400)
    }
    check()
  })
}

// ── 注册 app:// 自定义协议 ────────────────────────────────────────────────────
//  /api/**    → 代理到 http://127.0.0.1:PORT/api/**
//  /static/** → 代理到 http://127.0.0.1:PORT/static/**
//  其他       → 从 web-dist/ 目录读取前端静态文件（SPA fallback）
function registerAppProtocol() {
  const webDist = path.join(__dirname, 'web-dist')

  protocol.handle('app', async (request) => {
    const url      = new URL(request.url)
    const pathname = url.pathname

    // ── 代理到后端 ──────────────────────────────────────────────────────
    if (pathname.startsWith('/api/') || pathname.startsWith('/static/')) {
      const backendUrl = `http://127.0.0.1:${actualPort}${pathname}${url.search}`
      try {
        // 收集请求体（对 GET/HEAD 忽略）
        let body = null
        if (!['GET', 'HEAD'].includes(request.method) && request.body) {
          const chunks = []
          const reader  = request.body.getReader()
          let done = false
          while (!done) {
            const chunk = await reader.read()
            done = chunk.done
            if (chunk.value) chunks.push(chunk.value)
          }
          body = chunks.length ? Buffer.concat(chunks) : null
        }

        const resp = await net.fetch(backendUrl, {
          method:  request.method,
          headers: Object.fromEntries(request.headers.entries()),
          body,
          redirect: 'follow',
        })
        return resp
      } catch (e) {
        return new Response(`Backend error: ${e.message}`, { status: 502 })
      }
    }

    // ── 前端静态文件 ────────────────────────────────────────────────────
    let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '')
    let filePath = path.join(webDist, rel)

    // SPA fallback: 找不到文件就返回 index.html
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(webDist, 'index.html')
    }

    try {
      return new Response(fs.readFileSync(filePath), {
        headers: { 'Content-Type': getMime(filePath) },
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

// ── 创建主窗口 ────────────────────────────────────────────────────────────────
async function createWindow() {
  mainWindow = new BrowserWindow({
    width:     1280,
    height:    800,
    minWidth:  960,
    minHeight: 620,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      // 允许 app:// 访问本地后端
      webSecurity:      true,
    },
    show:               false,
    title:              'ReverieSoil 梦壤',
    backgroundColor:    '#0f0a1e',
    icon:               path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar:    true,
  })

  // 彻底移除系统菜单栏
  mainWindow.setMenu(null)

  if (isDev) {
    // 开发模式：直接访问 Vite 开发服务器
    await mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    await mainWindow.loadURL('app:///index.html')
  }

  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.on('closed', () => { mainWindow = null })

  // 所有外部链接在系统浏览器中打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

// ── 启动流程 ──────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // 1. 注册协议（仅生产模式）
  if (!isDev) registerAppProtocol()

  // 2. 确定可用端口（自动跳过被占用的端口）
  if (!isDev) {
    actualPort = await findFreePort(PREFERRED_PORT)
    console.log(`[main] Backend will use port ${actualPort}`)
  }

  // 3. 启动后端子进程
  await startBackend()

  // 4. 等待后端就绪
  if (!isDev) {
    try {
      await waitForBackend()
    } catch (e) {
      dialog.showErrorBox(
        '启动失败',
        `后台服务启动超时（端口 ${actualPort}）。\n请尝试重新打开应用，或重启电脑后再试。`
      )
      app.quit()
      return
    }
  }

  // 5. 创建窗口
  await createWindow()

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow()
  })
})

// ── 清理 ──────────────────────────────────────────────────────────────────────
function killBackend() {
  if (backendProcess) {
    try {
      if (process.platform === 'win32') {
        // Windows 下 kill 子进程树
        spawn('taskkill', ['/F', '/T', '/PID', String(backendProcess.pid)], { stdio: 'ignore' })
      } else {
        backendProcess.kill('SIGTERM')
      }
    } catch {}
    backendProcess = null
  }
}

app.on('window-all-closed', () => {
  killBackend()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', killBackend)
