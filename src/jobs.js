const { randomUUID } = require("node:crypto")
const { nombreCompleto, studentVars, interpolate, reportFilename } = require("./template")
const { buildRawMessage, GmailError } = require("./gmail")

/**
 * Estados por alumno: pending → downloading → drafting → success | failed | skipped
 * Estados del job: running → done | cancelled | failed
 */

class JobStore {
  constructor({ retentionMs = 30 * 60 * 1000 } = {}) {
    this._retention = retentionMs
    /** @type {Map<string, any>} */
    this._jobs = new Map()
  }

  create({ owner, sessionId, students }) {
    const id = randomUUID()
    const job = {
      id,
      owner,
      sessionId,
      status: "running",
      message: "Preparando…",
      createdAt: Date.now(),
      finishedAt: null,
      cancelRequested: false,
      students: students.map((s) => ({ key: s.key, nombre: nombreCompleto(s), status: "pending", message: "" })),
      listeners: new Set(),
    }
    this._jobs.set(id, job)
    return job
  }

  get(id, owner) {
    const job = this._jobs.get(id)
    if (!job || job.owner !== owner) return null
    return job
  }

  get runningCount() {
    let n = 0
    for (const j of this._jobs.values()) if (j.status === "running") n++
    return n
  }

  /** Vista pública (sin listeners ni owner). */
  snapshot(job) {
    const { listeners: _l, owner: _o, cancelRequested: _c, ...rest } = job
    return { ...rest, students: job.students.map((s) => ({ ...s })) }
  }

  subscribe(job, listener) {
    job.listeners.add(listener)
    listener({ type: "snapshot", job: this.snapshot(job) })
    return () => job.listeners.delete(listener)
  }

  _emit(job, event) {
    for (const l of job.listeners) {
      try {
        l(event)
      } catch {
        /* un cliente caído no detiene el job */
      }
    }
  }

  setStudent(job, key, status, message = "") {
    const s = job.students.find((x) => x.key === key)
    if (!s) return
    s.status = status
    s.message = message
    this._emit(job, { type: "student", key, status, message })
  }

  setJob(job, status, message) {
    job.status = status
    job.message = message
    if (status !== "running") {
      job.finishedAt = Date.now()
      setTimeout(() => this._jobs.delete(job.id), this._retention).unref?.()
    }
    this._emit(job, { type: "job", status, message })
  }

  cancel(job) {
    if (job.status !== "running") return false
    job.cancelRequested = true
    job.message = "Cancelando después del alumno actual…"
    this._emit(job, { type: "job", status: "running", message: job.message })
    return true
  }
}

/**
 * Ejecuta un job: por cada alumno imprime el PDF en Napsis y crea el borrador.
 * @param {{store: JobStore, job: any, client: {printReport(config: object, value: string): Promise<Buffer>},
 *          createDraft: (raw: string) => Promise<string>,
 *          students: any[], asunto: string, cuerpo: string, napsisConfig: object}} deps
 */
async function runJob({ store, job, client, createDraft, students, asunto, cuerpo, napsisConfig }) {
  const skipRest = (from, message) => {
    for (const s of students.slice(from)) store.setStudent(job, s.key, "skipped", message)
  }

  let ok = 0
  let failed = 0

  for (let i = 0; i < students.length; i++) {
    const student = students[i]

    if (job.cancelRequested) {
      skipRest(i, "Cancelado antes de procesar")
      store.setJob(job, "cancelled", `Cancelado. ${ok} borradores creados.`)
      return
    }

    store.setJob(job, "running", `Procesando ${i + 1} de ${students.length}`)

    let pdf
    try {
      store.setStudent(job, student.key, "downloading", "Descargando informe desde Napsis")
      pdf = await client.printReport(napsisConfig, student.napsisValue)
    } catch (err) {
      failed++
      store.setStudent(job, student.key, "failed", err.message)
      if (err.kind === "login") {
        skipRest(i + 1, "No se procesó: se perdió la sesión de Napsis")
        store.setJob(job, "failed", err.message)
        return
      }
      continue
    }

    try {
      store.setStudent(job, student.key, "drafting", "Creando borrador en Gmail")
      const vars = studentVars(student)
      const raw = buildRawMessage({
        to: vars.correoApoderado,
        cc: vars.emailAlumno || undefined,
        subject: interpolate(asunto, vars),
        body: interpolate(cuerpo, vars),
        attachment: { filename: reportFilename(student), content: pdf },
      })
      await createDraft(raw)
      ok++
      store.setStudent(job, student.key, "success", `Borrador para ${vars.correoApoderado}`)
    } catch (err) {
      failed++
      store.setStudent(job, student.key, "failed", err.message)
      if (err instanceof GmailError && err.kind === "auth") {
        skipRest(i + 1, "No se procesó: Google rechazó el permiso")
        store.setJob(job, "failed", err.message)
        return
      }
    }
  }

  const resumen = failed ? `${ok} borradores creados, ${failed} con problemas.` : `${ok} borradores creados.`
  store.setJob(job, "done", resumen)
}

module.exports = { JobStore, runJob }
