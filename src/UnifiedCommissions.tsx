import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import {
  cancelCommission,
  createCommission,
  fulfillCommission,
  getCommissions,
} from './online-commissions'
import type { CommissionOrder, CommissionSnapshot } from './online-commissions'
import { PlayerApiError } from './online-player'
import type { OnlineProfession } from './online-player'
import type { SurvivalCharacter } from './online-survival'

const professionNames: Record<OnlineProfession, string> = {
  blacksmith: 'Кузнец', herbalist: 'Травник', hunter: 'Охотник',
  scribe: 'Писарь', carter: 'Возчик', wanderer: 'Странник',
}
const materialNames: Record<string, string> = {
  'scrap-iron': 'Лом железа', charcoal: 'Древесный уголь',
  'burnt-hide': 'Обожжённая шкура', cloth: 'Грубая ткань',
  'river-bone': 'Речная кость', 'bitter-herb': 'Горькая трава',
}
const statusNames: Record<string, string> = {
  open: 'Открыт', fulfilled: 'Выполнен', cancelled: 'Отменён', expired: 'Истёк',
}

type Tab = 'available' | 'mine' | 'history'
const errorText = (error: unknown) => error instanceof PlayerApiError ? error.message : 'Не удалось связаться с доской заказов.'
const deadline = (timestamp: number) => {
  const left = Math.max(0, timestamp - Date.now())
  const hours = Math.floor(left / 3_600_000)
  const minutes = Math.floor(left % 3_600_000 / 60_000)
  return left <= 0 ? 'срок истёк' : `${hours} ч ${minutes} мин`
}

function OrderCard({ order, busy, onFulfill }: { order: CommissionOrder; busy: boolean; onFulfill: () => void }) {
  return <article className={`c-order ${order.canFulfill ? 'available' : ''}`}>
    <header><div><strong>{order.recipe.title}</strong><span>{professionNames[order.recipe.profession]}</span></div><strong>{order.rewardCoins} монет</strong></header>
    <p>Заказчик: {order.requesterName}{order.targetName ? ` · лично для ${order.targetName}` : ''}</p>
    <div className="c-order-result"><span>Результат</span><strong>{order.output.name} ×{order.output.quantity}</strong></div>
    <div className="c-materials">{order.recipe.ingredients.map((ingredient) => <span key={ingredient.id}>{materialNames[ingredient.id] ?? ingredient.id} ×{ingredient.quantity}</span>)}</div>
    <footer><small>Осталось: {deadline(order.expiresAt)}</small><button disabled={busy || !order.canFulfill} onClick={onFulfill} type="button">Выполнить</button></footer>
    {!order.canFulfill && order.fulfillReason && <small className="c-reason">{order.fulfillReason}</small>}
  </article>
}

export default function UnifiedCommissions({ character, onCharacter }: {
  character: SurvivalCharacter | null
  onCharacter: (character: SurvivalCharacter | null) => void
}) {
  const [snapshot, setSnapshot] = useState<CommissionSnapshot | null>(null)
  const [tab, setTab] = useState<Tab>('available')
  const [query, setQuery] = useState('')
  const [profession, setProfession] = useState<OnlineProfession | 'all'>('all')
  const [recipeId, setRecipeId] = useState('')
  const [batches, setBatches] = useState(1)
  const [reward, setReward] = useState(1)
  const [targetUsername, setTargetUsername] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const next = await getCommissions({ query, profession })
      setSnapshot(next)
      onCharacter(next.character)
      setRecipeId((current) => current || next.catalog[0]?.id || '')
      setError('')
    } catch (caught) { setError(errorText(caught)) }
  }, [onCharacter, profession, query])

  useEffect(() => {
    const delay = window.setTimeout(() => { void load() }, 250)
    const timer = window.setInterval(() => { void load() }, 20_000)
    return () => { window.clearTimeout(delay); window.clearInterval(timer) }
  }, [load])

  const selected = useMemo(() => snapshot?.catalog.find((recipe) => recipe.id === recipeId) ?? null, [recipeId, snapshot])
  const minimumReward = (selected?.baseReward ?? 1) * batches
  useEffect(() => { setReward((current) => Math.max(current, minimumReward)) }, [minimumReward])

  const apply = async (operation: () => Promise<CommissionSnapshot>, message: (result: CommissionSnapshot) => string) => {
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await operation()
      onCharacter(result.character)
      setNotice(message(result))
      await load()
    } catch (caught) { setError(errorText(caught)) }
    finally { setBusy(false) }
  }

  if (!character) return <section className="u-panel"><h2>Доска заказов закрыта</h2><p>Сначала создай серверного героя.</p></section>
  if (!snapshot) return <section className="u-panel"><h2>Ремесленные заказы</h2><p>{error || 'Читаем новые записи…'}</p></section>

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selected) return
    void apply(
      () => createCommission(selected.id, batches, reward, targetUsername.trim()),
      () => `Награда ${reward} монет зарезервирована для заказа «${selected.title}».`,
    )
  }

  return <div className="u-stack c-commissions">
    <section className="u-panel">
      <header className="u-section-head"><div><p className="eyebrow">Награда и результат защищены сервером</p><h2>Ремесленные заказы</h2></div><div className="c-summary"><span>Комиссия исполнителя</span><strong>до {snapshot.feePercent}%</strong><small>Срок заказа: {snapshot.lifetimeHours} часов</small></div></header>
      <div className="c-toolbar">
        <div className="u-tabs c-tabs">
          <button className={tab === 'available' ? 'active' : ''} onClick={() => setTab('available')} type="button">Доступные · {snapshot.available.length}</button>
          <button className={tab === 'mine' ? 'active' : ''} onClick={() => setTab('mine')} type="button">Мои · {snapshot.mine.length}</button>
          <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')} type="button">Выполненные · {snapshot.fulfilled.length}</button>
        </div>
        <button disabled={busy} onClick={() => void load()} type="button">Обновить</button>
      </div>
      {!snapshot.safe && <p className="u-notice error">{snapshot.safeReason}</p>}
      {notice && <p className="u-notice">{notice}</p>}
      {error && <p className="u-notice error">{error}</p>}
    </section>

    {tab === 'available' && <section className="u-panel">
      <div className="c-filter-row">
        <label>Поиск<input maxLength={40} onChange={(event) => setQuery(event.target.value)} placeholder="Рецепт или заказчик" value={query} /></label>
        <label>Ремесло<select onChange={(event) => setProfession(event.target.value as OnlineProfession | 'all')} value={profession}><option value="all">Все ремёсла</option>{(Object.keys(professionNames) as OnlineProfession[]).map((id) => <option key={id} value={id}>{professionNames[id]}</option>)}</select></label>
      </div>
      {snapshot.available.length === 0 ? <p className="u-empty">Подходящих заказов пока нет.</p> : <div className="c-order-grid">{snapshot.available.map((order) => <OrderCard busy={busy} key={order.id} onFulfill={() => void apply(() => fulfillCommission(order.id), (result) => `Заказ выполнен: ${result.fulfillment?.itemName ?? order.output.name} ×${order.output.quantity}. Получено ${result.fulfillment?.rewardCoins ?? order.rewardCoins} монет.`)} order={order} />)}</div>}
    </section>}

    {tab === 'mine' && <>
      <section className="u-panel">
        <p className="eyebrow">Монеты уходят в резерв сразу</p><h2>Новый заказ</h2>
        <form className="c-order-form" onSubmit={submit}>
          <label>Изделие<select onChange={(event) => { setRecipeId(event.target.value); setBatches(1) }} value={recipeId}>{snapshot.catalog.map((recipe) => <option key={recipe.id} value={recipe.id}>{recipe.title} · {professionNames[recipe.profession]}</option>)}</select></label>
          <label>Партий<input max={10} min={1} onChange={(event) => setBatches(Math.max(1, Math.min(10, Number(event.target.value) || 1)))} type="number" value={batches} /></label>
          <label>Награда<input max={100000} min={minimumReward} onChange={(event) => setReward(Math.max(minimumReward, Math.min(100000, Number(event.target.value) || minimumReward)))} type="number" value={reward} /></label>
          <label>Мастер, необязательно<input autoCapitalize="none" maxLength={20} onChange={(event) => setTargetUsername(event.target.value)} placeholder="логин мастера" value={targetUsername} /></label>
          <div><span>Получишь</span><strong>{selected?.output.name ?? 'Изделие'} ×{(selected?.output.quantity ?? 1) * batches}</strong><small>Минимальная награда: {minimumReward} монет</small></div>
          <button disabled={busy || !snapshot.safe || !selected || reward < minimumReward || reward > character.coins} type="submit">Разместить заказ</button>
        </form>
      </section>
      <section className="u-panel">
        <p className="eyebrow">Неиспользованная награда возвращается</p><h2>Мои заказы</h2>
        {snapshot.mine.length === 0 ? <p className="u-empty">Заказов ещё нет.</p> : <div className="c-own-list">{snapshot.mine.map((order) => <article key={order.id}><div><strong>{order.recipe.title} · {order.output.quantity} шт.</strong><span>{statusNames[order.status] ?? order.status}{order.targetName ? ` · мастер ${order.targetName}` : ''}</span><small>{order.rewardCoins} монет · {order.status === 'open' ? deadline(order.expiresAt) : order.fulfillerName ? `исполнил ${order.fulfillerName}` : 'закрыт без исполнения'}</small></div>{order.status === 'open' && <button disabled={busy || !snapshot.safe} onClick={() => void apply(() => cancelCommission(order.id), () => `Заказ «${order.recipe.title}» отменён, резерв возвращён.`)} type="button">Отменить</button>}</article>)}</div>}
      </section>
    </>}

    {tab === 'history' && <section className="u-panel">
      <p className="eyebrow">Репутация мастера растёт от выполненной работы</p><h2>Мои выполненные заказы</h2>
      {snapshot.fulfilled.length === 0 ? <p className="u-empty">Ты ещё не выполнял заказы других игроков.</p> : <div className="c-own-list">{snapshot.fulfilled.map((order) => <article key={order.id}><div><strong>{order.output.name} ×{order.output.quantity}</strong><span>Заказчик: {order.requesterName}</span><small>Получено {order.rewardCoins - order.feeCoins} монет · комиссия {order.feeCoins}</small></div><time>{new Date(order.closedAt ?? order.createdAt).toLocaleString('ru-RU')}</time></article>)}</div>}
    </section>}
  </div>
}
