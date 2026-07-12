import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAllNodes: vi.fn(),
  getMessagesAfterTimestamp: vi.fn(),
  getAllChannels: vi.fn(),
  getLongestActiveRouteSegment: vi.fn(),
  getRecordHolderRouteSegment: vi.fn(),
  getAllNeighborInfo: vi.fn(),
  getLatestTelemetryValueForAllNodes: vi.fn(),
}));

vi.mock('../../services/database.js', () => ({
  default: {
    nodes: { getAllNodes: mocks.getAllNodes },
    messages: { getMessagesAfterTimestamp: mocks.getMessagesAfterTimestamp },
    channels: { getAllChannels: mocks.getAllChannels },
    traceroutes: {
      getLongestActiveRouteSegment: mocks.getLongestActiveRouteSegment,
      getRecordHolderRouteSegment: mocks.getRecordHolderRouteSegment,
    },
    neighbors: { getAllNeighborInfo: mocks.getAllNeighborInfo },
    telemetry: { getLatestTelemetryValueForAllNodes: mocks.getLatestTelemetryValueForAllNodes },
  },
}));

import { matchStatsCommand, handleStatsCommand, buildMeshSnapshot } from './meshAnalystService.js';

const SOURCE = 'src-test';
const nowSec = Math.floor(Date.now() / 1000);

function makeNodes() {
  return [
    {
      nodeNum: 0x11223301, nodeId: '!11223301', longName: 'Alpha Station', shortName: 'ALFA',
      hwModel: 9, role: 2, hopsAway: 0, snr: 8.5, batteryLevel: 95, voltage: 4.1,
      channelUtilization: 12, lastHeard: nowSec - 120, latitude: 50.45, longitude: 30.52,
      createdAt: 0, updatedAt: 0,
    },
    {
      nodeNum: 0x11223302, nodeId: '!11223302', longName: 'Bravo', shortName: 'BRVO',
      hwModel: 9, role: 0, hopsAway: 1, snr: -12.25, batteryLevel: 18,
      lastHeard: nowSec - 600, createdAt: 0, updatedAt: 0,
    },
    {
      nodeNum: 0x11223303, nodeId: '!11223303', longName: 'Charlie', shortName: 'CHRL',
      hwModel: 9, hopsAway: 2, lastHeard: nowSec - 3 * 24 * 3600, createdAt: 0, updatedAt: 0,
    },
    {
      nodeNum: 0x11223304, nodeId: '!11223304', longName: 'Ghost', shortName: 'GHST',
      hwModel: 9, isIgnored: true, lastHeard: nowSec - 60, createdAt: 0, updatedAt: 0,
    },
  ];
}

function makeMessages() {
  const nowMs = Date.now();
  const broadcast = 0xffffffff;
  const mk = (from: number, to: number, channel: number, i: number) => ({
    id: `m${from}-${i}`, fromNodeNum: from, toNodeNum: to,
    fromNodeId: `!${from.toString(16)}`, toNodeId: `!${to.toString(16)}`,
    text: 'hi', channel, timestamp: nowMs - i * 60_000,
  });
  return [
    mk(0x11223301, broadcast, 0, 1),
    mk(0x11223301, broadcast, 0, 2),
    mk(0x11223301, broadcast, 1, 3),
    mk(0x11223302, broadcast, 0, 4),
    mk(0x11223302, 0x11223301, 0, 5), // DM
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAllNodes.mockResolvedValue(makeNodes());
  mocks.getMessagesAfterTimestamp.mockResolvedValue(makeMessages());
  mocks.getAllChannels.mockResolvedValue([
    { id: 0, name: 'LongFast', uplinkEnabled: false, downlinkEnabled: false, createdAt: 0, updatedAt: 0 },
    { id: 1, name: 'gauntlet', uplinkEnabled: false, downlinkEnabled: false, createdAt: 0, updatedAt: 0 },
  ]);
  mocks.getLongestActiveRouteSegment.mockResolvedValue({
    id: 1, fromNodeNum: 0x11223301, toNodeNum: 0x11223302,
    fromNodeId: '!11223301', toNodeId: '!11223302',
    distanceKm: 42.3, isRecordHolder: false, timestamp: Date.now(), createdAt: Date.now(),
  });
  mocks.getRecordHolderRouteSegment.mockResolvedValue(null);
  mocks.getAllNeighborInfo.mockResolvedValue([
    { nodeNum: 0x11223301, neighborNodeNum: 0x11223302, snr: 5 },
  ]);
  mocks.getLatestTelemetryValueForAllNodes.mockResolvedValue(new Map());
});

describe('matchStatsCommand', () => {
  it('matches Russian and English aliases', () => {
    expect(matchStatsCommand('стат')).toBe('stats');
    expect(matchStatsCommand('Статистика')).toBe('stats');
    expect(matchStatsCommand('stats')).toBe('stats');
    expect(matchStatsCommand('узлы')).toBe('nodes');
    expect(matchStatsCommand('онлайн')).toBe('nodes');
    expect(matchStatsCommand('бат')).toBe('battery');
    expect(matchStatsCommand('топ')).toBe('top');
    expect(matchStatsCommand('снр')).toBe('links');
    expect(matchStatsCommand('дальность')).toBe('range');
    expect(matchStatsCommand('help')).toBe('help');
    expect(matchStatsCommand('?')).toBe('help');
  });

  it('tolerates trailing punctuation and a qualifier word', () => {
    expect(matchStatsCommand('стат?')).toBe('stats');
    expect(matchStatsCommand('стат сети')).toBe('stats');
    expect(matchStatsCommand('stats network')).toBe('stats');
  });

  it('does not match free-form questions', () => {
    expect(matchStatsCommand('привет как дела')).toBeNull();
    expect(matchStatsCommand('топ вопрос дня')).toBeNull();
    expect(matchStatsCommand('какая погода')).toBeNull();
    expect(matchStatsCommand('')).toBeNull();
  });
});

describe('handleStatsCommand', () => {
  it('returns null for non-commands', async () => {
    expect(await handleStatsCommand('расскажи про сеть подробно', SOURCE)).toBeNull();
  });

  it('answers "стат" with node and message counts (ignored nodes excluded)', async () => {
    const reply = await handleStatsCommand('стат', SOURCE);
    expect(reply).toContain('3 узлов'); // Ghost is ignored
    expect(reply).toContain('онлайн 2');
    expect(reply).toContain('Смс/24ч: 5');
    expect(reply).toContain('18%'); // min battery
    expect(reply).toContain('42.3км');
  });

  it('answers "узлы" with online node names sorted by hops', async () => {
    const reply = await handleStatsCommand('узлы', SOURCE);
    expect(reply).toContain('Онлайн 2');
    expect(reply!.indexOf('ALFA')).toBeLessThan(reply!.indexOf('BRVO'));
    expect(reply).not.toContain('GHST');
  });

  it('answers "бат" with lowest battery first', async () => {
    const reply = await handleStatsCommand('бат', SOURCE);
    expect(reply!.indexOf('BRVO 18%')).toBeLessThan(reply!.indexOf('ALFA 95%'));
  });

  it('answers "топ" with the most active sender first', async () => {
    const reply = await handleStatsCommand('топ', SOURCE);
    expect(reply).toContain('ALFA 3');
    expect(reply).toContain('Всего 5');
  });

  it('answers "снр" with best direct-node SNR', async () => {
    const reply = await handleStatsCommand('снр', SOURCE);
    expect(reply).toContain('ALFA');
    expect(reply).toContain('8.5дБ');
  });

  it('answers "дальность" with the longest link', async () => {
    const reply = await handleStatsCommand('дальность', SOURCE);
    expect(reply).toContain('42.3км');
    expect(reply).toContain('ALFA');
  });

  it('lists commands for "help"', async () => {
    const reply = await handleStatsCommand('help', SOURCE);
    expect(reply).toContain('стат');
    expect(reply).toContain('дальность');
  });

  it('returns null when the DB throws (falls back to LLM)', async () => {
    mocks.getAllNodes.mockRejectedValue(new Error('db down'));
    expect(await handleStatsCommand('стат', SOURCE)).toBeNull();
  });
});

describe('buildMeshSnapshot', () => {
  it('includes totals, channels, messages, links and per-node lines', async () => {
    const snap = await buildMeshSnapshot(SOURCE);
    expect(snap).toContain('MESH NETWORK SNAPSHOT');
    expect(snap).toContain('Nodes: 3 known, 2 online(<30m)');
    expect(snap).toContain('0=LongFast, 1=gauntlet');
    expect(snap).toContain('Messages(24h): 5 total');
    expect(snap).toContain('DM:1');
    expect(snap).toContain('longest active 42.3km');
    expect(snap).toContain('Alpha Station');
    expect(snap).toContain('!11223302');
  });

  it('excludes ignored nodes and reports low battery alert', async () => {
    const snap = await buildMeshSnapshot(SOURCE);
    expect(snap).not.toContain('Ghost');
    expect(snap).toContain('low battery(<20%)');
    expect(snap).toContain('BRVO 18%');
  });

  it('lists nodes offline for 1-7 days', async () => {
    const snap = await buildMeshSnapshot(SOURCE);
    expect(snap).toContain('Offline 1-7d');
    expect(snap).toContain('CHRL(3d)');
  });

  it('survives an empty database', async () => {
    mocks.getAllNodes.mockResolvedValue([]);
    mocks.getMessagesAfterTimestamp.mockResolvedValue([]);
    mocks.getAllChannels.mockResolvedValue([]);
    mocks.getLongestActiveRouteSegment.mockResolvedValue(null);
    mocks.getAllNeighborInfo.mockResolvedValue([]);
    const snap = await buildMeshSnapshot(SOURCE);
    expect(snap).toContain('Nodes: 0 known');
    expect(snap).toContain('Messages(24h): none');
  });

  it('respects the maxNodeLines cap', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      nodeNum: 0x22000000 + i, nodeId: `!${(0x22000000 + i).toString(16)}`,
      longName: `Node${i}`, shortName: `N${i}`, hwModel: 9,
      lastHeard: nowSec - 60 - i, createdAt: 0, updatedAt: 0,
    }));
    mocks.getAllNodes.mockResolvedValue(many);
    const snap = await buildMeshSnapshot(SOURCE, { maxNodeLines: 10 });
    expect(snap).toContain('(+50 more nodes not listed');
  });
});
