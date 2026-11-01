param(
    [switch]$SkipInstall,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $repo

function Step([string]$message) {
    Write-Host "`n==> $message" -ForegroundColor Green
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker Desktop не найден.' }
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { throw 'uv не найден: https://docs.astral.sh/uv/' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'Node.js/npm не найден.' }
docker info *> $null

if (-not $SkipInstall) {
    Step 'Проверяем зафиксированные зависимости'
    uv sync --locked
    npm ci --prefix apps/web
}

Step 'Готовим локальные учётные записи и конфигурацию'
if (-not (Test-Path '.env')) {
    uv run python tools/dev/bootstrap.py
} elseif (-not (Test-Path '.local\test-credentials.json')) {
    throw 'Найдена .env, но нет .local/test-credentials.json. Восстановите локальные credentials или создайте чистый контур.'
} else {
    Write-Host 'Используем существующую локальную конфигурацию.'
}

Step 'Поднимаем PostgreSQL/PostGIS, Keycloak, Redis, API и фоновые задания'
docker compose --env-file .env -f infra/compose.yml --project-name pavlodar-gpt --profile test up -d --build

Step 'Ждём готовности API'
$deadline = (Get-Date).AddMinutes(4)
do {
    Start-Sleep -Seconds 2
    try {
        $openApi = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:8001/openapi.json' -TimeoutSec 5
        $ready = $openApi.StatusCode -eq 200
    } catch {
        $ready = $false
    }
} until ($ready -or (Get-Date) -gt $deadline)
if (-not $ready) { throw 'API не стал доступен на http://localhost:8001 за 4 минуты.' }

Step 'Создаём локальный город, роли и права доступа'
uv run python -m tools.dev.seed --profile test

Step 'Наполняем Павлодар воспроизводимым конкурсным контуром'
uv run python -m tools.dev.demo_bootstrap --license CC-BY-4.0

Step 'Публикуем 60 144 открытых городских объекта Павлодара'
uv run python -m tools.data.publish_pavlodar_v2 `
    --archive research/data/pavlodar-public-vectors-v2.zip `
    --base-url http://localhost:8001 `
    --city-id 10000000-0000-4000-8000-000000000001 `
    --evidence docs/evidence/final-public-data.json

$webReady = $false
try {
    $webReady = (Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:5173/' -TimeoutSec 3).StatusCode -eq 200
} catch {}
if (-not $webReady) {
    Step 'Запускаем веб-интерфейс'
    $stdout = Join-Path $repo '.local\vite-demo.out.log'
    $stderr = Join-Path $repo '.local\vite-demo.err.log'
    Start-Process -FilePath 'npm.cmd' -ArgumentList '--prefix','apps/web','run','dev','--','--host','127.0.0.1','--port','5173' -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
}

$deadline = (Get-Date).AddMinutes(2)
do {
    Start-Sleep -Seconds 2
    try {
        $webReady = (Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:5173/' -TimeoutSec 3).StatusCode -eq 200
    } catch {
        $webReady = $false
    }
} until ($webReady -or (Get-Date) -gt $deadline)
if (-not $webReady) { throw 'Веб-интерфейс не стал доступен; проверьте .local/vite-demo.err.log.' }

$credentials = Get-Content '.local/test-credentials.json' -Raw | ConvertFrom-Json
Write-Host "`nPavlodar Green готов: http://localhost:5173/" -ForegroundColor Cyan
Write-Host "Логин специалиста: specialist"
Write-Host "Пароль специалиста: $($credentials.specialist)"
Write-Host 'Остановка стенда: docker compose --env-file .env -f infra/compose.yml --project-name pavlodar-gpt --profile test down'

if (-not $NoBrowser) { Start-Process 'http://localhost:5173/' }
