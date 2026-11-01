param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('gemini', 'groq', 'openrouter')]
    [string]$Provider,
    [string]$Model,
    [switch]$Restart
)

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$envPath = Join-Path $root '.env'
$examplePath = Join-Path $root '.env.example'

if (-not (Test-Path -LiteralPath $envPath)) {
    Copy-Item -LiteralPath $examplePath -Destination $envPath
}

if ($Provider -eq 'openrouter' -and [string]::IsNullOrWhiteSpace($Model)) {
    throw 'OpenRouter requires -Model with an allowlisted provider/model identifier.'
}

$secure = Read-Host "Enter the $Provider API key (input is hidden)" -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    if ([string]::IsNullOrWhiteSpace($apiKey) -or $apiKey.Length -lt 12) {
        throw 'The API key is empty or too short.'
    }

    $text = [IO.File]::ReadAllText($envPath)
    function Set-EnvValue([string]$Name, [string]$Value) {
        $script:text = [regex]::Replace(
            $script:text,
            "(?m)^$([regex]::Escape($Name))=.*$",
            "$Name=$Value"
        )
    }

    Set-EnvValue 'PAVLODAR_LLM_PROVIDER' $Provider
    switch ($Provider) {
        'gemini' {
            Set-EnvValue 'PAVLODAR_GEMINI_API_KEY' $apiKey
            if ($Model) { Set-EnvValue 'PAVLODAR_GEMINI_MODEL' $Model }
        }
        'groq' {
            Set-EnvValue 'PAVLODAR_GROQ_API_KEY' $apiKey
            if ($Model) { Set-EnvValue 'PAVLODAR_GROQ_MODEL' $Model }
        }
        'openrouter' {
            Set-EnvValue 'PAVLODAR_OPENROUTER_API_KEY' $apiKey
            Set-EnvValue 'PAVLODAR_LLM_MODEL' $Model
        }
    }
    [IO.File]::WriteAllText($envPath, $text, [Text.UTF8Encoding]::new($false))
} finally {
    if ($pointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
    $apiKey = $null
    $secure = $null
}

Write-Output "Configured $Provider in the ignored local .env; the key was not printed."
if ($Restart) {
    docker compose --env-file $envPath -f (Join-Path $root 'infra\compose.yml') up -d --force-recreate worker dispatcher
    if ($LASTEXITCODE -ne 0) { throw 'Failed to restart the assistant worker.' }
    Write-Output 'Assistant worker and dispatcher restarted.'
}
