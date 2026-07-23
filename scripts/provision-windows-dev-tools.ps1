[CmdletBinding()]
param(
  [switch]$InstallOptionalReviewTools,
  [switch]$GrantDockerDaemonAccess,
  [switch]$RepairDockerUserConfig
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated PowerShell session (Run as administrator)."
  }
}

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = @($machine, $user, $env:Path) -join ";"
}

function Get-File {
  param([Parameter(Mandatory)][string]$Uri, [Parameter(Mandatory)][string]$Path)
  try {
    Invoke-WebRequest -Uri $Uri -OutFile $Path -UseBasicParsing -Headers @{ "User-Agent" = "InfiniteQuestNexus-provisioner/1.0" }
  } catch {
    throw "Download failed for $Uri. $($_.Exception.Message)"
  }
}

function Assert-AuthenticodeSignature {
  param([Parameter(Mandatory)][string]$Path)
  $signature = Get-AuthenticodeSignature -FilePath $Path
  if ($signature.Status -ne "Valid") {
    throw "The downloaded installer is not Authenticode-valid: $Path ($($signature.Status))."
  }
}

function Add-ToMachinePath {
  param([Parameter(Mandatory)][string]$Directory)
  $current = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $parts = @($current -split ";" | Where-Object { $_ })
  if ($parts -notcontains $Directory) {
    [Environment]::SetEnvironmentVariable("Path", ($parts + $Directory -join ";"), "Machine")
  }
}

function Get-GitHubReleaseAsset {
  param(
    [Parameter(Mandatory)][string]$Repository,
    [Parameter(Mandatory)][string]$AssetName,
    [Parameter(Mandatory)][string]$Destination
  )
  $release = Invoke-RestMethod -Headers @{ "User-Agent" = "InfiniteQuestNexus-provisioner" } -Uri "https://api.github.com/repos/$Repository/releases/latest"
  $asset = $release.assets | Where-Object name -eq $AssetName | Select-Object -First 1
  if (-not $asset) {
    throw "The latest $Repository release does not contain $AssetName."
  }
  Get-File -Uri $asset.browser_download_url -Path $Destination
}

Assert-Administrator
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) "infinitequest-dev-tools"
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

# Node 24 is the CI and container runtime major. The official latest-v24.x
# checksum manifest directly identifies the latest Windows x64 installer.
$nodeHashManifestUri = "https://nodejs.org/download/release/latest-v24.x/SHASUMS256.txt"
$nodeHashManifest = Invoke-WebRequest -Uri $nodeHashManifestUri -UseBasicParsing -Headers @{ "User-Agent" = "InfiniteQuestNexus-provisioner/1.0" }
$nodeMsi = (($nodeHashManifest.Content -split "`n") | ForEach-Object { ($_ -split "\s+")[-1] } | Where-Object { $_ -match '^node-v24\.[0-9]+\.[0-9]+-x64\.msi$' } | Select-Object -First 1)
if (-not $nodeMsi) { throw "Unable to identify a Node 24 Windows x64 installer from $nodeHashManifestUri." }
$nodeVersion = [regex]::Match($nodeMsi, '^node-(v24\.[0-9]+\.[0-9]+)-x64\.msi$').Groups[1].Value
$nodeMsiPath = Join-Path $tempRoot $nodeMsi
Get-File -Uri "https://nodejs.org/download/release/$nodeVersion/$nodeMsi" -Path $nodeMsiPath
$expectedHash = (($nodeHashManifest.Content -split "`n") | Where-Object { $_ -match "\s$([regex]::Escape($nodeMsi))$" } | Select-Object -First 1).Split(" ", [StringSplitOptions]::RemoveEmptyEntries)[0]
$actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $nodeMsiPath).Hash.ToLowerInvariant()
if (-not $expectedHash -or $actualHash -ne $expectedHash.ToLowerInvariant()) { throw "Node MSI checksum verification failed." }
Assert-AuthenticodeSignature $nodeMsiPath
Start-Process msiexec.exe -Wait -ArgumentList "/i", "`"$nodeMsiPath`"", "/qn", "/norestart" | Out-Null
Refresh-Path

# Keep the package manager independent of Codex's private fallback runtime.
& npm.cmd install --global pnpm@11.15.1
Refresh-Path

# Python supports the documented legacy static-server workflow and the optional
# YAML/Semgrep review tools. It is intentionally not used by application tests.
$pythonVersion = "3.14.6"
$pythonInstaller = "python-$pythonVersion-amd64.exe"
$pythonPath = Join-Path $tempRoot $pythonInstaller
Get-File -Uri "https://www.python.org/ftp/python/$pythonVersion/$pythonInstaller" -Path $pythonPath
Assert-AuthenticodeSignature $pythonPath
Start-Process $pythonPath -Wait -ArgumentList "/quiet", "InstallAllUsers=1", "PrependPath=1", "Include_test=0" | Out-Null
Refresh-Path

# Docker Desktop is already present on this machine. Install a current Compose
# CLI plugin in the user's Docker plugin directory if `docker compose` is absent.
& docker.exe compose version *> $null
if ($LASTEXITCODE -ne 0) {
  $dockerPluginDirectory = Join-Path $env:USERPROFILE ".docker\\cli-plugins"
  New-Item -ItemType Directory -Force -Path $dockerPluginDirectory | Out-Null
  $composePlugin = Join-Path $dockerPluginDirectory "docker-compose.exe"
  Get-GitHubReleaseAsset -Repository "docker/compose" -AssetName "docker-compose-windows-x86_64.exe" -Destination $composePlugin
  Unblock-File -LiteralPath $composePlugin
}

if ($RepairDockerUserConfig) {
  $dockerRoot = Join-Path $env:USERPROFILE ".docker"
  if (Test-Path -LiteralPath $dockerRoot) {
    $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls.exe $dockerRoot /grant "${currentIdentity}:(OI)(CI)F" /T /C | Out-Host
  }
}

if ($GrantDockerDaemonAccess) {
  # Docker documents that docker-users membership gives daemon-socket-level
  # access. Use only for a trusted local development account.
  $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  Add-LocalGroupMember -Group "docker-users" -Member $currentUser -ErrorAction SilentlyContinue
}

if ($InstallOptionalReviewTools) {
  & npm.cmd install --global markdownlint-cli2
  & python.exe -m pip install --upgrade pip yamllint semgrep

  $toolDirectory = Join-Path $env:ProgramData "InfiniteQuest\\dev-tools\\bin"
  New-Item -ItemType Directory -Force -Path $toolDirectory | Out-Null
  Add-ToMachinePath $toolDirectory

  $actionlintRelease = Invoke-RestMethod -Headers @{ "User-Agent" = "InfiniteQuestNexus-provisioner" } -Uri "https://api.github.com/repos/rhysd/actionlint/releases/latest"
  $actionlintAsset = @($actionlintRelease.assets | Where-Object { $_.name -match '(?i)^actionlint_.*windows.*\.zip$' } | Select-Object -First 1 -ExpandProperty name)[0]
  if ($actionlintAsset) {
    $actionlintZip = Join-Path $tempRoot "actionlint.zip"
    Get-GitHubReleaseAsset -Repository "rhysd/actionlint" -AssetName $actionlintAsset -Destination $actionlintZip
    Expand-Archive -LiteralPath $actionlintZip -DestinationPath $toolDirectory -Force
  } else {
    Write-Warning "Skipping actionlint: the latest release exposes no Windows ZIP asset."
  }

  $hadolint = Join-Path $toolDirectory "hadolint.exe"
  Get-GitHubReleaseAsset -Repository "hadolint/hadolint" -AssetName "hadolint-Windows-x86_64.exe" -Destination $hadolint
  Unblock-File -LiteralPath $hadolint

  $shellcheckRelease = Invoke-RestMethod -Headers @{ "User-Agent" = "InfiniteQuestNexus-provisioner" } -Uri "https://api.github.com/repos/koalaman/shellcheck/releases/latest"
  $shellcheckAsset = @($shellcheckRelease.assets | Where-Object { $_.name -match '(?i)^shellcheck.*\.zip$' } | Select-Object -First 1 -ExpandProperty name)[0]
  if ($shellcheckAsset) {
    $shellcheckZip = Join-Path $tempRoot "shellcheck.zip"
    Get-GitHubReleaseAsset -Repository "koalaman/shellcheck" -AssetName $shellcheckAsset -Destination $shellcheckZip
    $shellcheckExtract = Join-Path $tempRoot "shellcheck"
    Expand-Archive -LiteralPath $shellcheckZip -DestinationPath $shellcheckExtract -Force
    Copy-Item -LiteralPath (Get-ChildItem -LiteralPath $shellcheckExtract -Recurse -Filter "shellcheck.exe" | Select-Object -First 1 -ExpandProperty FullName) -Destination (Join-Path $toolDirectory "shellcheck.exe") -Force
  } else {
    Write-Warning "Skipping ShellCheck: the latest release exposes no Windows ZIP asset."
  }

  $trivyRelease = Invoke-RestMethod -Headers @{ "User-Agent" = "InfiniteQuestNexus-provisioner" } -Uri "https://api.github.com/repos/aquasecurity/trivy/releases/latest"
  $trivyAsset = @($trivyRelease.assets | Where-Object { $_.name -match '(?i)^trivy_.*windows.*\.zip$' } | Select-Object -First 1 -ExpandProperty name)[0]
  if ($trivyAsset) {
    $trivyZip = Join-Path $tempRoot "trivy.zip"
    Get-GitHubReleaseAsset -Repository "aquasecurity/trivy" -AssetName $trivyAsset -Destination $trivyZip
    $trivyExtract = Join-Path $tempRoot "trivy"
    Expand-Archive -LiteralPath $trivyZip -DestinationPath $trivyExtract -Force
    Copy-Item -LiteralPath (Get-ChildItem -LiteralPath $trivyExtract -Recurse -Filter "trivy.exe" | Select-Object -First 1 -ExpandProperty FullName) -Destination (Join-Path $toolDirectory "trivy.exe") -Force
  } else {
    Write-Warning "Skipping Trivy: the latest release exposes no Windows ZIP asset."
  }
}

Refresh-Path
Write-Host "`nInstalled/configured: Node $nodeVersion, pnpm 11.15.1, Python $pythonVersion, and Docker Compose CLI plugin when needed."
Write-Host "Open a new elevated PowerShell session before testing. If Docker access was changed, sign out and back in first."
Write-Host "PostgreSQL client binaries are not installed: Nexus integration tests use the pgvector Compose service, and backups use docker compose exec."
Write-Host "Then run: pnpm install --frozen-lockfile; pnpm check; pnpm test; pnpm build; docker compose config --quiet"
