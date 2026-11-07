import pg from 'pg';

/** Lo mínimo que la API necesita de la base; permite reemplazarla en las pruebas. */
export interface Database {
  /** Lanza un error si la base no responde. */
  ping(): Promise<void>;
  /** Ejecuta una consulta parametrizada y devuelve sus filas. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

export function createPgDatabase(connectionString: string): Database {
  const pool = new pg.Pool({ connectionString, max: 5 });
  return {
    async ping() {
      await pool.query('SELECT 1');
    },
    async query<T>(sql: string, params: unknown[] = []) {
      const result = await pool.query(sql, params);
      return result.rows as T[];
    },
    close: () => pool.end(),
  };
}
