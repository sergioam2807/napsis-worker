const { createHash } = require("node:crypto")

const USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"

class GoogleAuthError extends Error {
  constructor(message) {
    super(message)
    this.name = "GoogleAuthError"
  }
}

/**
 * Resuelve de quién es un access token preguntándoselo a Google.
 *
 * La identidad del usuario NO puede llegar en una cabecera: quien tuviera la
 * API key del servicio podría hacerse pasar por cualquiera y leer o cancelar
 * sus procesos. El token sí es una credencial que solo tiene su dueño.
 *
 * Se cachea el resultado un rato para no preguntar a Google en cada petición
 * (una sesión hace varias: opciones, listado, estado del proceso, SSE).
 *
 * @param {{ttlMs?: number, maxEntries?: number, fetchImpl?: typeof fetch, now?: () => number}} opts
 * @returns {(token: string) => Promise<string>} correo en minúsculas
 */
function createIdentifier({ ttlMs = 5 * 60 * 1000, maxEntries = 500, fetchImpl = fetch, now = Date.now } = {}) {
  /** @type {Map<string, {email: string, expires: number}>} */
  const cache = new Map()

  return async function identify(token) {
    const key = createHash("sha256").update(token).digest("hex")
    const hit = cache.get(key)
    if (hit && hit.expires > now()) return hit.email

    let res
    try {
      res = await fetchImpl(USERINFO_URL, { headers: { Authorization: `Bearer ${token}` } })
    } catch {
      throw new GoogleAuthError("No se pudo verificar tu sesión de Google. Revisa la conexión e intenta de nuevo.")
    }
    if (res.status === 401 || res.status === 403) {
      throw new GoogleAuthError("Tu sesión de Google expiró. Vuelve a ingresar.")
    }
    if (!res.ok) throw new GoogleAuthError(`Google no pudo verificar tu sesión (${res.status}).`)

    const data = await res.json().catch(() => ({}))
    const email = String(data.email || "").trim().toLowerCase()
    if (!email || data.email_verified === false) {
      throw new GoogleAuthError("Tu cuenta de Google no tiene un correo verificado.")
    }

    if (cache.size >= maxEntries) {
      for (const [k, v] of cache) if (v.expires <= now()) cache.delete(k)
    }
    cache.set(key, { email, expires: now() + ttlMs })
    return email
  }
}

module.exports = { createIdentifier, GoogleAuthError, USERINFO_URL }
