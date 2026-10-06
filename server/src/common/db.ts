import { Pool } from 'pg';
import { optional, required } from './config';

/** Pool con el rol y la contraseña indicados por las variables DB_USER / DB_PASSWORD de cada servicio. */
export function createPool(max = 5): Pool {
  return new Pool({
    host: optional('DB_HOST', 'db'),
    port: Number(optional('DB_PORT', '5432')),
    database: optional('DB_NAME', 'decargo'),
    user: required('DB_USER'),
    password: required('DB_PASSWORD'),
    max,
    connectionTimeoutMillis: 5000
  });
}
