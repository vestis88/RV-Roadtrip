import { initializeApp } from 'firebase-admin/app'
import { onRequest } from 'firebase-functions/https'
import { tripSchema } from '@rv/shared'

initializeApp()

export const ping = onRequest((_req, res) => {
  res.json({ ok: true, schemaKeys: Object.keys(tripSchema.shape) })
})
