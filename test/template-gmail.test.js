const { test } = require("node:test")
const assert = require("node:assert/strict")
const { interpolate, studentVars, reportFilename, nombreCompleto } = require("../src/template")
const { buildRawMessage, encodeHeader, createDraft, GmailError } = require("../src/gmail")

const alumno = {
  primerNombre: "Demián",
  segundoNombre: "Abel",
  apellidoPaterno: "Arancibia",
  apellidoMaterno: "Carrasco",
  rut: "24147564-7",
  emailAlumno: "demian@colegio.cl",
  nombreApoderado: "Allison Carrasco Pérez",
  correoApoderado: "allison@gmail.com",
}

test("interpolate reemplaza variables conocidas y deja las desconocidas", () => {
  const vars = studentVars(alumno)
  assert.equal(interpolate("Hola {nombreApoderado}, {nombreAlumno} ({rut}) {otra}", vars),
    "Hola Allison Carrasco Pérez, Demián Abel Arancibia Carrasco (24147564-7) {otra}")
})

test("nombreCompleto omite partes vacías", () => {
  assert.equal(nombreCompleto({ primerNombre: "Ana", segundoNombre: "", apellidoPaterno: "Soto" }), "Ana Soto")
})

test("reportFilename es ASCII y sin DV", () => {
  assert.equal(reportFilename(alumno), "Informe_Arancibia_Demian_24147564.pdf")
})

test("encodeHeader usa RFC 2047 solo si hay caracteres no ASCII", () => {
  assert.equal(encodeHeader("Informe"), "Informe")
  assert.match(encodeHeader("Informe – Pérez"), /^=\?UTF-8\?B\?.+\?=$/)
  assert.equal(encodeHeader("a\r\nBcc: x@y.z"), "a Bcc: x@y.z")
})

test("buildRawMessage arma destinatarios, asunto y adjunto decodificables", () => {
  const raw = buildRawMessage({
    to: alumno.correoApoderado,
    cc: alumno.emailAlumno,
    subject: "Informe Parcial - Demián",
    body: "Hola\nMundo",
    attachment: { filename: "Informe.pdf", content: Buffer.from("%PDF-1.4 test") },
    boundary: "B",
  })
  const mime = Buffer.from(raw, "base64url").toString("utf8")
  assert.match(mime, /^To: allison@gmail\.com\r\nCc: demian@colegio\.cl\r\n/)
  const subject = mime.match(/Subject: =\?UTF-8\?B\?(.+)\?=/)[1]
  assert.equal(Buffer.from(subject, "base64").toString("utf8"), "Informe Parcial - Demián")
  const parts = mime.split("--B")
  const body = parts[1].split("\r\n\r\n")[1].trim()
  assert.equal(Buffer.from(body, "base64").toString("utf8"), "Hola\r\nMundo")
  const pdf = parts[2].split("\r\n\r\n")[1].replace(/\s/g, "")
  assert.equal(Buffer.from(pdf, "base64").toString(), "%PDF-1.4 test")
  assert.match(mime, /--B--\r\n$/)
})

test("buildRawMessage rechaza correos inválidos", () => {
  assert.throws(
    () => buildRawMessage({ to: "no-es-correo", subject: "x", body: "x", attachment: { filename: "a.pdf", content: Buffer.from("") } }),
    (err) => err instanceof GmailError && err.kind === "invalid"
  )
})

test("createDraft traduce 401 a error de permiso", async () => {
  const fakeFetch = async () => ({ ok: false, status: 401, text: async () => "unauthorized" })
  await assert.rejects(createDraft("tok", "raw", fakeFetch), (err) => err.kind === "auth")
})

test("createDraft devuelve el id del borrador", async () => {
  const fakeFetch = async (_url, init) => {
    assert.equal(init.headers.Authorization, "Bearer tok")
    return { ok: true, status: 200, json: async () => ({ id: "r-123" }) }
  }
  assert.equal(await createDraft("tok", "raw", fakeFetch), "r-123")
})
