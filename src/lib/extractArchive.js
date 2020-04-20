import FileType from 'file-type'
import extractZip from 'extract-zip'
import tar from 'tar'

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
export async function extractArchive (pathToArchive, targetDirectory) {
  const fileTypeDetails = await FileType.fromFile(pathToArchive)

  switch (fileTypeDetails.mime) {
    case 'application/gzip':
      return tar.extract({
        cwd: targetDirectory,
        strict: true,
        file: pathToArchive
      })
    case 'application/zip':
      return extractZip(pathToArchive, { dir: targetDirectory })
    default:
      throw new Error('Archive format not recognised')
  }
}
