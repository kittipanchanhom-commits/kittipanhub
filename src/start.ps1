$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$cloudflared = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
$logFile = "$env:TEMP\torrent_tunnel.txt"

# Cleanup on exit
Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action {
    Get-Process python -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $pid } | Stop-Process -Force
    Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
    Remove-Item $logFile -ErrorAction SilentlyContinue
} | Out-Null

# Kill old instances
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process python -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $pid } | Stop-Process -Force
Start-Sleep -Seconds 1

# Show local IP
$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
    $_.InterfaceAlias -notmatch 'Loopback|Virtual|Bluetooth|Teredo|ISATAP' -and
    $_.PrefixOrigin -eq 'Dhcp'
} | Select-Object -First 1).IPAddress

Clear-Host
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "   Torrent Video Browser" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
if ($ip) {
    Write-Host "   Local: http://$($ip):5000" -ForegroundColor Gray
}
Write-Host ""

# Start server
Write-Host "* Starting server..." -ForegroundColor Yellow
$server = Start-Process python -ArgumentList "server.py" -WorkingDirectory $scriptDir -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 5

# Check server
try {
    $null = Invoke-WebRequest "http://127.0.0.1:5000" -TimeoutSec 5 -UseBasicParsing
    Write-Host "  Server OK" -ForegroundColor Green
} catch {
    Write-Host "  Server FAILED" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

# Start tunnel
Write-Host "* Starting Cloudflare Tunnel..." -ForegroundColor Yellow
Remove-Item $logFile -ErrorAction SilentlyContinue
$tunnel = Start-Process -FilePath $cloudflared -ArgumentList "tunnel --url http://127.0.0.1:5000 --protocol http2" -WindowStyle Hidden -RedirectStandardError $logFile -PassThru

# Wait for URL
Write-Host "  Waiting for tunnel URL " -NoNewline -ForegroundColor Gray
$url = $null
for ($i = 0; $i -lt 40; $i++) {
    Write-Host "." -NoNewline -ForegroundColor Gray
    Start-Sleep -Seconds 1
    try {
        $match = Select-String -Path $logFile -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue |
                 Select-Object -First 1
        if ($match) {
            $url = $match.Matches.Value
            break
        }
    } catch {}
}
Write-Host ""

if (-not $url) {
    Write-Host "  TUNNEL FAILED - Could not get URL" -ForegroundColor Red
    Write-Host "Last output:" -ForegroundColor Gray
    Get-Content $logFile -Tail 5 -ErrorAction SilentlyContinue
    Read-Host "Press Enter to exit"
    exit 1
}

# Copy URL to clipboard
try {
    Set-Clipboard $url
    $copied = "COPIED TO CLIPBOARD!"
} catch {
    $copied = "(manual copy)"
}

Write-Host ""
Write-Host "+-----------------------------------------------+"
Write-Host "| $copied |" -ForegroundColor Green
Write-Host "|                                               |" -ForegroundColor Green
Write-Host "| $url |" -ForegroundColor Cyan
Write-Host "|                                               |" -ForegroundColor Green
Write-Host "| Open in your browser                          |" -ForegroundColor Green
Write-Host "+-----------------------------------------------+"
Write-Host ""

# Save URL to file
$url | Out-File (Join-Path $scriptDir ".tunnel-url.txt") -Force

# Token reminder
try {
    $page_text = (Invoke-WebRequest "http://127.0.0.1:5000" -TimeoutSec 5 -UseBasicParsing).Content
    $idx_ct = $page_text.IndexOf('content="')
    if ($idx_ct -ge 0) {
        $idx_start = $idx_ct + 9
        $idx_end = $page_text.IndexOf('"', $idx_start)
        if ($idx_end -gt $idx_start) {
            $t = $page_text.Substring($idx_start, $idx_end - $idx_start)
            Write-Host "  Token: $t" -ForegroundColor Gray
        }
    }
} catch {}

Write-Host ""
Write-Host "  Press Ctrl+C to stop..." -ForegroundColor Gray

# Keep running - check tunnel health
try {
    while ($true) {
        Start-Sleep -Seconds 3
        if ($tunnel.HasExited) {
            Write-Host "Tunnel stopped unexpectedly!" -ForegroundColor Red
            Read-Host "Press Enter"
            break
        }
    }
} catch {}
