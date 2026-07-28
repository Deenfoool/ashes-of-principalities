import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { GuildBranchId } from './game/types'
import {
  acceptOnlineInvite,
  assignOnlineMemberRole,
  createOnlineRole,
  fetchOnlineMembers,
  fetchOnlineRoles,
  fetchTreasuryLog,
  inviteOnlinePlayer,
  kickOnlineMember,
  resetOnlineGuildTree,
  upgradeOnlineGuildBranch,
} from './online'
import type { OnlineMember, OnlineRole, OnlineSnapshot, TreasuryEntry } from './online'
import { donateServerCoins } from './online-player'
import { createPaidServerGuild } from './online-survival'
import type { SurvivalCharacter } from './online-survival'
import UnifiedGuildExpansion from './UnifiedGuildExpansion'

const branchInfo: Record<GuildBranchId, { name: string; description: string }> = {
  warband: { name: 'Дружина', description: 'Боевые преимущества подтверждённых сервером походов.' },
  treasury: { name: 'Казна', description: 'Повышает монеты за победы и контракты.' },
  workshops: { name: 'Мастерские', description: 'Снижает стоимость ремонта и лечения.' },
  foraging: { name: 'Промысел', description: 'Подготовка будущей добычи и ресурсов.' },
  chronicle: { name: 'Летопись', description: 'Повышает опыт за подтверждённые победы.' },
}

export default function UnifiedGuild({
  snapshot,
  character,
  onCharacter,
  onRefresh,
}: {
  snapshot: OnlineSnapshot
  character: SurvivalCharacter | null
  onCharacter: (character: SurvivalCharacter) => void
  onRefresh: () => Promise<void>
}) {
  const [roles, setRoles] = useState<OnlineRole[]>([])
  const [members, setMembers] = useState<OnlineMember[]>([])
  const [log, setLog] = useState<TreasuryEntry[]>([])
  const [name, setName] = useState('')
  const [tag, setTag] = useState('')
  const [invitee, setInvitee] = useState('')
  const [deposit, setDeposit] = useState('5')
  const [roleName, setRoleName] = useState('')
  const [permissions, setPermissions] = useState({ invite: false, kick: false, treasury: false, tree: false })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const guild = snapshot.guild

  useEffect(() => {
    if (!guild) {
      setRoles([]); setMembers([]); setLog([])
      return
    }
    void Promise.all([fetchOnlineRoles(), fetchOnlineMembers(), fetchTreasuryLog()])
      .then(([nextRoles, nextMembers, nextLog]) => {
        setRoles(nextRoles); setMembers(nextMembers); setLog(nextLog)
      })
      .catch(() => undefined)
  }, [guild?.id, guild?.treasuryCoins])

  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setMessage('')
    try { await operation() } catch (error) { setMessage(error instanceof Error ? error.message : 'Сервер не выполнил действие.') } finally { setBusy(false) }
  }

  if (!guild) {
    const hasSeal = Boolean(character?.inventory.some((item) => item.id === 'founder-seal'))
    return <div className="u-stack">
      {snapshot.invites.length > 0 && <section className="u-panel">
        <p className="eyebrow">Вступление только по приглашению</p><h2>Входящие приглашения</h2>
        <div className="u-card-list">{snapshot.invites.map((invite) => <article key={invite.id}><div><strong>[{invite.guildTag}] {invite.guildName}</strong><small>Пригласил: {invite.inviterName}</small></div><button disabled={busy} onClick={() => void run(async () => { await acceptOnlineInvite(invite.id); await onRefresh() })} type="button">Принять</button></article>)}</div>
      </section>}
      <section className="u-panel">
        <p className="eyebrow">Общее дело начинается с цены</p><h2>Основать гильдию</h2>
        <p>Сервер спишет 12 монет и Печать основателя в одной транзакции. Печать выдаётся за первый завершённый сюжетный контракт.</p>
        <div className="u-costs"><span className={(character?.coins ?? 0) >= 12 ? 'ready' : ''}>Монеты: {character?.coins ?? 0}/12</span><span className={hasSeal ? 'ready' : ''}>Печать: {hasSeal ? 'есть' : 'нет'}</span></div>
        <form className="u-inline-form" onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault()
          void run(async () => {
            const result = await createPaidServerGuild(name, tag)
            onCharacter(result.character)
            setName(''); setTag('')
            await onRefresh()
          })
        }}>
          <label>Название<input maxLength={28} onChange={(event) => setName(event.target.value)} placeholder="Серые вороны" value={name} /></label>
          <label>Тег<input maxLength={5} onChange={(event) => setTag(event.target.value)} placeholder="СВ" value={tag} /></label>
          <button disabled={busy || name.trim().length < 3 || tag.trim().length < 2 || !hasSeal || (character?.coins ?? 0) < 12} type="submit">Основать</button>
        </form>
        {message && <p className="u-notice">{message}</p>}
      </section>
    </div>
  }

  return <div className="u-stack">
    <section className="u-panel">
      <header className="u-section-head"><div><p className="eyebrow">[{guild.tag}] · {guild.role.name} · {guild.memberCount}/20</p><h2>{guild.name}</h2></div><div className="u-guild-level"><span>Уровень {guild.level}</span><strong>{guild.experience} опыта</strong></div></header>
      <div className="u-stat-grid"><article><span>Казна</span><strong>{guild.treasuryCoins} монет</strong><small>{guild.treasuryResources} ресурсов</small></article><article><span>Очки дерева</span><strong>{guild.treePoints}</strong><small>За уровни гильдии</small></article><article><span>Сезон</span><strong>{guild.seasonKey}</strong><small>Сброс дерева раз в сезон</small></article></div>
    </section>

    <section className="u-panel">
      <header className="u-section-head"><div><p className="eyebrow">Пять путей</p><h2>Дерево развития</h2></div>{guild.role.permissions.tree && <button disabled={busy} onClick={() => void run(async () => { await resetOnlineGuildTree(); await onRefresh() })} type="button">Сбросить дерево</button>}</header>
      <div className="u-branch-grid">{(Object.keys(branchInfo) as GuildBranchId[]).map((branch) => <article key={branch}><div><strong>{branchInfo[branch].name}</strong><span>{guild.branches[branch]}/5</span></div><p>{branchInfo[branch].description}</p><button disabled={busy || !guild.role.permissions.tree || guild.treePoints < 1 || guild.branches[branch] >= 5} onClick={() => void run(async () => { await upgradeOnlineGuildBranch(branch); await onRefresh() })} type="button">Улучшить</button></article>)}</div>
    </section>

    <section className="u-panel">
      <p className="eyebrow">Еженедельное общее дело</p><h2>Задания</h2>
      <div className="u-tasks">{guild.tasks.map((task) => <article className={task.completed ? 'completed' : ''} key={task.id}><div><strong>{task.title}</strong><span>{task.current}/{task.target}</span></div><div className="u-progress"><span style={{ width: `${Math.min(100, task.current / task.target * 100)}%` }} /></div><small>{task.reward} опыта гильдии</small></article>)}</div>
    </section>

    <section className="u-panel">
      <p className="eyebrow">Только реальные монеты героя</p><h2>Монетная казна</h2>
      <form className="u-inline-form compact" onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        void run(async () => {
          const result = await donateServerCoins(Number(deposit)) as unknown as { character: SurvivalCharacter }
          onCharacter(result.character)
          await onRefresh()
        })
      }}><label>Сумма<input min="1" onChange={(event) => setDeposit(event.target.value)} type="number" value={deposit} /></label><button disabled={busy || Number(deposit) < 1 || Number(deposit) > (character?.coins ?? 0)} type="submit">Внести</button></form>
      <div className="u-log">{log.slice(0, 12).map((entry) => <p key={entry.id}><span>{entry.playerName}</span><strong>+{entry.amount}</strong><time>{new Date(entry.createdAt).toLocaleString('ru-RU')}</time></p>)}</div>
    </section>

    <UnifiedGuildExpansion character={character} guildId={guild.id} onCharacter={onCharacter} onRefresh={onRefresh} />

    {guild.role.permissions.invite && <section className="u-panel"><p className="eyebrow">Новый участник получает бонусы постепенно</p><h2>Приглашение</h2><form className="u-inline-form compact" onSubmit={(event) => { event.preventDefault(); void run(async () => { const result = await inviteOnlinePlayer(invitee); setMessage(`Приглашение отправлено: ${result.invite.inviteeName}.`); setInvitee('') }) }}><label>Логин<input onChange={(event) => setInvitee(event.target.value)} value={invitee} /></label><button disabled={busy || invitee.trim().length < 3} type="submit">Пригласить</button></form></section>}

    <section className="u-panel">
      <p className="eyebrow">Состав и иерархия</p><h2>Участники</h2>
      <div className="u-member-list">{members.map((member) => <article key={member.id}><div><strong>{member.displayName}</strong><small>@{member.username} · {member.roleName}</small></div>{guild.role.permissions.roles && !member.isLeader ? <select onChange={(event) => void run(async () => setMembers(await assignOnlineMemberRole(member.id, event.target.value)))} value={member.roleId}>{roles.filter((role) => role.position < 100).map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select> : <span>{member.roleName}</span>}{guild.role.permissions.kick && !member.isLeader && <button className="u-danger" onClick={() => void run(async () => setMembers(await kickOnlineMember(member.id)))} type="button">Исключить</button>}</article>)}</div>
    </section>

    {guild.role.permissions.roles && <section className="u-panel"><p className="eyebrow">Глава задаёт структуру сам</p><h2>Новая роль</h2><div className="u-role-tags">{roles.map((role) => <span key={role.id}>{role.name}</span>)}</div><form className="u-role-form" onSubmit={(event) => { event.preventDefault(); void run(async () => { setRoles(await createOnlineRole({ name: roleName, permissions })); setRoleName(''); setPermissions({ invite: false, kick: false, treasury: false, tree: false }) }) }}><label>Название<input maxLength={20} onChange={(event) => setRoleName(event.target.value)} value={roleName} /></label><div>{(Object.keys(permissions) as Array<keyof typeof permissions>).map((permission) => <label key={permission}><input checked={permissions[permission]} onChange={(event) => setPermissions((current) => ({ ...current, [permission]: event.target.checked }))} type="checkbox" />{permission === 'invite' ? 'Приглашения' : permission === 'kick' ? 'Исключение' : permission === 'treasury' ? 'Казна' : 'Дерево'}</label>)}</div><button disabled={busy || roleName.trim().length < 2} type="submit">Создать роль</button></form></section>}

    {message && <p className="u-notice sticky">{message}</p>}
  </div>
}
