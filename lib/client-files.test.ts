// @vitest-environment node
//
// CLIENT FILES — the rules on their own (lib/client-files.ts). The routes and
// the screen both read these, so this is where "what counts as a photo",
// "what a safe name is" and "who may remove what" are pinned once.
import { describe, it, expect } from 'vitest'
import {
  ALLOWED_TYPES, MAX_FILE_BYTES, canRemoveClientFile, canSeeClientFiles, clientFilePath, clientThumbPath,
  displayName, fileSizeWords, isMissingFilesTable, isUuid, roleMayChangeFiles, sniffFileType, storageSafeName,
} from '@/lib/client-files'

const bytes = (...n: number[]) => new Uint8Array([...n, ...new Array(16).fill(0)])
const text = (s: string) => new TextEncoder().encode(s + ' '.repeat(16))

describe('what a file is, from its own first bytes', () => {
  it('knows the five kinds it accepts', () => {
    expect(sniffFileType(bytes(0xff, 0xd8, 0xff, 0xe1))).toBe('image/jpeg')
    expect(sniffFileType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('image/png')
    expect(sniffFileType(text('RIFF\u0010\u0000\u0000\u0000WEBPVP8 '))).toBe('image/webp')
    expect(sniffFileType(text('%PDF-1.4'))).toBe('application/pdf')
    expect(sniffFileType(text('\u0000\u0000\u0000\u0018ftypheic'))).toBe('image/heic')
    expect(sniffFileType(text('\u0000\u0000\u0000\u0018ftypmif1'))).toBe('image/heic')
    expect([...ALLOWED_TYPES].sort()).toEqual(['application/pdf', 'image/heic', 'image/jpeg', 'image/png', 'image/webp'])
  })

  it('refuses everything else: a web page, an SVG, a video, a zip, a GIF, a Word file, nothing at all', () => {
    for (const s of ['<!doctype html><html>', '<svg xmlns="http://www.w3.org/2000/svg">', '\u0000\u0000\u0000\u0018ftypmp42', '\u0000\u0000\u0000\u0018ftypqt  ', 'PK\u0003\u0004', 'GIF89a', 'MZ']) {
      expect(sniffFileType(text(s)), s).toBeNull()
    }
    expect(sniffFileType(new Uint8Array(0))).toBeNull()
    expect(sniffFileType(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull() // too short to be anything
    expect(sniffFileType(null)).toBeNull()
  })
})

describe('names and paths', () => {
  it('the path name: last segment only, safe characters only, no leading dots', () => {
    expect(storageSafeName('../../etc/passwd')).toBe('passwd')
    expect(storageSafeName('..\\..\\windows\\system.ini')).toBe('system.ini')
    expect(storageSafeName('Garage – before (1).JPG')).toBe('Garage_before_1_.JPG')
    expect(storageSafeName('.htaccess')).toBe('htaccess')
    expect(storageSafeName('')).toBe('file')
    expect(storageSafeName('a'.repeat(300) + '.jpg').length).toBe(120)
  })

  it('the shown name keeps what the owner typed, minus folders and control characters', () => {
    expect(displayName('Garage – before (1).JPG')).toBe('Garage – before (1).JPG')
    expect(displayName('/Users/suzanne/Desktop/Pantry após.jpg')).toBe('Pantry após.jpg')
    expect(displayName('line\nbreak\u0000.pdf')).toBe('line break .pdf')
    expect(displayName('')).toBe('file')
    expect(displayName('x'.repeat(500)).length).toBe(200)
  })

  it('a file is filed under its CLIENT: <lead id>/<uuid>-<name>, always two parts', () => {
    expect(clientFilePath('LEAD', 'UUID', '../x/y/photo 1.jpg')).toBe('LEAD/UUID-photo_1.jpg')
    expect(clientThumbPath('LEAD', 'UUID')).toBe('LEAD/UUID-preview.jpg')
  })

  it('a file id is a uuid and nothing else', () => {
    expect(isUuid('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toBe(true)
    for (const v of ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/x.jpg', '../x', '', null, 12]) expect(isUuid(v)).toBe(false)
  })
})

describe('who may do what', () => {
  const at = (role: string, location_id: string | null, id = 'me') => ({ id, role, location_id })
  const lead = { location_uuid: 'SEA' }

  it('seeing: your own location’s clients; corporate, any', () => {
    expect(canSeeClientFiles(at('owner', 'SEA'), lead)).toBe(true)
    expect(canSeeClientFiles(at('manager', 'SEA'), lead)).toBe(true)
    expect(canSeeClientFiles(at('lite_user', 'SEA'), lead)).toBe(true)
    expect(canSeeClientFiles(at('owner', 'KC'), lead)).toBe(false)
    expect(canSeeClientFiles(at('owner', null), { location_uuid: null })).toBe(false)
    expect(canSeeClientFiles(at('admin', null), lead)).toBe(true)
    expect(canSeeClientFiles(at('super_admin', null), lead)).toBe(true)
  })

  it('adding: everyone but the read-only role (and anything unknown)', () => {
    expect(['super_admin', 'admin', 'owner', 'manager'].every(roleMayChangeFiles)).toBe(true)
    expect(['lite_user', '', 'guest', null, undefined].some(r => roleMayChangeFiles(r as any))).toBe(false)
  })

  it('removing: corporate and the owner, any file; a manager, only their own; read-only, none', () => {
    const theirs = { uploaded_by: 'someone-else' }
    const mine = { uploaded_by: 'me' }
    expect(canRemoveClientFile(at('owner', 'SEA'), theirs)).toBe(true)
    expect(canRemoveClientFile(at('admin', null), theirs)).toBe(true)
    expect(canRemoveClientFile(at('manager', 'SEA'), theirs)).toBe(false)
    expect(canRemoveClientFile(at('manager', 'SEA'), mine)).toBe(true)
    expect(canRemoveClientFile(at('manager', 'SEA'), { uploaded_by: null })).toBe(false)
    expect(canRemoveClientFile(at('lite_user', 'SEA'), mine)).toBe(false)
  })
})

describe('small things', () => {
  it('the cap is 4 MB — under what Vercel will pass through', () => {
    expect(MAX_FILE_BYTES).toBe(4 * 1024 * 1024)
    expect(MAX_FILE_BYTES).toBeLessThan(4.5 * 1024 * 1024)
  })

  it('sizes read like sizes', () => {
    expect(fileSizeWords(512)).toBe('512 bytes')
    expect(fileSizeWords(340 * 1024)).toBe('340 KB')
    expect(fileSizeWords(1.25 * 1024 * 1024)).toBe('1.3 MB')
    expect(fileSizeWords(4 * 1024 * 1024)).toBe('4 MB')
  })

  it('"the table is not there yet" is recognised narrowly', () => {
    expect(isMissingFilesTable({ code: '42P01', message: 'relation "public.client_files" does not exist' })).toBe(true)
    expect(isMissingFilesTable({ code: 'PGRST205', message: "Could not find the table 'public.client_files' in the schema cache" })).toBe(true)
    expect(isMissingFilesTable({ code: '57014', message: 'canceling statement due to statement timeout' })).toBe(false)
    expect(isMissingFilesTable({ message: 'relation "public.leads" does not exist' })).toBe(false)
    expect(isMissingFilesTable(null)).toBe(false)
  })
})
