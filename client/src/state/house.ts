// Player houses (T5.4, docs/02 "Casas"): the house window built from HouseUpdate, and the
// door tiles of the map (vite/content.ts) so a right click on a bare door opens it. Pure:
// no DOM, no clock. The server validates every action; these helpers only shape the view.
import type { HouseUpdate } from "@rpg/protocol";

/** The house window. Money values are in the smallest coin. */
export interface HouseView {
  id: string;
  /** i18n key of the house name. */
  name: string;
  island: string;
  rent: number;
  periodDays: number;
  size: number;
  /** Owner's name; "" when free. */
  owner: string;
  isOwner: boolean;
  /** Unix ms the rent is paid until (owner only; 0 otherwise). */
  paidUntil: number;
  guests: string[];
  guildAccess: boolean;
  maxGuests: number;
  items: number;
  maxItems: number;
  minLevel: number;
  maxPeriods: number;
  /** Pending transfer: to whom and the price; forMe when offered to this player. */
  transfer: { to: string; price: number; forMe: boolean } | undefined;
  money: number;
  readOnly: boolean;
  access: boolean;
}

/** The window of a HouseUpdate, or undefined when it closes it. */
export function houseFrom(u: HouseUpdate): HouseView | undefined {
  if (!u.open) return undefined;
  return {
    id: u.houseId,
    name: u.name,
    island: u.island,
    rent: Number(u.rent),
    periodDays: u.periodDays,
    size: u.size,
    owner: u.owner,
    isOwner: u.isOwner,
    paidUntil: Number(u.paidUntil),
    guests: [...u.guests],
    guildAccess: u.guildAccess,
    maxGuests: u.maxGuests,
    items: u.items,
    maxItems: u.maxItems,
    minLevel: u.minLevel,
    maxPeriods: u.maxPeriods,
    transfer: u.transferTo
      ? { to: u.transferTo, price: Number(u.transferPrice), forMe: u.transferForMe }
      : undefined,
    money: Number(u.money),
    readOnly: u.readOnly,
    access: u.access,
  };
}

/** What the window offers: the server decides, this only hides what cannot work. */
export function houseActions(h: HouseView): {
  rent: boolean;
  manage: boolean;
  accept: boolean;
} {
  const live = !h.readOnly;
  return {
    rent: live && h.owner === "",
    manage: live && h.isOwner,
    accept: live && !h.isOwner && h.transfer?.forMe === true,
  };
}

/** Whole days (rounded up) until the rent runs out; 0 when it is due. */
export function daysLeft(h: HouseView, now: number): number {
  return Math.max(Math.ceil((h.paidUntil - now) / 86_400_000), 0);
}

/** Key of a door tile in ClientContent.houseDoors. */
export const doorKey = (x: number, y: number, z: number): string => `${x},${y},${z}`;
