$ErrorActionPreference = "Stop"
if (-not $env:NODE_ENV) {
    $env:NODE_ENV = "production"
}

$requiredVariables = @(
    "OPENFICM_RELEASE_STORE_FILE",
    "OPENFICM_RELEASE_STORE_PASSWORD",
    "OPENFICM_RELEASE_KEY_ALIAS",
    "OPENFICM_RELEASE_KEY_PASSWORD"
)
foreach ($name in $requiredVariables) {
    if (-not [Environment]::GetEnvironmentVariable($name)) {
        throw "Missing required environment variable: $name"
    }
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$androidRoot = Join-Path $projectRoot "android"
$gradle = Join-Path $androidRoot "gradlew.bat"
$mirrorInit = Join-Path $androidRoot "gradle\mirrors.init.gradle"
$appConfig = Get-Content -Raw (Join-Path $projectRoot "app.json") | ConvertFrom-Json
$version = [string]$appConfig.expo.version
$outputApk = Join-Path (Split-Path $projectRoot -Parent) "OpenFicM-Android-$version.apk"
if (Test-Path -LiteralPath $outputApk) {
    Remove-Item -LiteralPath $outputApk -Force
}
$appBuildRoot = [System.IO.Path]::GetFullPath((Join-Path $androidRoot "app\build"))
$androidAppRoot = [System.IO.Path]::GetFullPath((Join-Path $androidRoot "app")) + [System.IO.Path]::DirectorySeparatorChar
if (-not $appBuildRoot.StartsWith($androidAppRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clean unexpected Android build directory: $appBuildRoot"
}
if (Test-Path -LiteralPath $appBuildRoot) {
    Remove-Item -LiteralPath $appBuildRoot -Recurse -Force
}

Push-Location $androidRoot
try {
    & $gradle -I $mirrorInit assembleRelease --no-daemon
    if ($LASTEXITCODE -ne 0) {
        throw "Gradle release build failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}

$inputApk = Join-Path $androidRoot "app\build\outputs\apk\release\app-release.apk"
if (-not (Test-Path -LiteralPath $inputApk)) {
    throw "Release APK was not generated: $inputApk"
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($inputApk)
try {
    $bundledModels = @(
        $archive.Entries |
            Where-Object { $_.FullName -match "(?i)\.gguf$" } |
            ForEach-Object FullName
    )
} finally {
    $archive.Dispose()
}
if ($bundledModels.Count -gt 0) {
    $paths = $bundledModels -join ", "
    throw "Release APK must not bundle local GGUF models: $paths"
}
Write-Output "APK runtime resource check: no bundled GGUF models"
$lineageFile = $env:OPENFICM_RELEASE_LINEAGE_FILE

if ($lineageFile) {
    $legacyVariables = @(
        "OPENFICM_RELEASE_LEGACY_STORE_FILE",
        "OPENFICM_RELEASE_LEGACY_STORE_PASSWORD",
        "OPENFICM_RELEASE_LEGACY_KEY_ALIAS",
        "OPENFICM_RELEASE_LEGACY_KEY_PASSWORD"
    )
    foreach ($name in $legacyVariables) {
        if (-not [Environment]::GetEnvironmentVariable($name)) {
            throw "Lineage signing also requires $name"
        }
    }
    $lineagePath = (Resolve-Path -LiteralPath $lineageFile).Path
    $legacyStoreFile = (Resolve-Path -LiteralPath $env:OPENFICM_RELEASE_LEGACY_STORE_FILE).Path
    $sdkCandidates = @($env:ANDROID_SDK_ROOT, $env:ANDROID_HOME, (Join-Path $env:LOCALAPPDATA "Android\Sdk"))
    $sdkRoot = $sdkCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
    if (-not $sdkRoot) {
        throw "Android SDK was not found"
    }
    $apksigner = Get-ChildItem (Join-Path $sdkRoot "build-tools") -Directory |
        Sort-Object Name -Descending |
        ForEach-Object { Join-Path $_.FullName "apksigner.bat" } |
        Where-Object { Test-Path -LiteralPath $_ } |
        Select-Object -First 1
    if (-not $apksigner) {
        throw "apksigner.bat was not found under $sdkRoot"
    }
    $temporaryApk = "$outputApk.tmp"
    if (Test-Path -LiteralPath $temporaryApk) {
        Remove-Item -LiteralPath $temporaryApk -Force
    }
    $signArguments = @(
        "sign",
        "--v1-signing-enabled", "true",
        "--v2-signing-enabled", "true",
        "--v3-signing-enabled", "true",
        "--min-sdk-version", "28",
        "--ks", $legacyStoreFile,
        "--ks-key-alias", $env:OPENFICM_RELEASE_LEGACY_KEY_ALIAS,
        "--ks-pass", "env:OPENFICM_RELEASE_LEGACY_STORE_PASSWORD",
        "--key-pass", "env:OPENFICM_RELEASE_LEGACY_KEY_PASSWORD",
        "--next-signer",
        "--ks", $env:OPENFICM_RELEASE_STORE_FILE,
        "--ks-key-alias", $env:OPENFICM_RELEASE_KEY_ALIAS,
        "--ks-pass", "env:OPENFICM_RELEASE_STORE_PASSWORD",
        "--key-pass", "env:OPENFICM_RELEASE_KEY_PASSWORD",
        "--lineage", $lineagePath,
        "--out", $temporaryApk,
        $inputApk
    )
    & $apksigner @signArguments
    if ($LASTEXITCODE -ne 0) {
        throw "APK lineage signing failed with exit code $LASTEXITCODE"
    }
    & $apksigner verify --verbose --print-certs $temporaryApk
    if ($LASTEXITCODE -ne 0) {
        throw "APK signature verification failed with exit code $LASTEXITCODE"
    }
    Move-Item -LiteralPath $temporaryApk -Destination $outputApk -Force
} else {
    Copy-Item -LiteralPath $inputApk -Destination $outputApk -Force
}

$hash = Get-FileHash -Algorithm SHA256 -LiteralPath $outputApk
Write-Output "APK: $outputApk"
Write-Output "SHA-256: $($hash.Hash)"
