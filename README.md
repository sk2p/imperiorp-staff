# Imperio RP — Gestión de Staff

Panel interno para registrar las horas del staff, calcular las liquidaciones
semanales y llevar el control de los pagos.

La regla que sostiene todo el sistema: **cuando un período se cierra, sus
liquidaciones se congelan**. Si más adelante alguien asciende o cambia una
tarifa, la liquidación vieja sigue mostrando exactamente lo que mostraba ese
día. Nada se borra nunca: las horas se anulan, los miembros se archivan y los
pagos se revierten, siempre dejando quién lo hizo y por qué.

---

## Arrancar en local (3 minutos)

No hace falta instalar PostgreSQL: si no definís `DATABASE_URL`, la app usa una
base embebida (PGlite) guardada en `.pglite_data/`.

```bash
pnpm install
cp .env.example .env
```

Editá `.env` y dejá:

```
NODE_ENV=development
DATABASE_URL=
SESSION_SECRET=cualquier-cosa-de-32-caracteres-o-mas-para-desarrollo
```

Creá las tablas y las cuentas del equipo:

```bash
pnpm db:provision
pnpm dev
```

`db:provision` imprime en la consola las contraseñas generadas para cada
cuenta. **Copialas: no se vuelven a mostrar.**

Entrá a http://localhost:3000. La base arranca vacía: el primer paso dentro del
panel es crear un período en **Períodos**.

> ⚠️ `db:provision` **borra todo** lo que haya en la base. Es para empezar de
> cero, no para el día a día.

---

## Cómo funciona

### Períodos

Un período es un rango de fechas que definís vos: no tiene que ser de lunes a
domingo. Puede ser `01/09 → 08/09` si ese es el ciclo de pago.

- **Abierto**: se cargan y corrigen horas libremente.
- **Cerrado**: las horas, el rango, la tarifa y el importe de cada miembro
  quedan congelados. Recién ahí se pueden registrar los pagos.

Dos períodos no pueden compartir ningún día: si se solaparan, no habría forma de
saber a cuál pertenece una hora cargada.

Para modificar un período cerrado hay que **reabrirlo**, lo que exige un permiso
propio, un motivo escrito y queda contado en el historial del período.

### Horas

Se cargan por turno, con fecha y descripción. El total semanal nunca es un
número suelto: es la suma de turnos concretos, cada uno con su responsable. Por
eso siempre se puede responder "¿de dónde salieron estas 18 h 30 m?".

Las horas se guardan en **minutos enteros**. Nunca en horas decimales: 18,5 no
es exacto en binario, 1110 sí.

### Cálculo del dinero

```
importe = redondeo_half_up( minutos × tarifa_por_hora ÷ 60 )
```

Todo se calcula con enteros (`bigint`), multiplicando antes de dividir. Ejemplo:

```
18h 30m = 1110 minutos, tarifa $1.500.000/h
(1110 × 1.500.000) ÷ 60 = $27.750.000
```

El importe se calcula sobre el **total** de minutos del período, no sumando el
importe de cada turno: redondear una sola vez al final evita que se acumulen
diferencias de un peso por cada entrada cargada.

### Rangos y tarifas

| Categoría      | Rangos             | Tarifa por defecto |
| -------------- | ------------------ | ------------------ |
| Soporte        | SDP · SP · SE      | $1.000.000 / h     |
| Moderación     | MOD · MOD+ · MOD++ | $1.500.000 / h     |
| Administración | ADM · ADM+ · ADM++ | $2.000.000 / h     |
| Dirección      | SUBDG · DG         | $2.000.000 / h     |

Las tarifas se editan desde **Configuración**. Cambiarlas afecta **sólo a los
períodos abiertos**; los cerrados conservan la suya congelada.

### Usuarios vs. rangos

Son dos cosas distintas y no se mezclan:

- **Rol de usuario** (`FOUNDER`, `OWNER`, `HIGH_STAFF`, `MANAGER`, `AUDITOR`): qué puede
  hacer esa persona _en este panel_.
- **Rango de staff** (`SDP` … `DG`): la posición de esa persona _dentro del
  servidor_, y la tarifa que cobra.

| Rol            | Puede                                                              |
| -------------- | ------------------------------------------------------------------ |
| **Fundador**   | Todo. Es el único que puede administrar cuentas Owner              |
| **Owner**      | Todo, incluido reabrir períodos, anular pagos y gestionar usuarios |
| **High Staff** | Staff, horas, pagos y cierre de períodos                           |
| **Encargado**  | Cargar y corregir horas; ver pagos y estadísticas                  |
| **Auditor**    | Sólo lectura, incluida la auditoría                                |

Además hay permisos individuales que se pueden conceder o revocar por usuario.

### Auditoría

Cada operación queda registrada con el valor anterior, el nuevo, el motivo, el
usuario, la IP y la fecha. Los registros están **encadenados por hash**: cada
uno incluye el hash del anterior, así que si alguien borra o modifica una fila
directamente en la base, la cadena se rompe y la pantalla de Auditoría lo avisa.

---

## Seguridad

| Qué                     | Cómo                                                                             |
| ----------------------- | -------------------------------------------------------------------------------- |
| Contraseñas             | scrypt (N=2¹⁶, r=8, p=2) + pepper con HMAC-SHA256                                |
| Sesiones                | En base de datos, revocables, con vencimiento por inactividad y absoluto         |
| Cookies                 | `HttpOnly`, `Secure` en producción, `SameSite=Lax`                               |
| CSRF                    | Validación de origen + token de doble envío ligado a la sesión                   |
| Fuerza bruta            | Límite por IP y por cuenta, **persistido en PostgreSQL** (sobrevive a reinicios) |
| Enumeración de usuarios | Mensaje único y hash falso para igualar los tiempos de respuesta                 |
| Autorización            | Verificada en el servidor antes de cada consulta y cada acción                   |
| Entradas                | Todo pasa por un esquema de Zod: no hay mass assignment posible                  |
| Inyección SQL           | Consultas parametrizadas; los campos de orden salen de listas blancas            |
| XSS                     | React escapa por defecto + CSP estricta con nonce                                |
| Cabeceras               | CSP, HSTS, `X-Frame-Options: DENY`, `nosniff`, `Permissions-Policy`              |
| Errores                 | El cliente nunca ve un mensaje interno; se le da un código de traza              |

### Concurrencia

Si dos personas editan lo mismo a la vez, la segunda recibe un error claro en
lugar de pisar el trabajo de la primera. Toda fila editable lleva una `version`
que se verifica al guardar, y las operaciones críticas usan `SELECT … FOR UPDATE`.

Los pagos van más allá: un **índice único parcial** en PostgreSQL impide que
exista más de un pago vigente por miembro y período. Dos clics simultáneos en
"Pagar" no pueden generar un pago doble, porque la garantía la da la base y no
una comprobación previa en JavaScript.

---

## Despliegue gratis (recomendado)

**Vercel** para la app + **Neon** para la base. Las dos tienen plan gratuito de
verdad, sin tarjeta y sin vencimiento. La base es PostgreSQL estándar, así que
si algún día querés mudarte es un `pg_dump` y listo.

> Otras opciones que descarté para el plan gratis: Render borra la base a los
> 30 días y duerme la app con arranques de casi un minuto; Railway ya no tiene
> plan gratis; Supabase pausa el proyecto tras una semana sin uso.

### 1. Base de datos en Neon

1. Entrá a [neon.tech](https://neon.tech) y creá una cuenta (sirve con GitHub).
2. **Create project** → nombre `imperio-rp`, región la más cercana.
3. En **Connection string**, copiá la que dice **Pooled connection**.
   Tiene `-pooler` en el host y es la que hay que usar: sin ella, cada visita
   abriría una conexión nueva y se agotaría el límite del plan gratuito.

Te queda algo así:

```
postgresql://usuario:clave@ep-algo-123456-pooler.region.aws.neon.tech/neondb?sslmode=require
```

### 2. Crear las tablas y las cuentas

Esto se hace **una sola vez**, desde tu computadora, apuntando a Neon.
Editá el `.env` local y poné la cadena de Neon en `DATABASE_URL`:

```bash
pnpm db:provision
```

Te imprime las contraseñas de las 10 cuentas. **Copialas: no se vuelven a
mostrar.**

> ⚠️ `db:provision` **borra todo** lo que haya en esa base. Ejecutalo sólo la
> primera vez, o cuando quieras empezar de cero a propósito.

Cuando termines, volvé a dejar `DATABASE_URL=` vacío en tu `.env` local para
seguir desarrollando contra la base embebida y no tocar la de producción.

### 3. Subir el código a GitHub

```bash
git init
git add .
git commit -m "Imperio RP — panel de staff"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/imperiorp-staff.git
git push -u origin main
```

El `.gitignore` ya excluye el `.env`, así que las contraseñas y el secreto no
se suben.

### 4. Desplegar en Vercel

1. Entrá a [vercel.com](https://vercel.com) con tu cuenta de GitHub.
2. **Add New → Project** y elegí el repositorio.
3. Vercel detecta Next.js solo. No toques nada de build.
4. Abrí **Environment Variables** y cargá estas cinco:

| Variable                 | Valor                                  |
| ------------------------ | -------------------------------------- |
| `DATABASE_URL`           | la cadena **pooled** de Neon           |
| `SESSION_SECRET`         | generalo con `openssl rand -base64 48` |
| `APP_URL`                | `https://tu-proyecto.vercel.app`       |
| `DATABASE_POOL_MAX`      | `1`                                    |
| `RUN_MIGRATIONS_ON_BOOT` | `false`                                |

5. **Deploy**.

Las dos últimas variables importan y conviene entender por qué:

- **`DATABASE_POOL_MAX=1`** — en Vercel cada petición puede correr en una
  instancia distinta, y cada una abriría su propio grupo de conexiones. Con el
  valor por defecto (10) se agota el límite de Neon enseguida. Neon ya hace el
  reparto de conexiones por su lado, así que a la app le alcanza con una.
- **`RUN_MIGRATIONS_ON_BOOT=false`** — las migraciones ya las aplicaste en el
  paso 2. Dejarlo activado haría que varias instancias intentaran migrar a la
  vez al arrancar.

### 5. Ajustar `APP_URL`

Vercel te da la URL definitiva recién después del primer despliegue. Si no
coincide con `APP_URL`, la validación de origen rechaza los formularios.
Andá a **Settings → Environment Variables**, corregila y hacé **Redeploy**.

Si después conectás un dominio propio, actualizá `APP_URL` otra vez.

### Cuando cambies el esquema

Si más adelante tocás las tablas, generá y aplicá la migración apuntando a Neon:

```bash
pnpm db:generate    # crea el archivo SQL
pnpm db:migrate     # lo aplica (con DATABASE_URL de Neon en el .env)
```

---

## Otros despliegues

### Docker (servidor propio o VPS)

```bash
cp .env.example .env
# Completá POSTGRES_PASSWORD y SESSION_SECRET
docker compose up -d
```

Queda en `http://localhost:3000` y la base persiste en el volumen
`postgres_data`. Acá sí conviene dejar `RUN_MIGRATIONS_ON_BOOT=true`: es un
único proceso y se encarga solo.

### VPS sin Docker

```bash
pnpm install
pnpm build
DATABASE_URL=... SESSION_SECRET=... APP_URL=... pnpm start
```

Usá `pm2`, `systemd` o similar para que el proceso se levante solo, y poné
nginx o Caddy adelante para el certificado HTTPS.

### Cualquier otro proveedor

Sólo necesita **Node.js 22+** y una `DATABASE_URL` de PostgreSQL. Build
`pnpm build`, arranque `pnpm start`. No se usa ninguna función propietaria.

## Copias de seguridad

El proveedor de hosting **no** es una copia de seguridad. Hacé la tuya.

```bash
# Copia (semanal como mínimo; diaria si el staff es grande)
pg_dump "$DATABASE_URL" -Fc -f imperio_$(date +%F).dump

# Restauración
createdb imperiorp_staff
pg_restore -d "$DATABASE_URL" --clean --if-exists imperio_2026-09-11.dump
```

Recomendación: copias diarias con 30 días de retención, guardadas **fuera** del
proveedor donde corre la base. Probá una restauración cada tanto: una copia que
nunca se restauró no es una copia, es una suposición.

Toda la información vive en PostgreSQL estándar, sin nada propietario. Migrar de
proveedor es `pg_dump` → `pg_restore` → cambiar `DATABASE_URL`.

---

## Estructura

```
src/
  app/            Pantallas (Server Components) y rutas de API
  components/     Sistema de diseño e iconografía propia
  domain/         Reglas puras: dinero, tiempo, liquidación, rangos, permisos
  server/         Servicios con acceso a datos y Server Actions
  validation/     Esquemas de entrada (Zod)
  lib/
    auth/         Contraseñas, sesiones, CSRF, límite de intentos
    core/         Entorno, errores tipados, logs
  db/             Esquema de Drizzle, migraciones, seed
drizzle/          Migraciones SQL versionadas
```

Las mutaciones se hacen con **Server Actions**, no con endpoints REST: la lógica
se ejecuta siempre en el servidor y Next.js valida el origen de cada petición.

---

## Comandos

```bash
pnpm dev            # Desarrollo
pnpm build          # Compilar para producción
pnpm start          # Servir lo compilado
pnpm typecheck      # Verificar tipos
pnpm lint           # Verificar formato
pnpm lint:fix       # Corregir formato
pnpm test           # Tests
pnpm verify         # Tipos + formato + tests, todo junto
pnpm db:generate    # Generar una migración tras cambiar el esquema
pnpm db:migrate     # Aplicar migraciones
pnpm db:provision   # ⚠️ Borra todo y recrea las cuentas del equipo
pnpm db:seed        # Datos de prueba (sólo desarrollo)
pnpm db:studio      # Explorador visual de la base
```

## Monitoreo

- `GET /api/health` — el proceso está vivo (no toca la base).
- `GET /api/ready` — la base responde y la configuración es válida. Devuelve
  `503` si algo anda mal.

Los logs salen en JSON por línea, con las contraseñas y los tokens redactados
automáticamente.
