import { Button, Input, ScrollView, Text, Textarea, View } from '@tarojs/components';
import { Cell as NutCell } from '@nutui/nutui-react-taro';
import Taro from '@tarojs/taro';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { useDispatch, useSelector } from 'react-redux';
import { useI18n } from '../../i18n';
import {
  addObservation, addPoint, addSample, checkLeaderTimeouts, heartbeat, markLeaderLost,
  reviewObservation, setCurrentSegment, switchTeam, updatePointSegment, uploadOfflineBatch,
  verifySample, type RootState
} from '../../store';
import './index.scss';

const formSchema = z.object({ note: z.string().min(2), risk: z.enum(['low', 'medium', 'high']), species: z.string(), count: z.string() });
type FormValues = z.infer<typeof formSchema>;

export default function Index() {
  const t = useI18n();
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.patrol);
  const { register, handleSubmit, reset } = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: { note: '', risk: 'low', species: '', count: '1' } });
  const queued = state.observations.filter((item) => item.sync !== 'synced').length
    + state.points.filter((item) => item.arrivalSeq === null).length
    + state.samples.filter((item) => item.arrivalSeq === null).length;
  const pendingCount = state.segments.filter((item) => item.status === 'pending').length;
  const teamName = (id: string | null) => state.teams.find((team) => team.id === id)?.name ?? '待接';
  const segmentName = (id: string | null) => state.segments.find((segment) => segment.id === id)?.name ?? '未归属';
  const recordPoint = async () => {
    try { const result = await Taro.getLocation({ type: 'gcj02' }); dispatch(addPoint({ latitude: result.latitude, longitude: result.longitude })); } catch { dispatch(addPoint({ latitude: 30.5, longitude: 103.2 })); }
  };
  const submit = (values: FormValues) => {
    dispatch(addObservation({ note: values.note, risk: values.risk }));
    if (values.species) dispatch(addSample({ code: `WD-${Date.now().toString().slice(-5)}`, species: values.species, count: Number(values.count) || 1 }));
    reset();
  };
  return <View className="page">
    <View className="hero"><Text className="eyebrow">FIELD PATROL / PORT 62022</Text><Text className="title">{t.title}</Text><Text className="sub">巡护队分组轮换样线，弱网照常记录；一个路段同一时间只认一个责任队，归属以先到站点的记录为准。</Text></View>
    <View className="metrics"><View><Text>待同步</Text><Text className="metric warn">{queued}</Text></View><View><Text>待接路段</Text><Text className="metric">{pendingCount}</Text></View><View><Text>样本</Text><Text className="metric">{state.samples.length}</Text></View></View>

    <View className="card">
      <View className="card-title">样线路段与责任队</View>
      {state.segments.map((segment) => <NutCell
        key={segment.id}
        title={`${segment.name} · ${segment.status === 'pending' ? '待接' : teamName(segment.holderTeamId)}`}
        description={`接班队 ${teamName(segment.successorTeamId)} · 交接 ${segment.handoverCount} 次${segment.heldSeq ? ` · 到站#${segment.heldSeq}` : ''}`}
      />)}
      <View className="risk"><Text>当前巡护队</Text><select value={state.currentTeamId} onChange={(event) => dispatch(switchTeam(event.target.value))}>{state.teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></View>
      <View className="risk"><Text>记录所属路段</Text><select value={state.currentSegmentId} onChange={(event) => dispatch(setCurrentSegment(event.target.value))}>{state.segments.map((segment) => <option key={segment.id} value={segment.id}>{segment.name}</option>)}</select></View>
    </View>

    <View className="card"><View className="card-title">现场记录</View><form onSubmit={handleSubmit(submit)}><Textarea className="textarea" placeholder="记录观察、痕迹、设备问题或现场风险" {...register('note', { required: true })} /><View className="two"><Input className="input" placeholder="物种或样本名称" {...register('species')} /><Input className="input" type="number" placeholder="数量" {...register('count')} /></View><View className="risk"><Text>风险等级</Text><select {...register('risk')}><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></View><Button className="primary" formType="submit">{t.save}</Button><Button className="secondary" onClick={recordPoint}>记录当前轨迹点</Button></form></View>

    <View className="card">
      <View className="card-title">{t.sync}<Text className="count">{queued} 条</Text></View>
      <Button className="primary" onClick={() => dispatch(uploadOfflineBatch({ teamId: state.currentTeamId }))}>网络恢复，上传离线记录</Button>
      <Button className="secondary" onClick={() => dispatch(uploadOfflineBatch({ teamId: state.currentTeamId, replay: true }))}>模拟重复补传（只入账一次）</Button>
      <View className="two">
        <Button className="secondary" onClick={() => dispatch(heartbeat(state.currentTeamId))}>队长心跳</Button>
        <Button className="secondary" onClick={() => { dispatch(markLeaderLost(state.currentTeamId)); dispatch(checkLeaderTimeouts()); }}>模拟队长失联超期</Button>
      </View>
      {state.lastUpload && <Text className="hint">最近合并：入账 {state.lastUpload.live} · 补历史 {state.lastUpload.history} · 重复忽略 {state.lastUpload.duplicates}（{state.lastUpload.at}）</Text>}
      <Text className="hint">接班队上传后持有路段，原队再传只能补历史；失联超期路段回到待接，网络恢复后合并。</Text>
    </View>

    <View className="card"><View className="card-title">观察记录</View><ScrollView scrollY className="list">{state.observations.map((item) => <View className="observation" key={item.id}><View><Text className="obs-title">{item.risk === 'high' ? '高风险 · ' : ''}{item.note}</Text><Text className="muted">{item.time} · {segmentName(item.segmentId)} · {teamName(item.teamId)} · {item.sync}{item.ingest === 'history' ? ' · 补历史' : ''}{item.arrivalSeq ? ` · 到站#${item.arrivalSeq}` : ''}</Text></View><Button size="mini" disabled={item.reviewed || item.risk === 'low'} onClick={() => dispatch(reviewObservation(item.id))}>{item.reviewed ? '已复核' : '复核'}</Button></View>)}</ScrollView></View>

    <View className="card">
      <View className="card-title">轨迹与样本</View>
      {state.points.map((point) => <View className="point" key={point.id}><Text className="muted">{point.latitude.toFixed(4)}, {point.longitude.toFixed(4)} · {point.at} · {teamName(point.teamId)}</Text><select value={point.segmentId} onChange={(event) => dispatch(updatePointSegment({ pointId: point.id, segmentId: event.target.value }))}>{state.segments.map((segment) => <option key={segment.id} value={segment.id}>{segment.name}</option>)}</select></View>)}
      {state.samples.map((sample) => <View className="sample" key={sample.id}><View><Text>{sample.code} · {sample.species} × {sample.count}</Text><Text className="muted">{segmentName(sample.segmentId)} · 第 {sample.verifyRound + 1} 轮核验</Text></View><Button size="mini" disabled={sample.status === 'verified'} onClick={() => dispatch(verifySample(sample.id))}>{sample.status === 'verified' ? '已核验' : '核验'}</Button></View>)}
    </View>

    <View className="card"><View className="card-title">归属事件</View>{state.log.map((entry, index) => <Text className="hint" key={index}>· {entry}</Text>)}</View>
  </View>;
}
