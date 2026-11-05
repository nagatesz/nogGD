param(
    [string]$BuildDirectory = "build-wasm\bin\OpenGD"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$buildPath = Join-Path $repoRoot $BuildDirectory
$publicPath = Join-Path $repoRoot "public"
$gamePath = Join-Path $publicPath "game"

foreach ($file in @("OpenGD.html", "OpenGD.js", "OpenGD.wasm", "OpenGD.data")) {
    $source = Join-Path $buildPath $file
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Missing WebAssembly build output: $source"
    }
}

New-Item -ItemType Directory -Force -Path $gamePath | Out-Null
Get-ChildItem -LiteralPath $gamePath -Filter "*.map" -File | Remove-Item -Force
Copy-Item -LiteralPath (Join-Path $repoRoot "index.html") -Destination $publicPath -Force
Copy-Item -LiteralPath (Join-Path $repoRoot "app.js") -Destination $publicPath -Force
Copy-Item -LiteralPath (Join-Path $repoRoot "style.css") -Destination $publicPath -Force
Get-ChildItem -LiteralPath $buildPath -File |
    Where-Object { $_.Extension -ne ".map" } |
    Copy-Item -Destination $gamePath -Force
Write-Output "Packaged browser app in $publicPath"
