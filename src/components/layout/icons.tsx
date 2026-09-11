import type { ReactElement } from "react";

/**
 * Iconografía propia, trazo de 1.6 px sobre grilla de 20.
 *
 * Se dibujan a mano en lugar de usar una librería: son doce símbolos, pesan
 * unos pocos kilobytes y así la aplicación no hereda el aire genérico que dan
 * los sets de iconos que están en todas partes.
 */

const BASE = {
  width: 18,
  height: 18,
  viewBox: "0 0 20 20",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const PATHS: Record<string, ReactElement> = {
  home: (
    <>
      <path d="M3.5 8.2 10 3l6.5 5.2V16a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" />
      <path d="M8 17v-5h4v5" />
    </>
  ),
  clock: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 6v4.2l2.8 1.7" />
    </>
  ),
  users: (
    <>
      <circle cx="8" cy="7.5" r="2.8" />
      <path d="M3 16.5c0-2.5 2.2-4.2 5-4.2s5 1.7 5 4.2" />
      <path d="M14 5.6a2.6 2.6 0 0 1 0 5" />
      <path d="M15.2 12.6c1.3.6 2.3 1.9 2.3 3.6" />
    </>
  ),
  wallet: (
    <>
      <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h10A1.5 1.5 0 0 1 16 6.5V8" />
      <rect x="3" y="6.5" width="14" height="10" rx="1.6" />
      <path d="M13.4 11.5h2.2" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="4.5" width="14" height="12.5" rx="1.6" />
      <path d="M3 8.4h14M7 3v3M13 3v3" />
    </>
  ),
  chart: (
    <>
      <path d="M3.5 16.5h13" />
      <path d="M6 16.5v-4.2M10 16.5V6.5M14 16.5v-6.8" />
    </>
  ),
  history: (
    <>
      <path d="M3.6 10a6.4 6.4 0 1 0 1.9-4.5" />
      <path d="M3.2 3.6v3.2h3.2" />
      <path d="M10 6.6V10l2.4 1.5" />
    </>
  ),
  shield: (
    <>
      <path d="M10 3 4.8 5.1v4.3c0 3.2 2.1 6.1 5.2 7.1 3.1-1 5.2-3.9 5.2-7.1V5.1z" />
      <path d="m7.8 10 1.6 1.6 3-3.2" />
    </>
  ),
  settings: (
    <>
      <circle cx="10" cy="10" r="2.4" />
      <path d="m10 2.6.9 1.9 2.1-.4.6 2 2 .6-.4 2.1 1.9.9-1.9.9.4 2.1-2 .6-.6 2-2.1-.4-.9 1.9-.9-1.9-2.1.4-.6-2-2-.6.4-2.1L2.6 10l1.9-.9-.4-2.1 2-.6.6-2 2.1.4z" />
    </>
  ),
  user: (
    <>
      <circle cx="10" cy="7" r="3.1" />
      <path d="M4 17c0-3 2.7-4.8 6-4.8s6 1.8 6 4.8" />
    </>
  ),
  plus: <path d="M10 4.5v11M4.5 10h11" />,
  search: (
    <>
      <circle cx="9" cy="9" r="5.2" />
      <path d="m13 13 3.5 3.5" />
    </>
  ),
  logout: (
    <>
      <path d="M12 6V4.6a1.6 1.6 0 0 0-1.6-1.6H4.6A1.6 1.6 0 0 0 3 4.6v10.8A1.6 1.6 0 0 0 4.6 17h5.8a1.6 1.6 0 0 0 1.6-1.6V14" />
      <path d="M7.5 10h9.5M14.5 7.2 17.2 10l-2.7 2.8" />
    </>
  ),
  menu: <path d="M3.5 6h13M3.5 10h13M3.5 14h13" />,
  check: <path d="m4.5 10.5 3.5 3.5 7.5-8" />,
  alert: (
    <>
      <path d="M10 3.5 17 16H3z" />
      <path d="M10 8.2v3.2M10 13.6v.6" />
    </>
  ),
  lock: (
    <>
      <rect x="4.5" y="8.8" width="11" height="7.7" rx="1.6" />
      <path d="M7.2 8.8V6.9a2.8 2.8 0 0 1 5.6 0v1.9" />
    </>
  ),
  download: (
    <>
      <path d="M10 3.5v8.4M6.8 9l3.2 3 3.2-3" />
      <path d="M3.8 14.2v1.6a1.2 1.2 0 0 0 1.2 1.2h10a1.2 1.2 0 0 0 1.2-1.2v-1.6" />
    </>
  ),
  crown: (
    <>
      <path d="M3 6.4 5.6 12h8.8L17 6.4l-3.5 2.4L10 4 6.5 8.8z" />
      <path d="M5.6 15h8.8" />
    </>
  ),
};

export function Icon({
  name,
  className,
  size = 18,
}: {
  readonly name: keyof typeof PATHS | string;
  readonly className?: string;
  readonly size?: number;
}) {
  const path = PATHS[name];
  if (!path) return null;

  return (
    <svg {...BASE} width={size} height={size} className={className} aria-hidden="true">
      {path}
    </svg>
  );
}
