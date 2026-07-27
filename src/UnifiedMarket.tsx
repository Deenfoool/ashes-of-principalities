import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import UnifiedArtifacts from './UnifiedArtifacts'
import UnifiedCommissions from './UnifiedCommissions'
import { PlayerApiError } from './online-player'
import {
  buyMarketListing,
  cancelMarketListing,
  createMarketListing,
  getMarket,
} from './online-market'
import type { MarketListing, MarketSnapshot, MarketSort, MarketType } from './online-market'
import type { SurvivalCharacter } from './online-survival'

const qualityNames: Record<string, string> = { worn: 'изношенное', common: 'обычное', good: 'добротное', masterwork: 'мастерское' }
const statusNames: Record<string, string> = { active: 'Активно', sold: 'Продано', cancelled: 'Отменено', expired: 'Срок истёк' }
type Tab = 'market' | 'mine' | 'history' | 'orders' | 'artifacts'
const marketError = (error: unknown) => error instanceof PlayerApiError ? error.message : 'Не удалось связаться с рынком.'
const deadline = (timestamp: number) => {
  const left = Math.max(0, timestamp - Date.now())
  const hours = Math.floor(left / 3_600_000)
  const minutes = Math.floor(left % 3_600_000 / 60_000)
  return left <= 0 ? 'срок истёк' : `${hours} ч ${minutes} мин`
}

function ListingCard({ listing, busy, quantity, onQuantity, onBuy }: {
  listing: MarketListing
  busy: boolean
  quantity: number
  onQuantity: (value: number) => void
  onBuy: () => void
}) {
  const total = quantity * listing.unitPrice
  return <article className={`m-listing ${listing.isMine ? 'mine' : ''}`}>
    <header><div><strong>{listing.item.name}</strong><span>{qualityNames[listing.item.quality] ?? listing.item.quality}</span></div><strong>{listing.unitPrice} монет</strong></header>
    <p>Продавец: {listing.sellerName}</p>
    <div className="m-listing-meta"><span>Осталось: {listing.quantityRemaining}</span><span>До возврата: {deadline(listing.expiresAt)}</span></div>
    {listing.isMine ? <p className="m-own-label">Это ваше объявление</p> : <div className="m-buy-row">
      <label>Количество<input min={1} max={listing.quantityRemaining} onChange={(event) => onQuantity(Math.max(1, Math.min(listing.quantityRemaining, Number(event.target.value) || 1)))} type="number" value={quantity} /></label>
      <div><span>Итого</span><strong>{total} монет</strong></div>
      <button disabled={busy || quantity < 1 || quantity > listing.quantityRemaining} onClick={onBuy} type="button">Купить</button>
    </div>}
  </article>
}

export default function UnifiedMarket({ character, onCharacter }: {
  character: SurvivalCharacter | null
  onCharacter: (character: SurvivalCharacter | null) => void
}) {
  const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(null)
  const [tab, setTab] = useState<Tab>('market')
  const [query, setQuery] = useState('')
  const [type, setType] = useState<MarketType>('all')
  const [sort, setSort] = useState<MarketSort>('newest')
  const [itemId, setItemId] = useState('')
  const [quantity, setQuantity] = useState(1)
  const [unitPrice, setUnitPrice] = useState(1)
  const [buyQuantities, setBuyQuantities] = useState<Record<string, number>>({})
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const next = await getMarket({ query, type, sort })
      setSnapshot(next)
      onCharacter(next.character)
      setItemId((current) => current || next.sellable[0]?.id || '')
      setError('')
    } catch (caught) { setError(marketError(caught)) }
  }, [onCharacter, query, sort, type])

  useEffect(() => {
    const delay = window.setTimeout(() => { void load() }, 250)
    const timer = window.setInterval(() => { void load() }, 20_000)
    return () => { window.clearTimeout(delay); window.clearInterval(timer) }
  }, [load])

  const selected = useMemo(() => snapshot?.sellable.find((item) => item.id === itemId) ?? null, [snapshot, itemId])
  const apply = async (operation: () => Promise<MarketSnapshot>, success: (next: MarketSnapshot) => string) => {
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await operation()
      onCharacter(result.character)
      setNotice(success(result))
      await load()
    } catch (caught) { setError(marketError(caught)) }
    finally { setBusy(false) }
  }

  if (!character) return <section className="u-panel"><h2>Рынок закрыт</h2><p>Сначала создай серверного героя.</p></section>
  if (!snapshot) return <section className="u-panel"><h2>Торговая площадь</h2><p>{error || 'Собираем объявления…'}</p></section>

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selected) return
    void apply(() => createMarketListing(selected.id, quantity, unitPrice), () => `Выставлено: ${selected.name} ×${quantity} по ${unitPrice} монет.`)
  }

  return <div className="u-stack m-market">
    <section className="u-panel">
      <header className="u-section-head">
        <div><p className="eyebrow">Сделки, заказы и уникальные экземпляры подтверждает сервер</p><h2>Торговая площадь</h2></div>
        <div className="m-market-summary"><span>Монеты</span><strong>{snapshot.character?.coins ?? character.coins}</strong><small>Объявление живёт {snapshot.listingLifetimeHours} часа</small></div>
      </header>
      <div className="m-market-toolbar">
        <div className="u-tabs m-tabs">
          <button className={tab === 'market' ? 'active' : ''} onClick={() => setTab('market')} type="button">Рынок · {snapshot.listings.length}</button>
          <button className={tab === 'mine' ? 'active' : ''} onClick={() => setTab('mine')} type="button">Мои объявления · {snapshot.ownListings.length}</button>
          <button className={tab === 'orders' ? 'active' : ''} onClick={() => setTab('orders')} type="button">Заказы мастерам</button>
          <button className={tab === 'artifacts' ? 'active' : ''} onClick={() => setTab('artifacts')} type="button">Уникальные вещи</button>
          <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')} type="button">История · {snapshot.trades.length}</button>
        </div>
        <button disabled={busy} onClick={() => void load()} type="button">Обновить</button>
      </div>
      {snapshot.pendingCoins > 0 && <p className="u-notice">На счёте рода хранится {snapshot.pendingCoins} монет. Они перейдут следующему наследнику.</p>}
      {snapshot.pendingItems > 0 && <p className="u-notice">На складе рода ожидает предметов: {snapshot.pendingItems}. Они будут выданы живому наследнику.</p>}
      {!snapshot.safe && <p className="u-notice error">{snapshot.safeReason}</p>}
      {notice && <p className="u-notice">{notice}</p>}
      {error && <p className="u-notice error">{error}</p>}
    </section>

    {tab === 'market' && <section className="u-panel">
      <div className="m-filter-row">
        <label>Поиск<input maxLength={40} onChange={(event) => setQuery(event.target.value)} placeholder="Товар или продавец" value={query} /></label>
        <label>Тип<select onChange={(event) => setType(event.target.value as MarketType)} value={type}><option value="all">Все товары</option><option value="material">Материалы</option><option value="consumable">Расходники</option></select></label>
        <label>Сортировка<select onChange={(event) => setSort(event.target.value as MarketSort)} value={sort}><option value="newest">Сначала новые</option><option value="price-asc">Сначала дешёвые</option><option value="price-desc">Сначала дорогие</option><option value="quantity">По остатку</option></select></label>
      </div>
      <p className="eyebrow">Товар уже зарезервирован сервером</p><h2>Активные объявления</h2>
      {snapshot.listings.length === 0 ? <p className="u-empty">По выбранным условиям товаров нет.</p> : <div className="m-listing-grid">{snapshot.listings.map((listing) => {
        const amount = buyQuantities[listing.id] ?? 1
        return <ListingCard busy={busy || !snapshot.safe} key={listing.id} listing={listing} onBuy={() => void apply(() => buyMarketListing(listing.id, amount), (result) => `Куплено: ${result.purchase?.itemName ?? listing.item.name} ×${amount} за ${result.purchase?.gross ?? amount * listing.unitPrice} монет.`)} onQuantity={(value) => setBuyQuantities((current) => ({ ...current, [listing.id]: value }))} quantity={amount} />
      })}</div>}
    </section>}

    {tab === 'mine' && <>
      <section className="u-panel">
        <p className="eyebrow">Резерв создаётся сразу</p><h2>Новое объявление</h2>
        {snapshot.sellable.length === 0 ? <p className="u-empty">Нет материалов или расходников, доступных для продажи.</p> : <form className="m-sell-form" onSubmit={submit}>
          <label>Товар<select onChange={(event) => { setItemId(event.target.value); setQuantity(1) }} value={itemId}>{snapshot.sellable.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.quantity} шт.</option>)}</select></label>
          <label>Количество<input max={selected?.quantity ?? 1} min={1} onChange={(event) => setQuantity(Math.max(1, Math.min(selected?.quantity ?? 1, Number(event.target.value) || 1)))} type="number" value={quantity} /></label>
          <label>Цена за штуку<input max={10000} min={1} onChange={(event) => setUnitPrice(Math.max(1, Math.min(10000, Number(event.target.value) || 1)))} type="number" value={unitPrice} /></label>
          <div><span>Сумма при полной продаже</span><strong>{quantity * unitPrice} монет</strong><small>Комиссия удерживается при покупке.</small></div>
          <button disabled={busy || !snapshot.safe || !selected || quantity > (selected?.quantity ?? 0)} type="submit">Выставить товар</button>
        </form>}
      </section>
      <section className="u-panel">
        <p className="eyebrow">Проданное не возвращается</p><h2>Мои объявления</h2>
        {snapshot.ownListings.length === 0 ? <p className="u-empty">Объявлений ещё нет.</p> : <div className="m-own-list">{snapshot.ownListings.map((listing) => <article key={listing.id}><div><strong>{listing.item.name}</strong><span>{statusNames[listing.status] ?? listing.status}</span><small>{listing.quantityRemaining}/{listing.quantityTotal} шт. · {listing.unitPrice} монет{listing.status === 'active' ? ` · ${deadline(listing.expiresAt)}` : ''}</small></div>{listing.status === 'active' && <button disabled={busy || !snapshot.safe} onClick={() => void apply(() => cancelMarketListing(listing.id), () => `Объявление «${listing.item.name}» отменено, остаток возвращён.`)} type="button">Отменить</button>}</article>)}</div>}
      </section>
    </>}

    {tab === 'orders' && <UnifiedCommissions character={character} onCharacter={onCharacter} />}
    {tab === 'artifacts' && <UnifiedArtifacts character={character} onCharacter={onCharacter} />}

    {tab === 'history' && <section className="u-panel">
      <p className="eyebrow">Неизменяемый журнал</p><h2>Последние сделки</h2>
      {snapshot.trades.length === 0 ? <p className="u-empty">Покупок и продаж ещё не было.</p> : <div className="m-trade-list">{snapshot.trades.map((trade) => <article key={trade.id}><div><strong>{trade.side === 'purchase' ? 'Покупка' : 'Продажа'} · {trade.itemName}</strong><span>{trade.quantity} шт. по {trade.unitPrice} монет</span><small>{trade.side === 'purchase' ? `Продавец: ${trade.sellerName}` : `Покупатель: ${trade.buyerName}`}</small></div><div><strong>{trade.side === 'purchase' ? `−${trade.gross}` : `+${trade.sellerNet}`}</strong>{trade.side === 'sale' && <small>Комиссия {trade.fee}</small>}<time>{new Date(trade.createdAt).toLocaleString('ru-RU')}</time></div></article>)}</div>}
    </section>}
  </div>
}
