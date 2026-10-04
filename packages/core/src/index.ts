/**
 * @ploy/core — platform foundation.
 *
 * Transport-agnostic primitives shared by the server, workers and the CLI:
 * configuration, structured logging, identifiers and the error taxonomy.
 * This package never imports HTTP or UI code, so it can run inside the
 * control plane, a remote agent or a one-shot CLI process unchanged.
 */
export * from './config.ts';
export * from './crypto.ts';
export * from './errors.ts';
export * from './ids.ts';
export * from './logger.ts';
