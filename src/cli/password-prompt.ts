/**
 * Pedido de la contraseña de los comandos que crean cuentas (`crear-admin`, `crear-superadmin`).
 * Nunca se pasa como argumento: quedaría en el historial de la shell.
 */

/** Lee una línea del teclado sin mostrarla. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          process.stdout.write('\n');
          reject(new Error('Cancelado.'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

export async function readPassword(fail: (message: string) => never): Promise<string> {
  if (process.stdin.isTTY) {
    const first = await promptHidden('Contraseña: ');
    const second = await promptHidden('Repetí la contraseña: ');
    if (first !== second) fail('Las contraseñas no coinciden. No se creó nada.');
    return first;
  }
  const fromEnv = process.env.ADMIN_PASSWORD;
  if (!fromEnv) fail('No hay terminal interactiva: definí ADMIN_PASSWORD con la contraseña. No se creó nada.');
  return fromEnv;
}
