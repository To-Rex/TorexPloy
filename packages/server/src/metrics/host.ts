/**
 * Host metrics from `/proc` and `df`.
 *
 * The control plane reads the local host through the mounted `/proc` (a
 * container sees host CPU and memory counters there), and remote hosts
 * through one multiplexed SSH command. Both produce the same text, so one
 * parser serves both.
 */
import { readFile, statfs } from 'node:fs/promises';
import { join } from 'node:path';

export interface CpuTimes {
  idle: number;
  total: number;
}

export interface HostReading {
  cpu: CpuTimes | null;
  memTotal: number;
  memAvailable: number;
  load1: number;
  diskTotal: number;
  diskUsed: number;
}

/** First `cpu` line of /proc/stat → cumulative idle and total jiffies. */
export function parseProcStat(text: string): CpuTimes | null {
  const line = text.split('\n').find((candidate) => candidate.startsWith('cpu '));
  if (line === undefined) return null;
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  if (values.length < 4 || values.some((value) => !Number.isFinite(value))) return null;
  // user nice system idle iowait irq softirq steal (guest time is already inside user/nice)
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = values;
  return { idle: idle + iowait, total: user + nice + system + idle + iowait + irq + softirq + steal };
}

export function cpuBusyPercent(previous: CpuTimes, current: CpuTimes): number {
  const total = current.total - previous.total;
  const idle = current.idle - previous.idle;
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, ((total - idle) / total) * 100));
}

export function parseMeminfo(text: string): { total: number; available: number } {
  const value = (key: string): number => {
    const match = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
    return match === null ? 0 : Number(match[1]) * 1024;
  };
  const total = value('MemTotal');
  const available = value('MemAvailable') || value('MemFree') + value('Buffers') + value('Cached');
  return { total, available };
}

export function parseLoadavg(text: string): number {
  const first = Number(text.trim().split(/\s+/)[0]);
  return Number.isFinite(first) ? first : 0;
}

/** `df -PB1 /` data line → total and used bytes. */
export function parseDf(text: string): { total: number; used: number } {
  const line = text
    .trim()
    .split('\n')
    .reverse()
    .find((candidate) => /^\S+\s+\d+\s+\d+\s+\d+/.test(candidate.trim()));
  if (line === undefined) return { total: 0, used: 0 };
  const [, total = '0', used = '0'] = line.trim().split(/\s+/);
  return { total: Number(total), used: Number(used) };
}

/** Script run on remote hosts; sections are separated so each parser sees only its own input. */
export const REMOTE_PROBE = "cat /proc/stat | head -n 1; echo '--ploy--'; cat /proc/meminfo; echo '--ploy--'; cat /proc/loadavg; echo '--ploy--'; df -PB1 /";

export function parseRemoteProbe(output: string): HostReading {
  const [stat = '', meminfo = '', loadavg = '', df = ''] = output.split('--ploy--');
  const memory = parseMeminfo(meminfo);
  const disk = parseDf(df);
  return { cpu: parseProcStat(stat), memTotal: memory.total, memAvailable: memory.available, load1: parseLoadavg(loadavg), diskTotal: disk.total, diskUsed: disk.used };
}

/** Read the local host. Returns null where `/proc` is not available (e.g. macOS development). */
export async function readLocalHost(procDir: string, diskPath: string): Promise<HostReading | null> {
  try {
    const [stat, meminfo, loadavg] = await Promise.all([
      readFile(join(procDir, 'stat'), 'utf8'),
      readFile(join(procDir, 'meminfo'), 'utf8'),
      readFile(join(procDir, 'loadavg'), 'utf8'),
    ]);
    const memory = parseMeminfo(meminfo);
    const fs = await statfs(diskPath);
    const total = fs.blocks * fs.bsize;
    return {
      cpu: parseProcStat(stat),
      memTotal: memory.total,
      memAvailable: memory.available,
      load1: parseLoadavg(loadavg),
      diskTotal: total,
      diskUsed: total - fs.bfree * fs.bsize,
    };
  } catch {
    return null;
  }
}
