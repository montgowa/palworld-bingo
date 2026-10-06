# Starts the Palworld dedicated server with Pocketpair's recommended performance flags.
# High CPU priority comes from a registry setting (Image File Execution Options), so it
# applies however the server is started; see the README.
#
#   powershell -ExecutionPolicy Bypass -File server\start-palserver.ps1

$dir = "C:\Program Files (x86)\Steam\steamapps\common\PalServer"
$flags = "-useperfthreads -NoAsyncLoadingThread -UseMultithreadForDS"

if (Get-Process PalServer-Win64-Shipping-Cmd -ErrorAction SilentlyContinue) {
    Write-Output "The server is already running."
    exit 0
}
Start-Process -FilePath "$dir\PalServer.exe" -WorkingDirectory $dir -ArgumentList $flags
Write-Output "Started the Palworld server with $flags"
