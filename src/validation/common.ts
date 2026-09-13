import { z } from "zod";

import { isCalendarDate } from "@/domain/periods";

/**
 * Zod sin `eval`.
 *
 * Para validar objetos más rápido, zod prueba una vez si puede compilar código
 * con `new Function`. La política de seguridad de la página (CSP) no permite
 * evaluar texto como código —es justamente lo que frena una inyección—, así
 * que la prueba falla. Zod se da cuenta y sigue por el camino normal, pero el
 * navegador igual registra la violación de la política en cada carga, y la
 * consola de Chrome lo marca como problema.
 *
 * Con `jitless` zod ni siquiera lo intenta. Lo que se pierde es una
 * optimización pensada para validar miles de objetos por segundo; acá se valida
 * un formulario por vez.
 */
z.config({ jitless: true });

/**
 * IMPERIO RP — Piezas de validación compartidas.
 *
 * Nada entra al dominio sin pasar por un esquema. El cliente manda lo que
 * quiera; lo que llega al servicio es siempre una estructura conocida, con los
 * campos exactos y nada más. Eso cierra de raíz el mass assignment: un campo
 * `role` o `isAdmin` colado en el cuerpo de la petición ni siquiera sobrevive
 * al parseo.
 */

export const uuidSchema = z.string().uuid("Identificador inválido.");

export const calendarDateSchema = z
  .string()
  .refine(isCalendarDate, "La fecha debe tener el formato DD/MM/AAAA y existir en el calendario.");

/**
 * Texto de usuario saneado: sin caracteres de control, sin espacios dobles y
 * sin los márgenes en blanco que la gente pega sin querer.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/g;

export function cleanText(min: number, max: number, label: string) {
  return z
    .string()
    .transform((value) => value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim())
    .pipe(
      z
        .string()
        .min(min, label + " debe tener al menos " + min + " caracteres.")
        .max(max, label + " no puede superar los " + max + " caracteres."),
    );
}

/**
 * Campo de texto opcional.
 *
 * El `.optional()` marca la CLAVE como opcional, no sólo el valor. Sin él, un
 * formulario que simplemente no incluye el campo —la planilla de horas no manda
 * `note`— se rechaza con "expected nonoptional, received undefined", que no
 * ayuda a nadie. Los formularios HTML mandan cadena vacía, que también se
 * normaliza a `null`.
 */
export function optionalText(max: number, label: string) {
  return z
    .union([z.string(), z.null()])
    .optional()
    .transform((value) => {
      if (value === null || value === undefined) return null;
      const cleaned = value.replace(/\s+/g, " ").trim();
      return cleaned.length === 0 ? null : cleaned;
    })
    .pipe(
      z
        .string()
        .max(max, label + " no puede superar los " + max + " caracteres.")
        .nullable(),
    );
}

/**
 * Motivo obligatorio. Toda operación que altera datos históricos exige una
 * explicación: sin ella, la auditoría sirve para saber QUÉ pasó pero nunca
 * POR QUÉ, que es justo lo que se necesita seis meses después.
 */
export const reasonSchema = cleanText(5, 500, "El motivo").refine(
  (value) => !/^(\.|-|test|asd|aaa|xxx|n\/a|na)+$/i.test(value.replace(/\s/g, "")),
  "Escribí un motivo real: va a quedar registrado en la auditoría.",
);

export const optionalReasonSchema = optionalText(500, "El motivo");

/** Versión esperada de la fila, para el control optimista de concurrencia. */
export const versionSchema = z.coerce
  .number()
  .int("La versión debe ser un número entero.")
  .min(1, "Versión inválida.");

/** Clave de idempotencia generada por el cliente para operaciones críticas. */
export const idempotencyKeySchema = z
  .string()
  .min(8, "Clave de idempotencia inválida.")
  .max(64, "Clave de idempotencia inválida.")
  .regex(/^[A-Za-z0-9_-]+$/, "Clave de idempotencia inválida.");

/* -------------------------------------------------------------------------- */
/* Paginación y orden                                                         */
/* -------------------------------------------------------------------------- */

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export type Pagination = z.infer<typeof paginationSchema>;

export interface Paginated<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly pageCount: number;
}

export function paginate<T>(
  items: readonly T[],
  total: number,
  pagination: Pagination,
): Paginated<T> {
  return {
    items,
    total,
    page: pagination.page,
    pageSize: pagination.pageSize,
    pageCount: Math.max(1, Math.ceil(total / pagination.pageSize)),
  };
}

export function offsetFor(pagination: Pagination): number {
  return (pagination.page - 1) * pagination.pageSize;
}

export const sortDirectionSchema = z.enum(["asc", "desc"]).default("desc");

/**
 * Construye un validador de campo de orden a partir de una lista blanca.
 *
 * Es deliberado: aceptar un nombre de columna arbitrario del cliente sería
 * inyección SQL por la puerta de atrás, aunque el ORM escape los valores.
 */
export function sortFieldSchema<const T extends readonly [string, ...string[]]>(
  allowed: T,
  fallback: T[number],
) {
  return z
    .string()
    .optional()
    .transform((value) =>
      value !== undefined && (allowed as readonly string[]).includes(value)
        ? (value as T[number])
        : fallback,
    );
}

/* -------------------------------------------------------------------------- */
/* Búsqueda                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Término de búsqueda saneado para usarlo con `ILIKE`. Se escapan `%`, `_` y
 * `\` para que un usuario no pueda transformar su búsqueda en un comodín que
 * recorra la tabla entera.
 */
export const searchTermSchema = z
  .string()
  .max(80)
  .optional()
  .transform((value) => {
    const trimmed = value?.trim() ?? "";
    return trimmed.length === 0 ? null : trimmed;
  });

export function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, (character) => "\\" + character);
}

export function containsPattern(term: string): string {
  return "%" + escapeLikePattern(term) + "%";
}
