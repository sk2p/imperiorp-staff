# Bot de fichajes — Imperio RP

Entrada y salida desde Discord, contra la **misma base que la página**. No
guarda nada propio y no sincroniza nada: cuando alguien cierra un fichaje acá,
esa hora ya está en la planilla de `/horas`.

## Cómo se cuentan las horas

Es lo único que no puede fallar, así que conviene tenerlo claro:

1. Al cerrar, el turno se parte por las **medianoches locales** que cruce. Un
   turno de 22:00 a 02:00 son dos horas de cada día. Si esa medianoche es la
   del sábado, además son dos liquidaciones distintas.
2. Cada pedazo suma sus **segundos** a la casilla de su día. Se acumulan
   segundos y no minutos porque redondear turno a turno va perdiendo tiempo.
   Los minutos que se liquidan se derivan de ese total, así que nunca hay dos
   números que puedan contradecirse.
3. El día local es el de **Argentina**, no el del servidor donde corra el bot.
4. Si un pedazo cae fuera de todo período abierto, se avisa en vez de
   descartarlo callado.
5. Cargar horas a mano en la planilla **fija** el día; fichar **suma**.

## Puesta en marcha

### 1. Crear la aplicación

En <https://discord.com/developers/applications>:

- **New Application** → nombre y crear.
- **Bot** → *Reset Token* → copiar. Ese es `DISCORD_TOKEN`.
- **General Information** → copiar el *Application ID*. Ese es `DISCORD_CLIENT_ID`.
- **Installation** → en *Guild Install* marcar los scopes `bot` y
  `applications.commands`, y los permisos **Send Messages** y
  **Embed Links**. Copiar el link y abrirlo para invitarlo al servidor.

No hace falta activar ningún *Privileged Gateway Intent*: el bot vive de
interacciones, no lee mensajes.

### 2. Completar el `.env`

En Discord, activá *Ajustes → Avanzado → Modo desarrollador* para poder copiar
los IDs de los canales con click derecho.

```
DISCORD_TOKEN=...
DISCORD_CLIENT_ID=...
DISCORD_GUILD_ID=...          # el servidor donde probás

DISCORD_REGISTRO_HIGH=...     # registro-admin
DISCORD_REGISTRO_MID=...      # registro-moderador
DISCORD_REGISTRO_LOW=...      # registro-soporte

DISCORD_RESUMEN_HIGH=...      # resumen diario de administradores
DISCORD_RESUMEN_MID=...       # resumen diario de moderadores
DISCORD_RESUMEN_LOW=...       # resumen diario de soportes
DISCORD_RESUMEN_GLOBAL=...    # resumen-dia, con todo el staff junto

DISCORD_PAGOS=...             # canal de pagos
```

`DISCORD_GUILD_ID` hace que los comandos aparezcan al instante en ese servidor.
Sin él, Discord tarda hasta una hora en propagarlos.

### 3. Arrancarlo

```bash
pnpm bot
```

### 4. Publicar los paneles

En cada canal de fichaje, con rango ADM o superior:

```
/panel categoria: High Staff     ← en fichaje-admin
/panel categoria: Mid Staff      ← en fichaje-mods
/panel categoria: Low Staff      ← en fichaje-soporte
```

El panel queda fijo y sus botones siguen funcionando después de reiniciar el
bot: no hay estado en memoria que se pierda.

### 5. Vincular las cuentas

Cada persona necesita su cuenta de Discord atada a su ficha del staff.

**El primer vínculo lo hace quien administra el servidor de Discord.** Tiene que
ser así: antes del primer vínculo nadie tiene rango, así que nadie podría
vincular a nadie —ni a sí mismo. Una vez que hay un ADM vinculado, ese ADM ya
puede vincular al resto.

Con rango ADM o superior, o con permiso de administrar el servidor:

```
/vincular usuario: @alguien  staff: (buscá por nombre)
```

O desde **⚙️ Administración → 🔗 Vincular cuenta** en cualquier panel.

Se guarda el número de Discord, no el nombre: los nombres se cambian y el
número no.

## Emojis

Arrancan como emojis comunes. Para usar los de Imperio RP, subilos en el portal
de desarrolladores → tu aplicación → **Emojis**, con el mismo nombre que la
variable (`EMOJI_ENTRADA`, `EMOJI_SALIDA`, …), y después:

```bash
pnpm bot:emojis
```

Eso se los pregunta a Discord, empareja por nombre y escribe los códigos en el
`.env`. Copiarlos a mano con veintitrés es cuestión de tiempo que se escape un
dígito, y el error recién se ve al arrancar.

Conviene que sean emojis de la **aplicación** y no del servidor: los de la
aplicación son del bot y viajan con él cuando lo muevas al servidor real; los
del servidor sólo funcionan mientras el bot esté en ese servidor.

## Avisos de pago

Cuando alguien registra o anula un pago **en la página**, el canal de pagos se
entera solo. Eso no lo hace el bot: lo manda la página directo a Discord, así
que funciona aunque el bot esté apagado.

Para que ande, en **Vercel** tienen que estar `DISCORD_TOKEN` y `DISCORD_PAGOS`.

## Qué corre solo

- **Resumen diario**, a medianoche: uno por bloque en su canal y uno global con
  todo el staff.
- **Cierre de fichajes olvidados**, cada diez minutos. Un turno abierto más de
  `MAX_SHIFT_HOURS` (hoy, 16) se cierra al tope y queda marcado como automático
  en el registro, para que se vea que ese número no es de fiar.

  El límite **no se menciona en ningún mensaje del bot**, a propósito: un límite
  anunciado es un límite que se puede aprovechar. Si hay que cambiarlo, está en
  `src/server/shifts.ts`.

## Reglas que hace cumplir

- Un solo fichaje abierto por persona, garantizado por un índice único de la
  base y no por una consulta previa: dos clicks seguidos no abren dos.
- Cada quien ficha en el panel de **su** categoría. Un moderador no puede usar
  el panel de administradores.
- La administración del fichaje —cerrarle el turno a otro, vincular cuentas— es
  de **ADM** para arriba, según el rango de la ficha y no según un rol de
  Discord. La única excepción es quien administra el servidor de Discord, que
  puede hacerlo siempre: sin esa puerta el primer vínculo sería imposible.
