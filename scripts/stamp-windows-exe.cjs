const fs = require('fs')

function parseAppVersion(version) {
  const parts = String(version).replace(/^v/i, '').split('.').map((part) => {
    const n = Number.parseInt(part, 10)
    return Number.isFinite(n) && n >= 0 ? n : 0
  })
  const major = parts[0] || 0
  const minor = parts[1] || 0
  const patch = parts[2] || 0
  const revision = parts[3] || 0
  return {
    major,
    minor,
    patch,
    revision,
    fileVersion: `${major}.${minor}.${patch}.${revision}`,
    productVersion: `${major}.${minor}.${patch}`,
  }
}

function packedVersion(ms, ls) {
  return `${(ms >>> 16) & 0xffff}.${ms & 0xffff}.${(ls >>> 16) & 0xffff}.${ls & 0xffff}`
}

async function loadResEdit() {
  const { load } = require('resedit/cjs')
  return load()
}

async function stampWindowsExe(exePath, options) {
  if (!fs.existsSync(exePath)) throw new Error(`Missing executable: ${exePath}`)
  const ResEdit = await loadResEdit()
  const parsed = parseAppVersion(options.version)
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true })
  if (options.windowsSubsystem != null) exe.newHeader.optionalHeader.subsystem = options.windowsSubsystem
  const res = ResEdit.NtExecutableResource.from(exe)

  if (options.icon && fs.existsSync(options.icon)) {
    const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(options.icon))
    const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries)
    const groupId = groups[0] ? groups[0].id : 1
    const lang = groups[0] ? groups[0].lang : 1033
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
      res.entries,
      groupId,
      lang,
      iconFile.icons.map((item) => item.data),
    )
  }

  let versionInfo = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0]
  if (!versionInfo) {
    versionInfo = ResEdit.Resource.VersionInfo.create({
      lang: 1033,
      fixedInfo: { fileOS: 0x40004, fileType: 1 },
      strings: [{ lang: 1033, codepage: 1200, values: {} }],
    })
  }

  const translations = versionInfo.getAllLanguagesForStringValues()
  const languages = translations.length ? translations : [{ lang: 1033, codepage: 1200 }]
  for (const { lang } of languages) {
    versionInfo.setFileVersion(parsed.major, parsed.minor, parsed.patch, parsed.revision, lang)
    versionInfo.setProductVersion(parsed.major, parsed.minor, parsed.patch, parsed.revision, lang)
  }
  const originalFilename = options.originalFilename || 'relay-chat-dock.exe'
  const strings = {
    FileDescription: options.fileDescription || 'Relay Chat Dock',
    ProductName: options.productName || 'Relay Chat Dock',
    CompanyName: options.company || 'Milzstream',
    LegalCopyright: options.copyright || 'SEE LICENSE IN LICENSE',
    OriginalFilename: originalFilename,
    InternalName: originalFilename,
    FileVersion: parsed.fileVersion,
    ProductVersion: parsed.productVersion,
  }
  for (const language of languages) versionInfo.setStringValues(language, strings)
  versionInfo.outputToResourceEntries(res.entries)
  res.outputResource(exe)
  const stamped = `${exePath}.stamped`
  fs.writeFileSync(stamped, Buffer.from(exe.generate()))
  fs.copyFileSync(stamped, exePath)
  fs.rmSync(stamped, { force: true })
  return parsed
}

async function readWindowsVersion(exePath) {
  const ResEdit = await loadResEdit()
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true })
  const res = ResEdit.NtExecutableResource.from(exe)
  const versionInfo = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0]
  if (!versionInfo) return null
  const language = versionInfo.getAllLanguagesForStringValues()[0] || { lang: 1033, codepage: 1200 }
  const strings = versionInfo.getStringValues(language)
  return {
    fileVersion: strings.FileVersion,
    productVersion: strings.ProductVersion,
    internalName: strings.InternalName,
    originalFilename: strings.OriginalFilename,
    productName: strings.ProductName,
    fileVersionRaw: packedVersion(versionInfo.fixedInfo.fileVersionMS, versionInfo.fixedInfo.fileVersionLS),
    productVersionRaw: packedVersion(versionInfo.fixedInfo.productVersionMS, versionInfo.fixedInfo.productVersionLS),
  }
}

async function stampAndVerifyWindowsExe(exePath, options) {
  const expected = parseAppVersion(options.version)
  await stampWindowsExe(exePath, options)
  const actual = await readWindowsVersion(exePath)
  const originalFilename = options.originalFilename || 'relay-chat-dock.exe'
  if (!actual || actual.fileVersionRaw !== expected.fileVersion || actual.internalName !== originalFilename) {
    throw new Error(`Executable version is ${actual?.fileVersionRaw || 'missing'} (${actual?.internalName || 'no name'}); expected ${expected.fileVersion} (${originalFilename})`)
  }
  return actual
}

module.exports = { parseAppVersion, stampWindowsExe, readWindowsVersion, stampAndVerifyWindowsExe }
