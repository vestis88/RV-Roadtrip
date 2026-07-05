import { initializeApp } from 'firebase-admin/app'
import { onRequest } from 'firebase-functions/https'

initializeApp()

export const ping = onRequest((_req, res) => {
  res.json({ ok: true })
})
