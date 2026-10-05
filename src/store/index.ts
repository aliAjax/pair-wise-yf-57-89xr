import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';
import Taro from '@tarojs/taro';

export type SyncState = 'local' | 'queued' | 'synced';
export type IngestKind = 'live' | 'history';
export type Risk = 'low' | 'medium' | 'high';

export interface Team { id: string; name: string; leaderLastSeen: number | null; }
export interface Segment {
  id: string; lineId: string; name: string;
  holderTeamId: string | null;
  status: 'held' | 'pending';
  heldSeq: number | null;
  successorTeamId: string | null;
  handoverCount: number;
}
export interface PatrolObservation {
  id: string; time: string; ts: number; note: string; risk: Risk;
  sync: SyncState; reviewed: boolean;
  teamId: string; segmentId: string | null;
  ingest: IngestKind; arrivalSeq: number | null;
}
export interface TrackPoint {
  id: string; latitude: number; longitude: number; at: string; ts: number;
  source: 'gps' | 'manual'; teamId: string; segmentId: string; arrivalSeq: number | null;
}
export interface Sample {
  id: string; code: string; species: string; count: number;
  status: 'draft' | 'submitted' | 'verified';
  teamId: string; segmentId: string; verifyRound: number; arrivalSeq: number | null;
}
export interface UploadSummary { live: number; history: number; duplicates: number; at: string; }
interface State {
  teams: Team[]; segments: Segment[];
  observations: PatrolObservation[]; points: TrackPoint[]; samples: Sample[];
  currentTeamId: string; currentSegmentId: string;
  arrivalClock: number; ingestedIds: string[];
  leaderTimeoutMs: number;
  lastUpload: UploadSummary | null;
  log: string[];
}

const LEADER_TIMEOUT = 45 * 60 * 1000;
const seedNow = Date.now();
const HOUR = 3600 * 1000;

const seed: State = {
  teams: [
    { id: 'team-a', name: '巡护一队', leaderLastSeen: seedNow - 5 * 60 * 1000 },
    { id: 'team-b', name: '巡护二队', leaderLastSeen: seedNow - 12 * 60 * 1000 },
    { id: 'team-c', name: '巡护三队', leaderLastSeen: null }
  ],
  segments: [
    { id: 'seg-east', lineId: 'line-yf57', name: '东坡段', holderTeamId: 'team-a', status: 'held', heldSeq: 1, successorTeamId: 'team-b', handoverCount: 1 },
    { id: 'seg-valley', lineId: 'line-yf57', name: '溪谷段', holderTeamId: 'team-b', status: 'held', heldSeq: 2, successorTeamId: 'team-c', handoverCount: 1 },
    { id: 'seg-south', lineId: 'line-yf57', name: '南段', holderTeamId: null, status: 'pending', heldSeq: null, successorTeamId: 'team-a', handoverCount: 0 }
  ],
  observations: [
    { id: 'o1', time: '2026-09-29 07:20', ts: seedNow - 6 * HOUR, note: '东坡发现新鲜足迹，沿溪谷方向移动', risk: 'medium', sync: 'synced', reviewed: false, teamId: 'team-a', segmentId: 'seg-east', ingest: 'live', arrivalSeq: 1 },
    { id: 'o2', time: '2026-09-29 08:05', ts: seedNow - 5.6 * HOUR, note: '红外相机外壳松动，已拍照待补报', risk: 'high', sync: 'queued', reviewed: false, teamId: 'team-a', segmentId: 'seg-east', ingest: 'live', arrivalSeq: null },
    { id: 'o3', time: '2026-09-29 08:40', ts: seedNow - 4.6 * HOUR, note: '样线南段没有异常', risk: 'low', sync: 'synced', reviewed: true, teamId: 'team-b', segmentId: 'seg-valley', ingest: 'live', arrivalSeq: 2 }
  ],
  points: [
    { id: 'p1', latitude: 30.5821, longitude: 103.2174, at: '07:20', ts: seedNow - 6 * HOUR, source: 'gps', teamId: 'team-a', segmentId: 'seg-east', arrivalSeq: 1 },
    { id: 'p2', latitude: 30.5856, longitude: 103.2211, at: '08:05', ts: seedNow - 5 * HOUR, source: 'gps', teamId: 'team-b', segmentId: 'seg-valley', arrivalSeq: 2 }
  ],
  samples: [
    { id: 's1', code: 'WD-0929-01', species: '疑似豹猫毛发', count: 1, status: 'submitted', teamId: 'team-a', segmentId: 'seg-east', verifyRound: 0, arrivalSeq: 1 }
  ],
  currentTeamId: 'team-a',
  currentSegmentId: 'seg-east',
  arrivalClock: 2,
  ingestedIds: ['o1', 'o3', 'p1', 'p2', 's1'],
  leaderTimeoutMs: LEADER_TIMEOUT,
  lastUpload: null,
  log: ['样线 YF-57 拆分为东坡段、溪谷段、南段，一个路段同一时间只认一个责任队。']
};

const STORAGE_KEY = 'yf57-patrol-state-v2';
let idCounter = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;
function readState(): State {
  try {
    const saved = Taro.getStorageSync(STORAGE_KEY);
    return saved ? { ...seed, ...(JSON.parse(saved) as State) } : seed;
  } catch { return seed; }
}

function teamName(state: State, id: string | null): string {
  return state.teams.find((team) => team.id === id)?.name ?? '待接';
}
function segmentName(state: State, id: string | null): string {
  return state.segments.find((segment) => segment.id === id)?.name ?? '未归属';
}
function pushLog(state: State, message: string) {
  state.log.unshift(message);
  if (state.log.length > 9) state.log.length = 9;
}
function nearestPoint(points: TrackPoint[], ts: number, teamId: string): TrackPoint | null {
  let best: TrackPoint | null = null;
  for (const point of points) {
    if (point.teamId !== teamId) continue;
    if (!best || Math.abs(point.ts - ts) < Math.abs(best.ts - ts)) best = point;
  }
  return best;
}
// 轨迹点一更新，观察归属按本队最近轨迹点重算
function reattributeObservations(state: State) {
  state.observations.forEach((obs) => {
    const point = nearestPoint(state.points, obs.ts, obs.teamId);
    if (point) obs.segmentId = point.segmentId;
  });
}
// 责任方一变，样本核验就要重算
function recalcSamples(state: State, segmentId: string) {
  state.samples.forEach((sample) => {
    if (sample.segmentId === segmentId) {
      if (sample.status === 'verified') sample.status = 'submitted';
      sample.verifyRound += 1;
    }
  });
}
function setHolder(state: State, segment: Segment, teamId: string, seq: number, reason: string) {
  if (segment.holderTeamId === teamId) return;
  segment.holderTeamId = teamId;
  segment.status = 'held';
  segment.heldSeq = seq;
  segment.handoverCount += 1;
  recalcSamples(state, segment.id);
  pushLog(state, `${segment.name} 责任方变更为${teamName(state, teamId)}（${reason}），样本核验重算`);
}

const slice = createSlice({
  name: 'patrol', initialState: readState(),
  reducers: {
    switchTeam: (state, action: PayloadAction<string>) => { state.currentTeamId = action.payload; },
    setCurrentSegment: (state, action: PayloadAction<string>) => { state.currentSegmentId = action.payload; },
    addObservation: (state, action: PayloadAction<{ note: string; risk: Risk }>) => {
      const now = Date.now();
      const point = nearestPoint(state.points, now, state.currentTeamId);
      state.observations.unshift({
        id: nextId('o'), time: new Date(now).toLocaleString(), ts: now,
        note: action.payload.note, risk: action.payload.risk,
        sync: 'queued', reviewed: false,
        teamId: state.currentTeamId,
        segmentId: point?.segmentId ?? state.currentSegmentId,
        ingest: 'live', arrivalSeq: null
      });
    },
    addPoint: (state, action: PayloadAction<{ latitude: number; longitude: number }>) => {
      const now = Date.now();
      state.points.push({
        id: nextId('p'), ...action.payload, at: new Date(now).toLocaleTimeString(), ts: now,
        source: 'gps', teamId: state.currentTeamId, segmentId: state.currentSegmentId, arrivalSeq: null
      });
      reattributeObservations(state);
    },
    updatePointSegment: (state, action: PayloadAction<{ pointId: string; segmentId: string }>) => {
      const point = state.points.find((entry) => entry.id === action.payload.pointId);
      if (!point) return;
      point.segmentId = action.payload.segmentId;
      reattributeObservations(state);
      pushLog(state, `轨迹点 ${point.at} 更正到${segmentName(state, point.segmentId)}，观察归属已重算`);
    },
    addSample: (state, action: PayloadAction<{ code: string; species: string; count: number }>) => {
      state.samples.unshift({
        id: nextId('s'), ...action.payload, status: 'submitted',
        teamId: state.currentTeamId, segmentId: state.currentSegmentId, verifyRound: 0, arrivalSeq: null
      });
    },
    heartbeat: (state, action: PayloadAction<string>) => {
      const team = state.teams.find((entry) => entry.id === action.payload);
      if (team) team.leaderLastSeen = Date.now();
    },
    markLeaderLost: (state, action: PayloadAction<string>) => {
      const team = state.teams.find((entry) => entry.id === action.payload);
      if (team) {
        team.leaderLastSeen = Date.now() - state.leaderTimeoutMs - 1;
        pushLog(state, `${team.name}队长失联，等待超时判定`);
      }
    },
    // 队长失联超期，路段回到待接状态
    checkLeaderTimeouts: (state, action: PayloadAction<number | undefined>) => {
      const now = action.payload ?? Date.now();
      state.segments.forEach((segment) => {
        if (!segment.holderTeamId) return;
        const holder = state.teams.find((team) => team.id === segment.holderTeamId);
        const lastSeen = holder?.leaderLastSeen;
        if (!lastSeen || now - lastSeen > state.leaderTimeoutMs) {
          pushLog(state, `${holder?.name ?? '责任队'}队长失联超期，${segment.name}回到待接状态`);
          segment.holderTeamId = null;
          segment.status = 'pending';
          segment.heldSeq = null;
        }
      });
    },
    // 网络恢复后合并离线记录：按到站顺序入账，重复补传只入账一次
    uploadOfflineBatch: (state, action: PayloadAction<{ teamId: string; replay?: boolean }>) => {
      const { teamId, replay } = action.payload;
      const now = Date.now();
      const team = state.teams.find((entry) => entry.id === teamId);
      if (team) team.leaderLastSeen = now;
      const summary: UploadSummary = { live: 0, history: 0, duplicates: 0, at: new Date(now).toLocaleString() };
      const seen = new Set(state.ingestedIds);
      // 交接时间与上传顺序冲突时，归属以先到站点的记录为准
      const ingestSegment = (segmentId: string | null, seq: number): IngestKind => {
        const segment = state.segments.find((entry) => entry.id === segmentId);
        if (!segment) return 'live';
        if (!segment.holderTeamId) {
          setHolder(state, segment, teamId, seq, '先到站点的记录');
          return 'live';
        }
        if (segment.holderTeamId === teamId) return 'live';
        if (segment.successorTeamId === teamId) {
          setHolder(state, segment, teamId, seq, '接班队上传接管');
          return 'live';
        }
        return 'history';
      };
      const duplicated = (id: string): boolean => {
        if (!seen.has(id)) return false;
        summary.duplicates += 1;
        return true;
      };
      state.observations
        .filter((obs) => obs.teamId === teamId && (replay || obs.sync !== 'synced'))
        .sort((a, b) => a.ts - b.ts)
        .forEach((obs) => {
          if (duplicated(obs.id)) { obs.sync = 'synced'; return; }
          const seq = ++state.arrivalClock;
          obs.arrivalSeq = seq;
          obs.ingest = ingestSegment(obs.segmentId, seq);
          obs.sync = 'synced';
          seen.add(obs.id);
          if (obs.ingest === 'history') summary.history += 1; else summary.live += 1;
        });
      state.points
        .filter((point) => point.teamId === teamId && (replay || point.arrivalSeq === null))
        .sort((a, b) => a.ts - b.ts)
        .forEach((point) => {
          if (duplicated(point.id)) return;
          const seq = ++state.arrivalClock;
          point.arrivalSeq = seq;
          if (ingestSegment(point.segmentId, seq) === 'history') summary.history += 1; else summary.live += 1;
          seen.add(point.id);
        });
      state.samples
        .filter((sample) => sample.teamId === teamId && (replay || sample.arrivalSeq === null))
        .forEach((sample) => {
          if (duplicated(sample.id)) return;
          const seq = ++state.arrivalClock;
          sample.arrivalSeq = seq;
          if (ingestSegment(sample.segmentId, seq) === 'history') summary.history += 1; else summary.live += 1;
          seen.add(sample.id);
        });
      state.ingestedIds = [...seen];
      state.lastUpload = summary;
      pushLog(state, `${teamName(state, teamId)}网络恢复合并：入账 ${summary.live} · 补历史 ${summary.history} · 重复忽略 ${summary.duplicates}`);
    },
    reviewObservation: (state, action: PayloadAction<string>) => {
      const item = state.observations.find((entry) => entry.id === action.payload);
      if (item) item.reviewed = true;
    },
    verifySample: (state, action: PayloadAction<string>) => {
      const item = state.samples.find((entry) => entry.id === action.payload);
      if (item) item.status = 'verified';
    }
  }
});

export const patrolApi = createApi({ reducerPath: 'patrolApi', baseQuery: fakeBaseQuery(), endpoints: (builder) => ({ connection: builder.query<{ online: boolean }, void>({ queryFn: () => ({ data: { online: true } }) }) }) });
export const { useConnectionQuery } = patrolApi;
export const {
  addObservation, addPoint, addSample, checkLeaderTimeouts, heartbeat, markLeaderLost,
  reviewObservation, setCurrentSegment, switchTeam, updatePointSegment, uploadOfflineBatch, verifySample
} = slice.actions;
export const store = configureStore({ reducer: { patrol: slice.reducer, [patrolApi.reducerPath]: patrolApi.reducer }, middleware: (getDefault) => getDefault().concat(patrolApi.middleware) });
if (typeof window !== 'undefined') store.subscribe(() => Taro.setStorageSync(STORAGE_KEY, JSON.stringify(store.getState().patrol)));

export type RootState = ReturnType<typeof store.getState>;
