/**
 * Orden manual de los archivos dentro de su zona (lógica pura).
 * El servidor guarda `order` por archivo; aquí calculamos el nuevo orden tras mover uno.
 */
import type { Asset } from "@autoeditor/shared";

/** Orden visible: `order` ascendente y, a igualdad, el más antiguo primero. */
export function sortByOrder<T extends Pick<Asset, "order" | "createdAt" | "id">>(items: T[]): T[] {
  return [...items].sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** Mueve un elemento de `from` a `to` (devuelve una copia). */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, item!);
  return next;
}

/**
 * Cambios de `order` necesarios para que la lista quede como `ordered` (0, 1, 2…).
 * Solo devuelve los que cambian (menos peticiones).
 */
export function orderPatches(ordered: Pick<Asset, "id" | "order">[]): { id: string; order: number }[] {
  return ordered.map((a, i) => ({ id: a.id, order: i, prev: a.order })).filter((p) => p.prev !== p.order).map(({ id, order }) => ({ id, order }));
}

/** Agrupa por categoría conservando el orden de categorías dado. */
export function groupByCategory<T extends Pick<Asset, "category" | "order" | "createdAt" | "id">>(items: T[], categories: readonly string[]): { category: string; items: T[] }[] {
  return categories.map((category) => ({ category, items: sortByOrder(items.filter((a) => a.category === category)) })).filter((g) => g.items.length > 0);
}
