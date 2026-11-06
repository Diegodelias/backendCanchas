import pg from 'pg';

/** Lo mínimo que la API necesita de la base; permite reemplazarla en las pruebas. */
export interface Database {
  /** Lanza un error si la base no responde. */
  ping(): Promise<void>;
  close(): Promise<void>;
}

export function createPgDatabase(connectionString: string): Database {
  const pool = new pg.Pool({ connectionString, max: 5 });
  return {
    async ping() {
      await pool.query('SELECT 1');
    },
    close: () => pool.end(),
  };
}
