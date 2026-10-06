import { onBeforeUnmount, ref } from 'vue';

export interface SectionGroup { g: string; items: Array<{ id: string; t: string }> }

/**
 * Menú de secciones de un panel: marca la sección que se está viendo (la última cuyo borde superior ya ha llegado a la parte alta de la
 * columna `.ui-main`, que es lo que se desplaza) y salta directamente a una sección (sin animación: así siempre queda alineada arriba).
 */
export function useSections(groups: SectionGroup[]): { active: ReturnType<typeof ref<string>>; go: (id: string) => void; start: () => void } {
  const active = ref(groups[0].items[0].id);
  let mainEl: HTMLElement | null = null;
  function pick(): void {
    if (!mainEl) return;
    const top = mainEl.getBoundingClientRect().top;
    let cur = groups[0].items[0].id;
    for (const g of groups) for (const i of g.items) { const el = document.getElementById(i.id); if (el && el.getBoundingClientRect().top - top <= 80) cur = i.id; }
    active.value = cur;
  }
  function start(): void {
    mainEl?.removeEventListener('scroll', pick);
    mainEl = document.querySelector<HTMLElement>('.ui-main');
    mainEl?.addEventListener('scroll', pick, { passive: true });
    pick();
  }
  function go(id: string): void { active.value = id; document.getElementById(id)?.scrollIntoView({ block: 'start' }); }
  onBeforeUnmount(() => mainEl?.removeEventListener('scroll', pick));
  return { active, go, start };
}
