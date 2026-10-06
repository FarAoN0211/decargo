import { ApiError } from './api';

const FIELDS: Record<string, string> = {
  location: 'la ubicación del lugar',
  carrier_name: 'el nombre del transportista', carrier_nif: 'el NIF del transportista', shipper_name: 'el nombre del cargador', shipper_nif: 'el NIF del cargador', shipper_address: 'el domicilio del cargador', origin: 'el origen', destination: 'el destino',
  transport_date: 'la fecha', cargo: 'la mercancía', weight_kg: 'el peso (o indica otra magnitud)', alt_magnitude: 'la otra magnitud', aec_ref: 'la autorización especial',
  remarks: 'las observaciones', driver_id: 'el conductor', tractor_id: 'el vehículo (debe ser una tractora o un rígido activo)', trailer_id: 'el remolque (debe ser compatible con el vehículo)',
  reason: 'el motivo', iban: 'el IBAN', shipper_city: 'el código postal, la localidad, la provincia o el país del cargador', carrier_city: 'el código postal, la localidad, la provincia o el país del transportista', references: 'las referencias (hasta 10, de 40 caracteres como máximo)', seals: 'los precintos (hasta 10, de 30 caracteres como máximo)', pallets: 'los palets (un número entero entre 0 y 9999)', lat: 'la latitud (entre -90 y 90)', lon: 'la longitud (entre -180 y 180; si pones una, pon también la otra)', map_url: 'el enlace del mapa (https de Google Maps, Apple Maps, Waze u OpenStreetMap)', site_id: 'el lugar elegido', party_id: 'la empresa elegida', price_eur: 'el precio', units: 'el número de unidades (un número entero)', packaging: 'el tipo de embalaje', adr: 'el dato ADR', adr_detail: 'el detalle ADR', time: 'la hora (HH:MM)', transport_authorization: 'el nº de autorización de transporte', carrier_authorization: 'el nº de autorización del transportista', packages: 'los bultos', load_reference: 'la referencia de carga', temperature: 'la temperatura', carrier_address: 'el domicilio del transportista', template: 'el modelo de documento', show_driver: 'el ajuste del conductor', ss: 'el nº de la Seguridad Social (12 dígitos)', birth_date: 'la fecha de nacimiento', hire_date: 'la fecha de alta', contract_type: 'el tipo de contrato', phone: 'el teléfono', email: 'el correo electrónico', emergency_name: 'el contacto de emergencia', emergency_phone: 'el teléfono de emergencia', street: 'la dirección', postal_code: 'el código postal', city: 'el municipio', province: 'la provincia', country: 'el país', nationality: 'la nacionalidad', job_category: 'la categoría profesional', iban_holder: 'el titular', field: 'el campo', doc_type: 'el tipo de documento', label: 'el nombre del documento', number: 'el número', detail: 'el detalle', issued_on: 'la fecha de expedición', expires_on: 'la fecha de caducidad (no puede ser anterior a la de expedición)', notes: 'las notas', provider: 'el emisor', identifier: 'el número (mínimo 3 caracteres)', pin: 'el PIN (3 a 12 letras o números)', warn_days: 'los días de aviso (1 a 365)', food_transport: 'el ajuste de alimentación', subject_kind: 'a quién pertenece el documento', user_id: 'el conductor', vehicle_id: 'el vehículo', days: 'los días', name: 'el nombre', nif: 'el NIF / DNI (revisa la letra de control)', address: 'el domicilio', origins: 'los lugares de carga', destinations: 'los lugares de descarga', plate: 'la matrícula', kind: 'el tipo', username: 'el usuario', full_name: 'el nombre', role: 'el rol'
};
const WEAK: Record<string, string> = {
  too_short: 'La contraseña es demasiado corta (mínimo 10 caracteres).', too_long: 'La contraseña es demasiado larga.', too_common: 'Esa contraseña es demasiado común.',
  contains_username: 'La contraseña no puede contener tu usuario.', repetitive: 'La contraseña es demasiado repetitiva.', sequence: 'La contraseña es una secuencia evidente.'
};

/** Mensajes en español para los códigos de error de la API. Nunca se muestran detalles internos. */
export function messageFor(e: unknown): string {
  if (!(e instanceof ApiError)) return 'No se pudo conectar con el servidor.';
  const d = e.data;
  switch (e.code) {
    case 'invalid_credentials': return 'Usuario o contraseña incorrectos.';
    case 'totp_required': return 'Introduce el código de tu aplicación autenticadora.';
    case 'invalid_totp': return 'El código no es válido o ya se usó. Espera al siguiente código.';
    case 'invalid_activation': return 'El código de activación no es válido, ha caducado o se ha agotado. Pide uno nuevo a la oficina.';
    case 'too_many_attempts': return `Demasiados intentos. Vuelve a probar en ${Math.ceil((d.retry_after_seconds ?? 60) / 60)} min.`;
    case 'rate_limited': return 'Demasiadas peticiones. Espera un momento.';
    case 'device_revoked': return 'Este dispositivo ha sido revocado. Contacta con la oficina.';
    case 'pending_device_limit': return 'Este usuario ya tiene 3 dispositivos pendientes de confirmación. La oficina debe resolverlos.';
    case 'weak_password': return WEAK[d.reason] ?? 'La contraseña no es suficientemente segura.';
    case 'invalid_public_url': return d.reason === 'https' ? 'La dirección debe empezar por https://' : d.reason === 'solo_dominio' ? 'Escribe solo el dominio, sin ruta ni parámetros (por ejemplo https://decargo.tuempresa.com).' : d.reason === 'dominio' ? 'Escribe un nombre de dominio (no una dirección IP).' : 'La dirección no es válida.';
    case 'invalid_iban': return d.reason === 'control' ? 'El IBAN no es válido (dígitos de control incorrectos).' : d.reason === 'longitud' ? 'El IBAN no tiene la longitud correcta para ese país.' : d.reason === 'cuenta' ? 'El IBAN no es válido (dígitos de control de la cuenta incorrectos).' : 'El IBAN no tiene un formato válido.';
    case 'sin_dato': return 'Ese dato no está guardado.';
    case 'logo_invalido': return 'La imagen del logo no es válida. Usa un PNG, JPEG, WebP o SVG.';
    case 'logo_demasiado_grande': return 'El logo pesa demasiado (máximo 256 KB). Prueba con una imagen más pequeña.';
    case 'fcm_google_services': return 'El google-services.json no es válido. Descárgalo de nuevo desde la consola de Firebase.';
    case 'fcm_paquete': return `El google-services.json no incluye la app Android «${d.package}». Añádela en Firebase con ese nombre de paquete y vuelve a descargarlo.`;
    case 'fcm_cuenta_servicio': return 'La clave de la cuenta de servicio no es válida. Genera una nueva en Firebase → Cuentas de servicio.';
    case 'fcm_proyecto_distinto': return 'Los dos ficheros son de proyectos de Firebase distintos.';
    case 'fcm_credenciales': return 'Google no ha aceptado la clave de la cuenta de servicio (puede estar revocada). Genera una nueva.';
    case 'fcm_no_configurado': return 'La empresa aún no ha configurado los avisos de la app Android.';
    case 'ubicacion_requiere_empresa': return `Has indicado la ubicación de un lugar de ${d.field === 'origins' ? 'carga' : 'descarga'} sin escribir su empresa. Escribe la empresa para guardar la ubicación en la agenda, o borra la ubicación.`;
    case 'localidad_requerida': return `Indica la localidad de ${d.field === 'origins' ? 'cada lugar de carga' : 'cada lugar de descarga'}: es lo que sale en la casilla «Lugar de ${d.field === 'origins' ? 'origen' : 'destino'}» del DeCA (nunca la calle).`;
    case 'relevo_mismo_conductor': return 'Ese conductor ya lleva el transporte: elige otro para el relevo.';
    case 'demo_no_disponible': return 'Esta función no está disponible en la demostración.';
    case 'transporte_cerrado': return 'Este transporte ya está finalizado o anulado.';
    case 'ya_anulado': return 'Este transporte ya estaba anulado.';
    case 'sin_cambios': return 'El vehículo elegido es el mismo que ya tiene el transporte.';
    case 'dispositivo_pendiente': return 'Este teléfono aún no está autorizado por la oficina.';
    case 'sin_pin': return 'Esa tarjeta no tiene PIN guardado.';
    case 'deca_no_vigente': return 'Ese DeCA ya fue sustituido por otro.';
    case 'invalid_field': return `Revisa ${FIELDS[d.field] ?? 'los datos del formulario'}.`;
    case 'username_taken': return 'Ese nombre de usuario ya existe.';
    case 'plate_taken': return 'Ya existe un vehículo con esa matrícula.';
    case 'vehicle_in_use': return 'Ese vehículo ya se ha usado en transportes: su matrícula y tipo no se pueden cambiar (sí su estado).';
    case 'vehicle_required': return 'Falta asignar un vehículo.';
    case 'deca_exists': return 'Este transporte ya tiene su DeCA.';
    case 'deca_emitido': return 'El DeCA ya está emitido: cambiar el vehículo es una modificación legal (versionado), pendiente del siguiente bloque.';
    case 'no_company': return 'Todavía no hay empresa creada.';
    case 'mfa_required': return 'Falta configurar el segundo factor.';
    case 'prohibido': return 'No tienes permiso para esta operación.';
    case 'no_encontrado': return 'No se ha encontrado.';
    case 'no_autenticado': return 'La sesión ha caducado. Vuelve a entrar.';
    case 'totp_already_enabled': return 'El segundo factor ya está configurado. Si lo has perdido, pide a un administrador que lo reinicie.';
    case 'invalid_state': return 'La operación no es válida en el estado actual.';
    default: return e.status >= 500 ? 'Error del servidor. Inténtalo de nuevo.' : 'No se pudo completar la operación.';
  }
}
