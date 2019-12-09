const yauzl = require('yauzl')
const tar = require('tar')
const fileType = require('file-type')
const path = require('path')
const fs = require('fs')

exports.extractFileFromArchive = extractFileFromArchive

/**
 * Extracts a file from to given archive to the given destination.
 * @param {string} pathToArchive The path to the archive from which to extract
 * the file.
 * @param {string} sourceFilePath The path of the file _within the archive_
 * that needs to be extracted.
 * @param {string} destinationFilePath To where the file must be extracted to.
 * Note that the directory must exist.
 * @returns {Promise<void>} Resolves once the file has been extracted.
 */
async function extractFileFromArchive (pathToArchive, sourceFilePath,
  destinationFilePath) {
  const fileHandle = await fs.promises.open(pathToArchive, 'r')

  const { buffer } = await fileHandle.read(
    Buffer.alloc(fileType.minimumBytes),
    0,
    fileType.minimumBytes,
    0)

  await fileHandle.close()

  switch (fileType(buffer).mime) {
    case 'application/gzip':
      return extractFileFromTar(pathToArchive, sourceFilePath,
        destinationFilePath)
    case 'application/zip':
      return extractFileFromZip(pathToArchive, sourceFilePath,
        destinationFilePath)
    default:
      throw new Error('Archive format not recognised')
  }
}

/**
 * Extracts a file from to given ZIP archive to the given destination.
 * @param {string} pathToZip The path to the ZIP file from which to extract
 * the file.
 * @param {string} sourceFilePath The path of the file _within the ZIP archive_
 * that needs to be extracted.
 * @param {string} destinationFilePath To where the file must be extracted to.
 * Note that the directory must exist.
 * @returns {Promise<void>} Resolves once the file has been extracted.
 */
async function extractFileFromZip (pathToZip, sourceFilePath,
  destinationFilePath) {
  // Open the zip file
  const zipFile = await new Promise((resolve, reject) => {
    yauzl.open(pathToZip,
      { lazyEntries: true },
      (err, zipFile) => {
        if (err) reject(err)
        else resolve(zipFile)
      })
  })

  // Find the entry for the Steam CMD executable
  const executableEntry = await new Promise((resolve, reject) => {
    zipFile.on('end', () => {
      reject(new Error('Steam CMD executable not found in archive'))
    })
    zipFile.on('error', reject)
    zipFile.on('entry', entry => {
      if (entry.fileName === sourceFilePath) {
        resolve(entry)
      } else {
        zipFile.readEntry()
      }
    })

    zipFile.readEntry()
  })

  // Extract the executable to its destination path
  await new Promise((resolve, reject) => {
    zipFile.openReadStream(executableEntry, (err, readStream) => {
      if (err) throw err

      const exeFileWriteStream = fs.createWriteStream(destinationFilePath)

      readStream.pipe(exeFileWriteStream)
      exeFileWriteStream.on('finish', resolve)
      exeFileWriteStream.on('error', reject)
    })
  })

  // Finally close the zip
  zipFile.close()
}

/**
 * Extracts a file from to given TAR archive to the given destination.
 * @param {string} pathToTar The path to the TAR file from which to extract
 * the file.
 * @param {string} sourceFilePath The path of the file _within the TAR archive_
 * that needs to be extracted.
 * @param {string} destinationFilePath To where the file must be extracted to.
 * Note that the directory must exist.
 * @returns {Promise<void>} Resolves once the file has been extracted.
 */
async function extractFileFromTar (pathToTar, sourceFilePath,
  destinationFilePath) {
  // Extract the tar file. By using the filter we only extract the Steam CMD
  // executable.

  const destinationDirectoryPath = path.dirname(destinationFilePath)

  // FIXME use the low level `tar.Parse`. Renaming files is too hackish.
  await tar.extract({
    cwd: destinationDirectoryPath,
    strict: true,
    file: pathToTar
  }, [sourceFilePath])

  // The function above will extract the file as is to the destination
  // directory. The directory structure and name is preserved. We now need to
  // rename it to the actual destination file path.
  await fs.promises.rename(
    path.join(destinationDirectoryPath, sourceFilePath),
    destinationFilePath)
}
