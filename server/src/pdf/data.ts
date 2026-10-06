/**
 * Montaje de los datos que se imprimen en el DeCA a partir de un transporte. Es PURO (sin base de datos ni ficheros) y lo usan igual
 * el servidor y la demostración del navegador: así la demo genera exactamente el mismo documento que la aplicación real.
 */
import { fullAddress, placeFrom } from '../office/address';
import type { DecaData } from './deca-pdf';

export interface StopIn {
  party: string | null; address: string; postal_code?: string | null; city?: string | null; province?: string | null; country?: string | null;
  nif?: string | null; time?: string | null; pallets?: number | null; references?: string[]; seals?: string[];
}
export interface TransportIn {
  shipper_name: string; shipper_nif: string; shipper_address: string; carrier_name: string; carrier_nif: string;
  origin: { text: string; stops?: StopIn[] }; destination: { text: string; stops?: StopIn[] }; cargo_description: string; weight_kg: string | null; alt_magnitude: { text: string } | null;
  aec_ref: string | null; transport_date: string | Date; remarks: string | null;
  price_eur?: string | null; carrier_address?: string | null; packages?: string | null; load_reference?: string | null; temperature?: string | null;
  reference?: string | null; carrier_authorization?: string | null; units?: number | null; packaging?: string | null; adr?: boolean | null; adr_detail?: string | null;
}
export interface VehiclesIn { tractor: { plate: string; kind: string }; trailer: { plate: string; kind: string } | null }
export interface ExtraIn { companyAddress?: string | null; companyAuthorization?: string | null; driver?: DecaData['driver'] }

const isoDay = (d: string | Date): string => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));
const palletsTotal = (l: StopIn[]): number | null => (l.some((s) => s.pallets !== null && s.pallets !== undefined) ? l.reduce((a, s) => a + (s.pallets ?? 0), 0) : null);

export function buildDecaData(t: TransportIn, v: VehiclesIn, x: ExtraIn = {}): DecaData {
  const stopsO = t.origin.stops ?? [{ party: null, address: t.origin.text }], stopsD = t.destination.stops ?? [{ party: null, address: t.destination.text }];
  const uniq = (l: string[]): string[] => Array.from(new Set(l));
  /** Un lugar por parada (con sus palets); si dos paradas caen en la misma localidad se añade la empresa para distinguirlas. */
  const loads = (l: StopIn[]): Array<{ place: string; pallets: number | null; refs: string[]; seals: string[] }> => l.map((s) => {
    const place = placeFrom(s), dup = l.filter((x) => placeFrom(x) === place).length > 1;
    return { place: dup && s.party ? `${place} · ${s.party}` : place, pallets: s.pallets ?? null, refs: s.references ?? [], seals: s.seals ?? [] };
  });
  return {
    originLoads: loads(stopsO), destinationLoads: loads(stopsD), palletsTotal: palletsTotal(stopsO),
    consignees: stopsD.map((s) => ({ name: s.party, address: fullAddress(s), nif: s.nif ?? null })), originPlaces: uniq(stopsO.map((s) => placeFrom(s))), destinationPlaces: uniq(stopsD.map((s) => placeFrom(s))),
    carrierAddress: t.carrier_address ?? x.companyAddress ?? null, priceEur: t.price_eur ?? null, packages: t.packages ?? null, loadReference: t.load_reference ?? null, temperature: t.temperature ?? null, driver: x.driver ?? null,
    shipper: { name: t.shipper_name, nif: t.shipper_nif, address: t.shipper_address },
    carrier: { name: t.carrier_name, nif: t.carrier_nif },
    origin: t.origin.text, destination: t.destination.text, cargoDescription: t.cargo_description,
    weightKg: t.weight_kg, altMagnitude: t.alt_magnitude?.text ?? null, aecRef: t.aec_ref,
    transportDate: isoDay(t.transport_date), tractorPlate: v.tractor.plate, trailerPlate: v.trailer?.plate ?? null, remarks: t.remarks,
    // Modelo DECARGO (fichas)
    reference: t.reference ?? null, carrierAuthorization: t.carrier_authorization ?? x.companyAuthorization ?? null,
    tractorKind: v.tractor.kind, trailerKind: v.trailer?.kind ?? null, units: t.units ?? null, packaging: t.packaging ?? null,
    adr: t.adr ? { detail: t.adr_detail ?? null } : null,
    originStops: stopsO.map((s) => ({ party: s.party, address: fullAddress(s), time: s.time ?? null, pallets: s.pallets ?? null, refs: s.references ?? [], seals: s.seals ?? [] })),
    destinationStops: stopsD.map((s) => ({ party: s.party, address: fullAddress(s), time: s.time ?? null, pallets: s.pallets ?? null, refs: s.references ?? [], seals: s.seals ?? [] }))
  };
}

