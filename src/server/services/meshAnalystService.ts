import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { DEVICE_ROLES } from '../../utils/deviceRole.js';
import type { DbNode, DbMessage } from '../../db/types.js';

/**
 * Mesh Analyst — turns the AI bot into a full network analyst.
 *
 * Two capabilities:
 *  1. buildMeshSnapshot(sourceId) — a comprehensive, token-compact text dump of
 *     everything MeshMonitor knows about the mesh (nodes, telemetry, messages,
 *     topology, alerts). Injected into the LLM system prompt so the model can
 *     answer arbitrary analytical questions about the network.
 *  2. handleStatsCommand(query, sourceId) — deterministic short answers to basic
 *     stats commands (стат/узлы/бат/топ/снр/дальность/help) straight from the DB,
 *     with no LLM round-trip: instant, free, and exact.
 */

const ONLINE_WINDOW_SEC = 30 * 60;
const DAY_SEC = 24 * 60 * 60;
const BROADCAST_ADDR = 0xffffffff;

// ─── Shared helpers ───────────────────────────────────────────────────────────

function nodeShort(n: DbNode | undefined | null): string {
  if (!n) return '?';
  return n.shortName || n.longName || n.nodeId;
}

function agoText(nowSec: number, lastHeardSec: number | null | undefined, ru = false): string {
  if (!lastHeardSec) return ru ? 'давно' : 'never';
  const d = Math.max(0, nowSec - lastHeardSec);
  if (d < 3600) return `${Math.floor(d / 60)}${ru ? 'м' : 'm'}`;
  if (d < DAY_SEC) return `${Math.floor(d / 3600)}${ru ? 'ч' : 'h'}`;
  return `${Math.floor(d / DAY_SEC)}${ru ? 'д' : 'd'}`;
}

function battText(level: number | null | undefined): string {
  if (level == null) return '';
  // Meshtastic reports >100 when powered externally
  return level > 100 ? 'plug' : `${level}%`;
}

interface MeshData {
  nowSec: number;
  nodes: DbNode[];
  byNum: Map<number, DbNode>;
  online: DbNode[];
  active24h: DbNode[];
  messages24h: DbMessage[];
}

async function loadMeshData(sourceId: string): Promise<MeshData> {
  const nowSec = Math.floor(Date.now() / 1000);
  const [nodes, messages24h] = await Promise.all([
    databaseService.nodes.getAllNodes(sourceId),
    databaseService.messages.getMessagesAfterTimestamp(Date.now() - DAY_SEC * 1000, sourceId).catch(() => [] as DbMessage[]),
  ]);
  const visible = nodes.filter(n => !n.isIgnored);
  const byNum = new Map<number, DbNode>();
  for (const n of nodes) byNum.set(Number(n.nodeNum), n);
  const online = visible.filter(n => n.lastHeard && nowSec - n.lastHeard < ONLINE_WINDOW_SEC);
  const active24h = visible.filter(n => n.lastHeard && nowSec - n.lastHeard < DAY_SEC);
  return { nowSec, nodes: visible, byNum, online, active24h, messages24h };
}

function topTalkers(data: MeshData, count: number): Array<{ node: DbNode | undefined; num: number; msgs: number }> {
  const counts = new Map<number, number>();
  for (const m of data.messages24h) {
    const from = Number(m.fromNodeNum);
    counts.set(from, (counts.get(from) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([num, msgs]) => ({ node: data.byNum.get(num), num, msgs }));
}

// ─── Full mesh snapshot for the LLM ───────────────────────────────────────────

export interface SnapshotOptions {
  /** Cap for detailed per-node lines (online + recently heard first). Default 40. */
  maxNodeLines?: number;
}

/**
 * Build a compact plain-text snapshot of everything known about the mesh.
 * Designed to be appended to the LLM system prompt (nodeContext).
 */
export async function buildMeshSnapshot(sourceId: string, opts: SnapshotOptions = {}): Promise<string> {
  const maxNodeLines = opts.maxNodeLines ?? 40;
  const data = await loadMeshData(sourceId);
  const { nowSec, nodes, byNum, online, active24h, messages24h } = data;

  const channels = await databaseService.channels.getAllChannels(sourceId).catch(() => []);
  const longest = await databaseService.traceroutes.getLongestActiveRouteSegment(sourceId).catch(() => null);
  const record = await databaseService.traceroutes.getRecordHolderRouteSegment(sourceId).catch(() => null);
  const neighborInfo = await databaseService.neighbors.getAllNeighborInfo(sourceId).catch(() => []);
  const temps = await databaseService.telemetry.getLatestTelemetryValueForAllNodes('temperature', sourceId).catch(() => new Map<string, number>());
  const humidity = await databaseService.telemetry.getLatestTelemetryValueForAllNodes('humidity', sourceId).catch(() => new Map<string, number>());

  const lines: string[] = [];
  lines.push('=== MESH NETWORK SNAPSHOT (live MeshMonitor data) ===');
  lines.push('You are the analyst of this Meshtastic mesh network. Answer questions using ONLY the data below; be precise with numbers; if something is not in the data, say you do not have it. Reply in the language of the question.');
  lines.push(`Time: ${new Date().toISOString()}`);

  // Totals
  const withGps = nodes.filter(n => n.latitude != null && n.longitude != null).length;
  const viaMqtt = nodes.filter(n => n.viaMqtt).length;
  lines.push(`Nodes: ${nodes.length} known, ${online.length} online(<30m), ${active24h.length} active(<24h), ${withGps} with GPS, ${viaMqtt} via MQTT`);

  if (channels.length > 0) {
    lines.push('Channels: ' + channels.map(c => `${c.id}=${c.name || 'ch' + c.id}`).join(', '));
  }

  // Messages
  if (messages24h.length > 0) {
    const perChannel = new Map<number, number>();
    let dmCount = 0;
    for (const m of messages24h) {
      if (Number(m.toNodeNum) !== BROADCAST_ADDR) dmCount++;
      else perChannel.set(m.channel, (perChannel.get(m.channel) ?? 0) + 1);
    }
    const chPart = [...perChannel.entries()].sort((a, b) => a[0] - b[0]).map(([ch, c]) => `ch${ch}:${c}`).join(' ');
    const top = topTalkers(data, 5).map(t => `${nodeShort(t.node)}:${t.msgs}`).join(', ');
    lines.push(`Messages(24h): ${messages24h.length} total | ${chPart}${dmCount ? ` DM:${dmCount}` : ''} | top senders: ${top}`);
  } else {
    lines.push('Messages(24h): none');
  }

  // Battery summary (active nodes reporting battery, excluding plugged)
  const battNodes = active24h.filter(n => n.batteryLevel != null && n.batteryLevel <= 100);
  if (battNodes.length > 0) {
    const sorted = [...battNodes].sort((a, b) => (a.batteryLevel ?? 0) - (b.batteryLevel ?? 0));
    const avg = Math.round(battNodes.reduce((s, n) => s + (n.batteryLevel ?? 0), 0) / battNodes.length);
    lines.push(`Battery: min ${nodeShort(sorted[0])} ${sorted[0].batteryLevel}%, avg ${avg}% (${battNodes.length} reporting; "plug"=externally powered)`);
  }

  // Environment sensors
  const envParts: string[] = [];
  for (const [nodeId, t] of temps) {
    const n = nodes.find(x => x.nodeId === nodeId);
    if (!n) continue;
    const h = humidity.get(nodeId);
    envParts.push(`${nodeShort(n)} ${t.toFixed(1)}°C${h != null ? ` ${Math.round(h)}%RH` : ''}`);
    if (envParts.length >= 8) break;
  }
  if (envParts.length > 0) lines.push('Env sensors: ' + envParts.join(' | '));

  // Topology
  if (longest) {
    const from = byNum.get(Number(longest.fromNodeNum));
    const to = byNum.get(Number(longest.toNodeNum));
    let link = `Links: longest active ${longest.distanceKm.toFixed(1)}km ${nodeShort(from)}→${nodeShort(to)}`;
    if (record && record.id !== longest.id) {
      const rf = byNum.get(Number(record.fromNodeNum));
      const rt = byNum.get(Number(record.toNodeNum));
      link += `; record ${record.distanceKm.toFixed(1)}km ${nodeShort(rf)}→${nodeShort(rt)}`;
    }
    lines.push(link);
  }
  if (neighborInfo.length > 0) {
    lines.push(`Direct neighbor links (NeighborInfo): ${neighborInfo.length}`);
  }

  // Hop distribution among active nodes
  const hopHist = new Map<number, number>();
  for (const n of active24h) {
    if (n.hopsAway != null) hopHist.set(n.hopsAway, (hopHist.get(n.hopsAway) ?? 0) + 1);
  }
  if (hopHist.size > 0) {
    lines.push('Hops distribution(24h): ' + [...hopHist.entries()].sort((a, b) => a[0] - b[0]).map(([h, c]) => `${h}hop:${c}`).join(' '));
  }

  // Per-node detail table: online first, then most recently heard
  const detail = [...nodes]
    .sort((a, b) => (b.lastHeard ?? 0) - (a.lastHeard ?? 0))
    .slice(0, maxNodeLines);
  lines.push('NODES (name | short | id | relay | role | hops | SNR | batt | volt | ch.util | heard | pos):');
  for (const n of detail) {
    const relay = (Number(n.nodeNum) & 0xff).toString(16).padStart(2, '0');
    const role = n.role != null ? (DEVICE_ROLES[n.role] ?? String(n.role)) : '';
    const parts = [
      n.longName || '-',
      n.shortName || '-',
      n.nodeId,
      relay,
      role,
      n.hopsAway != null ? `${n.hopsAway}` : '',
      n.snr != null ? `${n.snr.toFixed(1)}dB` : '',
      battText(n.batteryLevel),
      n.voltage != null ? `${n.voltage.toFixed(2)}V` : '',
      n.channelUtilization != null ? `${n.channelUtilization.toFixed(0)}%` : '',
      agoText(nowSec, n.lastHeard),
      n.latitude != null && n.longitude != null ? `${n.latitude.toFixed(2)},${n.longitude.toFixed(2)}` : '',
    ];
    lines.push(parts.join('|'));
  }
  if (nodes.length > detail.length) {
    lines.push(`(+${nodes.length - detail.length} more nodes not listed, heard longer ago)`);
  }

  // Recently disappeared: heard 1-7 days ago
  const gone = nodes
    .filter(n => n.lastHeard && nowSec - n.lastHeard >= DAY_SEC && nowSec - n.lastHeard < 7 * DAY_SEC)
    .sort((a, b) => (b.lastHeard ?? 0) - (a.lastHeard ?? 0));
  if (gone.length > 0) {
    lines.push(`Offline 1-7d: ${gone.slice(0, 15).map(n => `${nodeShort(n)}(${agoText(nowSec, n.lastHeard)})`).join(', ')}${gone.length > 15 ? ` +${gone.length - 15}` : ''}`);
  }

  // Alerts
  const alerts: string[] = [];
  const keyIssues = nodes.filter(n => n.keyMismatchDetected || n.duplicateKeyDetected);
  if (keyIssues.length > 0) alerts.push(`key issues: ${keyIssues.map(n => nodeShort(n)).join(', ')}`);
  const spammers = nodes.filter(n => n.isExcessivePackets);
  if (spammers.length > 0) alerts.push(`excessive packets: ${spammers.map(n => nodeShort(n)).join(', ')}`);
  const lowBatt = battNodes.filter(n => (n.batteryLevel ?? 100) < 20);
  if (lowBatt.length > 0) alerts.push(`low battery(<20%): ${lowBatt.map(n => `${nodeShort(n)} ${n.batteryLevel}%`).join(', ')}`);
  if (alerts.length > 0) lines.push('ALERTS: ' + alerts.join('; '));

  lines.push('=== END SNAPSHOT ===');
  return lines.join('\n');
}

// ─── Deterministic stats commands ─────────────────────────────────────────────

export type StatsCommandId = 'stats' | 'nodes' | 'battery' | 'top' | 'links' | 'range' | 'help';

const COMMAND_ALIASES: Record<StatsCommandId, string[]> = {
  stats: ['стат', 'статы', 'статистика', 'stats', 'stat'],
  nodes: ['узлы', 'ноды', 'онлайн', 'nodes', 'online'],
  battery: ['бат', 'батарея', 'акб', 'battery', 'bat'],
  top: ['топ', 'top'],
  links: ['снр', 'сигнал', 'линки', 'snr', 'links'],
  range: ['дальность', 'рекорд', 'дистанция', 'range'],
  help: ['помощь', 'хелп', 'команды', 'help', 'commands', '?'],
};

const SECOND_TOKEN_OK = new Set(['сети', 'сеть', 'меш', 'mesh', 'net', 'network', '24ч', '24h']);

/**
 * Match a user query against the basic stats commands.
 * Accepts a bare command ("стат") or command + qualifier ("стат сети").
 * Anything longer falls through to the LLM analyst.
 */
export function matchStatsCommand(query: string): StatsCommandId | null {
  let normalized = query.toLowerCase().trim();
  // Strip trailing punctuation, but keep a bare "?" (it's the help alias)
  const stripped = normalized.replace(/[?!.,]+$/, '').trim();
  if (stripped) normalized = stripped;
  if (!normalized) return null;
  const tokens = normalized.split(/\s+/);
  if (tokens.length > 2) return null;
  if (tokens.length === 2 && !SECOND_TOKEN_OK.has(tokens[1])) return null;
  for (const [id, aliases] of Object.entries(COMMAND_ALIASES) as Array<[StatsCommandId, string[]]>) {
    if (aliases.includes(tokens[0])) return id;
  }
  return null;
}

/** Join items with ', ' until the result would exceed maxChars; append "+N" for the rest. */
function joinBudget(items: string[], maxChars: number): string {
  const out: string[] = [];
  let len = 0;
  for (let i = 0; i < items.length; i++) {
    const add = items[i].length + (out.length > 0 ? 2 : 0);
    if (len + add > maxChars) {
      out.push(`+${items.length - i}`);
      break;
    }
    out.push(items[i]);
    len += add;
  }
  return out.join(', ');
}

async function execStatsCommand(cmd: StatsCommandId, sourceId: string): Promise<string> {
  const data = await loadMeshData(sourceId);
  const { nodes, byNum, online, active24h, messages24h } = data;

  switch (cmd) {
    case 'stats': {
      const battNodes = active24h.filter(n => n.batteryLevel != null && n.batteryLevel <= 100);
      const minBatt = battNodes.length > 0
        ? [...battNodes].sort((a, b) => (a.batteryLevel ?? 0) - (b.batteryLevel ?? 0))[0]
        : null;
      const longest = await databaseService.traceroutes.getLongestActiveRouteSegment(sourceId).catch(() => null);
      let reply = `Сеть: ${nodes.length} узлов, онлайн ${online.length} (30м), за 24ч ${active24h.length}. Смс/24ч: ${messages24h.length}.`;
      if (minBatt) reply += ` Мин.бат: ${nodeShort(minBatt)} ${minBatt.batteryLevel}%.`;
      if (longest) reply += ` Линк: ${longest.distanceKm.toFixed(1)}км.`;
      return reply;
    }
    case 'nodes': {
      if (online.length === 0) return 'Онлайн узлов нет (за 30 мин).';
      const names = online
        .sort((a, b) => (a.hopsAway ?? 99) - (b.hopsAway ?? 99))
        .map(n => n.hopsAway != null ? `${nodeShort(n)}(${n.hopsAway}h)` : nodeShort(n));
      return `Онлайн ${online.length}: ${joinBudget(names, 170)}`;
    }
    case 'battery': {
      const batt = active24h
        .filter(n => n.batteryLevel != null)
        .sort((a, b) => (a.batteryLevel ?? 0) - (b.batteryLevel ?? 0));
      if (batt.length === 0) return 'Нет данных о батареях.';
      const items = batt.map(n => `${nodeShort(n)} ${(n.batteryLevel ?? 0) > 100 ? '🔌' : `${n.batteryLevel}%`}`);
      return `Батарея (мин→макс): ${joinBudget(items, 170)}`;
    }
    case 'top': {
      if (messages24h.length === 0) return 'За 24ч сообщений не было.';
      const top = topTalkers(data, 5).map(t => `${nodeShort(t.node) !== '?' ? nodeShort(t.node) : `!${t.num.toString(16)}`} ${t.msgs}`);
      return `Топ за 24ч: ${top.join(', ')}. Всего ${messages24h.length} смс.`;
    }
    case 'links': {
      const direct = active24h.filter(n => n.hopsAway === 0 && n.snr != null);
      if (direct.length === 0) return 'Нет прямых узлов с данными SNR.';
      const sorted = [...direct].sort((a, b) => (b.snr ?? -99) - (a.snr ?? -99));
      const best = sorted[0];
      const worst = sorted[sorted.length - 1];
      let reply = `Прямых узлов: ${direct.length}. Лучший SNR: ${nodeShort(best)} ${best.snr?.toFixed(1)}дБ`;
      if (worst !== best) reply += `, худший: ${nodeShort(worst)} ${worst.snr?.toFixed(1)}дБ`;
      return reply + '.';
    }
    case 'range': {
      const longest = await databaseService.traceroutes.getLongestActiveRouteSegment(sourceId).catch(() => null);
      const record = await databaseService.traceroutes.getRecordHolderRouteSegment(sourceId).catch(() => null);
      if (!longest && !record) return 'Данных о дальности линков пока нет.';
      let reply = '';
      if (longest) {
        reply = `Длиннейший активный линк: ${longest.distanceKm.toFixed(1)}км ${nodeShort(byNum.get(Number(longest.fromNodeNum)))}→${nodeShort(byNum.get(Number(longest.toNodeNum)))}.`;
      }
      if (record && (!longest || record.id !== longest.id)) {
        reply += ` Рекорд: ${record.distanceKm.toFixed(1)}км ${nodeShort(byNum.get(Number(record.fromNodeNum)))}→${nodeShort(byNum.get(Number(record.toNodeNum)))}.`;
      }
      return reply.trim();
    }
    case 'help':
      return 'Команды: стат, узлы, бат, топ, снр, дальность. Любой другой вопрос — отвечу как AI-аналитик сети.';
  }
}

/**
 * If the query is a basic stats command, answer it straight from the DB.
 * Returns null when the query is not a stats command (caller falls back to the LLM).
 */
export async function handleStatsCommand(query: string, sourceId: string): Promise<string | null> {
  const cmd = matchStatsCommand(query);
  if (!cmd) return null;
  try {
    return await execStatsCommand(cmd, sourceId);
  } catch (err) {
    logger.error(`🤖 Stats command "${cmd}" failed:`, err);
    return null;
  }
}
