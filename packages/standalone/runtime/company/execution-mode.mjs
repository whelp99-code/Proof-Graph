import { ValidationError } from '../core/errors.mjs';

export const EXECUTION_MODES = Object.freeze(['simulation', 'hosted', 'native_cloud', 'native_local']);

export function executionModeOf(port) {
  const mode = port?.executionMode ?? 'simulation';
  if (!EXECUTION_MODES.includes(mode)) throw new ValidationError(`Unsupported execution mode: ${mode}`);
  return mode;
}

export function isRealExecutionMode(mode) {
  return ['hosted', 'native_cloud', 'native_local'].includes(mode);
}

export function simulationPromotionAllowed() {
  return process.env.PROOFGRAPH_ALLOW_SIMULATION_PROMOTION === '1';
}
