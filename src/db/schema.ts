import { relations, sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * IMPERIO RP — Esquema de base de datos.
 *
 * Principios que sostienen todo el modelo:
 *
 *  1. NADA SE BORRA. Los miembros se archivan, las entradas de horas se anulan
 *     y los pagos se revierten. Cada fila conserva quién y por qué.
 *  2. LO HISTÓRICO SE CONGELA. `weekly_staff_records` guarda nombre, rango,
 *     tarifa e importe tal como estaban al cerrar el período. Cambiar la tarifa
 *     hoy no altera ni un peso de una liquidación de hace un año.
 *  3. CONCURRENCIA EXPLÍCITA. Toda fila editable lleva `version`; las
 *     actualizaciones exigen la versión esperada y fallan en vez de pisar.
 *  4. LAS REGLAS VIVEN EN LA BASE. Índices únicos y CHECKs hacen imposibles los
 *     estados inválidos aunque un bug del código lo intente.
 */

const primaryId = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/* ========================================================================== */
/* 1. Usuarios del sistema                                                    */
/* ========================================================================== */

export const users = pgTable(
  "users",
  {
    id: primaryId(),
    username: varchar("username", { length: 32 }).notNull(),
    displayName: varchar("display_name", { length: 80 }),
    passwordHash: text("password_hash").notNull(),
    /** OWNER | HIGH_STAFF | MANAGER | AUDITOR */
    role: varchar("role", { length: 24 }).notNull().default("MANAGER"),
    /** Permisos individuales por encima del rol. */
    grantedPermissions: jsonb("granted_permissions").$type<string[]>().notNull().default([]),
    /** Permisos revocados individualmente. Ganan sobre los del rol. */
    revokedPermissions: jsonb("revoked_permissions").$type<string[]>().notNull().default([]),

    active: boolean("active").notNull().default(true),
    mustChangePassword: boolean("must_change_password").notNull().default(false),

    /** Bloqueo por fuerza bruta. Persistido: sobrevive a reinicios del proceso. */
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),

    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    lastLoginIp: varchar("last_login_ip", { length: 45 }),
    passwordChangedAt: timestamp("password_changed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    createdBy: uuid("created_by"),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
    deactivatedBy: uuid("deactivated_by"),

    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // Los nombres de usuario se comparan siempre en minúsculas.
    uniqueIndex("users_username_lower_idx").on(sql`lower(${table.username})`),
    index("users_role_idx").on(table.role),
    index("users_active_idx").on(table.active),
    check("users_failed_login_non_negative", sql`${table.failedLoginCount} >= 0`),
  ],
);

/* ========================================================================== */
/* 2. Sesiones                                                                */
/* ========================================================================== */

export const sessions = pgTable(
  "sessions",
  {
    id: primaryId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** SHA-256 del token. El token en claro sólo existe en la cookie del cliente. */
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),

    ip: varchar("ip", { length: 45 }),
    userAgent: text("user_agent"),

    /** Expiración deslizante: se renueva con la actividad. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Techo absoluto: ni con actividad continua la sesión vive más que esto. */
    absoluteExpiresAt: timestamp("absolute_expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),

    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by").references(() => users.id, { onDelete: "set null" }),
    revokeReason: varchar("revoke_reason", { length: 120 }),

    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_idx").on(table.tokenHash),
    index("sessions_user_idx").on(table.userId),
    index("sessions_expires_idx").on(table.expiresAt),
  ],
);

/* ========================================================================== */
/* 3. Miembros del staff                                                      */
/* ========================================================================== */

export const staffMembers = pgTable(
  "staff_members",
  {
    id: primaryId(),
    name: varchar("name", { length: 80 }).notNull(),
    /** SDP | SP | SE | MOD | MOD+ | MOD++ | ADM | ADM+ | ADM++ */
    rank: varchar("rank", { length: 8 }).notNull(),
    /** Derivada del rango en el servidor. Nunca se confía en la que manda el cliente. */
    category: varchar("category", { length: 20 }).notNull(),

    /** Identificador dentro del servidor de rol, opcional. */
    inGameId: varchar("in_game_id", { length: 40 }),
    discordTag: varchar("discord_tag", { length: 40 }),

    active: boolean("active").notNull().default(true),
    notes: text("notes"),
    joinedAt: date("joined_at"),

    /** Baja lógica. El historial nunca se pierde. */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archivedBy: uuid("archived_by").references(() => users.id, { onDelete: "set null" }),
    archiveReason: text("archive_reason"),

    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),

    /**
     * Cuenta del panel a la que corresponde esta ficha, si tiene una.
     *
     * El rol de usuario y el rango de staff siguen siendo dos ejes distintos
     * —pit es Fundador del panel y ADM++ del servidor—, pero la pantalla
     * necesita el vínculo para mostrarle a cada uno su rango real en vez del
     * rol con el que entra.
     */
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),

    /**
     * Identificador de Discord, para que el bot sepa quién fichó.
     *
     * Es el número, no el nombre de usuario: los nombres se cambian y el
     * número no, así que vincular por nombre se rompería el día que alguien se
     * renombre. `discordTag` queda como dato de contacto, esto es el vínculo.
     */
    discordUserId: varchar("discord_user_id", { length: 20 }),

    /**
     * Posición manual dentro de su grupo en la grilla de horas. El equipo
     * ordena la lista como le resulta cómodo y ese orden se conserva.
     *
     * Es el criterio PRINCIPAL de orden. Arranca sembrado por rango —de ahí
     * que la lista aparezca ordenada por jerarquía sin que nadie toque nada—,
     * y a partir de ahí manda lo que el equipo acomode arrastrando.
     */
    displayOrder: integer("display_order").notNull().default(0),

    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // Dos personas activas no pueden llamarse igual: evita cargarle horas al equivocado.
    uniqueIndex("staff_members_name_active_idx")
      .on(sql`lower(${table.name})`)
      .where(sql`${table.archivedAt} is null`),
    // Una ficha activa por cuenta: nadie tiene dos fichas cobrando a la vez.
    uniqueIndex("staff_members_user_active_idx")
      .on(table.userId)
      .where(sql`user_id is not null and archived_at is null`),
    index("staff_members_rank_idx").on(table.rank),
    index("staff_members_active_idx").on(table.active),
    index("staff_members_category_idx").on(table.category),
    index("staff_members_display_order_idx").on(table.displayOrder),
    uniqueIndex("staff_members_discord_idx")
      .on(table.discordUserId)
      .where(sql`discord_user_id is not null and archived_at is null`),
  ],
);

/* ========================================================================== */
/* 4. Historial de rangos                                                     */
/* ========================================================================== */

export const staffRankHistory = pgTable(
  "staff_rank_history",
  {
    id: primaryId(),
    staffMemberId: uuid("staff_member_id")
      .notNull()
      .references(() => staffMembers.id, { onDelete: "cascade" }),
    fromRank: varchar("from_rank", { length: 8 }),
    toRank: varchar("to_rank", { length: 8 }).notNull(),
    /** ascenso | descenso | lateral | alta */
    changeType: varchar("change_type", { length: 12 }).notNull(),
    reason: text("reason"),
    changedBy: uuid("changed_by").references(() => users.id, { onDelete: "set null" }),
    changedByUsername: varchar("changed_by_username", { length: 32 }).notNull(),
    /** Período vigente al momento del cambio, si había uno abierto. */
    weekId: uuid("week_id"),
    createdAt: createdAt(),
  },
  (table) => [
    index("staff_rank_history_member_idx").on(table.staffMemberId, table.createdAt),
    index("staff_rank_history_created_idx").on(table.createdAt),
  ],
);

/* ========================================================================== */
/* 5. Tarifas vigentes por rango                                              */
/* ========================================================================== */

export const rankRates = pgTable(
  "rank_rates",
  {
    rank: varchar("rank", { length: 8 }).primaryKey(),
    category: varchar("category", { length: 20 }).notNull(),
    label: varchar("label", { length: 60 }).notNull(),
    /** Unidades enteras de moneda por hora. */
    ratePerHour: bigint("rate_per_hour", { mode: "number" }).notNull(),
    /** Color de la etiqueta del rango en la planilla. Hex `#rrggbb`. */
    color: varchar("color", { length: 7 }).notNull().default("#6f747d"),
    version: integer("version").notNull().default(1),
    updatedAt: updatedAt(),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  },
  (table) => [check("rank_rates_positive", sql`${table.ratePerHour} > 0`)],
);

/* ========================================================================== */
/* 6. Historial de tarifas                                                    */
/* ========================================================================== */

export const rankRateHistory = pgTable(
  "rank_rate_history",
  {
    id: primaryId(),
    rank: varchar("rank", { length: 8 }).notNull(),
    previousRate: bigint("previous_rate", { mode: "number" }),
    newRate: bigint("new_rate", { mode: "number" }).notNull(),
    reason: text("reason"),
    changedBy: uuid("changed_by").references(() => users.id, { onDelete: "set null" }),
    changedByUsername: varchar("changed_by_username", { length: 32 }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("rank_rate_history_rank_idx").on(table.rank, table.createdAt)],
);

/* ========================================================================== */
/* 7. Períodos de liquidación                                                 */
/* ========================================================================== */

export const weeks = pgTable(
  "weeks",
  {
    id: primaryId(),
    /** Código canónico `YYYY-MM-DD_YYYY-MM-DD`. Único por rango. */
    code: varchar("code", { length: 24 }).notNull(),
    /** Etiqueta editable por el equipo, p. ej. "Semana 36 — Septiembre". */
    label: varchar("label", { length: 80 }),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    /** open | closed */
    status: varchar("status", { length: 12 }).notNull().default("open"),
    notes: text("notes"),

    /** Totales congelados al cerrar. Permiten leer un período sin recalcular nada. */
    frozenTotalMinutes: integer("frozen_total_minutes"),
    frozenTotalAmount: bigint("frozen_total_amount", { mode: "number" }),
    frozenMemberCount: integer("frozen_member_count"),

    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by").references(() => users.id, { onDelete: "set null" }),

    reopenedAt: timestamp("reopened_at", { withTimezone: true }),
    reopenedBy: uuid("reopened_by").references(() => users.id, { onDelete: "set null" }),
    reopenReason: text("reopen_reason"),
    reopenCount: smallint("reopen_count").notNull().default(0),

    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("weeks_code_idx").on(table.code),
    uniqueIndex("weeks_range_idx").on(table.startDate, table.endDate),
    index("weeks_status_idx").on(table.status),
    index("weeks_start_date_idx").on(table.startDate),
    check("weeks_date_order", sql`${table.startDate} <= ${table.endDate}`),
    check("weeks_status_values", sql`${table.status} in ('open', 'closed')`),
    // Un período cerrado tiene siempre sus totales congelados: sin estados a medias.
    check(
      "weeks_closed_has_snapshot",
      sql`(${table.status} = 'open') or (${table.closedAt} is not null and ${table.frozenTotalAmount} is not null)`,
    ),
  ],
);

/* ========================================================================== */
/* 8. Entradas de horas                                                       */
/* ========================================================================== */

export const hourEntries = pgTable(
  "hour_entries",
  {
    id: primaryId(),
    staffMemberId: uuid("staff_member_id")
      .notNull()
      .references(() => staffMembers.id, { onDelete: "restrict" }),
    weekId: uuid("week_id")
      .notNull()
      .references(() => weeks.id, { onDelete: "restrict" }),

    /** Día trabajado. Siempre dentro del rango del período. */
    workDate: date("work_date").notNull(),
    minutes: integer("minutes").notNull(),
    /** Nota opcional del día. La grilla no la exige; el detalle manual sí la admite. */
    reason: varchar("reason", { length: 200 }),

    /**
     * Estado del DÍA: normal | inactivo | justificado | anulado | no_ingresado.
     * Se marca día por día porque una ausencia justificada es de un día
     * concreto, no de la semana entera. Sólo los días en `normal` suman horas
     * y se pagan. Los valores válidos los define `DAY_STATUSES`.
     */
    status: varchar("status", { length: 16 }).notNull().default("normal"),

    /**
     * Los segundos exactos del día. `minutes` es su vista redondeada, y es lo
     * que se liquida.
     *
     * Existe porque los fichajes de Discord son tiempo medido: un turno de
     * 1h 48m 53s no se puede guardar sólo en minutos sin ir perdiendo un cacho
     * en cada turno. Acá se acumula exacto y `minutes` se deriva, así que no
     * hay dos números que puedan contradecirse. Una carga a mano en la planilla
     * escribe los dos.
     */
    seconds: integer("seconds").notNull().default(0),

    recordedBy: uuid("recorded_by").references(() => users.id, { onDelete: "set null" }),
    recordedByUsername: varchar("recorded_by_username", { length: 32 }).notNull(),

    /** Anulación lógica: la entrada sigue existiendo para la auditoría. */
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by").references(() => users.id, { onDelete: "set null" }),
    voidReason: text("void_reason"),

    /** Lote de importación del que proviene, si aplica. */
    importBatchId: uuid("import_batch_id"),

    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /**
     * Una única entrada vigente por persona y día: es el modelo de la grilla,
     * donde cada casilla ES ese registro. El índice lo garantiza en la base y
     * además habilita el upsert de "escribir la casilla".
     * Las anuladas quedan fuera, así que corregir un día no choca con su
     * versión anterior.
     */
    uniqueIndex("hour_entries_day_unique_idx")
      .on(table.staffMemberId, table.weekId, table.workDate)
      .where(sql`voided_at is null`),
    index("hour_entries_week_staff_idx").on(table.weekId, table.staffMemberId),
    index("hour_entries_staff_date_idx").on(table.staffMemberId, table.workDate),
    index("hour_entries_week_date_idx").on(table.weekId, table.workDate),
    index("hour_entries_recorded_by_idx").on(table.recordedBy),
    index("hour_entries_created_idx").on(table.createdAt),
    check("hour_entries_minutes_non_negative", sql`${table.minutes} >= 0`),
    check("hour_entries_minutes_max", sql`${table.minutes} <= 1440`),
  ],
);

/* ========================================================================== */
/* 9. Snapshot semanal por miembro — el registro histórico congelado          */
/* ========================================================================== */

export const weeklyStaffRecords = pgTable(
  "weekly_staff_records",
  {
    id: primaryId(),
    weekId: uuid("week_id")
      .notNull()
      .references(() => weeks.id, { onDelete: "cascade" }),
    staffMemberId: uuid("staff_member_id")
      .notNull()
      .references(() => staffMembers.id, { onDelete: "restrict" }),

    /* --- Copia literal del estado del miembro en ese período --- */
    staffNameSnapshot: varchar("staff_name_snapshot", { length: 80 }).notNull(),
    rankSnapshot: varchar("rank_snapshot", { length: 8 }).notNull(),
    categorySnapshot: varchar("category_snapshot", { length: 20 }).notNull(),
    hourlyRateSnapshot: bigint("hourly_rate_snapshot", { mode: "number" }).notNull(),

    totalMinutes: integer("total_minutes").notNull().default(0),
    calculatedAmount: bigint("calculated_amount", { mode: "number" }).notNull().default(0),
    entryCount: integer("entry_count").notNull().default(0),

    /** Una vez congelado, ningún camino normal del código puede modificarlo. */
    frozenAt: timestamp("frozen_at", { withTimezone: true }),

    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("weekly_records_week_staff_idx").on(table.weekId, table.staffMemberId),
    index("weekly_records_week_idx").on(table.weekId),
    index("weekly_records_staff_idx").on(table.staffMemberId),
    index("weekly_records_rank_idx").on(table.rankSnapshot),
    check("weekly_records_minutes_non_negative", sql`${table.totalMinutes} >= 0`),
    check("weekly_records_amount_non_negative", sql`${table.calculatedAmount} >= 0`),
  ],
);

/* ========================================================================== */
/* 10. Pagos                                                                  */
/* ========================================================================== */

export const payments = pgTable(
  "payments",
  {
    id: primaryId(),
    weekId: uuid("week_id")
      .notNull()
      .references(() => weeks.id, { onDelete: "restrict" }),
    staffMemberId: uuid("staff_member_id")
      .notNull()
      .references(() => staffMembers.id, { onDelete: "restrict" }),
    /** Liquidación exacta que este pago cancela. */
    weeklyRecordId: uuid("weekly_record_id").references(() => weeklyStaffRecords.id, {
      onDelete: "restrict",
    }),

    amount: bigint("amount", { mode: "number" }).notNull(),
    /** Importe que la liquidación decía en el momento del pago. */
    expectedAmount: bigint("expected_amount", { mode: "number" }).notNull(),

    paidAt: timestamp("paid_at", { withTimezone: true }).notNull(),
    paidBy: uuid("paid_by").references(() => users.id, { onDelete: "set null" }),
    paidByUsername: varchar("paid_by_username", { length: 32 }).notNull(),

    /** transferencia | efectivo | in_game | otro */
    method: varchar("method", { length: 20 }).notNull().default("in_game"),
    paymentReference: varchar("payment_reference", { length: 80 }),
    notes: text("notes"),

    /**
     * Clave de idempotencia enviada por el cliente. Impide que un doble click o
     * un reintento de red generen dos pagos por la misma liquidación.
     */
    idempotencyKey: varchar("idempotency_key", { length: 64 }).notNull(),

    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by").references(() => users.id, { onDelete: "set null" }),
    voidReason: text("void_reason"),

    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /**
     * LA REGLA MÁS IMPORTANTE DE ESTA TABLA: una única liquidación vigente por
     * miembro y período. Un pago anulado libera el lugar para registrar el
     * correcto, y la base lo garantiza incluso frente a dos peticiones
     * simultáneas.
     */
    uniqueIndex("payments_week_staff_active_idx")
      .on(table.weekId, table.staffMemberId)
      .where(sql`voided_at is null`),
    uniqueIndex("payments_idempotency_idx").on(table.idempotencyKey),
    index("payments_week_idx").on(table.weekId),
    index("payments_staff_idx").on(table.staffMemberId),
    index("payments_paid_at_idx").on(table.paidAt),
    check("payments_amount_positive", sql`${table.amount} > 0`),
  ],
);

/* ========================================================================== */
/* 11. Auditoría — cadena encadenada por hash                                 */
/* ========================================================================== */

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: primaryId(),
    /** Orden total e inmutable de los hechos. */
    sequence: bigserial("sequence", { mode: "number" }).notNull(),

    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    /** Se copia el nombre: si la cuenta se borra, el registro sigue siendo legible. */
    actorUsername: varchar("actor_username", { length: 32 }).notNull(),
    actorRole: varchar("actor_role", { length: 24 }),

    action: varchar("action", { length: 48 }).notNull(),
    entity: varchar("entity", { length: 40 }).notNull(),
    entityId: varchar("entity_id", { length: 64 }).notNull(),
    /** Descripción legible: "Modificó las horas de Martin". */
    summary: varchar("summary", { length: 240 }).notNull(),

    before: jsonb("before"),
    after: jsonb("after"),
    /** Campos que efectivamente cambiaron. Ahorra comparar dos JSON a ojo. */
    changedFields: jsonb("changed_fields").$type<string[]>(),
    reason: text("reason"),
    metadata: jsonb("metadata"),

    ip: varchar("ip", { length: 45 }),
    userAgent: text("user_agent"),
    /** Correlaciona todos los registros producidos por una misma operación. */
    traceId: varchar("trace_id", { length: 32 }),

    /**
     * Cadena a prueba de manipulación: cada registro incluye el hash del
     * anterior. Alterar o borrar una fila del medio rompe la cadena y la
     * verificación lo detecta.
     */
    hashPrev: varchar("hash_prev", { length: 64 }),
    hash: varchar("hash", { length: 64 }).notNull(),

    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("audit_logs_sequence_idx").on(table.sequence),
    index("audit_logs_created_idx").on(table.createdAt),
    index("audit_logs_entity_idx").on(table.entity, table.entityId),
    index("audit_logs_actor_idx").on(table.actorId),
    index("audit_logs_action_idx").on(table.action),
  ],
);

/* ========================================================================== */
/* 12. Eventos de seguridad                                                   */
/* ========================================================================== */

export const securityEvents = pgTable(
  "security_events",
  {
    id: primaryId(),
    eventType: varchar("event_type", { length: 40 }).notNull(),
    /** info | warning | critical */
    severity: varchar("severity", { length: 12 }).notNull().default("info"),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),

    /**
     * Identificador de Discord, para que el bot sepa quién fichó.
     *
     * Es el número, no el nombre de usuario: los nombres se cambian y el
     * número no, así que vincular por nombre se rompería el día que alguien se
     * renombre. `discordTag` queda como dato de contacto, esto es el vínculo.
     */
    discordUserId: varchar("discord_user_id", { length: 20 }),
    username: varchar("username", { length: 32 }),
    ip: varchar("ip", { length: 45 }),
    userAgent: text("user_agent"),
    details: jsonb("details"),
    createdAt: createdAt(),
  },
  (table) => [
    index("security_events_created_idx").on(table.createdAt),
    index("security_events_type_idx").on(table.eventType),
    index("security_events_severity_idx").on(table.severity),
    index("security_events_username_idx").on(table.username),
  ],
);

/* ========================================================================== */
/* 13. Intentos de acceso — límite de tasa persistente                        */
/* ========================================================================== */

export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: primaryId(),
    /** Clave del cubo: `ip:usuario` o `ip`. */
    bucketKey: varchar("bucket_key", { length: 120 }).notNull(),
    attempts: integer("attempts").notNull().default(1),
    firstAttemptAt: timestamp("first_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("login_attempts_bucket_idx").on(table.bucketKey),
    index("login_attempts_locked_idx").on(table.lockedUntil),
  ],
);

/* ========================================================================== */
/* 14. Configuración del sistema                                              */
/* ========================================================================== */

export const systemSettings = pgTable("system_settings", {
  key: varchar("key", { length: 48 }).primaryKey(),
  value: text("value").notNull(),
  /** string | number | boolean | json */
  valueType: varchar("value_type", { length: 12 }).notNull().default("string"),
  label: varchar("label", { length: 120 }).notNull(),
  description: text("description"),
  updatedAt: updatedAt(),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
});

/* ========================================================================== */
/* 15. Lotes de importación                                                   */
/* ========================================================================== */

export const importBatches = pgTable(
  "import_batches",
  {
    id: primaryId(),
    /** hours | staff */
    kind: varchar("kind", { length: 16 }).notNull(),
    filename: varchar("filename", { length: 200 }).notNull(),
    weekId: uuid("week_id").references(() => weeks.id, { onDelete: "set null" }),

    totalRows: integer("total_rows").notNull().default(0),
    importedRows: integer("imported_rows").notNull().default(0),
    skippedRows: integer("skipped_rows").notNull().default(0),
    /** pending | applied | failed | rolled_back */
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    errors: jsonb("errors").$type<string[]>(),

    importedBy: uuid("imported_by").references(() => users.id, { onDelete: "set null" }),
    importedByUsername: varchar("imported_by_username", { length: 32 }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("import_batches_created_idx").on(table.createdAt)],
);

/* ========================================================================== */
/* Relaciones                                                                 */
/* ========================================================================== */

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  auditLogs: many(auditLogs),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const staffMembersRelations = relations(staffMembers, ({ many, one }) => ({
  hourEntries: many(hourEntries),
  weeklyRecords: many(weeklyStaffRecords),
  payments: many(payments),
  rankHistory: many(staffRankHistory),
  creator: one(users, { fields: [staffMembers.createdBy], references: [users.id] }),
}));

export const staffRankHistoryRelations = relations(staffRankHistory, ({ one }) => ({
  staffMember: one(staffMembers, {
    fields: [staffRankHistory.staffMemberId],
    references: [staffMembers.id],
  }),
}));

export const weeksRelations = relations(weeks, ({ many, one }) => ({
  hourEntries: many(hourEntries),
  weeklyRecords: many(weeklyStaffRecords),
  payments: many(payments),
  creator: one(users, { fields: [weeks.createdBy], references: [users.id] }),
  closer: one(users, { fields: [weeks.closedBy], references: [users.id] }),
}));

export const hourEntriesRelations = relations(hourEntries, ({ one }) => ({
  staffMember: one(staffMembers, {
    fields: [hourEntries.staffMemberId],
    references: [staffMembers.id],
  }),
  week: one(weeks, { fields: [hourEntries.weekId], references: [weeks.id] }),
  recorder: one(users, { fields: [hourEntries.recordedBy], references: [users.id] }),
}));

export const weeklyStaffRecordsRelations = relations(weeklyStaffRecords, ({ one, many }) => ({
  week: one(weeks, { fields: [weeklyStaffRecords.weekId], references: [weeks.id] }),
  staffMember: one(staffMembers, {
    fields: [weeklyStaffRecords.staffMemberId],
    references: [staffMembers.id],
  }),
  payments: many(payments),
}));

export const paymentsRelations = relations(payments, ({ one }) => ({
  week: one(weeks, { fields: [payments.weekId], references: [weeks.id] }),
  staffMember: one(staffMembers, {
    fields: [payments.staffMemberId],
    references: [staffMembers.id],
  }),
  weeklyRecord: one(weeklyStaffRecords, {
    fields: [payments.weeklyRecordId],
    references: [weeklyStaffRecords.id],
  }),
  payer: one(users, { fields: [payments.paidBy], references: [users.id] }),
}));

export const auditLogsRelations = relations(auditLogs, ({ one }) => ({
  actor: one(users, { fields: [auditLogs.actorId], references: [users.id] }),
}));

/* ========================================================================== */
/* Tipos inferidos                                                            */
/* ========================================================================== */

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type StaffMember = typeof staffMembers.$inferSelect;
export type NewStaffMember = typeof staffMembers.$inferInsert;
export type StaffRankChange = typeof staffRankHistory.$inferSelect;
export type RankRate = typeof rankRates.$inferSelect;
export type RankRateChange = typeof rankRateHistory.$inferSelect;
export type Week = typeof weeks.$inferSelect;
export type NewWeek = typeof weeks.$inferInsert;
export type HourEntry = typeof hourEntries.$inferSelect;
export type NewHourEntry = typeof hourEntries.$inferInsert;
export type WeeklyStaffRecord = typeof weeklyStaffRecords.$inferSelect;
export type NewWeeklyStaffRecord = typeof weeklyStaffRecords.$inferInsert;
export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;

/* ========================================================================== */
/* 16. Fichajes — entrada y salida desde Discord                              */
/* ========================================================================== */

/**
 * Un fichaje es un turno medido: entrada, salida y el tiempo entre las dos.
 *
 * Es DISTINTO de `hour_entries`, y la diferencia importa. `hour_entries` es la
 * casilla del día en la planilla —lo que se liquida—, y acá viven los turnos
 * reales que la fueron llenando. Un día puede tener cuatro fichajes; la casilla
 * es uno solo. Separarlos permite mostrar en Discord "entraste a las 22:10,
 * saliste a las 00:20" sin ensuciar la liquidación, y permite auditar de dónde
 * salió cada minuto de una semana.
 *
 * Al cerrarse, el fichaje se reparte por día local —un turno que cruza la
 * medianoche son dos días— y suma sus segundos a la casilla de cada uno.
 */
export const shiftSessions = pgTable(
  "shift_sessions",
  {
    id: primaryId(),
    staffMemberId: uuid("staff_member_id")
      .notNull()
      .references(() => staffMembers.id, { onDelete: "cascade" }),

    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    /** Nulo mientras el fichaje sigue abierto. */
    endedAt: timestamp("ended_at", { withTimezone: true }),

    /** Día local en que empezó. Para agrupar los reportes sin recalcular husos. */
    startDate: date("start_date").notNull(),

    /** Duración exacta, al cerrarse. */
    seconds: integer("seconds").notNull().default(0),

    /** discord | panel | sistema */
    source: varchar("source", { length: 16 }).notNull().default("discord"),

    discordUserId: varchar("discord_user_id", { length: 20 }),
    discordUsername: varchar("discord_username", { length: 64 }),

    /** Quién lo cerró, si no fue la propia persona. */
    closedByDiscordId: varchar("closed_by_discord_id", { length: 20 }),
    /** normal | forzado | automatico */
    closeReason: varchar("close_reason", { length: 32 }),

    /** Si sus segundos ya se sumaron a la planilla. Evita contar dos veces. */
    applied: boolean("applied").notNull().default(false),

    note: varchar("note", { length: 200 }),

    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /**
     * Un solo fichaje abierto por persona.
     *
     * Lo garantiza la base y no una consulta previa: dos clicks seguidos en
     * "Entrada" llegan juntos, las dos consultas verían "no hay ninguno
     * abierto" y las dos insertarían. Con el índice, una gana y la otra recibe
     * un error que se traduce en "ya tenés un fichaje abierto".
     */
    uniqueIndex("shift_sessions_open_unique_idx")
      .on(table.staffMemberId)
      .where(sql`ended_at is null`),
    index("shift_sessions_staff_date_idx").on(table.staffMemberId, table.startDate),
    index("shift_sessions_date_idx").on(table.startDate),
  ],
);

export type ShiftSession = typeof shiftSessions.$inferSelect;
export type NewShiftSession = typeof shiftSessions.$inferInsert;

export type SecurityEvent = typeof securityEvents.$inferSelect;
export type NewSecurityEvent = typeof securityEvents.$inferInsert;
export type LoginAttempt = typeof loginAttempts.$inferSelect;
export type SystemSetting = typeof systemSettings.$inferSelect;
export type ImportBatch = typeof importBatches.$inferSelect;
