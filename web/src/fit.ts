import { onBeforeUnmount, onMounted } from 'vue';

/**
 * Hace que el contenido de un panel ocupe exactamente lo que queda de ventana bajo lo que hay encima (barras, título, filtros):
 * así lo de arriba no se mueve nunca y solo se desplaza el contenido. Deja la altura en la variable CSS indicada.
 * `refit()` se vuelve a llamar si lo de arriba cambia de alto (p. ej. cuando el panel aparece después de cargar los datos).
 */
export function useFit(selector = '.fit', cssVar = '--fit-h', min = 280): { refit: () => void } {
  let obs: ResizeObserver | undefined;
  const refit = (): void => {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY;
    const bar = document.querySelector<HTMLElement>('.ui-actionbar');   // barra de acciones fija bajo el panel (formularios largos)
    const reserve = bar ? bar.offsetHeight + 13 : 0;
    document.documentElement.style.setProperty(cssVar, `${Math.max(min, Math.floor(window.innerHeight - top - 14 - reserve))}px`);
  };
  onMounted(() => {
    refit();
    window.addEventListener('resize', refit);
    obs = new ResizeObserver(refit);
    for (const el of document.querySelectorAll('.topbar, .demo-bar, .page-title, .toolbar, .ui-actionbar')) obs.observe(el);
  });
  onBeforeUnmount(() => {
    window.removeEventListener('resize', refit);
    obs?.disconnect();
    document.documentElement.style.removeProperty(cssVar);
  });
  return { refit };
}
