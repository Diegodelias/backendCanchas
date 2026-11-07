import argon2 from 'argon2';

export const MIN_PASSWORD_LENGTH = 10;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password);
}

let dummyHash: Promise<string> | null = null;

/**
 * Verifica contra un hash fijo y devuelve siempre false.
 * Se usa cuando el mail no existe, para que el tiempo de respuesta no revele qué cuentas hay.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword('canchas3-cuenta-inexistente');
  await argon2.verify(await dummyHash, password);
  return false;
}
