import { z } from "zod";

import { ALL_PERMISSIONS, USER_ROLES } from "@/domain/permissions";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@/lib/auth/password";
import {
  cleanText,
  optionalText,
  paginationSchema,
  reasonSchema,
  searchTermSchema,
  uuidSchema,
  versionSchema,
} from "./common";

/** Contratos de entrada para usuarios del sistema y autenticación. */

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, "El usuario debe tener al menos 3 caracteres.")
  .max(32, "El usuario no puede superar los 32 caracteres.")
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/,
    "El usuario admite letras, números, punto, guion y guion bajo, y debe empezar con letra o número.",
  );

export const passwordSchema = z
  .string()
  .min(
    MIN_PASSWORD_LENGTH,
    "La contraseña debe tener al menos " + MIN_PASSWORD_LENGTH + " caracteres.",
  )
  .max(MAX_PASSWORD_LENGTH, "La contraseña es demasiado larga.");

/**
 * En el login NO se aplican las reglas de fortaleza.
 *
 * Exigir mayúsculas o longitud mínima al iniciar sesión le revela a un atacante
 * qué forma tienen las contraseñas válidas y deja afuera a cuentas antiguas.
 * La fortaleza se exige al CREAR o CAMBIAR la contraseña, que es donde importa.
 */
export const loginSchema = z.object({
  username: z.string().trim().toLowerCase().min(1, "Ingresá tu usuario.").max(32),
  password: z.string().min(1, "Ingresá tu contraseña.").max(MAX_PASSWORD_LENGTH),
  /** Destino tras el login. Se valida como ruta interna para evitar open redirect. */
  redirectTo: z
    .string()
    .optional()
    .transform((value) => {
      if (!value) return null;
      // Sólo rutas absolutas del propio sitio. `//evil.com` y `https://…` quedan fuera.
      return /^\/(?!\/)[A-Za-z0-9/_\-?=&.%]*$/.test(value) ? value : null;
    }),
});

export type LoginInput = z.infer<typeof loginSchema>;

export const permissionListSchema = z
  .array(z.enum(ALL_PERMISSIONS as unknown as [string, ...string[]]))
  .max(ALL_PERMISSIONS.length)
  .default([]);

export const createUserSchema = z
  .object({
    username: usernameSchema,
    displayName: optionalText(80, "El nombre visible"),
    password: passwordSchema,
    confirmPassword: z.string(),
    role: z.enum(USER_ROLES, { message: "Seleccioná un rol válido." }),
    grantedPermissions: permissionListSchema,
    revokedPermissions: permissionListSchema,
    mustChangePassword: z.coerce.boolean().default(true),
  })
  .refine((value) => value.password === value.confirmPassword, {
    message: "Las contraseñas no coinciden.",
    path: ["confirmPassword"],
  });

export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z.object({
  id: uuidSchema,
  expectedVersion: versionSchema,
  displayName: optionalText(80, "El nombre visible"),
  role: z.enum(USER_ROLES),
  grantedPermissions: permissionListSchema,
  revokedPermissions: permissionListSchema,
  active: z.coerce.boolean(),
  reason: reasonSchema,
});

export type UpdateUserInput = z.infer<typeof updateUserSchema>;

/** Cambio de contraseña propia: exige la actual para frenar el secuestro de sesión. */
export const changeOwnPasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Ingresá tu contraseña actual."),
    newPassword: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((value) => value.newPassword === value.confirmPassword, {
    message: "Las contraseñas no coinciden.",
    path: ["confirmPassword"],
  })
  .refine((value) => value.newPassword !== value.currentPassword, {
    message: "La contraseña nueva tiene que ser distinta de la actual.",
    path: ["newPassword"],
  });

export type ChangeOwnPasswordInput = z.infer<typeof changeOwnPasswordSchema>;

/** Restablecimiento por un administrador: genera una contraseña temporal. */
export const resetUserPasswordSchema = z.object({
  id: uuidSchema,
  reason: reasonSchema,
  revokeSessions: z.coerce.boolean().default(true),
});

export type ResetUserPasswordInput = z.infer<typeof resetUserPasswordSchema>;

export const updateProfileSchema = z.object({
  displayName: cleanText(2, 80, "El nombre visible"),
});

export const revokeSessionSchema = z.object({
  sessionId: uuidSchema,
});

export const userFiltersSchema = paginationSchema.extend({
  search: searchTermSchema,
  role: z.enum(USER_ROLES).optional(),
  status: z.enum(["all", "active", "inactive"]).default("all"),
});

export type UserFilters = z.infer<typeof userFiltersSchema>;
