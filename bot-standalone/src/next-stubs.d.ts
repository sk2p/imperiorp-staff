/**
 * Stubs mínimos de next/headers para que TypeScript resuelva los imports
 * de context.ts y session.ts sin instalar Next.js.
 *
 * Estos módulos NO se ejecutan en el bot — el bot usa systemActor(), que
 * no toca headers ni cookies. Esto solo existe para que tsc no se queje.
 */
declare module "next/headers" {
  export function headers(): Promise<ReadonlyHeaders>;
  export function cookies(): Promise<ReadonlyCookies>;

  interface ReadonlyHeaders {
    get(name: string): string | null;
    has(name: string): boolean;
    entries(): IterableIterator<[string, string]>;
    forEach(callback: (value: string, key: string) => void): void;
    keys(): IterableIterator<string>;
    values(): IterableIterator<string>;
  }

  interface ReadonlyCookies {
    get(name: string): { name: string; value: string } | undefined;
    getAll(): Array<{ name: string; value: string }>;
    has(name: string): boolean;
    set(name: string, value: string, options?: Record<string, unknown>): void;
    delete(name: string): void;
  }
}

declare module "react" {
  export function cache<T extends (...args: any[]) => any>(fn: T): T;
}

/** Tipo DOM que usa backup.ts pero no está disponible sin la lib "dom". */
declare type BlobPart = string | Blob | BufferSource;
declare interface Blob {
  readonly size: number;
  readonly type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
  slice(start?: number, end?: number, contentType?: string): Blob;
  text(): Promise<string>;
}
