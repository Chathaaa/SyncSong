try {
  $ErrorActionPreference = "Stop"
  $it = New-Object -ComObject iTunes.Application
  "OK"
} catch {
  "NO_ITUNES"
  exit 1
}

