const fs = require('node:fs')
const path = require('node:path')

function readUInt32LE(buf, offset) {
  if (offset < 0 || offset + 4 > buf.length) return 0
  return buf.readUInt32LE(offset)
}

function readUInt16LE(buf, offset) {
  if (offset < 0 || offset + 2 > buf.length) return 0
  return buf.readUInt16LE(offset)
}

function certificateTable(filePath) {
  const buf = fs.readFileSync(filePath)
  if (buf.length < 0x100 || buf.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error(`${filePath}: not a PE executable`)
  }
  const peOffset = readUInt32LE(buf, 0x3c)
  if (buf.toString('ascii', peOffset, peOffset + 4) !== 'PE\u0000\u0000') {
    throw new Error(`${filePath}: PE header missing`)
  }
  const optionalHeaderOffset = peOffset + 24
  const magic = readUInt16LE(buf, optionalHeaderOffset)
  const dataDirectoryOffset = optionalHeaderOffset + (magic === 0x20b ? 112 : 96)
  const certDirectoryOffset = dataDirectoryOffset + 4 * 8
  const certificateFileOffset = readUInt32LE(buf, certDirectoryOffset)
  const certificateSize = readUInt32LE(buf, certDirectoryOffset + 4)
  const valid =
    certificateFileOffset > 0 &&
    certificateSize > 8 &&
    certificateFileOffset + certificateSize <= buf.length
  return { certificateFileOffset, certificateSize, valid }
}

function expandTargets(args) {
  if (args.length > 0) return args
  const releaseDir = path.resolve('release')
  if (!fs.existsSync(releaseDir)) return []
  return fs
    .readdirSync(releaseDir)
    .filter((name) => /^Vryx-Worker-Setup-.+\.exe$/i.test(name))
    .map((name) => path.join(releaseDir, name))
}

const targets = expandTargets(process.argv.slice(2))
if (targets.length === 0) {
  console.error('[verify-win-signature] Aucun installeur Windows trouve.')
  process.exit(1)
}

let ok = true
for (const target of targets) {
  const table = certificateTable(target)
  if (!table.valid) {
    ok = false
    console.error(`[verify-win-signature] NON SIGNE: ${target}`)
  } else {
    console.log(`[verify-win-signature] Signature presente: ${target} (${table.certificateSize} bytes)`)
  }
}

if (!ok) process.exit(1)
