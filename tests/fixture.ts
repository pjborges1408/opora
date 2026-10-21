import { readFileSync } from 'node:fs';
// Fictitious identities. Real clinic records are never stored in versioned source files.
export const fixtureSales=JSON.parse(readFileSync(new URL('./fixtures/sales.json',import.meta.url),'utf8')).sales as unknown[];
