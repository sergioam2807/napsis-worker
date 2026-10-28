const express = require("express")
const { timingSafeEqual } = require("node:crypto")
const { SessionError } = require("./sessions")
const { runJob } = require("./jobs")
const { createDraft } = require("./gmail")
const { createIdentifier } = require("./google-identity")

const MAX_STUDENTS = 200

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ""))
  const bb = Buffer.from(String(b || ""))
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0
}

/**
 * @param {{apiKey: string, sessions: import("./sessions").SessionStore,
 *          jobs: import("./jobs").JobStore, defaultColegio: string,
 *          maxConcurrentJobs?: number, draftFn?: typeof createDraft, heartbeatMs?: number,
 *          identify?: (token: string) => Promise<string>}} deps
 */
function createApp({
  apiKey,
  sessions,
  jobs,
  defaultColegio,
  maxConcurrentJobs = 2,
  draftFn = createDraft,
  heartbeatMs = 20000,
  identify = createIdentifier(),
}) {
  if (!apiKey) throw new Error("API_KEY es obligatoria")

  const app = express()
  app.disable("x-powered-by")
  app.use(express.json({ limit: "2mb" }))

  app.get("/health", (_req, res) => res.json({ ok: true }))

  // Dos cosas distintas: la API key prueba que la llamada viene de nuestro front,
  // y el token de Google prueba QUIÉN es el usuario. La identidad no puede venir
  // en una cabecera suelta: con la API key filtrada, cualquiera se haría pasar por
  // otro y vería o cancelaría sus procesos.
  app.use("/api", async (req, res, next) => {
    if (!safeEqual(req.headers["x-api-key"], apiKey)) return res.status(401).json({ error: "API key inválida" })
    const token = String(req.headers["x-google-token"] || "").trim()
    if (!token) return res.status(400).json({ error: "Falta la identidad del usuario" })
    try {
      req.owner = await identify(token)
      req.googleToken = token
      next()
    } catch (err) {
      next(err)
    }
  })

  // ── Sesiones de Napsis ─────────────────────────────────────────────

  app.post("/api/sessions", async (req, res) => {
    const { napsisRut, napsisPassword, colegio } = req.body || {}
    if (!isNonEmptyString(napsisRut) || !isNonEmptyString(napsisPassword)) {
      return res.status(400).json({ error: "Credenciales requeridas" })
    }
    const slug = isNonEmptyString(colegio) ? colegio.trim() : defaultColegio
    if (!/^[a-z0-9_-]{2,60}$/i.test(slug)) return res.status(400).json({ error: "Código de colegio inválido" })

    const { id, client } = await sessions.create(req.owner, { rut: napsisRut, password: napsisPassword, colegio: slug })
    try {
      const options = await client.options({})
      res.json({ sessionId: id, colegio: slug, options })
    } catch (err) {
      await sessions.destroy(id, req.owner)
      throw err
    }
  })

  const sessionRoute = (handler) => async (req, res) => {
    const s = sessions.get(req.params.id, req.owner)
    if (s.busyJob) return res.status(409).json({ error: "Hay un proceso en curso con esta sesión." })
    await handler(req, res, s)
  }

  app.post("/api/sessions/:id/options", sessionRoute(async (req, res, s) => {
    const { tipoEns, grado } = req.body || {}
    res.json(await s.client.options({ tipoEns, grado }))
  }))

  app.post("/api/sessions/:id/roster", sessionRoute(async (req, res, s) => {
    const { tipoEns, grado, curso } = req.body || {}
    if (![tipoEns, grado, curso].every(isNonEmptyString)) return res.status(400).json({ error: "Falta el curso" })
    res.json({ students: await s.client.roster({ tipoEns, grado, curso }) })
  }))

  app.delete("/api/sessions/:id", async (req, res) => {
    await sessions.destroy(req.params.id, req.owner)
    res.status(204).end()
  })

  // ── Jobs ───────────────────────────────────────────────────────────

  app.post("/api/jobs", async (req, res) => {
    const { sessionId, students, asunto, cuerpo, napsisConfig } = req.body || {}
    const cfgOk = napsisConfig && ["tipoEns", "grado", "curso", "periodo", "religion"].every((k) => isNonEmptyString(napsisConfig[k]))
    if (!Array.isArray(students) || !students.length || !isNonEmptyString(asunto) || !isNonEmptyString(cuerpo) || !cfgOk) {
      return res.status(400).json({ error: "Datos incompletos" })
    }
    if (students.length > MAX_STUDENTS) return res.status(400).json({ error: `Máximo ${MAX_STUDENTS} alumnos por proceso` })
    if (!students.every((s) => s && isNonEmptyString(s.key) && isNonEmptyString(s.napsisValue) && isNonEmptyString(s.correoApoderado))) {
      return res.status(400).json({ error: "Hay alumnos sin coincidencia en Napsis o sin correo del apoderado" })
    }

    const s = sessions.get(sessionId, req.owner)
    if (s.busyJob) return res.status(409).json({ error: "Ya hay un proceso en curso con esta sesión." })
    if (jobs.runningCount >= maxConcurrentJobs) {
      return res.status(429).json({ error: "El servicio está procesando otros cursos. Intenta en unos minutos." })
    }

    const job = jobs.create({ owner: req.owner, sessionId, students })
    sessions.markBusy(sessionId, job.id)
    res.status(202).json({ jobId: job.id })

    runJob({
      store: jobs,
      job,
      client: s.client,
      createDraft: (raw) => draftFn(req.googleToken, raw),
      students,
      asunto,
      cuerpo,
      napsisConfig,
    })
      .catch((err) => jobs.setJob(job, "failed", err.message || "Error inesperado"))
      .finally(() => sessions.release(sessionId))
  })

  app.get("/api/jobs/:id", (req, res) => {
    const job = jobs.get(req.params.id, req.owner)
    if (!job) return res.status(404).json({ error: "Proceso no encontrado o expirado" })
    res.json(jobs.snapshot(job))
  })

  app.post("/api/jobs/:id/cancel", (req, res) => {
    const job = jobs.get(req.params.id, req.owner)
    if (!job) return res.status(404).json({ error: "Proceso no encontrado o expirado" })
    jobs.cancel(job)
    res.status(202).json({ ok: true })
  })

  // SSE: primero un snapshot completo, luego cambios. Sirve para reconectar.
  app.get("/api/jobs/:id/events", (req, res) => {
    const job = jobs.get(req.params.id, req.owner)
    if (!job) return res.status(404).json({ error: "Proceso no encontrado o expirado" })

    res.setHeader("Content-Type", "text/event-stream")
    res.setHeader("Cache-Control", "no-cache, no-transform")
    res.setHeader("Connection", "keep-alive")
    res.setHeader("X-Accel-Buffering", "no")
    res.flushHeaders()

    const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`)
    const unsubscribe = jobs.subscribe(job, (event) => {
      send(event)
      if (event.type === "job" && event.status !== "running") setImmediate(() => res.end())
    })
    if (job.status !== "running") res.end()

    const ping = setInterval(() => res.write(": ping\n\n"), heartbeatMs)
    req.on("close", () => {
      clearInterval(ping)
      unsubscribe()
    })
  })

  // Errores → JSON con mensaje legible
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof SessionError) return res.status(err.status).json({ error: err.message })
    if (err && err.name === "GoogleAuthError") return res.status(401).json({ error: err.message, code: "google_auth" })
    if (err && err.name === "NapsisError") {
      return res.status(err.kind === "login" ? 401 : 502).json({ error: err.message, kind: err.kind })
    }
    if (err && err.type === "entity.parse.failed") return res.status(400).json({ error: "JSON inválido" })
    console.error(err)
    res.status(500).json({ error: "Error interno del worker" })
  })

  return app
}

module.exports = { createApp }
