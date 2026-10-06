import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { appendAudit } from '../common/audit';
import { required } from '../common/config';
import { docTemplate, getPublicBase, testMode } from '../common/settings';
import { LocalStorage, MAX_PDF_BYTES } from '../common/storage';
import { decryptToken, encryptToken, newToken, tokenHash } from '../common/token';
import { ApiError } from '../identity/service';
import { generateCartaPdf } from '../pdf/carta-pdf';
import { DecaData, generateDecaPdf } from '../pdf/deca-pdf';

/**
 * Núcleo ÚNICO de emisión de un DeCA: token, URL, PDF (generador real), almacén, hash, filas y auditoría.
 * Lo usan tanto el endpoint de prueba como la interfaz web: no existe un segundo generador.
 * Debe ejecutarse dentro de una transacción abierta; el fichero se escribe ANTES de confirmarla.
 */
export interface IssueInput {
  companyId: string;
  transportId: string;
  data: DecaData;
  actor: string;
  reason: string;
  isTest: boolean;
}

export async function issueDeca(client: PoolClient, storage: LocalStorage, i: IssueInput) {
  const appKey = required('APP_KEY');
  const baseUrl = await getPublicBase(client);   // la fijada en Configuración (web) o, si no, la del .env; exige https salvo ALLOW_INSECURE_PUBLIC_URL=1
  const decaId = randomUUID();
  const token = newToken();
  const url = `${baseUrl}/d/${token}`;
  const now = new Date();
  const tpl = await docTemplate(client);                      // modelo de documento de la empresa
  const data = { ...i.data, template: tpl, isTest: i.isTest };
  const pdf = await (tpl === 'CARTA_DE_PORTE' ? generateCartaPdf : generateDecaPdf)({ decaId, versionNo: 1, data, url, createdAt: now, modifiedAt: now, isTest: i.isTest });
  if (pdf.length > MAX_PDF_BYTES) throw new Error('PDF por encima del límite legal');
  const stored = await storage.put(pdf);

  await client.query(
    `INSERT INTO deca (id, company_id, current_version, token_hash, token_enc, public_url) VALUES ($1,$2,1,$3,$4,$5)`,
    [decaId, i.companyId, tokenHash(token), encryptToken(token, appKey), url]);
  await client.query('INSERT INTO deca_transport (deca_id, transport_id) VALUES ($1,$2)', [decaId, i.transportId]);
  await client.query(
    `INSERT INTO deca_version (deca_id, version_no, method, created_by, snapshot, file_key, sha256, size_bytes, pdf_created, pdf_modified)
     VALUES ($1,1,'NEW',$2,$3,$4,$5,$6,$7,$8)`,
    [decaId, i.actor, JSON.stringify(data), stored.key, stored.sha256, stored.size, now, now]);
  await appendAudit(client, {
    company_id: i.companyId, at: now, actor: i.actor, action: 'DECA_CREATED', entity: 'deca', entity_id: decaId,
    before: null, after: { version: 1, sha256: stored.sha256, transport_id: i.transportId }, reason: i.reason
  });
  return { deca_id: decaId, transport_id: i.transportId, version: 1, url, sha256: stored.sha256, size_bytes: stored.size };
}

/**
 * Nueva VERSIÓN de un DeCA vigente (método 1 del diseño): MISMA URL y MISMO QR, PDF nuevo con la fecha de modificación, versión anterior conservada
 * y enlazada. Se usa al añadir el conductor, al cambiar de vehículo, etc. Debe ejecutarse dentro de una transacción abierta.
 */
export async function addDecaVersion(client: PoolClient, storage: LocalStorage, i: { decaId: string; data: DecaData; actor: string; reason: string; changes: string[] }) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`deca:${i.decaId}`]);
  const d = (await client.query(
    `SELECT d.id, d.company_id, d.status, d.current_version, d.public_url, d.token_enc, v.id AS vid, v.pdf_created, v.snapshot
     FROM deca d JOIN deca_version v ON v.deca_id = d.id AND v.version_no = d.current_version WHERE d.id = $1`, [i.decaId])).rows[0];
  if (!d || d.status !== 'ACTIVE') throw new ApiError(409, 'deca_no_vigente');
  const url: string = d.public_url ?? `${await getPublicBase(client)}/d/${decryptToken(d.token_enc, required('APP_KEY'))}`;
  const tpl = (d.snapshot?.template === 'CARTA_DE_PORTE' ? 'CARTA_DE_PORTE' : 'ESTANDAR') as 'ESTANDAR' | 'CARTA_DE_PORTE';
  const isTest = typeof d.snapshot?.isTest === 'boolean' ? d.snapshot.isTest : await testMode(client);
  const data: DecaData = { ...i.data, template: tpl, isTest };
  const versionNo = d.current_version + 1, now = new Date(), created: Date = d.pdf_created;
  const pdf = await (tpl === 'CARTA_DE_PORTE' ? generateCartaPdf : generateDecaPdf)({ decaId: i.decaId, versionNo, data, url, createdAt: created, modifiedAt: now, isTest });
  if (pdf.length > MAX_PDF_BYTES) throw new Error('PDF por encima del límite legal');
  const stored = await storage.put(pdf);
  await client.query(
    `INSERT INTO deca_version (deca_id, version_no, method, reason, created_by, snapshot, diff, file_key, sha256, size_bytes, pdf_created, pdf_modified, prev_version_id)
     VALUES ($1,$2,'MODIFIED_SAME_PDF',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [i.decaId, versionNo, i.reason, i.actor, JSON.stringify(data), JSON.stringify({ changed: i.changes }), stored.key, stored.sha256, stored.size, created, now, d.vid]);
  await client.query('UPDATE deca SET current_version = $2 WHERE id = $1', [i.decaId, versionNo]);
  await appendAudit(client, { company_id: d.company_id, at: now, actor: i.actor, action: 'DECA_VERSION_ADDED', entity: 'deca', entity_id: i.decaId,
    before: { version: d.current_version }, after: { version: versionNo, sha256: stored.sha256, changed: i.changes.join(',') }, reason: i.reason });
  return { deca_id: i.decaId, version: versionNo, sha256: stored.sha256 };
}
