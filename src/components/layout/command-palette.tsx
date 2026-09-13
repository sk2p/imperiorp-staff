"use client";

import { useRouter } from "next/navigation";
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import { PERMISSIONS } from "@/domain/permissions";
import { Icon } from "./icons";
import type { NavItem } from "./navigation";

/**
 * Buscador del panel: Ctrl+K (⌘K en Mac) desde cualquier pantalla.
 *
 * Tres cosas en un solo lugar: ir a una pantalla, hacer lo de todos los días
 * —cargar horas, abrir un período— y encontrar a alguien del staff por nombre
 * sin pasar por la lista de cuarenta. Con el teclado no hace falta el mouse
 * para nada: flechas, Enter y listo.
 *
 * El staff se pide la primera vez que se abre, no al cargar cada pantalla.
 * Mandar la lista con cada página —y con cada refresco en vivo— sería pagar
 * una consulta por algo que la mayoría de las veces nadie abre.
 *
 * Qué NO hace: saltarse permisos. Las acciones se muestran según los permisos
 * de la cuenta, y cada pantalla vuelve a exigir el suyo al abrirla.
 */

/** Evento para abrir el buscador desde cualquier botón, sin pasar funciones por el árbol. */
export const ABRIR_BUSCADOR = "imperio:abrir-paleta";

type Grupo = "Ir a" | "Acciones" | "Staff";

interface Opcion {
  readonly id: string;
  readonly grupo: Grupo;
  readonly titulo: string;
  readonly detalle?: string;
  readonly href: string;
  readonly icono: string;
  /** El texto contra el que se busca, ya normalizado. */
  readonly clave: string;
}

interface Ficha {
  readonly id: string;
  readonly name: string;
  readonly rank: string;
}

/** Sin tildes y en minúscula: "periodo" encuentra "Períodos", "joaquin" a "Joaquín". */
function normalizar(texto: string): string {
  // Separada en letra + tilde, se descartan las marcas diacríticas (U+0300 a
  // U+036F). Sin expresión regular: el rango escrito con caracteres invisibles
  // es imposible de leer.
  return Array.from(texto.normalize("NFD"))
    .filter((letra) => {
      const codigo = letra.codePointAt(0) ?? 0;
      return codigo < 0x300 || codigo > 0x36f;
    })
    .join("")
    .toLowerCase()
    .trim();
}

/** Con la consulta vacía el staff no se lista: serían cuarenta renglones de golpe. */
const MAX_STAFF = 8;

export function CommandPalette({
  items,
  permisos,
}: {
  readonly items: readonly NavItem[];
  readonly permisos: readonly string[];
}) {
  const router = useRouter();
  const dialogo = useRef<HTMLDialogElement>(null);
  const listaId = useId();

  const [abierto, setAbierto] = useState(false);
  const [consulta, setConsulta] = useState("");
  const [activo, setActivo] = useState(0);
  const [staff, setStaff] = useState<readonly Ficha[] | null>(null);
  const pedido = useRef(false);

  const cargarStaff = useCallback(() => {
    if (pedido.current) return;
    pedido.current = true;

    void fetch("/api/paleta", { cache: "no-store", headers: { accept: "application/json" } })
      .then((respuesta) => (respuesta.ok ? respuesta.json() : null))
      .then((datos: unknown) => {
        const lista =
          datos !== null &&
          typeof datos === "object" &&
          "staff" in datos &&
          Array.isArray(datos.staff)
            ? (datos.staff as Ficha[])
            : [];
        setStaff(lista);
      })
      .catch(() => {
        // Se vuelve a intentar la próxima vez que se abra.
        pedido.current = false;
        setStaff([]);
      });
  }, []);

  const abrir = useCallback(() => {
    const elemento = dialogo.current;
    if (!elemento || elemento.open) return;

    setConsulta("");
    setActivo(0);
    setAbierto(true);
    elemento.showModal();
    cargarStaff();
  }, [cargarStaff]);

  const cerrar = useCallback(() => {
    dialogo.current?.close();
  }, []);

  useEffect(() => {
    const alTeclear = (evento: globalThis.KeyboardEvent) => {
      if ((evento.ctrlKey || evento.metaKey) && evento.key.toLowerCase() === "k") {
        evento.preventDefault();
        if (dialogo.current?.open) cerrar();
        else abrir();
      }
    };

    window.addEventListener("keydown", alTeclear);
    window.addEventListener(ABRIR_BUSCADOR, abrir);
    return () => {
      window.removeEventListener("keydown", alTeclear);
      window.removeEventListener(ABRIR_BUSCADOR, abrir);
    };
  }, [abrir, cerrar]);

  const opciones = useMemo<readonly Opcion[]>(() => {
    const puede = (permiso: string) => permisos.includes(permiso);

    const acciones: { href: string; label: string; icon: string; permiso: string }[] = [
      { href: "/horas", label: "Cargar horas", icon: "plus", permiso: PERMISSIONS.HOURS_CREATE },
      {
        href: "/pagos",
        label: "Registrar pagos",
        icon: "wallet",
        permiso: PERMISSIONS.PAYMENTS_CREATE,
      },
      {
        href: "/periodos",
        label: "Abrir o cerrar un período",
        icon: "calendar",
        permiso: PERMISSIONS.WEEKS_CREATE,
      },
      {
        href: "/staff",
        label: "Dar de alta a alguien",
        icon: "users",
        permiso: PERMISSIONS.STAFF_CREATE,
      },
    ];

    const todas: Opcion[] = [
      ...items.map((item) => ({
        id: "ir:" + item.href,
        grupo: "Ir a" as const,
        titulo: item.label,
        href: item.href,
        icono: item.icon,
        clave: normalizar(item.label),
      })),
      ...acciones
        .filter((accion) => puede(accion.permiso))
        .map((accion) => ({
          id: "accion:" + accion.label,
          grupo: "Acciones" as const,
          titulo: accion.label,
          href: accion.href,
          icono: accion.icon,
          clave: normalizar(accion.label),
        })),
      ...(staff ?? []).map((ficha) => ({
        id: "staff:" + ficha.id,
        grupo: "Staff" as const,
        titulo: ficha.name,
        detalle: ficha.rank,
        href: "/staff/" + ficha.id,
        icono: "user",
        clave: normalizar(ficha.name + " " + ficha.rank),
      })),
    ];

    const buscado = normalizar(consulta);
    if (!buscado) return todas.filter((opcion) => opcion.grupo !== "Staff");

    // Cada palabra tiene que aparecer, en cualquier orden: "mod sofi" encuentra
    // a Sofía, que es MOD++.
    const palabras = buscado.split(/\s+/);
    const coinciden = todas.filter((opcion) =>
      palabras.every((palabra) => opcion.clave.includes(palabra)),
    );

    let enStaff = 0;
    return coinciden.filter((opcion) => opcion.grupo !== "Staff" || ++enStaff <= MAX_STAFF);
  }, [items, permisos, staff, consulta]);

  const indice = opciones.length === 0 ? -1 : Math.min(activo, opciones.length - 1);

  // La opción marcada con el teclado siempre queda a la vista.
  useEffect(() => {
    if (indice < 0) return;
    document.getElementById(listaId + "-" + indice)?.scrollIntoView({ block: "nearest" });
  }, [indice, listaId]);

  const ir = (opcion: Opcion | undefined) => {
    if (!opcion) return;
    cerrar();
    router.push(opcion.href);
  };

  const teclas = (evento: KeyboardEvent<HTMLInputElement>) => {
    if (opciones.length === 0) return;

    if (evento.key === "ArrowDown") {
      evento.preventDefault();
      setActivo((indice + 1) % opciones.length);
    } else if (evento.key === "ArrowUp") {
      evento.preventDefault();
      setActivo((indice - 1 + opciones.length) % opciones.length);
    } else if (evento.key === "Enter") {
      evento.preventDefault();
      ir(opciones[indice]);
    }
  };

  return (
    <dialog
      ref={dialogo}
      aria-label="Buscar en el panel"
      className="paleta"
      onClose={() => setAbierto(false)}
      onClick={(evento) => {
        // Un clic en el fondo, fuera de la caja, cierra.
        if (evento.target === dialogo.current) cerrar();
      }}
    >
      {abierto ? (
        <div className="paleta-caja">
          <div className="paleta-campo">
            <Icon name="search" size={17} className="text-chalk-500 shrink-0" />
            <input
              autoFocus
              value={consulta}
              onChange={(evento) => {
                setConsulta(evento.target.value);
                setActivo(0);
              }}
              onKeyDown={teclas}
              placeholder="Buscar pantallas, acciones o staff…"
              role="combobox"
              aria-expanded="true"
              aria-controls={listaId}
              aria-autocomplete="list"
              aria-activedescendant={indice >= 0 ? listaId + "-" + indice : undefined}
              autoComplete="off"
              spellCheck={false}
            />
            <kbd className="paleta-tecla">Esc</kbd>
          </div>

          <ul id={listaId} role="listbox" aria-label="Resultados" className="paleta-lista">
            {opciones.length === 0 ? (
              <li className="paleta-vacia">
                {staff === null ? "Buscando…" : "Nada coincide con “" + consulta + "”."}
              </li>
            ) : (
              opciones.map((opcion, posicion) => (
                <Fragment key={opcion.id}>
                  {posicion === 0 || opciones[posicion - 1]?.grupo !== opcion.grupo ? (
                    <li role="presentation" className="paleta-grupo">
                      {opcion.grupo}
                    </li>
                  ) : null}
                  <li
                    id={listaId + "-" + posicion}
                    role="option"
                    aria-selected={posicion === indice}
                    data-activo={posicion === indice}
                    className="paleta-opcion"
                    onMouseMove={() => {
                      if (posicion !== indice) setActivo(posicion);
                    }}
                    onClick={() => ir(opcion)}
                  >
                    <span className="paleta-icono">
                      <Icon name={opcion.icono} size={15} />
                    </span>
                    <span className="min-w-0 flex-1 truncate">{opcion.titulo}</span>
                    {opcion.detalle ? (
                      <span className="paleta-detalle">{opcion.detalle}</span>
                    ) : null}
                    {posicion === indice ? (
                      <span className="paleta-enter" aria-hidden>
                        ↵
                      </span>
                    ) : null}
                  </li>
                </Fragment>
              ))
            )}
          </ul>

          <div className="paleta-pie" aria-hidden>
            <span>
              <kbd>↑</kbd>
              <kbd>↓</kbd> moverse
            </span>
            <span>
              <kbd>↵</kbd> abrir
            </span>
            <span>
              <kbd>Ctrl</kbd>
              <kbd>K</kbd> abrir o cerrar
            </span>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
