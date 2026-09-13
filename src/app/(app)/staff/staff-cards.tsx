import Link from "next/link";

import { Icon } from "@/components/layout/icons";
import { Badge, cn } from "@/components/ui/primitives";
import { PulsoSemanal } from "@/components/ui/pulso";
import { Tilt } from "@/components/ui/tilt";
import { GROUP_DEFINITIONS, readableTextOn } from "@/domain/groups";
import { formatMoney, formatMoneyCompact } from "@/domain/money";
import { PERMISSIONS, type Permission } from "@/domain/permissions";
import { rankLabel } from "@/domain/ranks";
import { formatMinutes } from "@/domain/time";
import type { StaffBoard, StaffBoardCard } from "@/server/staff";
import {
  ArchiveStaffDialog,
  ChangeRankDialog,
  EditStaffDialog,
  RestoreStaffDialog,
} from "./staff-dialogs";

/**
 * El plantel en fichas.
 *
 * Una fila de tabla obliga a leer en horizontal para juntar nombre, rango,
 * horas y contacto de una persona. Acá cada uno tiene su recuadro: se mira uno
 * y está todo. Los bloques son los mismos de la planilla —High, Mid y Low— y
 * dentro de cada uno el orden es el que el equipo acomodó arrastrando en
 * /horas, así que las dos pantallas cuentan la misma historia.
 */

function Dato({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-chalk-700 text-[0.5625rem] font-semibold tracking-[0.12em] uppercase">
        {label}
      </p>
      <p className="text-chalk-300 mt-0.5 truncate text-xs">{children}</p>
    </div>
  );
}

function StaffCard({
  card,
  can,
}: {
  readonly card: StaffBoardCard;
  readonly can: (permission: Permission) => boolean;
}) {
  const archived = card.archivedAt !== null;
  const member = {
    id: card.id,
    name: card.name,
    rank: card.rank,
    inGameId: card.inGameId,
    discordTag: card.discordTag,
    joinedAt: card.joinedAt,
    notes: card.notes,
    version: card.version,
  };

  return (
    <article
      className={cn("staff-card group", archived && "opacity-55")}
      style={{ "--rank": card.rankColor } as React.CSSProperties}
    >
      {/* Filo de color del rango: identifica la ficha de un vistazo, sin leer. */}
      <span aria-hidden className="staff-card-edge" />

      <header className="flex items-start gap-2.5">
        <span
          className="capa capa-alta flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[0.6875rem] font-black"
          style={{ backgroundColor: card.rankColor, color: readableTextOn(card.rankColor) }}
        >
          {card.name.slice(0, 2).toUpperCase()}
        </span>

        <div className="capa capa-media min-w-0 flex-1">
          <Link
            href={"/staff/" + card.id}
            className="text-chalk-50 hover:text-imperial-400 block truncate text-sm font-semibold transition"
          >
            {card.name}
          </Link>
          <p className="text-chalk-600 mt-0.5 truncate text-[0.6875rem]">{rankLabel(card.rank)}</p>
        </div>

        <span
          className="capa capa-alta shrink-0 rounded-md px-1.5 py-0.5 text-[0.625rem] font-bold"
          style={{ backgroundColor: card.rankColor, color: readableTextOn(card.rankColor) }}
        >
          {card.rank}
        </span>
      </header>

      {archived ? (
        <Badge tone="muted" className="mt-2.5 self-start">
          Archivado
        </Badge>
      ) : null}

      <div className="capa border-line mt-3 grid grid-cols-2 gap-2.5 border-t pt-3">
        <Dato label="Horas del período">
          <span className="tnum text-chalk-100 font-semibold">
            {formatMinutes(card.periodMinutes)}
          </span>
        </Dato>
        <Dato label="Le corresponde">
          <span className="tnum text-chalk-100 font-semibold">
            {formatMoneyCompact(card.periodAmount)}
          </span>
        </Dato>
        <Dato label="Discord">{card.discordTag ?? "—"}</Dato>
        <Dato label="ID en el servidor">
          <span className={card.inGameId ? "mono" : undefined}>{card.inGameId ?? "—"}</span>
        </Dato>

        {/*
          El reparto de la semana, día por día.

          Va como una fila propia de la grilla y no adentro del dato de horas:
          ese párrafo recorta lo que se pasa de ancho, y el pulso quedaba
          cortado con puntos suspensivos. Acá tiene el ancho de la ficha entera,
          que además es donde mejor se lee la forma de la semana.
        */}
        <div className="col-span-2">
          <p className="text-chalk-700 text-[0.5625rem] font-semibold tracking-[0.12em] uppercase">
            Cómo se repartió
          </p>
          <PulsoSemanal dias={card.periodDays} className="mt-1" />
        </div>
      </div>

      <footer className="capa mt-3 flex items-center justify-between gap-2">
        <span className="tnum text-chalk-700 text-[0.625rem]">
          {formatMoney(card.hourlyRate)}/hora
        </span>

        <div className="flex items-center gap-0.5 opacity-70 transition-opacity group-hover:opacity-100">
          {archived ? (
            can(PERMISSIONS.STAFF_EDIT) ? (
              <RestoreStaffDialog member={member} />
            ) : null
          ) : (
            <>
              {can(PERMISSIONS.STAFF_EDIT) ? <EditStaffDialog member={member} /> : null}
              {can(PERMISSIONS.STAFF_CHANGE_RANK) ? <ChangeRankDialog member={member} /> : null}
              {can(PERMISSIONS.STAFF_DELETE) ? <ArchiveStaffDialog member={member} /> : null}
            </>
          )}
        </div>
      </footer>
    </article>
  );
}

export function StaffCards({
  board,
  can,
}: {
  readonly board: StaffBoard;
  readonly can: (permission: Permission) => boolean;
}) {
  return (
    <div className="flex flex-col gap-5">
      {board.groups.map((group) => {
        const definition = GROUP_DEFINITIONS[group.group];

        return (
          <section key={group.group}>
            <header className="mb-2.5 flex flex-wrap items-center justify-between gap-2 px-0.5">
              <span className="flex items-center gap-2">
                <span className={cn("h-2 w-2 rounded-full", definition.dot)} />
                <span
                  className={cn(
                    "text-[0.6875rem] font-bold tracking-[0.12em] uppercase",
                    definition.accent,
                  )}
                >
                  {definition.label}
                </span>
                <span className="text-chalk-700 text-[0.6875rem]">
                  {group.cards.length} {group.cards.length === 1 ? "integrante" : "integrantes"}
                </span>
              </span>

              <span className="tnum text-chalk-600 text-[0.6875rem]">
                {formatMinutes(group.totalMinutes)}
                <span className="text-chalk-700 mx-2">·</span>
                <span className="text-chalk-300 font-semibold">
                  {formatMoneyCompact(group.totalAmount)}
                </span>
              </span>
            </header>

            <div className="stagger grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {group.cards.map((card) => (
                <Tilt key={card.id}>
                  <StaffCard card={card} can={can} />
                </Tilt>
              ))}
            </div>
          </section>
        );
      })}

      {board.groups.length === 0 ? (
        <p className="text-chalk-600 flex items-center justify-center gap-2 py-10 text-xs">
          <Icon name="users" size={16} />
          No hay nadie en el staff todavía.
        </p>
      ) : null}
    </div>
  );
}
