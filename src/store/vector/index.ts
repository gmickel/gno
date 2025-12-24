/**
 * Vector storage and search module.
 *
 * @module src/store/vector
 */

export {
  createVectorIndexPort,
  decodeEmbedding,
  encodeEmbedding,
} from './sqlite-vec';
export { createVectorStatsPort } from './stats';
export * from './types';
