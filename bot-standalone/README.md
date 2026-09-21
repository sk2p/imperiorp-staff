# Bot de fichajes — Imperio RP (standalone)

Proyecto independiente del bot de Discord de fichajes. Separado de la web para
poder desplegarlo en cualquier host (VPS, Railway, etc.) sin arrastrar Next.js
ni nada del panel web.

## Requisitos

- **Node.js ≥ 22**
- **pnpm** (o npm/yarn)
- Acceso a la **misma base de datos** que usa la web

## Instalación

```bash
# 1. Instalar dependencias
pnpm install

# 2. Configurar variables de entorno
cp .env.example .env
# Completar DISCORD_TOKEN, DISCORD_CLIENT_ID, DATABASE_URL, etc.
```

## Uso

### Desarrollo (con recarga en vivo)

```bash
pnpm bot:dev
```

### Producción (TypeScript directo)

```bash
pnpm bot
```

### Producción (bundle compilado)

```bash
# Compilar a un solo archivo JS
pnpm bot:build

# El resultado queda en dist-bot/
cd dist-bot
npm install
node bot.js
```

### Sincronizar emojis

```bash
pnpm bot:emojis
```

## Estructura

```
src/
├── bot/           ← El bot en sí: comandos, UI, tareas programadas
├── db/            ← Acceso a datos y schema (compartido con la web)
├── domain/        ← Reglas de negocio puras (reloj, rangos, grupos, dinero)
├── lib/           ← Utilidades (logger, errores, throttle)
├── server/        ← Servicios de negocio (fichajes, rotación, auditoría)
└── validation/    ← Schemas de validación (Zod)
```

## Relación con la web

El bot y la web **comparten la misma base de datos**. No son sistemas
independientes: ambos leen y escriben fichajes, horas y pagos. La separación
es solo de despliegue — el código de negocio es el mismo.

## Variables de entorno

Ver `.env.example` para la lista completa. Las más importantes:

| Variable | Descripción |
|----------|-------------|
| `DATABASE_URL` | Conexión a PostgreSQL (la misma que usa la web) |
| `DISCORD_TOKEN` | Token del bot de Discord |
| `DISCORD_CLIENT_ID` | Application ID del portal de Discord |
| `DISCORD_GUILD_ID` | Servidor donde registrar los comandos |
