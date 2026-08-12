# Start the FastAPI backend
Set-Location "$PSScriptRoot\backend"

# Create virtualenv if it doesn't exist
if (-not (Test-Path "venv")) {
    python -m venv venv
    Write-Host "Created virtual environment" -ForegroundColor Green
}

# Activate and install deps
& "venv\Scripts\Activate.ps1"
pip install -r requirements.txt --quiet

Write-Host "Starting backend on http://localhost:8000" -ForegroundColor Cyan
Write-Host "API docs at http://localhost:8000/docs" -ForegroundColor Cyan
python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
