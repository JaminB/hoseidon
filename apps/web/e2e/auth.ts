import { join } from 'node:path';

export const ADMIN_PASSWORD = 'e2e-correct-horse';
export const AUTH_FILE = join(import.meta.dirname, '.auth', 'state.json');
