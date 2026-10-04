import { createContext, useContext, type ReactNode } from 'react';

const messages = {
  title: '野外巡护离线调查',
  sync: '同步队列',
  review: '负责人复核',
  save: '保存现场记录',
  segments: '巡护路段',
  teams: '巡护队',
  transects: '样线',
  upload: '上传离线记录',
  handover: '设置交接',
  contactLeader: '联系队长',
  simulateTimeout: '模拟失联',
  checkTimeout: '检查失联',
  recalcVerification: '重算核验',
  recalcOwnership: '重算归属',
  pending: '待接',
  active: '责任中',
  historyOnly: '仅补历史',
  firstArrival: '先到站点',
  handoverTime: '交接时间',
  responsibleTeam: '责任队',
  handoverTeam: '接班队',
  leader: '队长',
  leaderLastContact: '最后联系',
  verificationEpoch: '核验重算版本',
  ownershipEpoch: '归属重算版本',
  queued: '待同步',
  synced: '已同步',
  conflict: '冲突',
};

const I18nContext = createContext(messages);
export function I18nProvider({ children }: { children: ReactNode }) {
  return <I18nContext.Provider value={messages}>{children}</I18nContext.Provider>;
}
export const useI18n = () => useContext(I18nContext);
