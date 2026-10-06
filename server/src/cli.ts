import { AuditEntry, GENESIS, auditHash } from './common/audit';
import { DOCUMENTS_DIR } from './common/config';
import { createPool } from './common/db';
import { LocalStorage } from './common/storage';
import { decryptToken, tokenHash } from './common/token';
import { createUser, resetTotpByUsername, revokeAllSessions } from './identity/service';
import { getConfig, setPublicBase } from './office/config';
import { seedDev } from './office/seed';
import { decryptTotpSecret } from './identity/totp';

/**
 * node dist/cli.js verify
 * Comprueba: (1) que cada versión de DeCA tiene su PDF y su SHA-256 coincide; (2) que la cadena de hashes
 * del registro de auditoría es íntegra. Sale con código distinto de 0 si hay discrepancias.
 */
async function verify(): Promise<void> {
  const pool = createPool(2);
  const storage = new LocalStorage(DOCUMENTS_DIR);
  const problems: string[] = [];

  const counts = {
    decas: Number((await pool.query('SELECT count(*) FROM deca')).rows[0].count),
    versions: Number((await pool.query('SELECT count(*) FROM deca_version')).rows[0].count),
    audit_rows: Number((await pool.query('SELECT count(*) FROM audit_log')).rows[0].count)
  };

  const versions = await pool.query('SELECT deca_id, version_no, file_key, sha256, size_bytes FROM deca_version ORDER BY created_at');
  let docsOk = 0;
  for (const v of versions.rows) {
    try {
      const buf = await storage.getVerified(v.file_key, v.sha256);
      if (buf.length !== v.size_bytes) throw new Error('tamaño distinto');
      docsOk++;
    } catch (e) {
      problems.push(`DeCA ${v.deca_id} v${v.version_no}: ${(e as Error).message}`);
    }
  }

  // DeCA externos almacenados: cada fichero debe existir y su SHA-256 coincidir.
  const extRows = await pool.query('SELECT id, file_key, sha256, size_bytes FROM external_deca');
  let extOk = 0;
  for (const e of extRows.rows) {
    try {
      const buf = await storage.getVerified(e.file_key, e.sha256);
      if (buf.length !== e.size_bytes) throw new Error('tamaño distinto');
      extOk++;
    } catch (err) { problems.push(`DeCA externo ${e.id}: ${(err as Error).message}`); }
  }

  // Secretos: APP_KEY debe poder descifrar cada token y reproducir su hash (si no, los QR no se podrían volver a mostrar).
  let tokensOk = 0;
  const toks = await pool.query('SELECT id, token_hash, token_enc FROM deca');
  for (const t of toks.rows) {
    try {
      const tok = decryptToken(t.token_enc, process.env.APP_KEY ?? '');
      if (tokenHash(tok) !== t.token_hash.trim()) throw new Error('el hash del token no coincide');
      tokensOk++;
    } catch (e) {
      problems.push(`DeCA ${t.id}: token no recuperable con APP_KEY (${(e as Error).message})`);
    }
  }

  // Secretos TOTP: deben poder descifrarse con APP_KEY (si no, nadie con segundo factor podría entrar tras restaurar).
  let totpOk = 0;
  const tot = await pool.query('SELECT id, totp_secret_enc FROM app_user WHERE totp_secret_enc IS NOT NULL');
  for (const t of tot.rows) {
    try { decryptTotpSecret(t.totp_secret_enc); totpOk++; } catch (e) { problems.push(`usuario ${t.id}: secreto TOTP no recuperable con APP_KEY (${(e as Error).message})`); }
  }

  let prev = GENESIS;
  const audit = await pool.query('SELECT * FROM audit_log ORDER BY id');
  for (const r of audit.rows) {
    const entry: AuditEntry = {
      company_id: r.company_id, at: r.at, actor: r.actor, action: r.action, entity: r.entity,
      entity_id: r.entity_id, before: r.before, after: r.after, reason: r.reason
    };
    if (r.prev_hash.trim() !== prev || auditHash(prev, entry) !== r.hash.trim()) {
      problems.push(`auditoría: la cadena se rompe en la fila ${r.id}`);
      break;
    }
    prev = r.hash.trim();
  }

  const result = { ...counts, documents_verified: docsOk, tokens_recoverable: tokensOk, totp_decryptable: totpOk, external_total: extRows.rowCount, external_verified: extOk, audit_chain_ok: !problems.some((p) => p.startsWith('auditoría')), problems };
  console.log(JSON.stringify(result, null, 2));
  await pool.end();
  process.exit(problems.length ? 1 : 0);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

/** create-user --username u --name "Nombre" --role admin|oficina|conductor|solo_lectura [--company-name N --company-nif X --company-address D]
 *  Imprime UNA VEZ el código de activación (solo se guarda su hash). Sirve para crear el primer administrador. */
async function createUserCmd(): Promise<void> {
  const pool = createPool(2);
  const username = arg('username'), name = arg('name'), role = arg('role');
  if (!username || !name || !role) { console.error('uso: create-user --username u --name "Nombre" --role <rol>'); process.exit(2); }
  const cn = arg('company-name'), nif = arg('company-nif'), ad = arg('company-address');
  const r = await createUser(pool, { kind: 'cli' }, { username, fullName: name, role }, cn && nif && ad ? { name: cn, nif, address: ad } : undefined);
  console.log(JSON.stringify(r, null, 2));
  await pool.end();
}

/** seed-dev [--reset-passwords]: datos de DESARROLLO (usuarios con contraseña aleatoria, vehículos y transportes con DeCA real). Re-ejecutable. */
async function seedDevCmd(): Promise<void> {
  const pool = createPool(3);
  console.log(JSON.stringify(await seedDev(pool, new LocalStorage(DOCUMENTS_DIR), { resetPasswords: process.argv.includes('--reset-passwords') }), null, 2));
  await pool.end();
}

/** public-url [https://dominio]: sin argumento muestra la dirección vigente; con argumento la fija (igual que Configuración en la web). */
async function publicUrlCmd(): Promise<void> {
  const pool = createPool(2);
  const u = process.argv[3];
  const c = u ? await setPublicBase(pool, { kind: 'cli' }, u) : await getConfig(pool);
  console.log(JSON.stringify({ public_base_url: c.public_base_url, source: c.source, decas_other_base: c.decas_other_base }));
  await pool.end();
}

async function resetTotpCmd(): Promise<void> {
  const pool = createPool(2);
  const u = arg('username');
  if (!u) { console.error('uso: reset-totp --username u'); process.exit(2); }
  await resetTotpByUsername(pool, u);
  console.log(JSON.stringify({ totp_reset: u }));
  await pool.end();
}

async function revokeAllCmd(): Promise<void> {
  const pool = createPool(2);
  const n = await revokeAllSessions(pool, arg('reason') ?? 'manual');
  console.log(JSON.stringify({ sessions_revoked: n }));
  await pool.end();
}

const cmd = process.argv[2];
const fail = (e: Error): never => { console.error(`ERROR ${cmd}:`, (e as { code?: string; message: string }).message); process.exit(2); };
if (cmd === 'verify') verify().catch(fail);
else if (cmd === 'create-user') createUserCmd().catch(fail);
else if (cmd === 'revoke-all-sessions') revokeAllCmd().catch(fail);
else if (cmd === 'reset-totp') resetTotpCmd().catch(fail);
else if (cmd === 'seed-dev') seedDevCmd().catch(fail);
else if (cmd === 'public-url') publicUrlCmd().catch(fail);
else { console.error('uso: node dist/cli.js verify | create-user ... | reset-totp --username u | seed-dev | revoke-all-sessions [--reason r]'); process.exit(2); }
