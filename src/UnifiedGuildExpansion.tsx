import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  actInGuildRaid,
  depositGuildResource,
  getGuildExpansion,
  joinGuildRaid,
  prepareGuildRaid,
  startGuildRaid,
  transferGuildLeadership,
  withdrawGuildResource,
} from './online-guild-v014'
import type { GuildExpansionSnapshot, GuildRaidSnapshot } from './online-guild-v014'
import type { SurvivalCharacter } from './online-survival'

const professionNames: Record<string, string> = {
  blacksmith: 'Кузнец', herbalist: 'Травник', hunter: 'Охотник',
  scribe: 'Писарь', carter: 'Возчик', wanderer: 'Странник',
}

const raidStatusNames: Record<string, string> = {
  preparing: 'Сбор ресурсов', ready: 'Запись дружины', active: 'Идёт бой',
  won: 'Победа', failed: 'Отступление', cooldown: 'Восстановление',
}

const intentNames: Record<string, string> = {
  crush: 'Крушит строй', 'ash-breath': 'Готовит пепельное дыхание',
  devour: 'Пожирает знамя', summon: 'Поднимает курганную тень',
}

function Meter({ label, value, max }: { label: string; value: number; max: number }) {
  const width = `${Math.max(0, Math.min(100, max > 0 ? value / max * 100 : 0))}%`
  return <div className="u-meter"><div><span>{label}</span><strong>{value}/{max}</strong></div><div><span style={{ width }} /></div></div>
}

function activityText(timestamp: number) {
  const difference = Date.now() - timestamp
  const hours = Math.floor(difference / 3_600_000)
  if (hours < 1) return 'был в сети недавно'
  if (hours < 24) return `был в сети ${hours} ч. назад`
  return `был в сети ${Math.floor(hours / 24)} дн. назад`
}

function RaidBoard({ raid, busy, onOperation }: {
  raid: GuildRaidSnapshot
  busy: boolean
  onOperation: (operation: () => Promise<unknown>) => void
}) {
  const self = raid.participants.find((participant) => participant.isSelf)
  const readyCount = raid.requirements.filter((requirement) => requirement.ready).length
  const active = raid.boss.status === 'active'
  return <section className="u-panel gv14-raid">
    <header className="u-section-head">
      <div><p className="eyebrow">Первый совместный противник</p><h2>{raid.boss.title}</h2></div>
      <span>{raidStatusNames[raid.boss.status] ?? raid.boss.status}</span>
    </header>
    <p>{raid.boss.description}</p>
    <div className="gv14-raid-meters">
      <Meter label="Венец" value={raid.boss.shield} max={raid.boss.maxShield} />
      <Meter label="Здоровье" value={raid.boss.health} max={raid.boss.maxHealth} />
      <Meter label="Боевой дух" value={raid.boss.morale} max={raid.boss.maxMorale} />
    </div>
    <div className="gv14-raid-facts">
      <span>Раунд: {raid.boss.round}</span>
      <span>Намерение: {intentNames[raid.boss.intent] ?? raid.boss.intent}</span>
      <span>Попыток: {raid.boss.attempts}</span>
      <span>Побед: {raid.boss.victories}</span>
    </div>

    {raid.boss.status === 'preparing' && <>
      <div className="gv14-requirements">{raid.requirements.map((requirement) => <article className={requirement.ready ? 'ready' : ''} key={requirement.id}>
        <strong>{requirement.name}</strong>
        <span>{requirement.available}/{requirement.required}</span>
        <small>{requirement.reserved > 0 ? `В резерве: ${requirement.reserved}` : 'Ещё не запечатано'}</small>
      </article>)}</div>
      <button disabled={busy || !raid.permissions.canPrepare || readyCount < raid.requirements.length} onClick={() => onOperation(prepareGuildRaid)} type="button">Запечатать ресурсы</button>
      {!raid.permissions.canPrepare && <p className="u-empty">Подготовку проводит участник с правом распоряжаться казной.</p>}
    </>}

    {raid.boss.status === 'ready' && <div className="gv14-raid-ready">
      <p>Для начала нужно участников: {raid.minimumParticipants}. Запись отнимает 3 силы героя.</p>
      {!self && <button disabled={busy || !raid.permissions.canJoin} onClick={() => onOperation(joinGuildRaid)} type="button">Войти в дружину</button>}
      {self && <span className="gv14-ready-mark">Ты записан: {self.actions}/{raid.boss.maxActionsPerMember} действий доступно</span>}
      {raid.permissions.canStart && <button disabled={busy || raid.participants.length < raid.minimumParticipants} onClick={() => onOperation(startGuildRaid)} type="button">Поднять знамя и начать</button>}
    </div>}

    {active && <div className="gv14-raid-actions">
      <div><p className="eyebrow">Общее состояние меняется после каждого хода</p><h3>Действие героя</h3></div>
      <button disabled={busy || !raid.permissions.canAct} onClick={() => onOperation(() => actInGuildRaid('assault'))} type="button"><strong>Штурм</strong><small>Максимальный прямой урон</small></button>
      <button disabled={busy || !raid.permissions.canAct} onClick={() => onOperation(() => actInGuildRaid('guard'))} type="button"><strong>Держать строй</strong><small>Поддержка боевого духа</small></button>
      <button disabled={busy || !raid.permissions.canAct} onClick={() => onOperation(() => actInGuildRaid('profession'))} type="button"><strong>Приём ремесла</strong><small>Эффект зависит от профессии</small></button>
      {self && <p>Твой вклад: {self.damage} урона, {self.support} поддержки, действий {self.actions}/{raid.boss.maxActionsPerMember}.</p>}
      {!self && <p className="u-empty">Ты не записан в начавшуюся дружину и можешь только наблюдать.</p>}
    </div>}

    {['won', 'failed', 'cooldown'].includes(raid.boss.status) && <p className="gv14-raid-result">
      {raid.boss.status === 'won' ? 'Чернопол повержен. Награды выданы всем участникам.' : 'Дружина отступила и восстанавливает знамя.'}
      {raid.boss.cooldownUntil ? ` Новый сбор откроется ${new Date(raid.boss.cooldownUntil).toLocaleString('ru-RU')}.` : ''}
    </p>}

    <div className="gv14-participants">
      <h3>Дружина</h3>
      {raid.participants.length === 0 ? <p className="u-empty">Пока никто не записался.</p> : raid.participants.map((participant) => <article key={participant.userId}>
        <div><strong>{participant.playerName}</strong><small>{professionNames[participant.profession] ?? participant.profession} · уровень {participant.level}</small></div>
        <span>{participant.damage} урона</span><span>{participant.support} поддержки</span><span>{participant.actions} действий</span>
      </article>)}
    </div>
    <div className="u-log gv14-raid-log">{raid.log.slice(0, 14).map((entry) => <p key={entry.id}><span>{entry.playerName ?? 'Летописец'}</span><strong>{entry.message}</strong><time>{new Date(entry.createdAt).toLocaleString('ru-RU')}</time></p>)}</div>
  </section>
}

export default function UnifiedGuildExpansion({ guildId, character, onCharacter, onRefresh }: {
  guildId: string
  character: SurvivalCharacter | null
  onCharacter: (character: SurvivalCharacter) => void
  onRefresh: () => Promise<void>
}) {
  const [snapshot, setSnapshot] = useState<GuildExpansionSnapshot | null>(null)
  const [resourceId, setResourceId] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const load = useCallback(async () => {
    const next = await getGuildExpansion()
    setSnapshot(next)
    if (!resourceId) {
      const first = next.resources.allowed.find((resource) => resource.owned > 0)
      if (first) setResourceId(first.id)
    }
  }, [resourceId])

  useEffect(() => {
    void load().catch(() => undefined)
    const timer = window.setInterval(() => { void load().catch(() => undefined) }, 20_000)
    return () => window.clearInterval(timer)
  }, [guildId, load])

  const run = async (operation: () => Promise<unknown>) => {
    setBusy(true); setMessage('')
    try {
      const result = await operation() as { character?: SurvivalCharacter }
      if (result?.character) onCharacter(result.character)
      await Promise.all([load(), onRefresh()])
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Сервер не выполнил действие гильдии.')
    } finally { setBusy(false) }
  }

  const depositable = useMemo(() => snapshot?.resources.allowed.filter((resource) => resource.owned > 0) ?? [], [snapshot])
  if (!snapshot) return <section className="u-panel"><h2>Общие дела</h2><p>Летописец сверяет склад и знамёна гильдии…</p></section>
  const selected = snapshot.resources.allowed.find((resource) => resource.id === resourceId)

  return <div className="u-stack gv14-stack">
    <section className="u-panel">
      <header className="u-section-head"><div><p className="eyebrow">Конкретные предметы вместо общего счётчика</p><h2>Ресурсная казна</h2></div><span>{snapshot.resources.total} ед. на складе</span></header>
      <form className="u-inline-form compact" onSubmit={(event) => {
        event.preventDefault()
        void run(() => depositGuildResource(resourceId, Number(quantity)))
      }}>
        <label>Ресурс<select onChange={(event) => setResourceId(event.target.value)} value={resourceId}>{depositable.length === 0 ? <option value="">Нет доступных ресурсов</option> : depositable.map((resource) => <option key={resource.id} value={resource.id}>{resource.name} · у тебя {resource.owned}</option>)}</select></label>
        <label>Количество<input min="1" max={selected?.owned ?? 1} onChange={(event) => setQuantity(event.target.value)} type="number" value={quantity} /></label>
        <button disabled={busy || !resourceId || Number(quantity) < 1 || Number(quantity) > (selected?.owned ?? 0)} type="submit">Внести ресурс</button>
      </form>
      <div className="gv14-stock">{snapshot.resources.stock.length === 0 ? <p className="u-empty">Ресурсная казна пуста.</p> : snapshot.resources.stock.map((resource) => <article key={resource.id}>
        <div><strong>{resource.name}</strong><small>Доступно {resource.available} · резерв {resource.reserved}</small></div><span>{resource.quantity}</span>
        {snapshot.resources.canWithdraw && resource.available > 0 && <button disabled={busy} onClick={() => void run(() => withdrawGuildResource(resource.id, 1))} type="button">Взять 1</button>}
      </article>)}</div>
      <div className="u-log gv14-resource-log">{snapshot.resources.log.slice(0, 12).map((entry) => <p key={entry.id}><span>{entry.playerName}</span><strong>{entry.operation === 'deposit' ? '+' : entry.operation === 'withdraw' ? '−' : '•'}{entry.quantity} {entry.itemName}</strong><time>{new Date(entry.createdAt).toLocaleString('ru-RU')}</time></p>)}</div>
    </section>

    <section className="u-panel">
      <header className="u-section-head"><div><p className="eyebrow">14 дней отсутствия · 7 дней активности преемника</p><h2>Преемственность главы</h2></div><span>{snapshot.leadership.canTransfer ? 'Ты действующий глава' : 'Передача защищена сервером'}</span></header>
      <div className="gv14-leadership">{snapshot.leadership.members.map((member) => <article className={member.isLeader ? 'leader' : ''} key={member.id}>
        <div><strong>{member.displayName}</strong><small>@{member.username} · {member.roleName}</small><small>{activityText(member.lastActiveAt)}</small></div>
        {member.isLeader ? <span>Глава</span> : snapshot.leadership.canTransfer ? <button disabled={busy} onClick={() => void run(() => transferGuildLeadership(member.id))} type="button">Передать власть</button> : <span>{member.roleName}</span>}
      </article>)}</div>
      {snapshot.leadership.history.length > 0 && <div className="u-log">{snapshot.leadership.history.map((entry) => <p key={entry.id}><span>{entry.reason === 'inactivity' ? 'Автоматически' : 'Добровольно'}</span><strong>{entry.previousLeaderName} → {entry.nextLeaderName}</strong><time>{new Date(entry.createdAt).toLocaleString('ru-RU')}</time></p>)}</div>}
    </section>

    <RaidBoard busy={busy} onOperation={(operation) => void run(operation)} raid={snapshot.raid} />
    {message && <p className="u-notice sticky">{message}</p>}
  </div>
}
