$ErrorActionPreference = "Stop"
$it = New-Object -ComObject iTunes.Application
$it.NextTrack()
"OK"
