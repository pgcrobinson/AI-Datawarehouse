# Start the Next.js frontend
Set-Location "$PSScriptRoot\frontend"

if (-not (Test-Path "node_modules")) {
    Write-Host "Installing dependencies..." -ForegroundColor Yellow
    npm install
}

Write-Host "Starting frontend on http://localhost:3000" -ForegroundColor Cyan
npm run dev
