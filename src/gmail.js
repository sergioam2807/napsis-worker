const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/

class GmailError extends Error {
  /** @param {string} message @param {"auth"|"quota"|"invalid"|"unknown"} kind */
  constructor(message, kind = "unknown") {
    super(message)
    this.name = "GmailError"
    this.kind = kind
  }
}

function assertEmail(value, label) {
  const v = String(value || "").trim()
  if (!EMAIL_RE.test(v)) throw new GmailError(`${label} no es un correo válido: "${v}"`, "invalid")
  return v
}

/** Quita saltos de línea para impedir inyección de cabeceras. */
function headerSafe(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim()
}

/** RFC 2047: cabecera con caracteres no ASCII. */
function encodeHeader(value) {
  const v = headerSafe(value)
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(v)) return v
  return `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`
}

function wrap76(b64) {
  return b64.replace(/.{1,76}/g, (line) => line + "\r\n").trimEnd()
}

/**
 * Construye el mensaje MIME y lo devuelve codificado en base64url (campo `raw` de Gmail).
 * @param {{to: string, cc?: string, subject: string, body: string,
 *          attachment: {filename: string, content: Buffer}, boundary?: string}} msg
 */
function buildRawMessage(msg) {
  const to = assertEmail(msg.to, "El correo del apoderado")
  const cc = msg.cc ? assertEmail(msg.cc, "El correo del alumno") : null
  const boundary = msg.boundary || `napsis_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
  const filename = headerSafe(msg.attachment.filename).replace(/"/g, "")

  const lines = [
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    `Subject: ${encodeHeader(msg.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(Buffer.from(String(msg.body).replace(/\r?\n/g, "\r\n"), "utf8").toString("base64")),
    "",
    `--${boundary}`,
    `Content-Type: application/pdf; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(msg.attachment.content.toString("base64")),
    "",
    `--${boundary}--`,
    "",
  ]

  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url")
}

/**
 * Crea un borrador en el Gmail del usuario.
 * @returns {Promise<string>} id del borrador
 */
async function createDraft(accessToken, raw, fetchImpl = fetch) {
  const res = await fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message: { raw } }),
  })

  if (res.ok) {
    const data = await res.json()
    return data.id
  }

  const detail = await res.text().catch(() => "")
  if (res.status === 401 || res.status === 403) {
    throw new GmailError("Google rechazó el permiso para crear borradores. Vuelve a iniciar sesión con Google.", "auth")
  }
  if (res.status === 429) {
    throw new GmailError("Gmail limitó la cantidad de borradores por minuto. Reintenta en unos minutos.", "quota")
  }
  throw new GmailError(`Gmail respondió ${res.status}: ${detail.slice(0, 200)}`)
}

module.exports = { buildRawMessage, createDraft, GmailError, encodeHeader }
