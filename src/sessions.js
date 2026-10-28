const { randomUUID } = require("node:crypto")

class SessionError extends Error {
  /** @param {string} message @param {number} status */
  constructor(message, status) {
    super(message)
    this.name = "SessionError"
    this.status = status
  }
}

/**
 * Sesiones de Napsis abiertas, una por usuario y flujo.
 * Expiran tras `idleMs` sin uso (salvo que tengan un job corriendo).
 */
class SessionStore {
  /**
   * @param {{openClient: (creds: object) => Promise<{close(): Promise<void>}>,
   *          idleMs?: number, maxSessions?: number, now?: () => number}} opts
   */
  constructor({ openClient, idleMs = 15 * 60 * 1000, maxSessions = 6, now = Date.now }) {
    this._open = openClient
    this._idleMs = idleMs
    this._max = maxSessions
    this._now = now
    /** @type {Map<string, {id: string, owner: string, client: any, lastUsed: number, busyJob: string|null}>} */
    this._sessions = new Map()
  }

  /** Abre una sesión nueva. Cierra antes las sesiones previas del mismo usuario. */
  async create(owner, creds) {
    for (const s of this._sessions.values()) {
      if (s.owner === owner && !s.busyJob) await this.destroy(s.id, owner)
    }
    this.sweep()
    if (this._sessions.size >= this._max) {
      throw new SessionError("El servicio está ocupado con otras sesiones. Intenta en unos minutos.", 429)
    }
    const client = await this._open(creds)
    const id = randomUUID()
    this._sessions.set(id, { id, owner, client, lastUsed: this._now(), busyJob: null })
    return { id, client }
  }

  /** Devuelve la sesión si existe, es del usuario y no expiró. */
  get(id, owner) {
    const s = this._sessions.get(id)
    if (!s || s.owner !== owner) {
      throw new SessionError("La sesión de Napsis expiró. Vuelve a ingresar tu contraseña.", 410)
    }
    s.lastUsed = this._now()
    return s
  }

  markBusy(id, jobId) {
    const s = this._sessions.get(id)
    if (s) s.busyJob = jobId
  }

  release(id) {
    const s = this._sessions.get(id)
    if (s) {
      s.busyJob = null
      s.lastUsed = this._now()
    }
  }

  async destroy(id, owner) {
    const s = this._sessions.get(id)
    if (!s || (owner && s.owner !== owner)) return
    this._sessions.delete(id)
    await s.client.close().catch(() => {})
  }

  /** Cierra sesiones inactivas. */
  sweep() {
    const limit = this._now() - this._idleMs
    for (const s of this._sessions.values()) {
      if (!s.busyJob && s.lastUsed < limit) void this.destroy(s.id)
    }
  }

  get size() {
    return this._sessions.size
  }

  async closeAll() {
    await Promise.all([...this._sessions.keys()].map((id) => this.destroy(id)))
  }
}

module.exports = { SessionStore, SessionError }
