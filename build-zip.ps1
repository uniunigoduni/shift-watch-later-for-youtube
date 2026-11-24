#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifestPath = Join-Path $rootDir 'manifest.json'

if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "manifest.json not found in $rootDir"
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $manifest.version
if ([string]::IsNullOrWhiteSpace($version)) {
    throw 'manifest.json does not specify a valid version.'
}

# Strict whitelist of files required for the Chrome Web Store package
$includeFiles = @(
    'manifest.json',
    'content.js',
    'inject.js',
    'popup.html',
    'popup.css',
    'popup.js',
    'styles.css',
    'icons/icon16.png',
    'icons/icon48.png',
    'icons/icon128.png'
)

foreach ($relPath in $includeFiles) {
    $fullPath = Join-Path $rootDir ($relPath -replace '/', [IO.Path]::DirectorySeparatorChar)
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        throw "Required extension file is missing: $relPath"
    }
}

$distDir = Join-Path $rootDir 'dist'
if (-not (Test-Path -LiteralPath $distDir)) {
    New-Item -ItemType Directory -Path $distDir | Out-Null
}

$zipName = "shift-watch-later-for-youtube-v$version.zip"
$zipPath = Join-Path $distDir $zipName
if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$zipStream = [IO.File]::Open($zipPath, [IO.FileMode]::CreateNew)
try {
    $archive = New-Object System.IO.Compression.ZipArchive(
        $zipStream,
        [System.IO.Compression.ZipArchiveMode]::Create,
        $false
    )
    try {
        foreach ($relPath in $includeFiles) {
            $fullPath = Join-Path $rootDir ($relPath -replace '/', [IO.Path]::DirectorySeparatorChar)
            # Always use POSIX '/' separators inside the archive
            $entryName = $relPath -replace '\\', '/'
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $archive,
                $fullPath,
                $entryName,
                [System.IO.Compression.CompressionLevel]::Optimal
            ) | Out-Null
        }
    }
    finally {
        $archive.Dispose()
    }
}
finally {
    $zipStream.Dispose()
}

Write-Host "Created: $zipPath"
Write-Host 'Archive contents:'
$verify = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
    foreach ($entry in $verify.Entries) {
        Write-Host ("  {0,-28} {1,8} bytes" -f $entry.FullName, $entry.Length)
    }
}
finally {
    $verify.Dispose()
}
