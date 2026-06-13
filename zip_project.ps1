# EVARA Submission Zipping Script
# This script packages your project for final submission, excluding large dependency folders (venv, node_modules) 
# and the 280MB video to keep the ZIP size small and quick to upload.

$Name = Read-Host "Enter your name (e.g., Jeevan_L)"
$RegNo = Read-Host "Enter your registration number (e.g., 25PG00147)"

# Format filename
$CleanName = $Name -replace '\s+', '_'
$CleanReg = $RegNo -replace '\s+', '_'
$ZipName = "${CleanName}_${CleanReg}.zip"
$ZipPath = Join-Path (Get-Location) $ZipName

Write-Host "`nPreparing to package project into $ZipName..." -ForegroundColor Cyan

# Define exclusions
$ExcludePatterns = @(
    "venv",
    ".venv",
    "node_modules",
    "dist",
    "build",
    "__pycache__",
    "backend/data",
    "backend/app/data",
    "deliverables/*.mp4",
    "deliverables/*.mov",
    "deliverables/*.mkv",
    "deliverables/*.avi",
    ".git",
    ".vscode",
    $ZipName,
    "zip_project.ps1"
)

# Temporary packaging folder
$TempDir = Join-Path $env:TEMP "evara_build_$(Get-Random)"
if (Test-Path $TempDir) {
    Remove-Item $TempDir -Recurse -Force | Out-Null
}
New-Item -ItemType Directory -Path $TempDir -Force | Out-Null

Write-Host "Copying project files to temporary folder..." -ForegroundColor Yellow

# Copy files recursively, skipping excluded patterns
Get-ChildItem -Path . -Recurse | ForEach-Object {
    $RelativePath = $_.FullName.Substring((Get-Location).Path.Length + 1)
    if ($RelativePath -eq "") { return }
    
    # Check if this file matches any exclusion pattern
    $IsExcluded = $false
    foreach ($Pattern in $ExcludePatterns) {
        if ($RelativePath -like "$Pattern" -or $RelativePath -like "$Pattern/*" -or $RelativePath -like "*/$Pattern*") {
            $IsExcluded = $true
            break
        }
    }
    
    if (-not $IsExcluded) {
        $DestPath = Join-Path $TempDir $RelativePath
        if ($_.PSIsContainer) {
            New-Item -ItemType Directory -Path $DestPath -Force | Out-Null
        } else {
            $ParentDir = Split-Path $DestPath
            if (-not (Test-Path $ParentDir)) {
                New-Item -ItemType Directory -Path $ParentDir -Force | Out-Null
            }
            Copy-Item -Path $_.FullName -Destination $DestPath -Force
        }
    }
}

# Zip the temp folder
if (Test-Path $ZipPath) {
    Remove-Item $ZipPath -Force
}

Write-Host "Compressing files into ZIP format..." -ForegroundColor Yellow
Compress-Archive -Path "$TempDir\*" -DestinationPath $ZipPath -Force

# Clean up temp folder
Remove-Item $TempDir -Recurse -Force | Out-Null

Write-Host "`nSuccessfully created submission ZIP file: $ZipName" -ForegroundColor Green
Write-Host "Location: $ZipPath" -ForegroundColor Green
Write-Host "Size: $([Math]::Round((Get-Item $ZipPath).Length / 1MB, 2)) MB" -ForegroundColor Green
Write-Host "You can now upload this ZIP file for your project submission!`n" -ForegroundColor Green
