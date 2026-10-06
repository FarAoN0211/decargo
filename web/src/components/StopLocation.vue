<script setup lang="ts">
/** Ubicación de un lugar de carga o descarga: enlace del mapa o coordenadas e indicaciones para el conductor.
 *  Si el lugar viene de la agenda, llega ya rellena; si no, lo que se escriba aquí se guarda en la agenda al crear el transporte. */
interface LocForm { map_url: string; lat: string; lon: string; notes: string; party: string; site_id: string; sites: any[] }
const props = defineProps<{ stop: LocForm; what: 'carga' | 'descarga' }>();
const saved = (): any => props.stop.sites.find((x) => x.id === props.stop.site_id);
const hasLoc = (): boolean => !!(props.stop.map_url.trim() || props.stop.lat.trim() || props.stop.lon.trim());
</script>
<template>
  <fieldset class="ficha stop-loc">
    <legend>Ubicación del lugar de {{ props.what }} <span class="hint small">(para el «Cómo llegar» del conductor)</span></legend>
    <p v-if="props.stop.site_id && (saved()?.maps_url || saved()?.notes)" class="muted small">Cargada de la agenda. Si la cambias, se actualiza el lugar guardado.</p>
    <p v-else-if="props.stop.site_id" class="muted small">Este lugar de la agenda aún no tiene ubicación: lo que pongas aquí se guardará en él.</p>
    <label>Enlace del mapa<span class="hint small"> (Google Maps, Apple Maps, Waze u OpenStreetMap; mejor el enlace largo, que trae las coordenadas)</span>
      <input v-model.trim="props.stop.map_url" maxlength="600" inputmode="url" placeholder="https://www.google.com/maps/@37.17,-3.59,17z" /></label>
    <div class="grid2">
      <label>Latitud<input v-model.trim="props.stop.lat" inputmode="decimal" placeholder="37.177336" /></label>
      <label>Longitud<input v-model.trim="props.stop.lon" inputmode="decimal" placeholder="-3.598557" /></label>
    </div>
    <label>Indicaciones para el conductor<span class="hint small"> (opcional: horario, muelle, persona de contacto, acceso…)</span>
      <input v-model="props.stop.notes" maxlength="500" /></label>
    <p v-if="(hasLoc() || props.stop.notes.trim()) && !props.stop.party.trim()" class="alert alert-warn small">Escribe la empresa de este lugar para poder guardar su ubicación en la agenda.</p>
  </fieldset>
</template>
