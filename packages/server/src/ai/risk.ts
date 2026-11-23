/**
 * How much a shell command can change, judged from its text.
 *
 * The answer decides whether the person is asked first, so the rule is
 * lopsided on purpose: a command is `safe` only when every part of it is a
 * known read-only program used in a read-only way, with nothing that could
 * hide another command inside it. Anything the classifier does not fully
 * understand is a `change` (asked about, unless the conversation allows
 * ordinary changes), and anything that deletes, overwrites, cuts access or
 * stops the machine is `danger` (always asked about).
 */
import type { AiRisk } from '@ploy/shared';

/** Programs that only report. Each may still be refused below for the flags it is given. */
const READERS = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'find', 'df', 'du', 'free', 'uptime', 'uname', 'whoami', 'id', 'hostname', 'date', 'ps', 'pwd',
  'echo', 'printf', 'wc', 'sort', 'uniq', 'cut', 'tr', 'stat', 'file', 'which', 'whereis', 'type', 'lsblk', 'lscpu', 'lsmem', 'lsof', 'ss', 'netstat', 'ip',
  'ifconfig', 'ping', 'dig', 'nslookup', 'host', 'journalctl', 'dmesg', 'last', 'w', 'who', 'nproc', 'getent', 'test', '[', 'true', 'false', 'md5sum', 'sha1sum',
  'sha256sum', 'base64', 'jq', 'column', 'tac', 'nl', 'realpath', 'dirname', 'basename', 'readlink', 'lsb_release', 'tree', 'pgrep', 'pidof', 'vmstat', 'iostat',
  'mpstat', 'sar', 'findmnt', 'mount', 'blkid', 'env', 'printenv', 'awk', 'sed', 'curl', 'docker', 'systemctl', 'git', 'crontab', 'ufw', 'iptables', 'nginx',
  'caddy', 'dpkg', 'apt', 'apt-cache', 'timedatectl', 'hostnamectl', 'loginctl', 'openssl', 'ssh-keygen', 'top', 'sysctl', 'swapon', 'zcat', 'zgrep', 'xxd', 'od',
  'strings', 'diff', 'cmp', 'comm', 'seq', 'sleep', 'timeout', 'nc', 'traceroute', 'mtr', 'arp', 'route', 'resolvectl', 'node', 'python3', 'php', 'go', 'java',
]);

/** Programs that are read-only for these first arguments only. */
const SUBCOMMANDS: Record<string, RegExp> = {
  docker: /^(ps|images|image\s+(ls|inspect|history)|logs|inspect|stats|version|info|top|port|diff|history|events|search|network\s+(ls|inspect)|volume\s+(ls|inspect)|system\s+(df|info)|container\s+(ls|inspect|logs|top|port|stats)|compose\s+(\S+\s+)*(ps|logs|config|ls|images|top|version)|buildx\s+(ls|du|version)|context\s+(ls|inspect|show)|manifest\s+inspect)\b/,
  systemctl: /^(status|is-active|is-enabled|is-failed|list-units|list-unit-files|list-timers|list-sockets|list-dependencies|show|cat|--version|--failed)\b/,
  git: /^(status|log|diff|show|branch|remote(\s+-v|\s+show)?|rev-parse|describe|tag(\s+-l)?|ls-files|ls-remote|config\s+(--get|--list|-l)|shortlog|blame|--version)(\s|$)/,
  crontab: /^-l\b/,
  ufw: /^(status|show|version|app\s+(list|info))\b/,
  iptables: /^(-L|-S|--list|--list-rules|-t\s+\S+\s+(-L|-S)|-nL|-vnL|-nvL)\b/,
  nginx: /^(-t|-T|-v|-V)\b/,
  caddy: /^(version|validate|list-modules|environ|fmt(?!\s+.*--overwrite))\b/,
  dpkg: /^(-l|-s|-L|-S|--list|--status|--listfiles|--search|--get-selections|--print-architecture)\b/,
  apt: /^(list|show|search|policy|depends|rdepends|--version)\b/,
  'apt-cache': /^(show|search|policy|depends|rdepends|showpkg|stats)\b/,
  timedatectl: /^(status|show|list-timezones|timesync-status)?(\s|$)/,
  hostnamectl: /^(status)?(\s|$)/,
  loginctl: /^(list-sessions|list-users|show-session|show-user|session-status|user-status)?(\s|$)/,
  openssl: /^(version|x509\s[^>]*-noout|s_client|verify|ciphers)\b/,
  'ssh-keygen': /^(-l|-lf|-F|-H\s+-F)\b/,
  top: /^-b\b/,
  sysctl: /^(-a|-n\s+\S+$|[a-z0-9_.]+$)/,
  swapon: /^(--show|-s|--summary)\b/,
  mount: /^(-l)?$/,
  ip: /^(-[46a-z]+\s+)*(a|addr|address|l|link|r|route|n|neigh|rule|netns\s+list|-s\s+link)(\s+(show|list|get)\b.*)?$/,
  env: /^$/,
  node: /^(-v|--version)$/,
  python3: /^(-V|--version)$/,
  php: /^(-v|--version|-m|-i)$/,
  go: /^version$/,
  java: /^(-version|--version)$/,
  nc: /^-z\b/,
  timeout: /^\d+[smh]?\s+\S/,
};

/** What makes an otherwise read-only program write, run something else, or never return. */
const REFUSED_FLAGS: Record<string, RegExp> = {
  find: /\s-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b/,
  sed: /\s-(i|-in-place)|\bw\s+\S|\be\b/,
  awk: /system\s*\(|\|\s*getline|print\s*>|printf\s*>|getline\s*</,
  curl: /\s(-X\s*(?!GET\b|HEAD\b)\S+|--request\s+(?!GET\b|HEAD\b)\S+|-d|--data\S*|-F|--form\S*|-T|--upload-file|-O|--remote-name\S*|-K|--config|-o\s*(?!\/dev\/null)\S+|--output\s+(?!\/dev\/null)\S+)/,
  tail: /\s(-[a-zA-Z]*[fF]\b|--follow)/,
  journalctl: /\s(-f\b|--follow|--vacuum\S*|--rotate|--flush)/,
  docker: /\s(-f\b|--follow)\b|\bevents\b(?!.*--until)|\bstats\b(?!.*--no-stream)/,
  dmesg: /\s(-[a-zA-Z]*[cCwW]\b|--clear|--follow)/,
  date: /\s(-s\b|--set)/,
  hostname: /^hostname\s+[^-\s]/,
  tree: /\s-o\b/,
  sort: /\s(-o\b|--output)/,
  ping: /^(?!.*\s-c\s*\d)/,
  xxd: /\s-r\b/,
  git: /\s(--output|-o)\b/,
  sysctl: /\s-w\b|=/,
  top: /^(?!.*\s-n\s*\d)/,
  sleep: /^sleep\s+(?!([0-9]|[1-5][0-9])(\.\d+)?s?$)/,
  mtr: /^(?!.*(\s-r\b|--report))/,
};

/** Things that are never ordinary: they destroy data, cut access, or stop the machine or the panel. */
const DANGER: RegExp[] = [
  /\brm\s+(-[a-zA-Z-]+\s+)*-[a-zA-Z]*[rR]/, // rm -r, rm -rf
  /\brm\s+(-[a-zA-Z-]+\s+)*--recursive/,
  /\brm\s+(-[a-zA-Z]+\s+)*(\/|~|\$HOME|\/\*|\.\/?\*?)(\s|$)/,
  /\b(mkfs(\.\w+)?|wipefs|shred|fdisk|sfdisk|parted|sgdisk|blkdiscard)\b/,
  /\bdd\b[^|;&]*\bof=/,
  /\b(shutdown|reboot|poweroff|halt)\b|\binit\s+[06]\b|\bsystemctl\s+(reboot|poweroff|halt|kexec|suspend|hibernate)\b/,
  /\bsystemctl\s+(stop|disable|mask|kill)\b/,
  /\bservice\s+\S+\s+stop\b/,
  /\bdocker\s+(system|volume|image|container|network|builder|buildx)\s+prune\b/,
  /\bdocker\s+(volume\s+rm|rmi|image\s+rm|rm|container\s+rm|network\s+rm|swarm\s+leave|compose\s+(\S+\s+)*down)\b/,
  /\bdocker\s+\S+.*\bploy-(control|proxy|updater)\b/,
  /\b(drop\s+(database|table|schema|user|role)|truncate\s+table|delete\s+from)\b/i,
  /\b(dropdb|dropuser)\b/,
  />\s*\/dev\/(sd|nvme|vd|xvd|mapper|disk)/,
  /\bchmod\s+(-[a-zA-Z]+\s+)*-[a-zA-Z]*R|\bchown\s+(-[a-zA-Z]+\s+)*-[a-zA-Z]*R/,
  /\b(userdel|deluser|groupdel|passwd|chpasswd|usermod|visudo)\b/,
  /\b(iptables|ip6tables|nft)\b[^|;&]*(-F\b|--flush|-X\b|-P\s+\w+\s+DROP|flush\s+ruleset)/,
  /\bufw\s+(disable|reset|default\s+deny|deny|delete)\b/,
  /:\(\)\s*\{[^}]*\}\s*;?\s*:/, // fork bomb
  /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/,
  /\bapt(-get)?\s+(-\S+\s+)*(remove|purge|autoremove|dist-upgrade|full-upgrade)\b/,
  /\b(yum|dnf)\s+(-\S+\s+)*(remove|erase|autoremove)\b/,
  /\bkill\s+(-\S+\s+)*1\b|\b(killall|pkill)\b/,
  /\bcrontab\s+(-\S+\s+)*-r\b/,
  /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f|push\s+[^|;&]*(--force|-f\b))/,
  /\b(swapoff|umount)\b/,
  /\btruncate\s+(-\S+\s+)*-s\b/,
  /(>|\btee\b)[^|;&]*\/etc\/(passwd|shadow|sudoers|group|fstab|hosts\.allow|hosts\.deny|ssh\/|sudoers\.d\/)/,
  /\.ssh\/authorized_keys/,
  /\/etc\/(ssh\/sshd_config|sudoers)/,
  /\bhistory\s+-c\b|\bunset\s+HISTFILE\b/,
  /\bmv\s+[^|;&]*\s\/dev\/null\b/,
  /\bfind\b[^|;&]*\s-delete\b/,
  /\bxargs\b[^|;&]*\brm\b/,
];

/** Constructs that can hide a command from a reader of the text. */
const OPAQUE = /`|\$\(|<\(|>\(|<<|\beval\b|\bexec\b|\bsource\b|^\s*\.\s|\bxargs\b|\bsudo\b|\bsu\s|\bnohup\b|\b(ba|z|da|k)?sh\s+(-\S+\s+)*-c\b|\bwatch\b|\bscreen\b|\btmux\b|\bat\s|\bbatch\b/;

/** Redirections that write nowhere: to the bit bucket, or one stream into another. */
const HARMLESS_REDIRECT = /(\d|&)?>>?\s*\/dev\/null|\d?>&\d|\d?<\s*\/dev\/null/g;

/** Split on `|`, `||`, `&&`, `;` and newlines outside quotes. Returns null when quotes do not balance. */
export function splitCommand(command: string): string[] | null {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote !== null) {
      current += char;
      if (char === '\\' && quote === '"' && index + 1 < command.length) {
        current += command[index + 1];
        index += 1;
      } else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '\\' && index + 1 < command.length) {
      current += char + command[index + 1];
      index += 1;
      continue;
    }
    if (char === '|' || char === ';' || char === '\n' || (char === '&' && command[index + 1] === '&')) {
      if ((char === '|' && command[index + 1] === '|') || char === '&') index += 1;
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (quote !== null) return null;
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/** The text with quoted strings blanked, so their contents are not mistaken for shell syntax. */
function unquoted(text: string): string {
  return text.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

function segmentIsSafe(segment: string): boolean {
  const bare = unquoted(segment).replace(HARMLESS_REDIRECT, ' ').trim();
  // A redirection that is left writes a file; a lone `&` backgrounds; an assignment prefix changes what runs.
  if (/[<>]/.test(bare) || /(^|[^&])&($|[^&])/.test(bare)) return false;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(bare)) return false;
  const words = bare.split(/\s+/);
  const program = (words[0] ?? '').replace(/^.*\//, '');
  if (!READERS.has(program)) return false;
  const rest = bare.slice((words[0] ?? '').length).trim();
  const allowed = SUBCOMMANDS[program];
  if (allowed !== undefined && !allowed.test(rest)) return false;
  const refused = REFUSED_FLAGS[program];
  if (refused !== undefined && refused.test(`${program} ${rest}`)) return false;
  if (program === 'timeout') {
    // `timeout 10 <command>` is as safe as the command it bounds.
    const inner = rest.replace(/^\d+[smh]?\s+/, '');
    return segmentIsSafe(inner);
  }
  return true;
}

export function classifyCommand(command: string): AiRisk {
  const text = command.trim();
  if (text.length === 0) return 'safe';
  if (DANGER.some((pattern) => pattern.test(text))) return 'danger';
  if (OPAQUE.test(unquoted(text))) return 'change';
  const segments = splitCommand(text);
  if (segments === null || segments.length === 0) return 'change';
  return segments.every(segmentIsSafe) ? 'safe' : 'change';
}

/** Files on a host whose change can lock people out or break the system: writing them is always asked about. */
const SENSITIVE_PATHS = /^\/(etc\/(passwd|shadow|group|sudoers|sudoers\.d\/|ssh\/|fstab|crontab|cron\.|systemd\/|hosts$|resolv\.conf|netplan\/|network\/|docker\/daemon\.json|pam\.d\/)|root\/\.ssh\/|home\/[^/]+\/\.ssh\/|boot\/|usr\/(bin|sbin|lib)\/|bin\/|sbin\/|lib\/|var\/lib\/docker\/|var\/run\/docker\.sock)/;

export function classifyHostWrite(path: string): AiRisk {
  return SENSITIVE_PATHS.test(path) ? 'danger' : 'change';
}
