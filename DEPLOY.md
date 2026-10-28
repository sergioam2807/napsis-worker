# Despliegue del worker

El worker inicia sesión en Napsis con Playwright, imprime los informes a PDF y
crea los borradores en Gmail. Lo consume el front (`napsis-front`), nunca el
navegador del usuario directamente.

## Lo que condiciona dónde puede vivir

No es un servicio sin estado. Mantiene **un Chromium vivo en memoria por cada
sesión de Napsis** (`src/sessions.js`), los procesos en memoria sin base de
datos (`src/jobs.js`), y envía el avance por SSE durante varios minutos.

De ahí salen tres requisitos que descartan casi todo el alojamiento gratuito:

| Requisito | Por qué |
|---|---|
| Un único proceso siempre encendido | Si se duerme o se reinicia, se pierden las sesiones y los procesos en curso |
| Sin escalado horizontal | Una segunda instancia no conoce el navegador que abrió la primera |
| **≥ 1 GB de RAM** | Ver medición abajo |

### Memoria medida

Con **una sola sesión abierta y en reposo**, antes de imprimir ningún informe:

```
Chromium de Playwright (4 procesos)  386 MB
Node del worker                      108 MB
                                     ------
TOTAL                                494 MB
```

El worker admite hasta 2 procesos simultáneos (`maxConcurrentJobs`), así que el
techo real ronda 1 GB. **Los planes de 512 MB no sirven**: no cabe ni una sesión
inactiva.

## Opciones

| Dónde | Coste | Notas |
|---|---|---|
| Render, plan de 2 GB | ~$25/mes | Despliegue directo desde este repo con el Dockerfile |
| Oracle Cloud Always Free | Gratis | 2 OCPU / 12 GB ARM. Pide tarjeta, la imagen de Playwright debe ser arm64, y hay recuperación por inactividad |
| Railway | ~$5/mes | Objetivo original del diseño |
| Túnel desde un equipo propio | Gratis | Para desarrollo: `cloudflared tunnel --url http://localhost:3001` |

Los planes gratuitos de Render, Koyeb y Fly.io tienen 512 MB: no alcanzan.

## Variables de entorno

| Variable | Obligatoria | Valor |
|---|---|---|
| `API_KEY` | sí | Secreto compartido. Debe coincidir **exactamente** con `WORKER_API_KEY` del front |
| `NAPSIS_COLEGIO` | no | Slug por defecto en `snd.napsis.cl/<colegio>/…` (por defecto `rayencaven`) |
| `HEADLESS` | no | `false` abre Chromium visible; solo para depurar en local |
| `PORT` | no | **No la definas en Render ni Railway**: la inyecta la plataforma y el worker ya la lee |

El worker aborta al arrancar si falta `API_KEY`.

## Comprobación

`GET /health` responde `{"ok":true}` sin autenticación. Úsalo como health check
de la plataforma y para confirmar que el servicio está en línea.

## Cómo se conecta con el front

El front llama al worker desde su propio servidor (nunca desde el navegador) y
manda dos cabeceras:

- `x-api-key`: prueba que la llamada viene de nuestro front.
- `x-google-token`: el access token de Google del usuario. **El worker lo
  verifica contra Google** (`src/google-identity.js`) para saber de quién es la
  petición, y con ese mismo token crea los borradores en Gmail.

La identidad no viaja en una cabecera declarativa a propósito: con la `API_KEY`
filtrada, cualquiera podría decir que es otro usuario y ver o cancelar sus
procesos. El resultado de la verificación se cachea 5 minutos.

En el front hay que apuntar `WORKER_URL` a la URL pública del worker, sin barra
final.

## Contenedores

El `Dockerfile` parte de `mcr.microsoft.com/playwright`, cuya versión **debe
coincidir** con la de `playwright` en `package.json`.

Chromium se lanza con `--disable-dev-shm-usage` porque Docker da 64 MB de
`/dev/shm` por defecto y sin ese flag el navegador se cae con errores confusos
de «Target closed» al imprimir.
