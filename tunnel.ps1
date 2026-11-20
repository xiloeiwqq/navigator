# Держит постоянный HTTPS-туннель к локальному навигатору и публикует актуальный адрес
# в файле tunnel-url.txt. Запускать после `python app.py --host 127.0.0.1 --port 8080`.
param(
    [int]$Port = 8080,
    [string]$Executable = "$env:TEMP\opencode\cloudflared.exe",
    [int]$RetrySeconds = 5
)

$urlFile = Join-Path $PSScriptRoot "tunnel-url.txt"
$stdoutLog = Join-Path $env:TEMP "cloudflared-tunnel.out.log"
$stderrLog = Join-Path $env:TEMP "cloudflared-tunnel.err.log"

if (-not (Test-Path $Executable)) {
    throw "Не найден cloudflared: $Executable"
}

while ($true) {
    Remove-Item $stdoutLog, $stderrLog -ErrorAction SilentlyContinue
    $process = Start-Process -FilePath $Executable `
        -ArgumentList "tunnel", "--url", "http://127.0.0.1:$Port", "--no-autoupdate" `
        -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog `
        -PassThru -WindowStyle Hidden

    $url = $null
    for ($attempt = 0; $attempt -lt 60 -and -not $url; $attempt += 1) {
        Start-Sleep -Seconds 1
        foreach ($log in @($stderrLog, $stdoutLog)) {
            if ($url -or -not (Test-Path $log)) { continue }
            $found = Select-String -Path $log -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" -AllMatches |
                Select-Object -First 1
            if ($found) { $url = $found.Matches[0].Value }
        }
        if ($process.HasExited) { break }
    }

    if ($url) {
        Set-Content -Path $urlFile -Value $url -Encoding ascii
        Write-Host "PUBLIC_URL $url"
    } else {
        Write-Warning "Не удалось получить публичный адрес, перезапуск"
    }

    Wait-Process -Id $process.Id -ErrorAction SilentlyContinue
    Write-Host "Туннель закрыт, перезапуск через $RetrySeconds с"
    Start-Sleep -Seconds $RetrySeconds
}
