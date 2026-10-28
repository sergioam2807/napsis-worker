/** Nombre completo en orden natural: nombres y luego apellidos. */
function nombreCompleto(s) {
  return [s.primerNombre, s.segundoNombre, s.apellidoPaterno, s.apellidoMaterno]
    .map((p) => (p || "").trim())
    .filter(Boolean)
    .join(" ")
}

/** Variables disponibles en asunto y cuerpo. */
function studentVars(s) {
  return {
    nombreAlumno: nombreCompleto(s),
    nombreApoderado: (s.nombreApoderado || "").trim(),
    rut: (s.rut || "").trim(),
    emailAlumno: (s.emailAlumno || "").trim(),
    correoApoderado: (s.correoApoderado || "").trim(),
  }
}

/** Reemplaza {variable}. Las variables desconocidas quedan tal cual. */
function interpolate(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match
  )
}

/** Nombre de archivo ASCII seguro: Informe_Perez_Juan_12345678.pdf */
function reportFilename(s) {
  const clean = (v) =>
    String(v || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^A-Za-z0-9]+/g, "")
  const rutNum = String(s.rut || "").replace(/[^0-9]/g, "").slice(0, -1) || "sinrut"
  const parts = ["Informe", clean(s.apellidoPaterno), clean(s.primerNombre), rutNum].filter(Boolean)
  return `${parts.join("_")}.pdf`
}

module.exports = { nombreCompleto, studentVars, interpolate, reportFilename }
