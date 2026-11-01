$ErrorActionPreference = 'Stop'
if ((git config --local user.name) -ne 'Mustiks07') { throw 'Incorrect local commit name' }
if ((git config --local user.email) -ne '232028042+Mustiks07@users.noreply.github.com') { throw 'Incorrect local commit email' }
$credentialResult = "protocol=https`nhost=github.com`nusername=Mustiks07`n`n" | git credential fill
if ($LASTEXITCODE -ne 0) { throw 'Credential lookup failed' }
$credentialParts = @{}
foreach ($entry in $credentialResult) {
    if ($entry -match '^([^=]+)=(.*)$') { $credentialParts[$Matches[1]] = $Matches[2] }
}
$authHeaders = @{ Authorization = 'Bearer ' + $credentialParts['password']; 'User-Agent' = 'pavlodar-identity-check' }
$profile = Invoke-RestMethod -Uri 'https://api.github.com/user' -Headers $authHeaders
if ($profile.login -ne 'Mustiks07' -or $profile.id -ne 232028042) { throw 'Git credential account is not authorized' }
$credentialResult = $null
$credentialParts = $null
$authHeaders = $null
Write-Output 'Verified commit identity and Git credential account: Mustiks07 (232028042)'
