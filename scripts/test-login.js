/**
 * Prueba manual con navegador visible:
 *   node scripts/test-login.js <rut-sin-dv> <contraseña> [colegio]
  * Inicia sesión (eligiendo el portal SND), carga la cascada del formulario y muestra las opciones.
 */
require("dotenv").config({ quiet: true })
const { NapsisClient } = require("../src/napsis/client")

const [rut = process.env.TEST_RUT, password = process.env.TEST_PASS, colegio = process.env.NAPSIS_COLEGIO || "rayencaven"] =
  process.argv.slice(2)

if (!rut || !password) {
  console.error("Uso: node scripts/test-login.js <rut-sin-dv> <contraseña> [colegio]")
  process.exit(1)
}

;(async () => {
  let client
  try {
    console.log("Iniciando sesión en Napsis…")
    client = await NapsisClient.open({ rut, password, colegio, headless: false })
    console.log("✓ Sesión iniciada")

    const opts = await client.options({})
    console.log("\nTipos de enseñanza:", opts.tipoEns.map((o) => `${o.value}=${o.label}`).join(" | "))
    console.log("Grados:", opts.grado.map((o) => `${o.value}=${o.label}`).join(" | "))
    console.log("Cursos:", opts.curso.map((o) => `${o.value}=${o.label}`).join(" | "))

    if (opts.curso[0]) {
      const roster = await client.roster({ ...opts.selected, curso: opts.curso[0].value })
      console.log(`\nAlumnos en ${opts.curso[0].label}: ${roster.length}`)
      roster.slice(0, 5).forEach((a) => console.log(`  ${a.value} → ${a.label}`))
    }
    console.log("\n✓ Todo OK")
  } catch (err) {
    console.error("\n✗ ERROR:", err.message)
    process.exitCode = 1
  } finally {
    if (client) await client.close()
  }
})()
