import { Button, Input, ScrollView, Text, Textarea, View } from '@tarojs/components';
import { Cell as NutCell, Dialog as NutDialog } from '@nutui/nutui-react-taro';
import Taro from '@tarojs/taro';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useI18n } from '../../i18n';
import {
  addObservation, addPoint, addSample,
  setHandover, uploadRecords,
  checkLeaderTimeout, contactLeader, simulateLeaderTimeout,
  syncQueue, resolveConflict,
  reviewObservation, verifySample,
  recalcVerification, recalcOwnership,
  type RootState,
} from '../../store';
import './index.scss';

const formSchema = z.object({ note: z.string().min(2), risk: z.enum(['low', 'medium', 'high']), species: z.string(), count: z.string() });
type FormValues = z.infer<typeof formSchema>;

const teamName = (state: RootState['patrol'], teamId: string | null) =>
  teamId ? state.teams.find((t) => t.id === teamId)?.name ?? '未知' : '待接';

const fmtTime = (iso: string | null) => {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
};

export default function Index() {
  const t = useI18n();
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.patrol);
  const { register, handleSubmit, reset } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { note: '', risk: 'low', species: '', count: '1' },
  });

  const queued = state.observations.filter((item) => item.sync === 'queued').length;
  const pendingCount = state.segments.filter((s) => s.status === 'pending').length;

  const recordPoint = async () => {
    try {
      const result = await Taro.getLocation({ type: 'gcj02' });
      dispatch(addPoint({ latitude: result.latitude, longitude: result.longitude }));
    } catch {
      dispatch(addPoint({ latitude: 30.5, longitude: 103.2 }));
    }
  };

  const submit = (values: FormValues) => {
    dispatch(addObservation({ note: values.note, risk: values.risk }));
    if (values.species) {
      dispatch(addSample({ code: `WD-${Date.now().toString().slice(-5)}`, species: values.species, count: Number(values.count) || 1 }));
    }
    reset();
  };

  /** 上传某队在某路段的离线记录 */
  const handleUpload = (segmentId: string, teamId: string) => {
    if (!teamId) return;
    const observationIds = state.observations.filter((o) => o.sync === 'queued').map((o) => o.id);
    const pointIds = state.points.filter((p) => p.segmentId === null).map((p) => p.id);
    const sampleIds = state.samples.filter((s) => s.segmentId === null && s.status === 'draft').map((s) => s.id);
    dispatch(uploadRecords({
      teamId,
      segmentId,
      arrivedAt: new Date().toISOString(),
      observationIds,
      pointIds,
      sampleIds,
    }));
  };

  /** 设置交接 */
  const handleSetHandover = (segmentId: string, handoverTeamId: string, handoverTime: string) => {
    if (!handoverTeamId || !handoverTime) return;
    dispatch(setHandover({ segmentId, handoverTeamId, handoverTime: new Date(handoverTime).toISOString() }));
  };

  const teamOptions = state.teams.map((team) => ({ value: team.id, label: team.name }));

  return (
    <View className="page">
      <View className="hero">
        <Text className="eyebrow">FIELD PATROL / PORT 62022</Text>
        <Text className="title">{t.title}</Text>
        <Text className="sub">弱网也能记录，联网后统一同步；路段责任队轮换，先到站点为准。</Text>
      </View>

      <View className="metrics">
        <View><Text>轨迹点</Text><Text className="metric">{state.points.length}</Text></View>
        <View><Text>待同步</Text><Text className="metric warn">{queued}</Text></View>
        <View><Text>样本</Text><Text className="metric">{state.samples.length}</Text></View>
        <View><Text>待接路段</Text><Text className="metric warn">{pendingCount}</Text></View>
      </View>

      {/* 现场记录 */}
      <View className="card">
        <View className="card-title">现场记录</View>
        <form onSubmit={handleSubmit(submit)}>
          <Textarea className="textarea" placeholder="记录观察、痕迹、设备问题或现场风险" {...register('note', { required: true })} />
          <View className="two">
            <Input className="input" placeholder="物种或样本名称" {...register('species')} />
            <Input className="input" type="number" placeholder="数量" {...register('count')} />
          </View>
          <View className="risk">
            <Text>风险等级</Text>
            <select {...register('risk')}>
              <option value="low">低</option>
              <option value="medium">中</option>
              <option value="high">高</option>
            </select>
          </View>
          <Button className="primary" formType="submit">{t.save}</Button>
          <Button className="secondary" onClick={recordPoint}>记录当前轨迹点</Button>
        </form>
      </View>

      {/* 巡护路段 */}
      <View className="card">
        <View className="card-title">{t.segments}<Text className="count">{state.segments.length} 段</Text></View>
        {state.segments.map((seg) => (
          <SegmentCard
            key={seg.id}
            segment={seg}
            teamOptions={teamOptions}
            teamName={teamName(state, seg.responsibleTeamId)}
            onUpload={(teamId) => handleUpload(seg.id, teamId)}
            onSetHandover={(teamId, time) => handleSetHandover(seg.id, teamId, time)}
            onRecalcVerification={() => dispatch(recalcVerification(seg.id))}
            onRecalcOwnership={() => dispatch(recalcOwnership(seg.id))}
          />
        ))}
      </View>

      {/* 巡护队 */}
      <View className="card">
        <View className="card-title">{t.teams}<Text className="count">{state.teams.length} 队</Text></View>
        {state.teams.map((team) => {
          const overdue = Date.now() - new Date(team.leaderLastContact).getTime() > state.leaderTimeoutMinutes * 60 * 1000;
          return (
            <View className="team-row" key={team.id}>
              <View className="team-info">
                <Text className="team-name">{team.name}</Text>
                <Text className="muted">{t.leader}：{team.leader} · {t.leaderLastContact}：{fmtTime(team.leaderLastContact)}</Text>
                {overdue && <Text className="warn-text">队长失联超期，路段将回到待接状态</Text>}
              </View>
              <View className="team-actions">
                <Button size="mini" onClick={() => dispatch(contactLeader(team.id))}>{t.contactLeader}</Button>
                <Button size="mini" onClick={() => dispatch(simulateLeaderTimeout(team.id))}>{t.simulateTimeout}</Button>
              </View>
            </View>
          );
        })}
        <Button className="secondary" onClick={() => dispatch(checkLeaderTimeout())}>{t.checkTimeout}</Button>
      </View>

      {/* 同步队列 */}
      <View className="card">
        <View className="card-title">{t.sync}<Text className="count">{queued} 条</Text></View>
        <Button className="secondary" onClick={() => dispatch(syncQueue())}>网络恢复 · 合并记录</Button>
        {state.conflict && (
          <View className="alert conflict">
            <Text>{state.conflict}</Text>
            <View className="alert-actions">
              <Button size="mini" onClick={() => dispatch(resolveConflict('local'))}>保留本地</Button>
              <Button size="mini" onClick={() => dispatch(resolveConflict('remote'))}>合并云端意见</Button>
            </View>
          </View>
        )}
        <Text className="hint">网络恢复后检查队长失联，合并待接路段记录；重复补传只入账一次。</Text>
      </View>

      {/* 重算状态 */}
      <View className="card">
        <View className="card-title">重算状态</View>
        <View className="recalc-grid">
          <View><Text className="muted">{t.verificationEpoch}</Text><Text className="metric">{state.verificationEpoch}</Text></View>
          <View><Text className="muted">{t.ownershipEpoch}</Text><Text className="metric">{state.ownershipEpoch}</Text></View>
        </View>
        <Text className="hint">责任方一变，样本核验重算；轨迹点一更新，观察归属重算。</Text>
      </View>

      {/* 观察记录 */}
      <View className="card">
        <View className="card-title">观察记录</View>
        <ScrollView scrollY className="list">
          {state.observations.map((item) => (
            <View className="observation" key={item.id}>
              <View>
                <Text className="obs-title">{item.risk === 'high' ? '高风险 · ' : ''}{item.note}</Text>
                <Text className="muted">
                  {item.time} · {item.sync} · {teamName(state, item.teamId)}
                  {item.segmentId ? ` · ${state.segments.find((s) => s.id === item.segmentId)?.name ?? ''}` : ''}
                </Text>
              </View>
              <Button size="mini" disabled={item.reviewed || item.risk === 'low'} onClick={() => dispatch(reviewObservation(item.id))}>
                {item.reviewed ? '已复核' : '复核'}
              </Button>
            </View>
          ))}
        </ScrollView>
      </View>

      {/* 轨迹与样本 */}
      <View className="card">
        <View className="card-title">轨迹与样本</View>
        {state.points.slice(-3).map((point) => (
          <NutCell
            key={point.id}
            title={`${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)}`}
            description={`${point.at} · ${point.source} · ${teamName(state, point.teamId)}`}
          />
        ))}
        {state.samples.map((sample) => (
          <View className="sample" key={sample.id}>
            <View>
              <Text>{sample.code} · {sample.species} × {sample.count}</Text>
              <Text className="muted">{teamName(state, sample.teamId)} · 核验版本 {sample.verificationEpoch}</Text>
            </View>
            <Button size="mini" disabled={sample.status === 'verified'} onClick={() => dispatch(verifySample(sample.id))}>
              {sample.status === 'verified' ? '已核验' : sample.status === 'submitted' ? '待核验' : '核验'}
            </Button>
          </View>
        ))}
      </View>

      <NutDialog title="离线说明" content="轨迹点和记录会写入本地存储，恢复网络后再合并。" visible={false} />
    </View>
  );
}

// ─── 路段卡片子组件 ─────────────────────────────────────────
function SegmentCard({
  segment, teamOptions, teamName,
  onUpload, onSetHandover, onRecalcVerification, onRecalcOwnership,
}: {
  segment: RootState['patrol']['segments'][number];
  teamOptions: { value: string; label: string }[];
  teamName: string;
  onUpload: (teamId: string) => void;
  onSetHandover: (teamId: string, time: string) => void;
  onRecalcVerification: () => void;
  onRecalcOwnership: () => void;
}) {
  const t = useI18n();
  const [uploadTeam, setUploadTeam] = useState(teamOptions[0]?.value ?? '');
  const [handoverTeam, setHandoverTeam] = useState(segment.handoverTeamId ?? '');
  const [handoverTime, setHandoverTime] = useState(segment.handoverTime ? new Date(segment.handoverTime).toISOString().slice(0, 16) : '');

  return (
    <View className="segment-card">
      <View className="segment-header">
        <Text className="segment-name">{segment.name}</Text>
        <Text className={`badge ${segment.status === 'active' ? 'active' : 'pending'}`}>
          {segment.status === 'active' ? t.active : t.pending}
        </Text>
      </View>
      <Text className="muted">{t.responsibleTeam}：{teamName}</Text>
      {segment.handoverTeamId && (
        <Text className="muted">
          {t.handoverTeam}：{teamOptions.find((o) => o.value === segment.handoverTeamId)?.label ?? '—'}
          {' · '}{t.handoverTime}：{fmtTime(segment.handoverTime)}
        </Text>
      )}
      {segment.firstArrivalAt && (
        <Text className="muted">{t.firstArrival}：{fmtTime(segment.firstArrivalAt)}</Text>
      )}

      <View className="segment-actions">
        <View className="two">
          <select value={uploadTeam} onChange={(e) => setUploadTeam(e.target.value)}>
            {teamOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <Button size="mini" className="primary" onClick={() => onUpload(uploadTeam)}>{t.upload}</Button>
        </View>
      </View>

      <View className="handover-row">
        <Text className="muted">{t.handover}</Text>
        <View className="two">
          <select value={handoverTeam} onChange={(e) => setHandoverTeam(e.target.value)}>
            <option value="">选择接班队</option>
            {teamOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <Input
            type="text"
            placeholder="交接时间 2026-10-04T10:00"
            value={handoverTime}
            onInput={(e) => setHandoverTime(e.detail.value)}
          />
        </View>
        <Button size="mini" className="secondary" onClick={() => onSetHandover(handoverTeam, handoverTime)}>{t.handover}</Button>
      </View>

      <View className="segment-actions">
        <Button size="mini" onClick={onRecalcVerification}>{t.recalcVerification}</Button>
        <Button size="mini" onClick={onRecalcOwnership}>{t.recalcOwnership}</Button>
      </View>
    </View>
  );
}
