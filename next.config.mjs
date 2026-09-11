/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  /**
   * `standalone` empaqueta el servidor con sus dependencias en `.next/standalone`.
   * Lo necesita el Dockerfile; en Vercel, Render o Railway sobra y sólo hace el
   * build más lento, así que se activa únicamente cuando se pide.
   */
  ...(process.env.BUILD_STANDALONE === "true" ? { output: "standalone" } : {}),

  /**
   * Los drivers de base de datos usan binarios y APIs de Node: no deben pasar
   * por el empaquetador.
   */
  serverExternalPackages: ["@electric-sql/pglite", "pg"],

  /**
   * Las cabeceras de seguridad se definen en un único lugar, `src/middleware.ts`,
   * porque la CSP necesita un nonce distinto por petición y eso no se puede
   * expresar en una cabecera estática. Duplicarlas acá sólo llevaría a que las
   * dos definiciones se contradigan con el tiempo.
   */
};

export default nextConfig;
