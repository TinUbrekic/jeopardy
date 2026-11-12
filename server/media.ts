import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'

export type StoredMedia = { type: 'image' | 'video'; url: string }

const mediaDirectory = join(process.cwd(), 'data', 'media')
mkdirSync(mediaDirectory, { recursive: true })

const mimeExtensions: Record<string, string> = {
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/ogg': '.ogv',
}

export function isStoredMediaUrl(url: string) {
  return /^\/media\/[a-f0-9-]+\.[a-z0-9]+$/i.test(url)
}

export function storeDataUrl(type: StoredMedia['type'], dataUrl: string, maxBytes: number): StoredMedia {
  const match = dataUrl.match(/^data:([^;,]+);base64,([a-z0-9+/=\r\n]+)$/i)
  if (!match) throw new Error('Media must be a valid base64 data URL.')
  const mimeType = match[1].toLowerCase()
  const expectedPrefix = `${type}/`
  if (!mimeType.startsWith(expectedPrefix) || !mimeExtensions[mimeType]) {
    throw new Error('Media MIME type does not match the selected media type.')
  }
  const content = Buffer.from(match[2], 'base64')
  if (!content.length || content.length > maxBytes) throw new Error('Media files must be 8 MB or smaller.')
  const filename = `${randomUUID()}${mimeExtensions[mimeType]}`
  writeFileSync(join(mediaDirectory, filename), content, { flag: 'wx' })
  return { type, url: `/media/${filename}` }
}

export function removeStoredMedia(url: string) {
  if (!isStoredMediaUrl(url)) return
  const filename = url.slice('/media/'.length)
  const path = join(mediaDirectory, filename)
  if (existsSync(path)) unlinkSync(path)
}

export function readStoredMedia(filename: string) {
  if (!/^[a-f0-9-]+\.[a-z0-9]+$/i.test(filename)) return undefined
  const path = join(mediaDirectory, filename)
  if (!existsSync(path)) return undefined
  return readFileSync(path)
}

export function mediaContentType(filename: string) {
  const extension = extname(filename).toLowerCase()
  const contentTypes: Record<string, string> = {
    '.gif': 'image/gif',
    '.jpg': 'image/jpeg',
    '.ogv': 'video/ogg',
    '.mp4': 'video/mp4',
    '.png': 'image/png',
    '.webm': 'video/webm',
    '.webp': 'image/webp',
  }
  return contentTypes[extension]
}

export function removeOrphanedMedia(referencedUrls: Set<string>) {
  for (const filename of readdirSync(mediaDirectory)) {
    const url = `/media/${filename}`
    if (!referencedUrls.has(url)) removeStoredMedia(url)
  }
}
