[CmdletBinding()]
param(
  [string]$Destination = "",
  [string]$Proxy = $env:HTTPS_PROXY
)

$ErrorActionPreference = "Stop"

if (-not $Destination) {
  $Destination = Join-Path $PSScriptRoot "..\assets\models"
}

function Get-Sha256([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
      $bytes = $algorithm.ComputeHash($stream)
      return ([System.BitConverter]::ToString($bytes)).Replace("-", "").ToLowerInvariant()
    } finally {
      $algorithm.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

$models = @(
  @{
    Name = "bge-small-zh-v1.5-q4_k_m.gguf"
    Url = "https://huggingface.co/CompendiumLabs/bge-small-zh-v1.5-gguf/resolve/main/bge-small-zh-v1.5-q4_k_m.gguf"
    Sha256 = "0c17cc6ed7ec697db6768c2db6dd22c4e816a12c68ed14ff4d764927338532f8"
  },
  @{
    Name = "bge-reranker-base-q4_k_m.gguf"
    Url = "https://huggingface.co/sabafallah/bge-reranker-base-Q4_K_M-GGUF/resolve/main/bge-reranker-base-q4_k_m.gguf"
    Sha256 = "18a10177d2494696616d252d55d42dc1046efe8b6b005aa911b5c167dc731f1c"
  }
)

New-Item -ItemType Directory -Path $Destination -Force | Out-Null

foreach ($model in $models) {
  $target = Join-Path $Destination $model.Name
  if (Test-Path -LiteralPath $target) {
    $existingHash = Get-Sha256 $target
    if ($existingHash -eq $model.Sha256) {
      Write-Host "$($model.Name) already verified."
      continue
    }
  }

  $temporary = "$target.download"
  Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
  $request = @{
    Uri = $model.Url
    OutFile = $temporary
    UseBasicParsing = $true
  }
  if ($Proxy) {
    $request.Proxy = $Proxy
  }

  try {
    Write-Host "Downloading $($model.Name)..."
    Invoke-WebRequest @request
    $downloadHash = Get-Sha256 $temporary
    if ($downloadHash -ne $model.Sha256) {
      throw "SHA-256 mismatch for $($model.Name): $downloadHash"
    }
    Move-Item -LiteralPath $temporary -Destination $target -Force
  } catch {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    throw
  }
}

Write-Host "All OpenFicM local models are ready."
