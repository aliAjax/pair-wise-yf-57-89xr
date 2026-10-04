import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';
import Taro from '@tarojs/taro';

// ─── 基础类型 ───────────────────────────────────────────────
export type SyncState = 'local' | 'queued' | 'synced' | 'conflict';
export type SegmentStatus = 'pending' | 'active';
export type RiskLevel = 'low' | 'medium' | 'high';
export type SampleStatus = 'draft' | 'submitted' | 'verified';

// ─── 业务对象 ───────────────────────────────────────────────
export interface Transect { id: string; name: string; }
export interface PatrolTeam { id: string; name: string; leader: string; leaderLastContact: string; }
export interface OwnershipPeriod { teamId: string; from: string; to: string | null; }

export interface PatrolSegment {
  id: string;
  transectId: string;
  name: string;
  status: SegmentStatus;
  responsibleTeamId: string | null;
  handoverTeamId: string | null;
  handoverTime: string | null;
  firstArrivalAt: string | null;
  heldSince: string | null;
  ownershipHistory: OwnershipPeriod[];
}

export interface PatrolObservation {
  id: string;
  dedupKey: string;
  segmentId: string | null;
  teamId: string | null;
  time: string;
  recordedAt: string;
  note: string;
  risk: RiskLevel;
  sync: SyncState;
  reviewed: boolean;
}

export interface TrackPoint {
  id: string;
  dedupKey: string;
  segmentId: string | null;
  teamId: string | null;
  latitude: number;
  longitude: number;
  at: string;
  source: 'gps' | 'manual';
}

export interface Sample {
  id: string;
  dedupKey: string;
  segmentId: string | null;
  teamId: string | null;
  code: string;
  species: string;
  count: number;
  status: SampleStatus;
  verifiedByTeamId: string | null;
  verificationEpoch: number;
}

export interface UploadRecord {
  id: string;
  dedupKey: string;
  teamId: string;
  segmentId: string;
  arrivedAt: string;
  kind: 'observation' | 'point' | 'sample';
  refId: string;
  historyOnly: boolean;
}

interface State {
  transects: Transect[];
  teams: PatrolTeam[];
  segments: PatrolSegment[];
  observations: PatrolObservation[];
  points: TrackPoint[];
  samples: Sample[];
  uploads: UploadRecord[];
  conflict: string | null;
  verificationEpoch: number;
  ownershipEpoch: number;
  leaderTimeoutMinutes: number;
  lastRecalc: { verification: string | null; ownership: string | null };
}

// ─── 工具函数 ───────────────────────────────────────────────
const genId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const nowIso = () => new Date().toISOString();

function teamName(state: State, teamId: string | null): string {
  if (!teamId) return '待接';
  return state.teams.find((t) => t.id === teamId)?.name ?? '未知';
}

/** 责任方一变，样本核验就要重算：已核验样本需在新责任方下重新核验 */
function recalcVerificationForSegment(state: State, segmentId: string) {
  state.verificationEpoch += 1;
  state.samples.forEach((s) => {
    if (s.segmentId !== segmentId) return;
    if (s.status === 'verified') {
      s.status = 'submitted';
      s.verifiedByTeamId = null;
      s.verificationEpoch = state.verificationEpoch;
    }
  });
  state.lastRecalc.verification = nowIso();
}

/** 轨迹点一更新，观察归属也要重算：按路段责任历史归属到记录时刻的责任队 */
function recalcOwnershipForSegment(state: State, segmentId: string) {
  state.ownershipEpoch += 1;
  const seg = state.segments.find((s) => s.id === segmentId);
  if (!seg) return;
  state.observations.forEach((o) => {
    if (o.segmentId !== segmentId) return;
    const period = seg.ownershipHistory.find(
      (h) => h.from <= o.recordedAt && (h.to === null || o.recordedAt < h.to),
    );
    if (period) o.teamId = period.teamId;
  });
  state.lastRecalc.ownership = nowIso();
}

/** 队长失联超期 → 路段回到待接状态 */
function applyLeaderTimeout(state: State) {
  const nowTs = Date.now();
  state.segments.forEach((seg) => {
    if (seg.status !== 'active' || !seg.responsibleTeamId) return;
    const team = state.teams.find((t) => t.id === seg.responsibleTeamId);
    if (!team) return;
    const last = new Date(team.leaderLastContact).getTime();
    if (nowTs - last > state.leaderTimeoutMinutes * 60 * 1000) {
      const current = seg.ownershipHistory.find((h) => h.to === null);
      if (current) current.to = nowIso();
      seg.responsibleTeamId = null;
      seg.status = 'pending';
      seg.heldSince = null;
    }
  });
}

// ─── 种子数据 ───────────────────────────────────────────────
const seedTeams: PatrolTeam[] = [
  { id: 'team-a', name: '一队', leader: '张建国', leaderLastContact: nowIso() },
  { id: 'team-b', name: '二队', leader: '李卫东', leaderLastContact: nowIso() },
  { id: 'team-c', name: '三队', leader: '王志强', leaderLastContact: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() },
];

const seedTransects: Transect[] = [
  { id: 't1', name: '东坡样线' },
  { id: 't2', name: '南样线' },
];

const seedSegments: PatrolSegment[] = [
  {
    id: 'seg1', transectId: 't1', name: '东坡北段',
    status: 'active', responsibleTeamId: 'team-a',
    handoverTeamId: 'team-b', handoverTime: '2026-10-04T10:00:00.000Z',
    firstArrivalAt: '2026-10-04T07:00:00.000Z', heldSince: '2026-10-04T07:00:00.000Z',
    ownershipHistory: [{ teamId: 'team-a', from: '2026-10-04T07:00:00.000Z', to: null }],
  },
  {
    id: 'seg2', transectId: 't1', name: '东坡南段',
    status: 'pending', responsibleTeamId: null,
    handoverTeamId: null, handoverTime: null,
    firstArrivalAt: null, heldSince: null,
    ownershipHistory: [],
  },
  {
    id: 'seg3', transectId: 't2', name: '南样线东段',
    status: 'active', responsibleTeamId: 'team-b',
    handoverTeamId: null, handoverTime: null,
    firstArrivalAt: '2026-10-04T07:45:00.000Z', heldSince: '2026-10-04T07:45:00.000Z',
    ownershipHistory: [{ teamId: 'team-b', from: '2026-10-04T07:45:00.000Z', to: null }],
  },
];

const seedObservations: PatrolObservation[] = [
  { id: 'o1', dedupKey: 'seed-o1', time: '07:20', recordedAt: '2026-10-04T07:20:00.000Z', note: '东坡发现新鲜足迹，沿溪谷方向移动', risk: 'medium', sync: 'synced', reviewed: false, segmentId: 'seg1', teamId: 'team-a' },
  { id: 'o2', dedupKey: 'seed-o2', time: '08:05', recordedAt: '2026-10-04T08:05:00.000Z', note: '红外相机外壳松动，已拍照待补报', risk: 'high', sync: 'queued', reviewed: false, segmentId: 'seg1', teamId: 'team-a' },
  { id: 'o3', dedupKey: 'seed-o3', time: '08:40', recordedAt: '2026-10-04T08:40:00.000Z', note: '样线南段没有异常', risk: 'low', sync: 'synced', reviewed: true, segmentId: 'seg3', teamId: 'team-b' },
];

const seedPoints: TrackPoint[] = [
  { id: 'p1', dedupKey: 'seed-p1', latitude: 30.5821, longitude: 103.2174, at: '07:20', source: 'gps', segmentId: 'seg1', teamId: 'team-a' },
  { id: 'p2', dedupKey: 'seed-p2', latitude: 30.5856, longitude: 103.2211, at: '08:05', source: 'gps', segmentId: 'seg1', teamId: 'team-a' },
];

const seedSamples: Sample[] = [
  { id: 's1', dedupKey: 'seed-s1', code: 'WD-0929-01', species: '疑似豹猫毛发', count: 1, status: 'submitted', segmentId: 'seg3', teamId: 'team-b', verifiedByTeamId: null, verificationEpoch: 0 },
];

const seedUploads: UploadRecord[] = [
  { id: 'u1', dedupKey: 'seed-u1', teamId: 'team-a', segmentId: 'seg1', arrivedAt: '2026-10-04T07:00:00.000Z', kind: 'observation', refId: 'o1', historyOnly: false },
  { id: 'u2', dedupKey: 'seed-u2', teamId: 'team-b', segmentId: 'seg3', arrivedAt: '2026-10-04T07:45:00.000Z', kind: 'observation', refId: 'o3', historyOnly: false },
];

const seed: State = {
  transects: seedTransects,
  teams: seedTeams,
  segments: seedSegments,
  observations: seedObservations,
  points: seedPoints,
  samples: seedSamples,
  uploads: seedUploads,
  conflict: null,
  verificationEpoch: 0,
  ownershipEpoch: 0,
  leaderTimeoutMinutes: 60,
  lastRecalc: { verification: null, ownership: null },
};

function readState(): State {
  try {
    const saved = Taro.getStorageSync('yf57-patrol-state');
    return saved ? (JSON.parse(saved) as State) : seed;
  } catch {
    return seed;
  }
}

// ─── Slice ─────────────────────────────────────────────────
const slice = createSlice({
  name: 'patrol',
  initialState: readState(),
  reducers: {
    /** 弱网本地记录观察 */
    addObservation: (state, action: PayloadAction<{ note: string; risk: RiskLevel }>) => {
      const id = genId('o');
      state.observations.unshift({
        id,
        dedupKey: `local-${id}`,
        time: new Date().toLocaleString(),
        recordedAt: nowIso(),
        note: action.payload.note,
        risk: action.payload.risk,
        sync: 'queued',
        reviewed: false,
        segmentId: null,
        teamId: null,
      });
    },

    /** 弱网本地记录轨迹点 */
    addPoint: (state, action: PayloadAction<{ latitude: number; longitude: number }>) => {
      const id = genId('p');
      state.points.push({
        id,
        dedupKey: `local-${id}`,
        latitude: action.payload.latitude,
        longitude: action.payload.longitude,
        at: new Date().toLocaleTimeString(),
        source: 'gps',
        segmentId: null,
        teamId: null,
      });
    },

    /** 弱网本地记录样本 */
    addSample: (state, action: PayloadAction<{ code: string; species: string; count: number }>) => {
      const id = genId('s');
      state.samples.unshift({
        id,
        dedupKey: `local-${id}`,
        code: action.payload.code,
        species: action.payload.species,
        count: action.payload.count,
        status: 'draft',
        segmentId: null,
        teamId: null,
        verifiedByTeamId: null,
        verificationEpoch: 0,
      });
    },

    /** 设置接班计划（交接时间 + 接班队） */
    setHandover: (state, action: PayloadAction<{ segmentId: string; handoverTeamId: string; handoverTime: string }>) => {
      const seg = state.segments.find((s) => s.id === action.payload.segmentId);
      if (seg) {
        seg.handoverTeamId = action.payload.handoverTeamId;
        seg.handoverTime = action.payload.handoverTime;
      }
    },

    /**
     * 上传离线记录到站点。
     * 归属规则：
     *  - 路段无责任队 → 先到先得，首个上传队持有
     *  - 接班队上传 → 持有路段（先到站点为准，可早于计划交接时间）
     *  - 原队再传 → 只能补历史，不改变归属
     *  - 重复补传只入账一次（按 dedupKey 去重）
     */
    uploadRecords: (state, action: PayloadAction<{
      teamId: string;
      segmentId: string;
      arrivedAt: string;
      observationIds?: string[];
      pointIds?: string[];
      sampleIds?: string[];
    }>) => {
      const { teamId, segmentId, arrivedAt, observationIds, pointIds, sampleIds } = action.payload;
      const seg = state.segments.find((s) => s.id === segmentId);
      if (!seg) return;

      // ── 责任归属判定 ──
      if (seg.status === 'pending' || !seg.responsibleTeamId) {
        // 先到先得
        seg.responsibleTeamId = teamId;
        seg.firstArrivalAt = arrivedAt;
        seg.heldSince = arrivedAt;
        seg.status = 'active';
        seg.ownershipHistory.push({ teamId, from: arrivedAt, to: null });
        recalcVerificationForSegment(state, segmentId);
      } else if (seg.responsibleTeamId !== teamId) {
        if (seg.handoverTeamId === teamId) {
          // 接班队到站点，先到站点为准
          if (!seg.firstArrivalAt || arrivedAt < seg.firstArrivalAt) {
            seg.firstArrivalAt = arrivedAt;
          }
          if (seg.responsibleTeamId !== teamId) {
            const current = seg.ownershipHistory.find((h) => h.to === null);
            if (current) current.to = arrivedAt;
            seg.responsibleTeamId = teamId;
            seg.heldSince = seg.firstArrivalAt;
            seg.ownershipHistory.push({ teamId, from: seg.firstArrivalAt, to: null });
            seg.status = 'active';
            recalcVerificationForSegment(state, segmentId);
          }
        }
        // 原队或其他队补历史，不改变归属
      }

      const historyOnly = seg.responsibleTeamId !== teamId && seg.handoverTeamId !== teamId;

      // ── 入账（去重：重复补传只入账一次） ──
      const addUpload = (kind: UploadRecord['kind'], refId: string, dedupKey: string) => {
        if (state.uploads.some((u) => u.dedupKey === dedupKey)) return;
        state.uploads.push({ id: genId('u'), dedupKey, teamId, segmentId, arrivedAt, kind, refId, historyOnly });
      };

      observationIds?.forEach((id) => {
        const o = state.observations.find((x) => x.id === id);
        if (!o) return;
        if (state.uploads.some((u) => u.dedupKey === o.dedupKey)) return;
        o.segmentId = segmentId;
        o.teamId = teamId;
        o.sync = 'synced';
        addUpload('observation', o.id, o.dedupKey);
      });

      pointIds?.forEach((id) => {
        const p = state.points.find((x) => x.id === id);
        if (!p) return;
        if (state.uploads.some((u) => u.dedupKey === p.dedupKey)) return;
        p.segmentId = segmentId;
        p.teamId = teamId;
        addUpload('point', p.id, p.dedupKey);
      });

      sampleIds?.forEach((id) => {
        const s = state.samples.find((x) => x.id === id);
        if (!s) return;
        if (state.uploads.some((u) => u.dedupKey === s.dedupKey)) return;
        s.segmentId = segmentId;
        s.teamId = teamId;
        s.status = 'submitted';
        s.verifiedByTeamId = null;
        s.verificationEpoch = state.verificationEpoch;
        addUpload('sample', s.id, s.dedupKey);
      });

      // 轨迹点一更新，观察归属也要重算
      if (pointIds && pointIds.length > 0) {
        recalcOwnershipForSegment(state, segmentId);
      }
    },

    /** 队长失联超期检查 */
    checkLeaderTimeout: (state) => {
      applyLeaderTimeout(state);
    },

    /** 联系队长（更新最后联系时间） */
    contactLeader: (state, action: PayloadAction<string>) => {
      const team = state.teams.find((t) => t.id === action.payload);
      if (team) team.leaderLastContact = nowIso();
    },

    /** 模拟队长失联（演示用） */
    simulateLeaderTimeout: (state, action: PayloadAction<string>) => {
      const team = state.teams.find((t) => t.id === action.payload);
      if (team) team.leaderLastContact = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    },

    /** 网络恢复：检查失联 + 合并待接记录 */
    syncQueue: (state) => {
      applyLeaderTimeout(state);
      state.observations.forEach((o) => {
        if (o.sync === 'queued') o.sync = 'synced';
      });
      state.conflict = null;
      state.lastRecalc.ownership = nowIso();
    },

    resolveConflict: (state, action: PayloadAction<'local' | 'remote'>) => {
      state.observations.forEach((o) => {
        if (o.sync === 'conflict') o.sync = 'synced';
      });
      state.conflict = null;
      Taro.setStorageSync('yf57-conflict-resolution', action.payload);
    },

    reviewObservation: (state, action: PayloadAction<string>) => {
      const item = state.observations.find((o) => o.id === action.payload);
      if (item) item.reviewed = true;
    },

    verifySample: (state, action: PayloadAction<string>) => {
      const item = state.samples.find((s) => s.id === action.payload);
      if (item) {
        item.status = 'verified';
        item.verifiedByTeamId = item.teamId;
        item.verificationEpoch = state.verificationEpoch;
      }
    },

    /** 手动重算样本核验 */
    recalcVerification: (state, action: PayloadAction<string>) => {
      recalcVerificationForSegment(state, action.payload);
    },

    /** 手动重算观察归属 */
    recalcOwnership: (state, action: PayloadAction<string>) => {
      recalcOwnershipForSegment(state, action.payload);
    },
  },
});

// ─── API ───────────────────────────────────────────────────
export const patrolApi = createApi({
  reducerPath: 'patrolApi',
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    connection: builder.query<{ online: boolean }, void>({ queryFn: () => ({ data: { online: true } }) }),
  }),
});

export const { useConnectionQuery } = patrolApi;
export const {
  addObservation, addPoint, addSample,
  setHandover, uploadRecords,
  checkLeaderTimeout, contactLeader, simulateLeaderTimeout,
  syncQueue, resolveConflict,
  reviewObservation, verifySample,
  recalcVerification, recalcOwnership,
} = slice.actions;

export const store = configureStore({
  reducer: { patrol: slice.reducer, [patrolApi.reducerPath]: patrolApi.reducer },
  middleware: (getDefault) => getDefault().concat(patrolApi.middleware),
});

if (typeof window !== 'undefined') {
  store.subscribe(() => Taro.setStorageSync('yf57-patrol-state', JSON.stringify(store.getState().patrol)));
}

export type RootState = ReturnType<typeof store.getState>;
