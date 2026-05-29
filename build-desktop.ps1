param(
    [switch]$Debug
)

$ErrorActionPreference = "Stop"
$base = $PSScriptRoot

function Step($name) { Write-Host "`n==> $name" -ForegroundColor Cyan }

Step "Build frontend"
npm run build

Step "Build server TypeScript"
npx tsc --project tsconfig.server.json

Step "Copy OpenAPI spec"
New-Item -ItemType Directory -Force "$base\dist\server\routes\v1" | Out-Null
Copy-Item -Force "$base\src\server\routes\v1\openapi.yaml" "$base\dist\server\routes\v1\"

Step "Install desktop dependencies"
npm install --prefix desktop

Step "Prepare desktop resources"
$res = "$base\desktop\resources"
# Clean dist to avoid stale/nested files from previous builds
if (Test-Path "$res\dist") { Remove-Item -Recurse -Force "$res\dist" }
New-Item -ItemType Directory -Force "$res\dist" | Out-Null
New-Item -ItemType Directory -Force "$res\binaries" | Out-Null

$dirs = @("server","services","db","utils","types","config","constants","contexts","assets","locales","pmtiles")
foreach ($d in $dirs) {
    if (Test-Path "$base\dist\$d") {
        Copy-Item -Recurse -Force "$base\dist\$d" "$res\dist\$d"
    }
}
if (Test-Path "$base\protobufs") {
    Copy-Item -Recurse -Force "$base\protobufs" "$res\dist\protobufs"
}
$files = @("index.html","logo.png","logo-original.png","favicon.ico","favicon-16x16.png","favicon-32x32.png","cors-detection.js","cors-error.html")
foreach ($f in $files) {
    if (Test-Path "$base\dist\$f") { Copy-Item -Force "$base\dist\$f" "$res\dist\$f" }
}
Copy-Item -Force "$base\package.json" "$res\package.json"
Copy-Item -Force "$base\package.json" "$res\dist\package.json"
Copy-Item -Force "$base\package-lock.json" "$res\dist\package-lock.json"

Step "Install production dependencies in resources"
Push-Location "$res\dist"
npm ci --omit=dev --legacy-peer-deps
Pop-Location

Step "Rebuild better-sqlite3 for Node 24"
Push-Location "$res\dist\node_modules\better-sqlite3"
npx prebuild-install --runtime=node --target=24.12.0 --arch=x64 --platform=win32
Pop-Location

Step "Download Node.js binary"
$nodeBin = "$res\binaries\node.exe"
if (-not (Test-Path $nodeBin)) {
    Write-Host "Downloading node.exe..."
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v24.12.0/win-x64/node.exe" -OutFile $nodeBin
}
$hash = (Get-FileHash $nodeBin -Algorithm SHA256).Hash.ToLower()
$expected = "2ffe3acc0458fdde999f50d11809bbe7c9b7ef204dcf17094e325d26ace101d8"
if ($hash -ne $expected) { throw "node.exe checksum mismatch! Got: $hash" }
Write-Host "node.exe OK"

Step "Release file locks before Tauri build"
# Tauri copies resources\binaries\node.exe → target\release\binaries\node.exe during build.
# If a previous desktop-app session left node.exe running from target\release\, the copy
# fails with os error 32 (ERROR_SHARING_VIOLATION) because Windows blocks overwriting a
# running executable.
$releaseNodePath = "$base\desktop\src-tauri\target\release\binaries\node.exe"
$installedNodePattern = "*AppData*MeshMonitor*node.exe"

# Kill any meshmonitor-desktop instances (both installed and from target/)
Get-Process -Name "MeshMonitor","meshmonitor-desktop" -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "Stopping $($_.Name) PID $($_.Id)..." -ForegroundColor Yellow
    $_ | Stop-Process -Force
}

# Kill node.exe processes running from the previous build output (target/release/binaries)
# — these are the actual cause of os error 32 when Tauri tries to copy node.exe
Get-Process -Name "node" -ErrorAction SilentlyContinue | ForEach-Object {
    try {
        $p = $_.Path
        if ($p -ieq $releaseNodePath -or $p -like $installedNodePattern) {
            Write-Host "Stopping node.exe PID $($_.Id) ($p)..." -ForegroundColor Yellow
            $_ | Stop-Process -Force
        }
    } catch { }
}
Start-Sleep -Seconds 2

Step "Build Tauri app"
Push-Location "$base\desktop"
if ($Debug) {
    Write-Host "Mode: DEBUG" -ForegroundColor Yellow
    npm run tauri:build -- --debug
    $out = "$base\desktop\src-tauri\target\debug\bundle\nsis"
} else {
    Write-Host "Mode: RELEASE" -ForegroundColor Green
    npm run tauri:build
    $out = "$base\desktop\src-tauri\target\release\bundle\nsis"
}
Pop-Location

Write-Host "`nDone! Installer:" -ForegroundColor Green
Get-ChildItem $out -Filter "*.exe" | Select-Object -ExpandProperty FullName
