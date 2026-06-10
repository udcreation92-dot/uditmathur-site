const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID
const API_KEY   = import.meta.env.VITE_GOOGLE_API_KEY
const SCOPE     = 'https://www.googleapis.com/auth/drive.file'
const FOLDER_NAME = 'Accounts Vouchers'

let accessToken = null
let tokenExpiry  = 0

function getStoredToken() {
  try {
    const t = JSON.parse(localStorage.getItem('drive_token') || 'null')
    if (t && Date.now() < t.expiry) return t
  } catch {}
  return null
}

function storeToken(token, expiresIn) {
  const t = { token, expiry: Date.now() + expiresIn * 1000 - 60000 }
  localStorage.setItem('drive_token', JSON.stringify(t))
  accessToken = token
  tokenExpiry  = t.expiry
}

export function clearDriveToken() {
  localStorage.removeItem('drive_token')
  accessToken = null
  tokenExpiry  = 0
}

export function isDriveConnected() {
  const t = getStoredToken()
  return !!t
}

export function requestDriveAccess() {
  return new Promise((resolve, reject) => {
    if (!window.google) return reject(new Error('Google Identity Services not loaded'))
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: (resp) => {
        if (resp.error) return reject(new Error(resp.error))
        storeToken(resp.access_token, resp.expires_in)
        resolve(resp.access_token)
      },
    })
    client.requestAccessToken()
  })
}

async function ensureToken() {
  const stored = getStoredToken()
  if (stored) { accessToken = stored.token; return stored.token }
  return requestDriveAccess()
}

async function ensureFolder() {
  const token = await ensureToken()
  const search = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false&fields=files(id)`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  const { files } = await search.json()
  if (files && files.length > 0) return files[0].id

  const create = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
  })
  const folder = await create.json()
  return folder.id
}

export async function uploadToDrive(file) {
  const token    = await ensureToken()
  const folderId = await ensureFolder()

  const meta = JSON.stringify({ name: file.name, parents: [folderId] })
  const form = new FormData()
  form.append('metadata', new Blob([meta], { type: 'application/json' }))
  form.append('file', file)

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,mimeType',
    { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form }
  )
  if (!res.ok) throw new Error('Drive upload failed')
  return res.json()
}

export async function deleteDriveFile(fileId) {
  const token = await ensureToken()
  await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
}
