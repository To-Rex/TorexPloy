import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError, badRequest, forbidden, internal, isAppError, notFound, toAppError } from './errors.ts';

test('each error code maps to the intended HTTP status', () => {
  assert.equal(new AppError('bad_request', 'x').status, 400);
  assert.equal(new AppError('unauthorized', 'x').status, 401);
  assert.equal(new AppError('forbidden', 'x').status, 403);
  assert.equal(new AppError('not_found', 'x').status, 404);
  assert.equal(new AppError('conflict', 'x').status, 409);
  assert.equal(new AppError('validation_failed', 'x').status, 422);
  assert.equal(new AppError('rate_limited', 'x').status, 429);
  assert.equal(new AppError('setup_required', 'x').status, 428);
  assert.equal(new AppError('engine_unavailable', 'x').status, 503);
  assert.equal(new AppError('internal_error', 'x').status, 500);
});

test('AppError is a real Error with a stable name and code', () => {
  const error = new AppError('conflict', 'already exists');
  assert.equal(error instanceof Error, true);
  assert.equal(error instanceof AppError, true);
  assert.equal(error.name, 'AppError');
  assert.equal(error.code, 'conflict');
  assert.equal(error.message, 'already exists');
});

test('errors preserve their cause for logging', () => {
  const cause = new Error('connection reset');
  const error = internal('engine failed', cause);
  assert.equal(error.cause, cause);
});

test('toJSON omits details when none were provided', () => {
  assert.deepEqual(notFound('Application').toJSON(), {
    code: 'not_found',
    message: 'Application not found',
  });
  assert.deepEqual(badRequest('nope', { field: 'name' }).toJSON(), {
    code: 'bad_request',
    message: 'nope',
    details: { field: 'name' },
  });
});

test('isAppError distinguishes platform errors from arbitrary throws', () => {
  assert.equal(isAppError(forbidden()), true);
  assert.equal(isAppError(new Error('plain')), false);
  assert.equal(isAppError('string'), false);
  assert.equal(isAppError(null), false);
});

test('toAppError normalizes unknown throws without leaking a non-Error value', () => {
  const fromString = toAppError('boom');
  assert.equal(fromString.code, 'internal_error');
  assert.equal(fromString.message, 'boom');

  const original = new Error('disk full');
  const fromError = toAppError(original);
  assert.equal(fromError.message, 'disk full');
  assert.equal(fromError.cause, original);

  const already = badRequest('kept');
  assert.equal(toAppError(already), already, 'existing AppError instances pass through unchanged');
});