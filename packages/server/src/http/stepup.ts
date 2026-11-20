/**
 * Step-up confirmation: a fresh proof, on a session that is already signed
 * in, that the person at the keyboard owns the account.
 *
 * Changing how an account is entered (a new password, a passkey, turning
 * two-factor off) asks for the password, so that a stolen session alone
 * cannot do it. Someone who has forgotten the password still has other ways
 * to prove who they are: the GitHub account linked to theirs, or one of
 * their passkeys. Proving it that way grants the session a short window in
 * which the password is not asked for.
 *
 * The grant belongs to one session, lasts ten minutes, and lives in memory:
 * a restart forgets it, which costs its owner one more confirmation.
 */
import type { StepUpMethod } from '@ploy/shared';
import type { Context } from '../context.ts';
import { verifyPassword } from '../lib/crypto.ts';
import { AppError } from '../lib/errors.ts';
import type { Auth } from './core.ts';

export const STEP_UP_TTL_MS = 10 * 60_000;

export interface StepUpGrant {
  method: StepUpMethod;
  /** Epoch milliseconds after which the password is asked for again. */
  until: number;
}

export class StepUps {
  private readonly grants = new Map<string, StepUpGrant>();

  grant(sessionId: string, method: StepUpMethod, now: number = Date.now()): StepUpGrant {
    for (const [key, value] of this.grants) if (value.until <= now) this.grants.delete(key);
    const grant = { method, until: now + STEP_UP_TTL_MS };
    this.grants.set(sessionId, grant);
    return grant;
  }

  /** The grant in force on a session, if any. API tokens have no session and can never hold one. */
  active(sessionId: string | null, now: number = Date.now()): StepUpGrant | null {
    if (sessionId === null) return null;
    const grant = this.grants.get(sessionId);
    if (grant === undefined) return null;
    if (grant.until <= now) {
      this.grants.delete(sessionId);
      return null;
    }
    return grant;
  }

  clear(sessionId: string | null): void {
    if (sessionId !== null) this.grants.delete(sessionId);
  }
}

/**
 * Gate for a sensitive change. Passes when this session confirmed its owner
 * a moment ago, or when `password` is the account's password; an account
 * without a password has nothing to be asked for. Returns how the owner was
 * confirmed, for the audit log.
 */
export async function confirmOwner(ctx: Context, auth: Auth, password: string | undefined): Promise<StepUpMethod | 'password' | 'none'> {
  const grant = ctx.stepUps.active(auth.sessionId);
  if (grant !== null) return grant.method;
  const user = ctx.stores.users.getById(auth.user.id);
  if (user === undefined || user.passwordHash === null) return 'none';
  if (password !== undefined && password.length > 0 && (await verifyPassword(password, user.passwordHash))) return 'password';
  throw new AppError('invalid_credentials', 'Password is incorrect');
}
