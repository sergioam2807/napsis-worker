const { chromium } = require("playwright")

/**
 * Cliente de Napsis: una sesión de navegador logueada que expone solo operaciones de negocio.
 * Todas las operaciones se serializan (una pestaña, un paso a la vez) y si Napsis
 * cierra la sesión por inactividad, el cliente vuelve a iniciar sesión una vez.
 *
 * Los selectores dependen del HTML actual de Napsis. Si Napsis cambia su UI, ajustar aquí.
 */

const LOGIN_URL = "https://login.napsis.com/"
const SEL = {
  tipoEns: 'select[name="fTipoEns"]',
  grado: "#fGrado",
  curso: "#fCurso",
  alumno: "#multfRunAlumno0",
  periodo: 'select[name="fPeriodos"]',
  religion: 'select[name="fReligion"]',
  // Paso posterior a la contraseña: "Selector de roles"
  sistema: "#id_system",
  codigoVerificacion: "#text-validation",
}

/** El informe de apoderados vive en el portal SND, no en Portal Comunidad. */
const PORTAL_SND = /SND/i

class NapsisError extends Error {
  /** @param {string} message @param {"login"|"not_found"|"napsis"} kind */
  constructor(message, kind = "napsis") {
    super(message)
    this.name = "NapsisError"
    this.kind = kind
  }
}

function rutSinDv(rut) {
  return String(rut).replace(/\./g, "").trim().split("-")[0]
}

function informesUrl(colegio) {
  return `https://snd.napsis.cl/${encodeURIComponent(colegio)}/informes/apoderado/index.phtml`
}

async function readOptions(page, selector) {
  return page.$$eval(`${selector} option`, (opts) =>
    opts
      .filter((o) => o.value !== "" && o.value !== "0")
      .map((o) => ({ value: o.value, label: (o.textContent || "").replace(/\s+/g, " ").trim() }))
  )
}

/** Los selects de la cascada hacen submit del formulario (onchange) → esperar la recarga. */
async function selectAndWait(page, selector, value) {
  const loaded = page.waitForEvent("load", { timeout: 15000 }).catch(() => null)
  await page.selectOption(selector, value)
  await loaded
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {})
}

async function selectSettled(page, selector, value) {
  await page.selectOption(selector, value)
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => page.waitForTimeout(600))
}

/**
 * Tras la contraseña, Napsis muestra un "Selector de roles" con la cascada
 * País → Área → Sistema → Institución → Perfil. Basta elegir el sistema: los
 * demás se completan solos. Hay que entrar por el portal SND, que es donde
 * está el formulario de informes; Portal Comunidad lleva a otro sitio.
 */
async function elegirPortalSnd(page) {
  const opciones = await readOptions(page, SEL.sistema)
  const snd = opciones.find((o) => PORTAL_SND.test(o.label))
  if (!snd) {
    const lista = opciones.map((o) => o.label).join(", ") || "ninguno"
    throw new NapsisError(
      `Tu cuenta de Napsis no tiene acceso al portal SND, que es donde están los informes. Sistemas disponibles: ${lista}.`,
      "login"
    )
  }
  await page.selectOption(SEL.sistema, snd.value)
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => page.waitForTimeout(1500))
  await page.getByRole("button", { name: "Enviar" }).first().click()
}

const fueraDelLogin = (url) => !url.href.includes("login.napsis.com")

async function login(page, rut, password) {
  await page.goto(LOGIN_URL, { waitUntil: "networkidle" })
  await page.getByRole("textbox", { name: "Usuario" }).fill(rutSinDv(rut))
  await page.getByRole("button", { name: "Siguiente" }).click()

  const passwordField = page.locator(
    ['input[type="password"]', 'input[name*="password" i]', 'input[name*="contrasena" i]', 'input[name*="pass" i]'].join(", ")
  ).first()

  try {
    await passwordField.waitFor({ state: "visible", timeout: 15000 })
  } catch {
    throw new NapsisError("Napsis no reconoció el RUT. Revisa que esté bien escrito.", "login")
  }
  await passwordField.fill(password)
  await page.getByRole("button", { name: "Siguiente" }).click()

  // Con la contraseña puesta, Napsis puede entrar directo, pedir el selector de
  // roles, pedir un código de verificación, o rechazar las credenciales.
  const nunca = new Promise(() => {})
  const cuando = (promesa, etiqueta) => promesa.then(() => etiqueta).catch(() => nunca)
  const paso = await Promise.race([
    cuando(page.waitForURL(fueraDelLogin, { timeout: 25000 }), "dentro"),
    cuando(page.locator(SEL.sistema).waitFor({ state: "visible", timeout: 25000 }), "roles"),
    cuando(page.locator(SEL.codigoVerificacion).waitFor({ state: "visible", timeout: 25000 }), "codigo"),
    page.waitForTimeout(26000).then(() => "atascado"),
  ])

  if (paso === "codigo") {
    throw new NapsisError(
      "Napsis pidió un código de verificación para este equipo, y esta herramienta no puede completarlo. Entra una vez a Napsis desde tu navegador marcando «confiar en este navegador» y vuelve a intentarlo.",
      "login"
    )
  }

  if (paso === "atascado") {
    const errText = await page
      .locator('[class*="error" i], [class*="alert" i], [role="alert"]')
      .first()
      .textContent({ timeout: 1000 })
      .catch(() => "")
    throw new NapsisError(errText?.trim() || "RUT o contraseña de Napsis incorrectos.", "login")
  }

  if (paso === "roles") {
    await elegirPortalSnd(page)
    try {
      await page.waitForURL(fueraDelLogin, { timeout: 25000 })
    } catch {
      throw new NapsisError("Napsis no terminó de abrir el portal SND. Intenta de nuevo en unos minutos.", "login")
    }
  }
}

class NapsisClient {
  /**
   * Abre Chromium e inicia sesión.
   * @param {{rut: string, password: string, colegio: string, headless?: boolean}} opts
   */
  static async open({ rut, password, colegio, headless = true }) {
    const browser = await chromium.launch({ headless, args: ["--no-sandbox", "--disable-setuid-sandbox"] })
    try {
      const context = await browser.newContext({ locale: "es-CL" })
      const page = await context.newPage()
      await login(page, rut, password)
      return new NapsisClient({ browser, page, colegio, relogin: () => login(page, rut, password) })
    } catch (err) {
      await browser.close().catch(() => {})
      throw err
    }
  }

  constructor({ browser, page, colegio, relogin }) {
    this._browser = browser
    this._page = page
    this._colegio = colegio
    this._relogin = relogin
    this._queue = Promise.resolve()
    this._closed = false
  }

  /** Serializa operaciones sobre la única pestaña. */
  _run(fn) {
    const next = this._queue.then(() => {
      if (this._closed) throw new NapsisError("La sesión de Napsis se cerró.")
      return fn(this._page)
    })
    this._queue = next.catch(() => {})
    return next
  }

  async _openForm(page) {
    await page.goto(informesUrl(this._colegio), { waitUntil: "networkidle" })
    if (page.url().includes("login.napsis.com") || !(await page.locator(SEL.tipoEns).count())) {
      await this._relogin()
      await page.goto(informesUrl(this._colegio), { waitUntil: "networkidle" })
      if (!(await page.locator(SEL.tipoEns).count())) {
        throw new NapsisError(`No se encontró el formulario de informes del colegio "${this._colegio}".`)
      }
    }
  }

  async _cascade(page, { tipoEns, grado, curso }) {
    await this._openForm(page)
    await selectAndWait(page, SEL.tipoEns, tipoEns)
    await selectAndWait(page, SEL.grado, grado)
    if (curso) await selectAndWait(page, SEL.curso, curso)
  }

  /**
   * Opciones de la cascada. Si falta tipoEns o grado se usa el primero disponible.
   * @returns {Promise<{tipoEns: Opt[], grado: Opt[], curso: Opt[], selected: {tipoEns: string, grado: string}}>}
   */
  options({ tipoEns, grado } = {}) {
    return this._run(async (page) => {
      await this._openForm(page)
      const tipoEnsOpts = await readOptions(page, SEL.tipoEns)
      const selTipo = tipoEnsOpts.some((o) => o.value === tipoEns) ? tipoEns : tipoEnsOpts[0]?.value
      if (!selTipo) throw new NapsisError("Tu cuenta de Napsis no tiene tipos de enseñanza disponibles.")
      await selectAndWait(page, SEL.tipoEns, selTipo)

      const gradoOpts = await readOptions(page, SEL.grado)
      const selGrado = gradoOpts.some((o) => o.value === grado) ? grado : gradoOpts[0]?.value
      if (!selGrado) throw new NapsisError("No hay grados disponibles para ese tipo de enseñanza.")
      await selectAndWait(page, SEL.grado, selGrado)

      const cursoOpts = await readOptions(page, SEL.curso)
      return { tipoEns: tipoEnsOpts, grado: gradoOpts, curso: cursoOpts, selected: { tipoEns: selTipo, grado: selGrado } }
    })
  }

  /** Listado de alumnos del curso tal como aparece en Napsis. */
  roster({ tipoEns, grado, curso }) {
    return this._run(async (page) => {
      await this._cascade(page, { tipoEns, grado, curso })
      await page.waitForSelector(`${SEL.alumno} option[value]`, { timeout: 8000, state: "attached" }).catch(() => {})
      return readOptions(page, SEL.alumno)
    })
  }

  /**
   * Imprime a PDF el informe de un alumno.
   * @param {{tipoEns: string, grado: string, curso: string, periodo: string, religion: string}} config
   * @param {string} alumnoValue value de la opción del alumno en Napsis
   * @returns {Promise<Buffer>}
   */
  printReport(config, alumnoValue) {
    return this._run(async (page) => {
      await this._cascade(page, config)

      const exists = await page.locator(`${SEL.alumno} option[value="${alumnoValue.replace(/"/g, "")}"]`).count()
      if (!exists) throw new NapsisError("El alumno ya no aparece en el listado del curso en Napsis.", "not_found")
      await page.selectOption(SEL.alumno, alumnoValue)

      await selectSettled(page, SEL.periodo, config.periodo)
      await selectSettled(page, SEL.religion, config.religion)

      await page.getByRole("button", { name: "Continuar" }).click()
      await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {})

      const imprimir = page.getByRole("link", { name: "Imprimir" }).first()
      if (!(await imprimir.isVisible().catch(() => false))) {
        throw new NapsisError("Napsis no generó el informe (no apareció el botón Imprimir). Puede no tener notas en el período.")
      }

      const [popup] = await Promise.all([page.waitForEvent("popup", { timeout: 20000 }), imprimir.click()])
      try {
        await popup.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {})
        return await popup.pdf({ format: "A4", printBackground: true })
      } finally {
        await popup.close().catch(() => {})
      }
    })
  }

  async close() {
    if (this._closed) return
    this._closed = true
    await this._browser.close().catch(() => {})
  }
}

module.exports = { NapsisClient, NapsisError, rutSinDv, informesUrl }
