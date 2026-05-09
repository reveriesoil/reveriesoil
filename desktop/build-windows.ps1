<#
.SYNOPSIS
    ReverieSoil 梦壤 — 桌面客户端一键构建脚本 (Windows x64)

.DESCRIPTION
    步骤：
      1. 检查依赖（Node.js ≥18、Python ≥3.10、pip）
      2. 将 PNG 图标转换为 .ico（需要 Pillow）
      3. 构建前端（Vite）→ web-dist/
      4. PyInstaller 打包 Python 后端 → backend-dist/
      5. npm install electron + electron-builder
      6. electron-builder 生成 Windows 安装包 → dist-installer/

.NOTES
    在 opensource/desktop/ 目录下运行：
        .\build-windows.ps1
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── 路径定义 ──────────────────────────────────────────────────────────────────
$ScriptDir  = $PSScriptRoot
$RootDir    = Split-Path $ScriptDir -Parent   # opensource/
$BackendDir = Join-Path $RootDir 'backend'
$WebDir     = Join-Path $RootDir 'web'
$DesktopDir = $ScriptDir

$WebDist     = Join-Path $DesktopDir 'web-dist'
$BackendDist = Join-Path $DesktopDir 'backend-dist'
$BuildDir    = Join-Path $DesktopDir 'build'

function Write-Step([string]$msg) {
    Write-Host "`n━━━ $msg ━━━" -ForegroundColor Cyan
}
function Write-OK([string]$msg)   { Write-Host "  ✓ $msg" -ForegroundColor Green }
function Write-Warn([string]$msg) { Write-Host "  ⚠ $msg" -ForegroundColor Yellow }
function Write-Fail([string]$msg) { Write-Host "  ✗ $msg" -ForegroundColor Red; exit 1 }

# ══════════════════════════════════════════════════════════════════════════════
# 步骤 0：检查依赖
# ══════════════════════════════════════════════════════════════════════════════
Write-Step "步骤 0 / 5：检查运行环境"

# Node.js
try {
    $nodeVer = (node --version 2>&1).Trim()
    $nodeMaj = [int]($nodeVer.TrimStart('v').Split('.')[0])
    if ($nodeMaj -lt 18) { Write-Fail "Node.js 版本过低（$nodeVer），需要 ≥ 18" }
    Write-OK "Node.js $nodeVer"
} catch { Write-Fail "未找到 Node.js，请先安装 https://nodejs.org/" }

# Python
try {
    $pyVer = (python --version 2>&1).Trim()
    Write-OK "Python $pyVer"
} catch { Write-Fail "未找到 Python，请先安装 https://python.org/" }

# pip
try {
    python -m pip --version | Out-Null
    Write-OK "pip 可用"
} catch { Write-Fail "pip 不可用" }

# ══════════════════════════════════════════════════════════════════════════════
# 步骤 1：PNG → ICO 图标转换
# ══════════════════════════════════════════════════════════════════════════════
Write-Step "步骤 1 / 5：生成 Windows .ico 图标"

$IcoPath = Join-Path $BuildDir 'icon.ico'
$PngPath = Join-Path $BuildDir 'icon.png'

if (-not (Test-Path $PngPath)) {
    Write-Fail "找不到源图标：$PngPath"
}

# 如果 ICO 已存在则跳过转换（避免 pip 网络超时阻塞构建）
if (Test-Path $IcoPath) {
    Write-OK "图标已存在，跳过转换：$IcoPath"
} else {
# 安装 Pillow（如已安装会跳过）
# 抑制 stderr 上的 pip 警告（如 "Ignoring invalid distribution"），避免在 ErrorActionPreference=Stop 下中止脚本
& cmd /c "python -m pip install Pillow --quiet --disable-pip-version-check 2>NUL"

$tmpPy = Join-Path $env:TEMP 'gen_ico.py'
$pngEsc = $PngPath -replace '\\', '/'
$icoEsc = $IcoPath -replace '\\', '/'
Set-Content -Path $tmpPy -Value @"
from PIL import Image
img = Image.open(r'$pngEsc').convert('RGBA')
sizes = [(16,16),(32,32),(48,48),(64,64),(128,128),(256,256)]
img.save(r'$icoEsc', format='ICO', sizes=sizes)
print('OK')
"@ -Encoding utf8
$result = & python $tmpPy 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Warn "ICO 转换失败（将使用 PNG）: $result"
} else {
    Write-OK "图标已生成：$IcoPath"
}
Remove-Item $tmpPy -ErrorAction SilentlyContinue
} # end else (ico not existed)

# ══════════════════════════════════════════════════════════════════════════════
# 步骤 2：构建前端
# ══════════════════════════════════════════════════════════════════════════════
Write-Step "步骤 2 / 5：构建前端（Vite）"

Push-Location $WebDir
try {
    Write-Host "  安装前端依赖..."
    npm install --silent
    if ($LASTEXITCODE -ne 0) { Write-Fail "npm install 失败" }

    Write-Host "  执行 npm run build..."
    npm run build
    if ($LASTEXITCODE -ne 0) { Write-Fail "前端构建失败" }
} finally {
    Pop-Location
}

# 将 dist/ 复制到 desktop/web-dist/
$WebDistSrc = Join-Path $WebDir 'dist'
if (-not (Test-Path $WebDistSrc)) { Write-Fail "前端构建产物不存在：$WebDistSrc" }

if (Test-Path $WebDist) { Remove-Item $WebDist -Recurse -Force }
Copy-Item $WebDistSrc $WebDist -Recurse
Write-OK "前端产物已复制到 $WebDist"

# ══════════════════════════════════════════════════════════════════════════════
# 步骤 3：PyInstaller 打包后端
# ══════════════════════════════════════════════════════════════════════════════
Write-Step "步骤 3 / 5：PyInstaller 打包 Python 后端"

# 如果已有打包产物则跳过，避免 pip 网络下载阻塞
$ServerExe = Join-Path $BackendDist 'server\server.exe'
if (Test-Path $ServerExe) {
    Write-OK "后端打包产物已存在，跳过重新打包：$ServerExe"
} else {
# 安装依赖 + pyinstaller
Push-Location $BackendDir
try {
    Write-Host "  安装 Python 依赖..."
    & cmd /c "python -m pip install -r requirements.txt --quiet --disable-pip-version-check 2>NUL"
    if ($LASTEXITCODE -ne 0) { Write-Fail "pip install requirements.txt 失败" }

    Write-Host "  安装 PyInstaller..."
    & cmd /c "python -m pip install pyinstaller --quiet --disable-pip-version-check 2>NUL"
    if ($LASTEXITCODE -ne 0) { Write-Fail "PyInstaller 安装失败" }

    Write-Host "  执行 PyInstaller（这可能需要几分钟）..."
    $SpecFile  = Join-Path $DesktopDir 'backend.spec'
    $WorkPath  = Join-Path $DesktopDir 'pyinstaller-work'
    $DistPath  = Join-Path $DesktopDir 'backend-dist'

    # PyInstaller 把进度信息写到 stderr，会被 ErrorActionPreference=Stop 误判
    # 临时把策略改为 Continue，并通过 $LASTEXITCODE 判断真正失败
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        pyinstaller --workpath "$WorkPath" --distpath "$DistPath" --noconfirm "$SpecFile" 2>&1 | ForEach-Object { "$_" }
    } finally {
        $ErrorActionPreference = $prevEAP
    }

    if ($LASTEXITCODE -ne 0) { Write-Fail "PyInstaller 打包失败，请查看上方错误信息" }
} finally {
    Pop-Location
}

# 验证产物
$ServerExe = Join-Path $BackendDist 'server\server.exe'
if (-not (Test-Path $ServerExe)) {
    Write-Fail "找不到打包产物：$ServerExe"
}
Write-OK "后端打包完成：$ServerExe"
} # end else (server.exe not existed)

# 清理临时文件
$WorkPath = Join-Path $DesktopDir 'pyinstaller-work'
if (Test-Path $WorkPath) { Remove-Item $WorkPath -Recurse -Force }

# ══════════════════════════════════════════════════════════════════════════════
# 步骤 4：安装 Electron 依赖
# ══════════════════════════════════════════════════════════════════════════════
Write-Step "步骤 4 / 5：安装 Electron 依赖"

Push-Location $DesktopDir
try {
    npm install --silent
    if ($LASTEXITCODE -ne 0) { Write-Fail "npm install（desktop）失败" }
    Write-OK "Electron 依赖安装完成"
} finally {
    Pop-Location
}

# ══════════════════════════════════════════════════════════════════════════════
# 步骤 5：electron-builder 打包安装程序
# ══════════════════════════════════════════════════════════════════════════════
Write-Step "步骤 5 / 5：electron-builder 打包安装程序"

# 使用工作区外的临时目录作为输出，避免 VS Code 文件监视器锁定 app.asar
$TmpBuildDir  = Join-Path $env:TEMP 'ReverieSoil-build'
$InstallerDir = Join-Path $DesktopDir 'dist-installer'

# 清理旧的临时目录
if (Test-Path $TmpBuildDir) { Remove-Item $TmpBuildDir -Recurse -Force }
New-Item -ItemType Directory -Force $TmpBuildDir | Out-Null

Push-Location $DesktopDir
try {
    # 代码签名：若证书存在则自动注入 electron-builder 环境变量
    $PfxFile = Join-Path $DesktopDir 'build\reveriesoil-signing.pfx'
    if (Test-Path $PfxFile) {
        $env:CSC_LINK           = $PfxFile
        $env:CSC_KEY_PASSWORD   = "20050503wcz"
        Write-OK "代码签名证书已加载（微萃科技（沧州）有限公司）"
    } else {
        Write-Warn "未找到签名证书，跳过代码签名：$PfxFile"
    }

    # 直接通过命令行参数指定输出目录，完全不修改 package.json
    # 避免任何编码/BOM 问题
    $TmpBuildEsc = $TmpBuildDir -replace '\\', '/'
    npx electron-builder --win --x64 "--config.directories.output=$TmpBuildEsc"
    $ebExit = $LASTEXITCODE

    # 清理签名环境变量，避免污染后续进程
    Remove-Item Env:\CSC_LINK         -ErrorAction SilentlyContinue
    Remove-Item Env:\CSC_KEY_PASSWORD -ErrorAction SilentlyContinue

    if ($ebExit -ne 0) { Write-Fail "electron-builder 打包失败" }
} finally {
    Pop-Location
}

# 将安装包从临时目录复制到 dist-installer/
# 注意：不整体删除目录，避免 VS Code 文件监视器锁住 app.asar 导致 Remove-Item 失败
New-Item -ItemType Directory -Force $InstallerDir | Out-Null
# 清理旧版本安装包，避免目录中混杂多个版本
Get-ChildItem $InstallerDir -Filter '*.exe' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
Get-ChildItem $InstallerDir -Filter '*.blockmap' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
Get-ChildItem $TmpBuildDir -Filter '*.exe' | ForEach-Object {
    $dest = Join-Path $InstallerDir $_.Name
    Copy-Item $_.FullName $dest -Force
}
Get-ChildItem $TmpBuildDir -Filter '*.blockmap' | ForEach-Object {
    $dest = Join-Path $InstallerDir $_.Name
    Copy-Item $_.FullName $dest -Force
}
Remove-Item $TmpBuildDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "══════════════════════════════════════════════════" -ForegroundColor Magenta
Write-Host "  构建完成！安装包位于：" -ForegroundColor Magenta
Write-Host "  $InstallerDir" -ForegroundColor Yellow
Write-Host ""
$exeFiles = Get-ChildItem $InstallerDir -Filter '*.exe' -ErrorAction SilentlyContinue
foreach ($f in $exeFiles) {
    $sizeMB = [math]::Round($f.Length / 1MB, 1)
    Write-Host "  → $($f.Name)  ($sizeMB MB)" -ForegroundColor Green
}
Write-Host "══════════════════════════════════════════════════" -ForegroundColor Magenta
