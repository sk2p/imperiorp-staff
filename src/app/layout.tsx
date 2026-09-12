import type { Metadata, Viewport } from "next";

import { ToastProvider } from "@/components/ui/interactive";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Imperio RP — Gestión de Staff",
    template: "%s · Imperio RP",
  },
  description:
    "Sistema interno de Imperio RP para el registro de horas, liquidaciones semanales, pagos y auditoría del staff.",
  applicationName: "Imperio RP Staff",
  icons: { icon: "/imperiorplogo.webp", apple: "/imperiorplogo.webp" },
  // Es una herramienta interna: no debe aparecer en buscadores.
  robots: { index: false, follow: false, nocache: true },
  formatDetection: { telephone: false, date: false, address: false, email: false },
};

export const viewport: Viewport = {
  themeColor: "#07080a",
  width: "device-width",
  initialScale: 1,
  // Se permite ampliar: bloquear el zoom rompe la accesibilidad en el teléfono.
  maximumScale: 5,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { readonly children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
