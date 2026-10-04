/**
 * Operator recovery commands, run on the host:
 *
 *   docker exec ploy-control node packages/server/src/cli.ts <command> [args]
 *
 *   reset-password <email>   print a new random password for the account
 *   disable-2fa <email>      turn off two-factor authentication
 *   make-admin <email>       grant instance administration
 *   backup <file>            write a consistent copy of the database (safe while running)
 *   info                     show version, data directory and counts
 */
import { randomBytes } from 'node:crypto';
import { openDatabase } from './db/database.ts';
import { loadConfig } from './lib/config.ts';
import { hashPassword } from './lib/crypto.ts';
import { Secrets } from './lib/secrets.ts';
import { createStores } from './store/index.ts';

async function main(): Promise<void> {
  const [command, argument] = process.argv.slice(2);
  const config = loadConfig();
  const db = openDatabase(config.databasePath);
  const stores = createStores(db, new Secrets(config.secretKey));

  const user = (): NonNullable<ReturnType<typeof stores.users.getByEmail>> => {
    if (argument === undefined) throw new Error('Email is required');
    const found = stores.users.getByEmail(argument);
    if (found === undefined) throw new Error(`No user with email ${argument}`);
    return found;
  };

  switch (command) {
    case 'reset-password': {
      const target = user();
      const password = randomBytes(12).toString('base64url');
      stores.users.setPasswordHash(target.id, await hashPassword(password));
      stores.sessions.deleteForUser(target.id);
      stores.audit.record({ teamId: null, userId: null, action: 'user.password_reset_cli', targetType: 'user', targetId: target.id, targetName: target.email });
      console.log(`New password for ${target.email}: ${password}`);
      break;
    }
    case 'disable-2fa': {
      const target = user();
      stores.users.disableTotp(target.id);
      stores.audit.record({ teamId: null, userId: null, action: 'user.2fa_disabled_cli', targetType: 'user', targetId: target.id, targetName: target.email });
      console.log(`Two-factor authentication disabled for ${target.email}`);
      break;
    }
    case 'make-admin': {
      const target = user();
      db.run('UPDATE users SET is_instance_admin = 1 WHERE id = ?', target.id);
      console.log(`${target.email} is now an instance administrator`);
      break;
    }
    case 'backup': {
      if (argument === undefined || argument.includes("'")) throw new Error('Usage: backup <file>');
      // VACUUM INTO produces a consistent snapshot even while the control plane is writing.
      db.exec(`VACUUM INTO '${argument}'`);
      console.log(`Database copied to ${argument}. Also keep ${config.dataDir}/secret.key: without it, stored secrets cannot be decrypted.`);
      break;
    }
    case 'info':
      console.log(
        JSON.stringify(
          {
            version: config.version,
            dataDir: config.dataDir,
            users: stores.users.count(),
            servers: stores.servers.listAll().map((server) => ({ name: server.name, kind: server.kind, status: server.status })),
            schemaVersion: db.schemaVersion,
          },
          null,
          2,
        ),
      );
      break;
    default:
      console.log('Usage: cli.ts <reset-password|disable-2fa|make-admin> <email> | backup <file> | info');
      process.exitCode = command === undefined ? 0 : 1;
  }
  db.close();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
