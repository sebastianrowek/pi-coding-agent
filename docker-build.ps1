$certsPath = "C:\Appl\workspace\certificates"
$certFileName = "trusted_certs.crt"
$certFile = Join-Path $certsPath $certFileName

if (-not (Test-Path -Path $certFile -PathType Leaf)) {
    Write-Error "Missing required certificate file: $certFile"
    Write-Error "Expected certificate directory: $certsPath"
    Write-Error "Expected certificate file name: $certFileName"
    exit 1
}

docker build -t pi-local -f Dockerfile.local `
  --build-context certs="$certsPath" `
  .
