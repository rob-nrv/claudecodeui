# Runs one command on nas-hub over SSH and keeps a UTF-8 log, from Windows PowerShell 5.1.
# The SSH password is typed by you in the terminal when ssh asks; it never passes through this script.
#   powershell -ExecutionPolicy Bypass -File deploy\nas-hub\nas.ps1 -Cmd "<remote command>" [-Log file.txt] [-Tty]
# -Tty : allocate a terminal (needed when the remote stage prompts you or prints a one-time link).
#        Do NOT combine -Tty with -Log for such stages: the terminal content would land in the log.
param(
  [Parameter(Mandatory = $true)][string]$Cmd,
  [string]$Log,
  [switch]$Tty,
  [string]$Target = 'robin@192.168.1.145'
)
$ErrorActionPreference = 'Continue'
$sshArgs = @()
if ($Tty) { $sshArgs += '-t' }
$sshArgs += $Target
$sshArgs += $Cmd
if ($Log) {
  New-Item -ItemType File -Force -Path $Log | Out-Null
  Set-Content -Path $Log -Value "# $(Get-Date -Format o) ssh $Target  (command not echoed: see the runbook)" -Encoding UTF8
  & ssh @sshArgs 2>&1 | ForEach-Object {
    $line = $_.ToString()
    $line
    Add-Content -Path $Log -Value $line -Encoding UTF8
  }
} else {
  & ssh @sshArgs
}
exit $LASTEXITCODE
