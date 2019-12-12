const fs = require('fs')
const fileType = require('file-type')
const extractZip = require('extract-zip')
const tar = require('tar')

exports.extractArchive = extractArchive

/**
 * Extracts the contents of the given archive to the destination folder.
 * The archive must be in a ZIP or TAR format.
 * @param {string} pathToArchive The path to the archive that needs to be
 * extracted
 * @param {string} targetDirectory The directory to which the contents of the
 * archive will be extracted to.
 * @returns {Promise<void>} Resolves once the archive has been extracted.
 * @throws Error when the archive format is not recognised.
 */
async function extractArchive (pathToArchive, targetDirectory) {
  const fileHandle = await fs.promises.open(pathToArchive, 'r')

  const { buffer } = await fileHandle.read(
    Buffer.alloc(fileType.minimumBytes),
    0,
    fileType.minimumBytes,
    0)

  await fileHandle.close()

  switch (fileType(buffer).mime) {
    case 'application/gzip':
      return tar.extract({
        cwd: targetDirectory,
        strict: true,
        file: pathToArchive
      })
    case 'application/zip':
      return new Promise((resolve, reject) => {
        extractZip(pathToArchive, { dir: targetDirectory }, err => {
          if (err) reject(err)
          else resolve()
        })
      })
    default:
      throw new Error('Archive format not recognised')
  }
}
