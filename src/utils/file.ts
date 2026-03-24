import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const GARBAGE_FILE_REGEX = /(?:Thumbs\.db|\.DS_Store)$/i

export const getFileMd5 = (filePath: string): Promise<string> => {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('md5')
    const stream = createReadStream(filePath)
    stream.on('error', (err) => reject(err))
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolvePromise(hash.digest('hex')))
  })
}

export const removeEmptyDirectories = async (rootDir: string): Promise<string[]> => {
  const deletedDirectories: string[] = []

  const visit = async (dirPath: string): Promise<boolean> => {
    const entries = await readdir(dirPath, { withFileTypes: true })
    let hasNonEmptyContent = false

    for (const entry of entries) {
      const entryPath = resolve(dirPath, entry.name)

      if (entry.isDirectory()) {
        const removed = await visit(entryPath)
        if (!removed) hasNonEmptyContent = true
        continue
      }

      if (!GARBAGE_FILE_REGEX.test(entry.name)) {
        hasNonEmptyContent = true
      }
    }

    if (hasNonEmptyContent) return false

    await rm(dirPath, { recursive: true, force: true })
    deletedDirectories.push(dirPath)
    return true
  }

  await visit(resolve(rootDir))
  return deletedDirectories
}
