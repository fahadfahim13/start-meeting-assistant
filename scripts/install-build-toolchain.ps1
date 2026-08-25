<#
.SYNOPSIS
    Installs the native build toolchain MeetFroge needs on Windows.

.DESCRIPTION
    Three things are required, for three different reasons:

      Visual Studio 2022 Build Tools (VCTools workload)
        - compiles the better-sqlite3 and sherpa-onnx native Node addons
        - required by whisper.cpp and llama.cpp builds

      CMake
        - build system for whisper.cpp and llama.cpp

      Vulkan SDK
        - headers and loader for GGML_VULKAN=1, which is the only GPU
          acceleration path available on Windows AMD APUs (ROCm does not
          support them)

    Roughly 8-12 GB and 30-60 minutes depending on connection speed.

.NOTES
    MUST be run elevated. Right-click PowerShell and choose "Run as
    administrator", or from an elevated terminal:

        pwsh -ExecutionPolicy Bypass -File scripts\install-build-toolchain.ps1

    Safe to re-run - each step is skipped if already present.
#>

[CmdletBinding()]
param(
    [switch]$SkipVisualStudio,
    [switch]$SkipCMake,
    [switch]$SkipVulkan
)

$ErrorActionPreference = 'Stop'

function Write-Step { param($m) Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Write-Ok   { param($m) Write-Host "  OK  $m" -ForegroundColor Green }
function Write-Skip { param($m) Write-Host "  --  $m" -ForegroundColor DarkGray }
function Write-Warn2{ param($m) Write-Host "  !!  $m" -ForegroundColor Yellow }

# --- preconditions ---------------------------------------------------------

$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "This script must run elevated (UAC)." -ForegroundColor Red
    Write-Host "Open PowerShell as administrator and run it again." -ForegroundColor Red
    exit 1
}

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Host "winget not found. Install 'App Installer' from the Microsoft Store." -ForegroundColor Red
    exit 1
}

Write-Host "MeetFroge build toolchain installer" -ForegroundColor White
Write-Host "Free space on C: $([math]::Round((Get-PSDrive C).Free/1GB,1)) GB"

if ((Get-PSDrive C).Free/1GB -lt 20) {
    Write-Warn2 "Less than 20 GB free. The toolchain needs roughly 8-12 GB."
}

# --- Visual Studio 2022 Build Tools ----------------------------------------

Write-Step "Visual Studio 2022 Build Tools"
if ($SkipVisualStudio) {
    Write-Skip "skipped by flag"
}
elseif (Test-Path "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC") {
    Write-Ok "already installed"
}
else {
    Write-Host "  installing (this is the long one)..."
    # --includeRecommended pulls in the Windows SDK, which the addons need.
    winget install --id Microsoft.VisualStudio.2022.BuildTools `
        --accept-package-agreements --accept-source-agreements `
        --override "--quiet --wait --norestart --nocache --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
    if ($LASTEXITCODE -ne 0) { Write-Warn2 "winget returned $LASTEXITCODE - verify manually" }
    else { Write-Ok "installed" }
}

# --- CMake -----------------------------------------------------------------

Write-Step "CMake"
if ($SkipCMake) {
    Write-Skip "skipped by flag"
}
elseif (Get-Command cmake -ErrorAction SilentlyContinue) {
    Write-Ok "already installed: $((cmake --version | Select-Object -First 1))"
}
else {
    winget install --id Kitware.CMake `
        --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { Write-Warn2 "winget returned $LASTEXITCODE" }
    else { Write-Ok "installed" }
}

# --- Vulkan SDK ------------------------------------------------------------

Write-Step "Vulkan SDK"
if ($SkipVulkan) {
    Write-Skip "skipped by flag"
}
elseif ($env:VULKAN_SDK -and (Test-Path $env:VULKAN_SDK)) {
    Write-Ok "already installed at $env:VULKAN_SDK"
}
elseif (Test-Path "C:\VulkanSDK") {
    Write-Ok "already installed at C:\VulkanSDK (VULKAN_SDK not set in this shell)"
}
else {
    winget install --id KhronosGroup.VulkanSDK `
        --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { Write-Warn2 "winget returned $LASTEXITCODE" }
    else { Write-Ok "installed" }
}

# --- verify ----------------------------------------------------------------

Write-Step "Verification"
Write-Host "  Close and reopen your terminal first - PATH and VULKAN_SDK are set"
Write-Host "  by the installers and will not be visible in this session."
Write-Host ""
Write-Host "  Then check:" -ForegroundColor White
Write-Host "    cmake --version"
Write-Host "    echo `$env:VULKAN_SDK"
Write-Host "    Test-Path `"`${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools`""
Write-Host ""
Write-Host "  Then build whisper.cpp with Vulkan - see docs/setup.md" -ForegroundColor White

Write-Host "`nDone.`n" -ForegroundColor Green
