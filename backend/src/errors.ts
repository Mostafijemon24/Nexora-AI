/** An error that is safe to show to the client as-is. */
export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message: string, code = 'bad_request') => new HttpError(400, code, message);
export const notFound = (message = 'Not found.') => new HttpError(404, 'not_found', message);
export const conflict = (message: string, code = 'conflict') => new HttpError(409, code, message);
/** The session is missing or no longer backed by an active license on this device. */
export const licenseRequired = (message = 'An active license is required on this device.') => new HttpError(401, 'license_required', message);
export const tooMany = (message = 'Too many attempts. Wait a few minutes and try again.') => new HttpError(429, 'rate_limited', message);
