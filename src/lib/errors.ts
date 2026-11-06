export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (message = 'No se encontró lo que buscabas.') =>
  new AppError(404, 'not_found', message);
export const unauthorized = (message = 'Necesitás iniciar sesión.') =>
  new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'No tenés permiso para hacer esto.') =>
  new AppError(403, 'forbidden', message);
export const badRequest = (message: string, code = 'bad_request') =>
  new AppError(400, code, message);
