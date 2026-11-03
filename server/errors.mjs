export class AppError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function publicError(error) {
  if (error instanceof AppError) return { code: error.code, message: error.message };
  return { code: 'INTERNAL_ERROR', message: 'The operation could not be completed. Check the local service and try again.' };
}
