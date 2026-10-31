import { ecotrack } from './ecotrack.js';
import { sandbox } from './sandbox.js';
import { manual } from './manual.js';
import { myecom } from './myecom.js';

const PROVIDERS = { ecotrack, myecom, sandbox, manual };

export const PROVIDER_NAMES = Object.keys(PROVIDERS);

export function getProvider(name) {
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Unknown delivery provider: ${name}`);
  return provider;
}
