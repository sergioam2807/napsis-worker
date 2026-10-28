const { test } = require("node:test")
const assert = require("node:assert/strict")
const { JobStore, runJob } = require("../src/jobs")
const { SessionStore } = require("../src/sessions")
const { createApp } = require("../src/app")
const { GmailError } = require("../src/gmail")

const mk = (n) => ({
  key: `${n}-k`,
  napsisValue: `${n}-229-1`,
  primerNombre: `Alumno${n}`,
  apellidoPaterno: "Soto",
  rut: `${n}-k`,
  emailAlumno: `a${n}@colegio.cl`,
  nombreApoderado: `Apoderado ${n}`,
  correoApoderado: `p${n}@gmail.com`,
})

const baseArgs = { asunto: "Informe {nombreAlumno}", cuerpo: "Hola {nombreApoderado}", napsisConfig: { periodo: "1" } }

test("runJob crea un borrador por alumno y marca fallos sin detenerse", async () => {
  const store = new JobStore()
  const students = [mk(1), mk(2), mk(3)]
  const job = store.create({ owner: "u", sessionId: "s", students })
  const client = {
    printReport: async (_c, value) => {
      if (value.startsWith("2")) throw Object.assign(new Error("Sin notas"), { kind: "napsis" })
      return Buffer.from("pdf")
    },
  }
  const drafts = []
  await runJob({ store, job, client, createDraft: async (raw) => drafts.push(raw), students, ...baseArgs })

  assert.equal(drafts.length, 2)
  assert.deepEqual(job.students.map((s) => s.status), ["success", "failed", "success"])
  assert.equal(job.students[1].message, "Sin notas")
  assert.equal(job.status, "done")
  assert.match(job.message, /2 borradores creados, 1 con problemas/)
})

test("runJob respeta la cancelación después del alumno actual", async () => {
  const store = new JobStore()
  const students = [mk(1), mk(2), mk(3)]
  const job = store.create({ owner: "u", sessionId: "s", students })
  const client = { printReport: async () => { store.cancel(job); return Buffer.from("pdf") } }
  await runJob({ store, job, client, createDraft: async () => "id", students, ...baseArgs })

  assert.deepEqual(job.students.map((s) => s.status), ["success", "skipped", "skipped"])
  assert.equal(job.status, "cancelled")
})

test("runJob se detiene si Google rechaza el permiso", async () => {
  const store = new JobStore()
  const students = [mk(1), mk(2)]
  const job = store.create({ owner: "u", sessionId: "s", students })
  const client = { printReport: async () => Buffer.from("pdf") }
  const createDraft = async () => { throw new GmailError("sin permiso", "auth") }
  await runJob({ store, job, client, createDraft, students, ...baseArgs })

  assert.deepEqual(job.students.map((s) => s.status), ["failed", "skipped"])
  assert.equal(job.status, "failed")
})

test("subscribe envía snapshot primero y luego cambios", () => {
  const store = new JobStore()
  const job = store.create({ owner: "u", sessionId: "s", students: [mk(1)] })
  const events = []
  store.subscribe(job, (e) => events.push(e))
  store.setStudent(job, "1-k", "downloading")
  assert.equal(events[0].type, "snapshot")
  assert.equal(events[0].job.owner, undefined)
  assert.deepEqual(events[1], { type: "student", key: "1-k", status: "downloading", message: "" })
})

test("SessionStore aísla usuarios y expira por inactividad", async () => {
  let now = 0
  const closed = []
  const store = new SessionStore({
    openClient: async (c) => ({ c, close: async () => closed.push(c.rut) }),
    idleMs: 1000,
    now: () => now,
  })
  const { id } = await store.create("a@x.cl", { rut: "1" })
  assert.throws(() => store.get(id, "b@x.cl"), { status: 410 })
  assert.ok(store.get(id, "a@x.cl"))
  now = 5000
  store.sweep()
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(closed, ["1"])
  assert.throws(() => store.get(id, "a@x.cl"), { status: 410 })
})

// ── HTTP ──────────────────────────────────────────────────────────

async function withServer(deps, fn) {
  const app = createApp({ apiKey: "k", defaultColegio: "rayencaven", heartbeatMs: 50, ...deps })
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)) })
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    await fn(base)
  } finally {
    server.closeAllConnections?.()
    await new Promise((r) => server.close(r))
  }
}

const headers = { "content-type": "application/json", "x-api-key": "k", "x-user-email": "Profe@Colegio.cl" }

test("API: rechaza sin API key y valida credenciales", async () => {
  const sessions = new SessionStore({ openClient: async () => ({ close: async () => {} }) })
  await withServer({ sessions, jobs: new JobStore() }, async (base) => {
    const r1 = await fetch(`${base}/api/sessions`, { method: "POST" })
    assert.equal(r1.status, 401)
    const r2 = await fetch(`${base}/api/sessions`, { method: "POST", headers, body: "{}" })
    assert.equal(r2.status, 400)
    assert.equal((await r2.json()).error, "Credenciales requeridas")
  })
})

test("API: flujo sesión → roster → job → SSE", async () => {
  const fakeClient = {
    options: async () => ({ tipoEns: [{ value: "110", label: "Básica" }], grado: [], curso: [], selected: { tipoEns: "110", grado: "3" } }),
    roster: async () => [{ value: "1-229-1", label: "SOTO ALUMNO1" }],
    printReport: async () => Buffer.from("pdf"),
    close: async () => {},
  }
  const sessions = new SessionStore({ openClient: async () => fakeClient })
  const drafts = []
  await withServer({ sessions, jobs: new JobStore(), draftFn: async (tok, raw) => drafts.push([tok, raw]) }, async (base) => {
    const s = await (await fetch(`${base}/api/sessions`, {
      method: "POST", headers, body: JSON.stringify({ napsisRut: "1-9", napsisPassword: "x" }),
    })).json()
    assert.ok(s.sessionId)
    assert.equal(s.colegio, "rayencaven")

    const roster = await (await fetch(`${base}/api/sessions/${s.sessionId}/roster`, {
      method: "POST", headers, body: JSON.stringify({ tipoEns: "110", grado: "3", curso: "A" }),
    })).json()
    assert.equal(roster.students.length, 1)

    const other = await fetch(`${base}/api/sessions/${s.sessionId}/roster`, {
      method: "POST", headers: { ...headers, "x-user-email": "otro@x.cl" }, body: JSON.stringify({ tipoEns: "110", grado: "3", curso: "A" }),
    })
    assert.equal(other.status, 410)

    const start = await fetch(`${base}/api/jobs`, {
      method: "POST", headers, body: JSON.stringify({
        sessionId: s.sessionId, students: [mk(1)], googleAccessToken: "tok", ...baseArgs,
        napsisConfig: { tipoEns: "110", grado: "3", curso: "A", periodo: "1", religion: "2" },
      }),
    })
    assert.equal(start.status, 202)
    const { jobId } = await start.json()

    const text = await (await fetch(`${base}/api/jobs/${jobId}/events`, { headers })).text()
    const events = text.split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)))
    assert.equal(events[0].type, "snapshot")
    // El job puede terminar antes de conectarse: entonces el snapshot ya trae el estado final
    const last = events.at(-1)
    assert.equal(last.type === "snapshot" ? last.job.status : last.status, "done")
    const job = await (await fetch(`${base}/api/jobs/${jobId}`, { headers })).json()
    assert.equal(job.students[0].status, "success")
    assert.equal(drafts.length, 1)
    assert.equal(drafts[0][0], "tok")
  })
})
