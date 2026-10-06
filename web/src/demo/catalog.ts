/** Catálogo de documentos (copia del del servidor, server/src/office/catalog.ts) para la demostración. */
type Subject = 'DRIVER' | 'VEHICLE' | 'COMPANY';
type VehicleKind = 'TRACTORA' | 'SEMIRREMOLQUE' | 'REMOLQUE' | 'RIGIDO';
interface DocType { code: string; label: string; subject: Subject; hint: string; food?: boolean; kinds?: VehicleKind[]; detailLabel?: string }

export const DOCS: DocType[] = [
  { code: 'DNI', label: 'DNI / NIE', subject: 'DRIVER', hint: 'Fecha de validez impresa en el documento.' },
  { code: 'PERMISO', label: 'Permiso de conducir', subject: 'DRIVER', hint: 'C y C+E: 5 años hasta los 65 y plazos más cortos después. Se renueva con reconocimiento médico.', detailLabel: 'Clases (C, C+E…)' },
  { code: 'CAP', label: 'CAP (certificado de aptitud profesional)', subject: 'DRIVER', hint: 'Caduca a los 5 años; exige formación continua.' },
  { code: 'TARJETA_CONDUCTOR', label: 'Tarjeta del conductor (tacógrafo digital)', subject: 'DRIVER', hint: 'Validez de 5 años.' },
  { code: 'RECONOCIMIENTO', label: 'Reconocimiento médico / aptitud psicofísica', subject: 'DRIVER', hint: 'Según el último reconocimiento y el servicio de prevención.' },
  { code: 'ADR_CONDUCTOR', label: 'Certificado ADR del conductor (mercancías peligrosas)', subject: 'DRIVER', hint: 'Solo si transporta mercancías peligrosas; suele durar 5 años.' },
  { code: 'MANIPULADOR', label: 'Carné de manipulador de alimentos', subject: 'DRIVER', hint: 'Sin plazo legal único: lo fija la política de la empresa.', food: true },
  { code: 'PERMISO_TRABAJO', label: 'Permiso de residencia y trabajo', subject: 'DRIVER', hint: 'Solo conductores de fuera de la UE.' },
  { code: 'PRL', label: 'Formación en prevención de riesgos laborales', subject: 'DRIVER', hint: 'Según el plan de prevención de la empresa.' },
  { code: 'OTRO', label: 'Otro documento', subject: 'DRIVER', hint: 'Indica su nombre.' },

  { code: 'ITV', label: 'ITV', subject: 'VEHICLE', hint: 'Anota la fecha de la próxima inspección. Pesados: anual hasta 10 años de antigüedad y semestral después.' },
  { code: 'SEGURO', label: 'Seguro obligatorio', subject: 'VEHICLE', hint: 'Normalmente anual.' },
  { code: 'TACOGRAFO', label: 'Inspección periódica del tacógrafo', subject: 'VEHICLE', hint: 'Al menos cada 2 años.', kinds: ['TRACTORA', 'RIGIDO'] },
  { code: 'EXTINTOR', label: 'Revisión de extintores', subject: 'VEHICLE', hint: 'Mira la etiqueta del extintor (suele ser anual).' },
  { code: 'IMPUESTO', label: 'Impuesto de circulación', subject: 'VEHICLE', hint: 'Anual.' },
  { code: 'ADR_VEHICULO', label: 'Certificado ADR del vehículo', subject: 'VEHICLE', hint: 'Solo mercancías peligrosas; suele ser anual.' },
  { code: 'ATP', label: 'Certificado ATP (isotermo / frigorífico)', subject: 'VEHICLE', hint: 'Válido 6 años desde la fabricación y después se renueva cada 3. Sin él no se pueden llevar perecederos bajo ATP.', food: true, kinds: ['SEMIRREMOLQUE', 'REMOLQUE', 'RIGIDO'], detailLabel: 'Clase ATP (IN, IR, RN, RS, FRC…)' },
  { code: 'FRIO', label: 'Revisión del equipo de frío', subject: 'VEHICLE', hint: 'Según el mantenimiento del fabricante.', food: true, kinds: ['SEMIRREMOLQUE', 'REMOLQUE', 'RIGIDO'] },
  { code: 'OTRO', label: 'Otro documento', subject: 'VEHICLE', hint: 'Indica su nombre.' },

  { code: 'VISADO', label: 'Visado de la autorización de transporte (MDP)', subject: 'COMPANY', hint: 'Cada 2 años; hoy lo gestiona la Administración de oficio.' },
  { code: 'SEGURO_RC', label: 'Seguro de responsabilidad civil / mercancías (CMR)', subject: 'COMPANY', hint: 'Normalmente anual.' },
  { code: 'RGSEAA', label: 'Registro sanitario de la empresa (RGSEAA)', subject: 'COMPANY', hint: 'Solo si transporta alimentos; anota si tiene fecha.', food: true },
  { code: 'OTRO', label: 'Otro documento', subject: 'COMPANY', hint: 'Indica su nombre.' }
];

export const ASSETS = [
  { code: 'FUEL_CARD', label: 'Tarjeta de combustible', hasPin: true, identifierLabel: 'Número de tarjeta', providerLabel: 'Emisor (Solred, DKV, UTA…)' },
  { code: 'VIA_T', label: 'VIA-T / telepeaje', hasPin: false, identifierLabel: 'Número de serie del dispositivo', providerLabel: 'Concesionaria o emisor' },
  { code: 'OTRO', label: 'Otro dispositivo o tarjeta', hasPin: true, identifierLabel: 'Identificador', providerLabel: 'Emisor' }
] as const;
