const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const root = path.resolve(__dirname, '..')
const source = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'assets', 'app-icon-source.jpg')
const assets = path.join(root, 'assets')
const publicDir = path.join(root, 'public')
const work = path.join(assets, '.icon-work')
const sizes = [16, 24, 32, 48, 64, 256]

if (!fs.existsSync(source)) {
  console.error(`Missing icon source: ${source}`)
  process.exit(1)
}

fs.mkdirSync(assets, { recursive: true })
fs.mkdirSync(publicDir, { recursive: true })
fs.rmSync(work, { recursive: true, force: true })
fs.mkdirSync(work)

const ps = `
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile(${JSON.stringify(source)})
$work = ${JSON.stringify(work)}
$bg = [System.Drawing.Color]::FromArgb(255, 23, 27, 30)
foreach ($size in @(${sizes.join(',')})) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear($bg)
  $g.DrawImage($src, 0, 0, $size, $size)
  $bmp.Save((Join-Path $work ("app-icon-$size.png")), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
}
$src.Dispose()
`

const result = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' })
if (result.status !== 0) {
  console.error(result.stdout || '')
  console.error(result.stderr || '')
  console.error('PowerShell could not rasterize the app icon.')
  process.exit(result.status || 1)
}

function pngToIco(images) {
  const count = images.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(count, 4)
  const entries = Buffer.alloc(16 * count)
  const blobs = []
  let offset = 6 + 16 * count
  images.forEach((image, index) => {
    const size = image.size >= 256 ? 0 : image.size
    const at = index * 16
    entries.writeUInt8(size, at)
    entries.writeUInt8(size, at + 1)
    entries.writeUInt8(0, at + 2)
    entries.writeUInt8(0, at + 3)
    entries.writeUInt16LE(1, at + 4)
    entries.writeUInt16LE(32, at + 6)
    entries.writeUInt32LE(image.png.length, at + 8)
    entries.writeUInt32LE(offset, at + 12)
    blobs.push(image.png)
    offset += image.png.length
  })
  return Buffer.concat([header, entries, ...blobs])
}

const images = sizes.map((size) => ({
  size,
  png: fs.readFileSync(path.join(work, `app-icon-${size}.png`)),
}))
const ico = pngToIco(images)
const png256 = path.join(work, 'app-icon-256.png')
fs.copyFileSync(png256, path.join(assets, 'app-icon.png'))
fs.copyFileSync(png256, path.join(publicDir, 'app-icon.png'))
fs.writeFileSync(path.join(assets, 'app-icon.ico'), ico)
fs.rmSync(work, { recursive: true, force: true })
console.log('Wrote assets/app-icon.ico, assets/app-icon.png, and public/app-icon.png')
