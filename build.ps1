<#
  Democracy & Space - project builder

  Scans every folder in projects/ and writes js/projects-data.js, which the
  website reads. Run it (double-click build.bat) after adding, removing or
  changing a project folder.

  Folder rules (details: projects/README.txt) - the ending of a file name sets its role:
    projects/<folder>/              one folder = one project; folder name = project id in the URL
      <name>_info.txt               texts (TITLE:, LOCATION:, AUTHOR:, YEAR:, SIZE:, CONTRIBUTED BY:, CREDITS:, TEXT:, CAPTIONS:)
                                    AUTHOR = who made the project shown; CONTRIBUTED BY = the student who wrote the entry
      <name>_hero.png / .mp4        represents the project on the landing page (drawing or video)
      <name>_1.jpg, <name>_2.jpg    images on the project page, in number order
                                    (a numbered .mp4 is shown as a video in that place)
      <name>_background.mp4         optional background video of the project page
                                    (a hero video is used when there is none)
    Folders starting with _ or . are ignored (e.g. _TEMPLATE, or to hide a project).

  Extra keys for the site editor (optional, in info.txt):
    POSITION: 4, -2           fixed grid position (col, row); otherwise placed automatically
    MAP WIDTH: 300            width of the hero drawing / video on the map in px
    ANCHOR: 0.5, 1            point of the hero drawing that sits on the grid (fractions of width, height)
    VIDEO FOCUS: 0.5          which part of the video the map crop shows (0 = left ... 1 = right)
    INVERT: no                show the hero image with its real colors (for photos)
#>

$ErrorActionPreference = 'Stop'

$root        = $PSScriptRoot
$projectsDir = Join-Path $root 'projects'
$outFile     = Join-Path $root 'js\projects-data.js'

$imageExt = @('.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif')
$videoExt = @('.mp4', '.webm')
$keys     = @('TITLE', 'LOCATION', 'AUTHOR', 'YEAR', 'SIZE', 'CONTRIBUTED BY', 'CREDITS', 'CREDIT', 'TEXT', 'CAPTIONS',
              'POSITION', 'MAP WIDTH', 'ANCHOR', 'VIDEO FOCUS', 'INVERT')
$invariant = [System.Globalization.CultureInfo]::InvariantCulture

function Get-UrlPath($folder, $file) {
  'projects/' + [uri]::EscapeDataString($folder) + '/' + [uri]::EscapeDataString($file)
}

# UTF-8 first; fall back to the Windows codepage for files saved as ANSI
function Read-TextFile($path) {
  $text = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
  if ($text.Contains([string][char]0xFFFD)) {
    $text = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::Default)
  }
  return $text
}

function Read-Info($text) {
  $info = @{ fields = @{}; text = New-Object System.Collections.ArrayList; captions = @{} }
  $section = $null
  $lastCaption = $null

  foreach ($raw in ($text -split "`r?`n")) {
    $line = $raw.TrimEnd()
    # lines starting with # are comments - except inside TEXT:, where "# Heading"
    # is a section heading on the project page
    if ($line.TrimStart().StartsWith('#') -and $section -ne 'TEXT') { continue }

    if ($line -match '^\s*([A-Za-z][A-Za-z ]*?)\s*:\s*(.*)$' -and $keys -contains $Matches[1].ToUpper()) {
      $key = $Matches[1].ToUpper()
      $value = $Matches[2].Trim()
      if ($key -eq 'TEXT' -or $key -eq 'CAPTIONS') {
        $section = $key
        if ($key -eq 'TEXT' -and $value) { [void]$info.text.Add($value) }
      } else {
        $section = $null
        $info.fields[$key] = $value
      }
      continue
    }

    if ($section -eq 'TEXT') {
      [void]$info.text.Add($line)
    } elseif ($section -eq 'CAPTIONS') {
      # "01: caption", "1 - caption", "01. caption"
      if ($line -match '^\s*(\d+)\s*[:.\-–]\s*(.*)$') {
        $lastCaption = [int]$Matches[1]
        $info.captions[$lastCaption] = $Matches[2].Trim()
      } elseif ($line.Trim() -and $null -ne $lastCaption) {
        $info.captions[$lastCaption] += ' ' + $line.Trim()
      }
    }
  }

  $info.textJoined = (($info.text -join "`n") -replace '^\s+', '' -replace '\s+$', '')
  return $info
}

function Get-Number($value) {
  if ($value -match '^\s*(-?[0-9]+(\.[0-9]+)?)\s*$') { return [double]::Parse($Matches[1], $invariant) }
  return $null
}

function Get-Pair($value, [switch]$Integers) {
  if ($value -match '^\s*(-?[0-9.]+)\s*[,; ]\s*(-?[0-9.]+)\s*$') {
    if ($Integers) { return @([int]$Matches[1], [int]$Matches[2]) }
    return @([double]::Parse($Matches[1], $invariant), [double]::Parse($Matches[2], $invariant))
  }
  return $null
}

if (-not (Test-Path $projectsDir)) { throw "No projects folder found at $projectsDir" }

$projects = New-Object System.Collections.ArrayList
$warnings = New-Object System.Collections.ArrayList

# oldest folders first, so new projects are placed after the existing ones
$folders = Get-ChildItem $projectsDir -Directory |
  Where-Object { $_.Name -notmatch '^[_.]' } |
  Sort-Object CreationTime, Name

foreach ($dir in $folders) {
  $files = @(Get-ChildItem $dir.FullName -File)

  $images = @($files | Where-Object { $imageExt -contains $_.Extension.ToLower() })
  $videos = @($files | Where-Object { $videoExt -contains $_.Extension.ToLower() })

  # --- <name>_info.txt (or any single .txt) ---
  $txt = $files | Where-Object { $_.Extension -ieq '.txt' -and $_.BaseName -match '_info$' } | Select-Object -First 1
  if (-not $txt) { $txt = $files | Where-Object { $_.Extension -ieq '.txt' } | Sort-Object Name | Select-Object -First 1 }
  if ($txt) {
    $info = Read-Info (Read-TextFile $txt.FullName)
  } else {
    $info = Read-Info ''
    [void]$warnings.Add("$($dir.Name): no _info.txt")
  }
  $f = $info.fields

  # --- <name>_hero: drawing or video for the landing page ---
  $heroVideo = $videos | Where-Object { $_.BaseName -match '_hero$' } | Select-Object -First 1
  $heroImage = $images | Where-Object { $_.BaseName -match '_hero$' } | Select-Object -First 1
  if (-not $heroVideo -and -not $heroImage) { [void]$warnings.Add("$($dir.Name): no _hero image or video") }

  # --- <name>_background: page background video (falls back to a hero video) ---
  $background = $videos | Where-Object { $_.BaseName -match '_background$' } | Select-Object -First 1
  if (-not $background) { $background = $heroVideo }

  # --- <name>_1, <name>_2, ...: images (or videos) on the project page ---
  $gallery = New-Object System.Collections.ArrayList
  $numbered = ($images + $videos) |
    Where-Object { $_.BaseName -match '_(\d+)$' } |
    Sort-Object @{ Expression = { [int]([regex]::Match($_.BaseName, '(\d+)$').Value) } }, Name
  foreach ($img in $numbered) {
    $n = [int]([regex]::Match($img.BaseName, '(\d+)$').Value)
    [void]$gallery.Add([ordered]@{
      src     = Get-UrlPath $dir.Name $img.Name
      caption = [string]$info.captions[$n]
    })
  }

  if ($heroVideo -and $heroImage) {
    [void]$warnings.Add("$($dir.Name): has a hero image and a hero video - the video is used on the map")
  }

  # files that match none of the rules
  foreach ($file in ($images + $videos)) {
    if ($file.BaseName -notmatch '_(hero|background|\d+)$') {
      [void]$warnings.Add("$($dir.Name): ignored $($file.Name) (name must end in _hero, _background or _1, _2, ...)")
    }
  }

  # formats browsers can't show (e.g. iPhone .mov / .heic, print .tif / .pdf)
  foreach ($file in $files) {
    $ext = $file.Extension.ToLower()
    if ($ext -ne '.txt' -and $imageExt -notcontains $ext -and $videoExt -notcontains $ext) {
      [void]$warnings.Add("$($dir.Name): ignored $($file.Name) - unsupported format, use .jpg/.png/.webp or .mp4")
    }
  }

  # CREDITS: or CREDIT:, without a leading "photography by" (the site adds that)
  $credits = $f['CREDITS']
  if (-not $credits) { $credits = $f['CREDIT'] }
  if ($credits) { $credits = $credits -replace '^\s*photography\s+by\s*:?\s*', '' }

  $title = $f['TITLE']
  if (-not $title) { $title = $dir.Name }

  [void]$projects.Add([ordered]@{
    id          = $dir.Name
    title       = $title
    location    = $f['LOCATION']
    author      = $f['AUTHOR']
    year        = $f['YEAR']
    size        = $f['SIZE']
    contributor = $f['CONTRIBUTED BY']
    credits     = $credits
    text        = $info.textJoined
    heroImage   = $(if ($heroImage) { Get-UrlPath $dir.Name $heroImage.Name } else { $null })
    heroVideo   = $(if ($heroVideo) { Get-UrlPath $dir.Name $heroVideo.Name } else { $null })
    background  = $(if ($background) { Get-UrlPath $dir.Name $background.Name } else { $null })
    gallery     = @($gallery)
    position    = Get-Pair $f['POSITION'] -Integers
    mapWidth    = Get-Number $f['MAP WIDTH']
    anchor      = Get-Pair $f['ANCHOR']
    videoFocusX = Get-Number $f['VIDEO FOCUS']
    invert      = $f['INVERT'] -notmatch '^\s*(no|false|0|off)\s*$'
  })
}

$json = ConvertTo-Json -InputObject @($projects) -Depth 6
$content = @"
// GENERATED by build.ps1 - do not edit by hand.
// Edit the folders in projects/ and run build.bat instead.
window.PROJECTS_DATA = $json;
"@
[System.IO.File]::WriteAllText($outFile, $content, (New-Object System.Text.UTF8Encoding $false))

# --- Student template zip: projects/_TEMPLATE packed as lastname_project-title/ ---
# (forward slashes in the entry names so it unpacks correctly on Macs too)
$templateDir = Join-Path $projectsDir '_TEMPLATE'
$zipPath = Join-Path $root 'Democracy-and-Space_project-template.zip'
if (Test-Path $templateDir) {
  Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
  if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
  $stream = [System.IO.File]::Open($zipPath, [System.IO.FileMode]::Create)
  $archive = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($file in Get-ChildItem $templateDir -File) {
      [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $archive, $file.FullName, 'lastname_project-title/' + $file.Name,
        [System.IO.Compression.CompressionLevel]::Optimal)
    }
  } finally {
    $archive.Dispose()
    $stream.Dispose()
  }
}

Write-Host ""
Write-Host "Built $($projects.Count) project(s) -> js\projects-data.js" -ForegroundColor Green
if (Test-Path $templateDir) { Write-Host "Template zip updated -> Democracy-and-Space_project-template.zip" -ForegroundColor Green }
foreach ($p in $projects) {
  $extra = @()
  if ($p.heroVideo) { $extra += 'hero video' } elseif ($p.heroImage) { $extra += 'hero image' }
  if ($p.background) { $extra += 'background' }
  if ($p.position) { $extra += "position $($p.position -join ', ')" }
  Write-Host ("  {0,-34} {1,2} image(s)  {2}" -f $p.id, $p.gallery.Count, ($extra -join ', '))
}
if ($warnings.Count) {
  Write-Host ""
  foreach ($w in $warnings) { Write-Host "  ! $w" -ForegroundColor Yellow }
}
Write-Host ""
