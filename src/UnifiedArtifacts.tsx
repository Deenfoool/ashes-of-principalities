import { useCallback, useEffect, useMemo, useState } from 'react'
import { PlayerApiError } from './online-player'
import type { OnlineProfession } from './online-player'
import {
  buyArtifact,
  cancelArtifactListing,
  forgeArtifact,
  getArtifacts,
  listArtifact,
} from './online-artifacts'
import type { ArtifactItem, ArtifactListing, ArtifactSnapshot } from './online-artifacts'
import { unequipServerSlot } from './online-survival'
import type { EquipmentSlot, SurvivalCharacter } from './online-survival'

const professionNames: Record<OnlineProfession, string> = {
  blacksmith: 'Кузнец', herbalist: 'Травник', hunter: 'Охотник',
  scribe: 'Писарь', carter: 'Возчик', wanderer: 'Странник',
}
const qualityNames: Record<string, string> = { worn: 'изношенное', common: 'обычное', good: 'добротное', masterwork: 'мастерское' }
const slotNames: Record<EquipmentSlot, string> = { 'main-hand': 'основная рука', body: 'броня', charm: 'оберег' }
const originNames: Record<string, string> = {
  starter: 'родовое начало',
  'legacy-starter': 'старое родовое снаряжение',
  'legacy-migration': 'предмет старого мира',
  'chapter-reward': 'награда первой главы',
  crafted: 'работа мастера',
  'crafted-equipment': 'региональная работа мастера',
  'boss-reward': 'награда регионального босса',
}
const materialNames: Record<string, string> = {
  'scrap-iron': 'лом железа', charcoal: 'древесный уголь', cloth: 'грубая ткань',
  'burnt-hide': 'обожжённая шкура', 'river-bone': 'речная кость', 'bitter-herb': 'горькая трава',
}

type Tab = 'market' | 'forge' | 'owned' | 'masters' | 'history'
const errorText = (error: unknown) => error instanceof PlayerApiError ? error.message : 'Не удалось связаться с реестром артефактов.'
const deadline = (value: number) => {
  const left = value - Date.now()
  if (left <= 0) return 'срок истёк'
  const hours = Math.ceil(left / 3_600_000)
  return hours < 24 ? `${hours} ч.` : `${Math.ceil(hours / 24)} дн.`
}

function ArtifactFacts({ item }: { item: ArtifactItem }) {
  const combatFacts = [
    (item.armor ?? 0) > 0 ? `броня ${item.armor}` : null,
    (item.zoneResistance ?? 0) > 0 ? `контроль −${item.zoneResistance}` : null,
    (item.movementDiscount ?? 0) > 0 ? `движение −${item.movementDiscount}` : null,
    (item.hexResistance ?? 0) > 0 ? `порча −${item.hexResistance}` : null,
    (item.elevationBonus ?? 0) > 0 ? `высота +${item.elevationBonus}` : null,
  ].filter((value): value is string => Boolean(value))
  return <div className="a-facts">
    <span>{item.serial}</span>
    <span>{qualityNames[item.quality] ?? item.quality}</span>
    {item.equipmentSlot && <span>Слот: {slotNames[item.equipmentSlot]}</span>}
    <span>{item.durability}/{item.maxDurability} прочности</span>
    {combatFacts.map((fact) => <span key={fact}>{fact}</span>)}
    <span>Переходов между владельцами: {item.tradeCount}</span>
  </div>
}

function ArtifactCard({ listing, busy, onBuy }: { listing: ArtifactListing; busy: boolean; onBuy: () => void }) {
  const item = listing.item
  return <article className="a-card">
    <header><div><strong>{item.name}</strong><small>{item.serial}</small></div><strong>{listing.unitPrice} монет</strong></header>
    <ArtifactFacts item={item} />
    <p>Мастер: {item.makerName ?? 'неизвестен'} · Продавец: {listing.sellerName}</p>
    <p>Происхождение: {originNames[item.originType] ?? item.originType}</p>
    <footer><small>Осталось: {deadline(listing.expiresAt)}</small>{listing.isMine ? <span>Ваше объявление</span> : <button disabled={busy} onClick={onBuy} type="button">Купить экземпляр</button>}</footer>
  </article>
}

export default function UnifiedArtifacts({ character, onCharacter }: {
  character: SurvivalCharacter | null
  onCharacter: (character: SurvivalCharacter | null) => void
}) {
  const [snapshot, setSnapshot] = useState<ArtifactSnapshot | null>(null)
  const [tab, setTab] = useState<Tab>('market')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [prices, setPrices] = useState<Record<string, number>>({})

  const load = useCallback(async () => {
    try {
      const next = await getArtifacts()
      setSnapshot(next)
      onCharacter(next.character)
      setError('')
    } catch (caught) { setError(errorText(caught)) }
  }, [onCharacter])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => { void load() }, 25_000)
    return () => window.clearInterval(timer)
  }, [load])

  const apply = async (operation: () => Promise<ArtifactSnapshot>, success: (next: ArtifactSnapshot) => string) => {
    setBusy(true); setError(''); setNotice('')
    try {
      const next = await operation()
      setSnapshot(next)
      onCharacter(next.character)
      setNotice(success(next))
    } catch (caught) { setError(errorText(caught)) }
    finally { setBusy(false) }
  }

  const removeEquipment = async (slot: EquipmentSlot, itemName: string) => {
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await unequipServerSlot(slot)
      onCharacter(result.character)
      await load()
      setNotice(`Предмет «${itemName}» снят. Теперь его можно использовать вне боевой раскладки.`)
    } catch (caught) { setError(errorText(caught)) }
    finally { setBusy(false) }
  }

  const tradableOwned = useMemo(() => snapshot?.owned.filter((item) => item.tradable && !item.equipped) ?? [], [snapshot])
  void tradableOwned

  if (!character) return <section className="u-panel"><h2>Артефакты недоступны</h2><p>Сначала создай серверного героя.</p></section>
  if (!snapshot) return <section className="u-panel"><h2>Реестр артефактов</h2><p>{error || 'Летописец сверяет серийные клейма…'}</p></section>

  return <div className="u-stack a-artifacts">
    <section className="u-panel">
      <header className="u-section-head"><div><p className="eyebrow">Каждый экземпляр существует в единственном числе</p><h2>Артефакты и именные вещи</h2></div><button disabled={busy} onClick={() => void load()} type="button">Обновить</button></header>
      <div className="u-tabs a-tabs">
        <button className={tab === 'market' ? 'active' : ''} onClick={() => setTab('market')} type="button">Торги · {snapshot.listings.length}</button>
        <button className={tab === 'forge' ? 'active' : ''} onClick={() => setTab('forge')} type="button">Чертежи</button>
        <button className={tab === 'owned' ? 'active' : ''} onClick={() => setTab('owned')} type="button">Мои вещи · {snapshot.owned.length}</button>
        <button className={tab === 'masters' ? 'active' : ''} onClick={() => setTab('masters')} type="button">Мастера</button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')} type="button">История</button>
      </div>
      {!snapshot.safe && <p className="u-notice error">{snapshot.safeReason}</p>}
      {notice && <p className="u-notice">{notice}</p>}
      {error && <p className="u-notice error">{error}</p>}
    </section>

    {tab === 'market' && <section className="u-panel">
      <p className="eyebrow">Сервер передаёт сам экземпляр</p><h2>Уникальные вещи на торгах</h2>
      {snapshot.listings.length === 0 ? <p className="u-empty">Уникальных вещей на продаже пока нет.</p> : <div className="a-grid">{snapshot.listings.map((listing) => <ArtifactCard busy={busy || !snapshot.safe} key={listing.id} listing={listing} onBuy={() => void apply(() => buyArtifact(listing.id), () => `Куплен уникальный предмет «${listing.item.name}» ${listing.item.serial}.`)} />)}</div>}
    </section>}

    {tab === 'forge' && <section className="u-panel">
      <p className="eyebrow">Шесть ремёсел · шесть именных изделий</p><h2>Чертежи уникальных предметов</h2>
      <div className="a-grid">{snapshot.blueprints.map((blueprint) => <article className="a-blueprint" key={blueprint.id}>
        <header><div><strong>{blueprint.name}</strong><small>{professionNames[blueprint.profession]}</small></div><strong>{blueprint.coins} монет</strong></header>
        <p>{blueprint.description}</p>
        <div className="a-facts"><span>{qualityNames[blueprint.quality]}</span><span>{blueprint.durability} прочности</span></div>
        <ul>{Object.entries(blueprint.ingredients).map(([id, amount]) => <li key={id}>{materialNames[id] ?? id} ×{amount}</li>)}</ul>
        <button disabled={busy || !blueprint.available} onClick={() => void apply(() => forgeArtifact(blueprint.id), (next) => `Создано: ${next.forged?.name ?? blueprint.name} ${next.forged?.serial ?? ''}.`)} type="button">{blueprint.available ? 'Изготовить' : blueprint.reason}</button>
      </article>)}</div>
    </section>}

    {tab === 'owned' && <>
      <section className="u-panel"><p className="eyebrow">Снаряжение рода</p><h2>Личная коллекция</h2>
        {snapshot.owned.length === 0 ? <p className="u-empty">У рода пока нет уникальных вещей.</p> : <div className="a-owned-list">{snapshot.owned.map((item) => <article key={item.id}>
          <div><strong>{item.name} · {item.serial}</strong><ArtifactFacts item={item} /><small>Мастер: {item.makerName ?? 'неизвестен'} · {originNames[item.originType] ?? item.originType}{item.equipped ? ' · экипировано' : ''}</small></div>
          {item.equipped && item.equipmentSlot ? <button disabled={busy || !snapshot.safe} onClick={() => void removeEquipment(item.equipmentSlot!, item.name)} type="button">Снять</button> : !item.tradable ? <span className="a-bound">Связано с родом</span> : <div className="a-sell"><input aria-label={`Цена ${item.name}`} max={100000} min={1} onChange={(event) => setPrices((current) => ({ ...current, [item.id]: Math.max(1, Math.min(100000, Number(event.target.value) || 1)) }))} type="number" value={prices[item.id] ?? 10} /><button disabled={busy || !snapshot.safe} onClick={() => void apply(() => listArtifact(item.id, prices[item.id] ?? 10), () => `${item.name} выставлен на торги.`)} type="button">Выставить</button></div>}
        </article>)}</div>}
      </section>
      <section className="u-panel"><p className="eyebrow">Возврат только до продажи</p><h2>Мои объявления</h2>
        {snapshot.ownListings.length === 0 ? <p className="u-empty">Объявлений уникальных вещей ещё нет.</p> : <div className="a-owned-list">{snapshot.ownListings.map((listing) => <article key={listing.id}><div><strong>{listing.item.name} · {listing.item.serial}</strong><ArtifactFacts item={listing.item} /><small>{listing.status} · {listing.unitPrice} монет{listing.status === 'active' ? ` · ${deadline(listing.expiresAt)}` : ''}</small></div>{listing.status === 'active' && <button disabled={busy || !snapshot.safe} onClick={() => void apply(() => cancelArtifactListing(listing.id), () => `Объявление ${listing.item.serial} отменено.`)} type="button">Отменить</button>}</article>)}</div>}
      </section>
    </>}

    {tab === 'masters' && <section className="u-panel">
      <p className="eyebrow">Репутация, заказы и именные работы</p><h2>Рейтинг мастеров</h2>
      {snapshot.leaderboard.length === 0 ? <p className="u-empty">Мастера ещё не оставили достаточно следов в летописи.</p> : <div className="a-ranking">{snapshot.leaderboard.map((master) => <article key={`${master.rank}-${master.name}`}><strong>#{master.rank}</strong><div><b>{master.name}</b><span>{professionNames[master.profession]}</span></div><span>Работ: {master.crafted}</span><span>Заказов: {master.fulfilled}</span><strong>{master.score}</strong></article>)}</div>}
    </section>}

    {tab === 'history' && <section className="u-panel">
      <p className="eyebrow">Неизменяемые переходы собственности</p><h2>Последние сделки рода</h2>
      {snapshot.trades.length === 0 ? <p className="u-empty">Уникальные предметы ещё не переходили между игроками.</p> : <div className="m-trade-list">{snapshot.trades.map((trade) => <article key={trade.id}><div><strong>{trade.side === 'purchase' ? 'Покупка' : 'Продажа'} · {trade.itemName}</strong><span>{trade.side === 'purchase' ? `Продавец: ${trade.sellerName}` : `Покупатель: ${trade.buyerName}`}</span></div><div><strong>{trade.side === 'purchase' ? `−${trade.gross}` : `+${trade.sellerNet}`}</strong>{trade.side === 'sale' && <small>Комиссия {trade.fee}</small>}<time>{new Date(trade.createdAt).toLocaleString('ru-RU')}</time></div></article>)}</div>}
    </section>}
  </div>
}
