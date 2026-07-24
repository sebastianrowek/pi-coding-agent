# Keep user configuration (auth, models, sessions) mounted from the host while
# exposing this repository's committed .pi resources at a Linux-only path.
$agentDir = Join-Path $env:USERPROFILE ".pi\agent"
$settingsPath = Join-Path $agentDir "settings.json"
$temporarySettingsPath = Join-Path $env:TEMP "pi-docker-settings-$([guid]::NewGuid()).json"
$exitCode = 1

# Disable Bash guard, because the container is already running in a container.
$env:BASH_GUARD_DISABLE = 1

# When launched from this repository, the repository's .pi directory is already
# available at /workspace/.pi through the current-directory bind mount. Do not
# also configure it through /pi-resources, or Pi will load every resource twice.
$repositoryDir = (Resolve-Path -LiteralPath $PSScriptRoot).Path.TrimEnd([char[]]@('\', '/'))
$launchDir = (Resolve-Path -LiteralPath (Get-Location).Path).Path.TrimEnd([char[]]@('\', '/'))

$launchedFromRepository = [string]::Equals(
  $launchDir,
  $repositoryDir,
  [System.StringComparison]::OrdinalIgnoreCase
)

try {
  # Pi settings use host paths outside Docker. Generate a temporary settings
  # overlay. When launched outside this repository, append the mounted
  # /pi-resources directories so Pi can discover the committed resources.
  $settings = if (Test-Path $settingsPath) {
    Get-Content -Raw $settingsPath | ConvertFrom-Json
  } else {
    [pscustomobject]@{}
  }

  foreach ($type in @("extensions", "skills", "prompts", "themes")) {
    $containerPath = "/pi-resources/$type"
    $existing = @()

    if ($settings.$type) {
      $existing = @(
        $settings.$type | Where-Object {
          $_ -is [string] -and $_ -and $_ -ne $containerPath
        }
      )
    }

    if (-not $launchedFromRepository) {
      $existing += $containerPath
    }

    $settings | Add-Member -NotePropertyName $type -NotePropertyValue $existing -Force
  }

  # Windows PowerShell's Set-Content -Encoding utf8 writes a BOM, which Pi's
  # JSON parser rejects. JSON settings are ASCII-compatible, so use ASCII to
  # produce a BOM-free file that works in constrained-language mode.
  $settings | ConvertTo-Json -Depth 100 | Set-Content -Encoding ascii $temporarySettingsPath

  # The .pi mount is read-only so the container cannot modify committed
  # resources. The generated settings file replaces only settings.json; the
  # surrounding agent-directory mount still supplies auth, models, and sessions.
  # Resource extensions are outside /app, so NODE_PATH lets Jiti resolve their
  # npm dependencies from the image's /app/node_modules directory.
  docker run --rm -it `
    -e "NODE_PATH=/app/node_modules" `
    -v "${PWD}:/workspace" `
    -v "${agentDir}:/root/.pi/agent" `
    -v "${PSScriptRoot}\.pi:/pi-resources:ro" `
    -v "${temporarySettingsPath}:/root/.pi/agent/settings.json:ro" `
    pi-local

  $exitCode = $LASTEXITCODE
} finally {
  # Docker bind mounts use live host files. Remove the temporary file only
  # after docker run has exited and released its settings.json mount.
  Remove-Item -Force -ErrorAction SilentlyContinue $temporarySettingsPath
}

exit $exitCode