require("dotenv").config({ quiet: true })
const { createApp } = require("./src/app")
const { SessionStore } = require("./src/sessions")
const { JobStore } = require("./src/jobs")
const { NapsisClient } = require("./src/napsis/client")

const apiKey = process.env.API_KEY
if (!apiKey) {
  console.error("Falta API_KEY en el entorno (.env). Copia .env.example a .env y define una clave.")
  process.exit(1)
}

const headless = process.env.HEADLESS !== "false"
const sessions = new SessionStore({ openClient: (creds) => NapsisClient.open({ ...creds, headless }) })
const jobs = new JobStore()

const app = createApp({
  apiKey,
  sessions,
  jobs,
  defaultColegio: process.env.NAPSIS_COLEGIO || "rayencaven",
})

const sweeper = setInterval(() => sessions.sweep(), 60 * 1000)
const PORT = Number(process.env.PORT) || 3001
const server = app.listen(PORT, () => console.log(`Napsis worker escuchando en http://localhost:${PORT}`))

// Cierre ordenado: cierra los navegadores que abrió este proceso (no toca otros Chrome del equipo)
let closing = false
async function shutdown(signal) {
  if (closing) return
  closing = true
  console.log(`${signal} recibido, cerrando…`)
  clearInterval(sweeper)
  server.close()
  server.closeAllConnections?.()
  await sessions.closeAll()
  process.exit(0)
}
process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))
