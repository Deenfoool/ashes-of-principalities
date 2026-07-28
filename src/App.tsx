import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import AppV3 from './AppV3'
import UnifiedChat from './UnifiedChat'
import UnifiedCrafting from './UnifiedCrafting'
import UnifiedGuild from './UnifiedGuild'
import UnifiedJourney from './UnifiedJourney'
import UnifiedMarket from './UnifiedMarket'
import {
  fetchOnlineSnapshot,
  loginOnline,
  logoutOnline,
  OnlineError,
  registerOnline,
} from './online'
import type { OnlineSnapshot } from './online'
import {
  actInServerExpedition,
  createServerCharacter,
  createServerHeir,
  flushPlayerActionQueue,
  getServerContracts,
  PlayerApiError,
  QueuedPlayerAction,
  startServerExpedition,
  useExpeditionTactic,
} from './online-player'
import type { CombatAction, ContractRotation, ExpeditionTactic, OnlineProfession } from './online-player'
import { chooseMarshStory, flushMarshStoryActionQueue, getMarshStory } from './online-marsh-story'
import type { MarshStory } from './online-marsh-story'
import {
  chooseServerStory,
  flushStoryActionQueue,
  getServerStory,
} from './online-story'
import type { ServerStory } from './online-story'
import {
  equipServerItem,
  repairServerItem,
  treatServerInjury,
} from './online-survival'
import type { EquipmentSlot, SurvivalCharacter, SurvivalItem } from './online-survival'
import { getRegionalBosses, startSaltBellWarden } from './online-v013'
import type { RegionalBoss } from './online-v013'

type View = 'journey' | 'character' | 'crafting' | 'market' | 'guild' | 'chat' | 'account'

const EMPTY_ROTATION: ContractRotation = { contracts: [], regions: [], rotationEndsAt: null }

const professionNames: Record<OnlineProfession, string> = {
  blacksmith: 'Кузнец', herbalist: 'Травник', hunter: 'Охотник',
  scribe: 'Писарь', carter: 'Возчик', wanderer: 'Странник',
}

const qualityNames: Record<string, string> = {
  worn: 'изношенное', common: 'обычное', good: 'добротное', masterwork: 'мастерское',
}

const slotNames: Record<EquipmentSlot, string> = {
  'main-hand': 'Основная рука', body: 'Броня', charm: 'Оберег',
}

function describeError(error: unknown) {
  if (error instanceof OnlineError || error instanceof PlayerApiError || error instanceof QueuedPlayerAction) return error.message
  return 'Не удалось связаться с сервером.'
}

function Meter({ label, value, max }: { label: string; value: number; max: number }) {
  const width = `${Math.max(0, Math.min(100, max > 0 ? value / max * 100 : 0))}%`
  return <div className="u-meter"><div><span>{label}</span><strong>{value}/{max}</strong></div><div><span style={{ width }} /></div></div>
}

function GuestPortal({ onAuthenticated }: { onAuthenticated: () => Promise<void> }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [demo, setDemo] = useState(false)

  if (demo) return <div className="u-demo-mode"><button className="u-demo-exit" onClick={() => setDemo(false)} type="button">Выйти из демо</button><AppV3 /></div>

  return <main className="u-gate">
    <section className="u-gate-copy">
      <p className="eyebrow">Онлайн PWA RPG-рогалик</p>
      <h1>Пепел Княжеств</h1>
      <p>Две серверные главы, групповая тактика, ремёсла и решения, которые переживают героя.</p>
      <div className="u-gate-facts"><span>3 слота экипировки</span><span>Бои с отрядами</span><span>Региональный босс</span><span>Смерть и наследники</span></div>
      <button className="u-secondary" onClick={() => setDemo(true)} type="button">Открыть гостевое демо</button>
    </section>
    <section className="u-auth-card">
      <div className="u-tabs">
        <button className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')} type="button">Вход</button>
        <button className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')} type="button">Регистрация</button>
      </div>
      <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        setBusy(true)
        setError('')
        const operation = mode === 'register'
          ? registerOnline({ username, password, displayName })
          : loginOnline({ username, password })
        void operation.then(onAuthenticated).catch((caught) => setError(describeError(caught))).finally(() => setBusy(false))
      }}>
        {mode === 'register' && <label>Имя в игре<input maxLength={24} onChange={(event) => setDisplayName(event.target.value)} value={displayName} /></label>}
        <label>Логин<input autoCapitalize="none" maxLength={20} onChange={(event) => setUsername(event.target.value)} value={username} /></label>
        <label>Пароль<input minLength={8} maxLength={128} onChange={(event) => setPassword(event.target.value)} type="password" value={password} /></label>
        <button disabled={busy || username.trim().length < 3 || password.length < 8 || (mode === 'register' && displayName.trim().length < 2)} type="submit">
          {busy ? 'Подключение…' : mode === 'register' ? 'Создать аккаунт' : 'Войти'}
        </button>
      </form>
      {error && <p className="u-notice error">{error}</p>}
    </section>
  </main>
}

function equipmentFacts(item: SurvivalItem) {
  const facts: string[] = []
  if ((item.armor ?? 0) > 0) facts.push(`броня ${item.armor}`)
  if ((item.zoneResistance ?? 0) > 0) facts.push(`контроль −${item.zoneResistance}`)
  if ((item.movementDiscount ?? 0) > 0) facts.push(`движение −${item.movementDiscount}`)
  if ((item.hexResistance ?? 0) > 0) facts.push(`порча −${item.hexResistance}`)
  if ((item.elevationBonus ?? 0) > 0) facts.push(`высота +${item.elevationBonus}`)
  return facts
}

function ItemCard({ item, busy, onRepair, onEquip }: {
  item: SurvivalItem
  busy: boolean
  onRepair: () => void
  onEquip: () => void
}) {
  const facts = equipmentFacts(item)
  return <article className={`u-item ${item.equipped ? 'equipped' : ''} ${item.broken ? 'broken' : ''}`}>
    <div><strong>{item.name}</strong><span>{qualityNames[item.quality] ?? item.quality}{item.quantity > 1 ? ` · ${item.quantity} шт.` : ''}</span></div>
    {item.equipmentSlot && <small>{slotNames[item.equipmentSlot]}</small>}
    {facts.length > 0 && <div className="v13-item-stats">{facts.map((fact) => <span key={fact}>{fact}</span>)}</div>}
    {item.maxDurability > 0 ? <>
      <Meter label="Прочность" value={item.durability} max={item.maxDurability} />
      <div className="u-item-actions"><button disabled={busy || item.equipped} onClick={onEquip} type="button">{item.equipped ? 'Экипировано' : 'Экипировать'}</button><button disabled={busy || item.durability >= item.maxDurability} onClick={onRepair} type="button">Ремонт</button></div>
    </> : <small>{item.type === 'quest' ? 'Сюжетный предмет' : item.type === 'relic' ? 'Реликвия рода' : item.type === 'consumable' ? 'Расходник или ремесленная заготовка' : 'Материал или трофей'}</small>}
  </article>
}

function injuryEffect(kind: string, severity: number) {
  if (kind === 'wounded-arm') return `Атаки требуют ещё ${severity} силы.`
  if (kind === 'sprained-ankle') return `Отступление требует ещё ${severity} силы.`
  if (kind === 'marsh-fever') return `Движение в бою требует ещё ${severity} силы.`
  if (kind === 'deep-cut') return `Атаки и ремесленные приёмы требуют ещё ${severity} силы.`
  if (kind === 'salt-burn') return `Полевые тактики требуют ещё ${severity} силы.`
  return 'Травма влияет на выносливость героя.'
}

function LoadoutSlot({ slot, item }: { slot: EquipmentSlot; item: SurvivalItem | null | undefined }) {
  return <article className={`v13-loadout-slot ${item ? 'filled' : ''}`}>
    <span>{slotNames[slot]}</span>
    <strong>{item?.name ?? 'Пусто'}</strong>
    {item ? <><small>{qualityNames[item.quality] ?? item.quality}</small>{item.maxDurability > 0 && <small>{item.durability}/{item.maxDurability} прочности</small>}</> : <small>Выбери подходящий предмет ниже</small>}
  </article>
}

function CharacterView({ character, story, marshStory, busy, onRepair, onEquip, onTreat }: {
  character: SurvivalCharacter
  story: ServerStory | null
  marshStory: MarshStory | null
  busy: boolean
  onRepair: (id: string) => void
  onEquip: (id: string) => void
  onTreat: (id: string) => void
}) {
  return <div className="u-stack">
    <section className="u-panel">
      <header className="u-section-head"><div><p className="eyebrow">Поколение {character.generation}</p><h2>{character.name}</h2><span>{professionNames[character.profession]} · уровень {character.level}</span></div><span className={character.alive ? 'u-alive' : 'u-dead'}>{character.alive ? 'Жив' : 'Погиб'}</span></header>
      <div className="u-stat-grid"><Meter label="Здоровье" value={character.health} max={character.maxHealth} /><Meter label="Силы" value={character.stamina} max={character.maxStamina} /><Meter label="Опыт" value={character.experience} max={character.experienceToNext} /><article><span>Монеты</span><strong>{character.coins}</strong></article><article><span>Чутьё</span><strong>{character.insight}</strong></article><article><span>Репутация</span><strong>{character.reputation}</strong></article><article><span>Слава рода</span><strong>{character.legacyGlory}</strong></article><article><span>Броня</span><strong>{character.armorRating ?? 0}</strong></article></div>
    </section>
    <section className="u-panel">
      <p className="eyebrow">Три независимых слота</p><h2>Боевая раскладка</h2>
      <div className="v13-loadout-grid"><LoadoutSlot item={character.equipment?.mainHand ?? character.equippedItem} slot="main-hand" /><LoadoutSlot item={character.equipment?.body} slot="body" /><LoadoutSlot item={character.equipment?.charm} slot="charm" /></div>
    </section>
    <section className="u-panel">
      <p className="eyebrow">Покой теперь имеет значение</p><h2>Травмы и естественное заживление</h2>
      {character.injuries.length === 0 ? <p className="u-empty">Активных травм нет.</p> : <div className="u-injury-list">{character.injuries.map((injury) => <article key={injury.id}><div><strong>{injury.title}</strong><span>Тяжесть {injury.severity} · {injury.source}</span><small>{injuryEffect(injury.kind, injury.severity)}</small>{injury.naturalHealAt && <small>Следующее естественное улучшение: {new Date(injury.naturalHealAt).toLocaleString('ru-RU')}</small>}{injury.recoveryNote && <small>{injury.recoveryNote}</small>}</div><button disabled={busy || Boolean(character.activeExpedition)} onClick={() => onTreat(injury.id)} type="button">Лечить</button></article>)}</div>}
    </section>
    <section className="u-panel"><p className="eyebrow">Качество определяет цену содержания</p><h2>Снаряжение и трофеи</h2><div className="u-item-grid">{character.inventory.map((item) => <ItemCard busy={busy} item={item} key={item.id} onEquip={() => onEquip(item.id)} onRepair={() => onRepair(item.id)} />)}</div></section>
    {story && <section className="u-panel"><p className="eyebrow">Первая летопись</p><h2>Последние записи Верескова</h2><div className="u-history">{story.history.slice(0, 8).map((entry, index) => <p key={`${entry}-${index}`}>{entry}</p>)}</div></section>}
    {marshStory?.history && marshStory.history.length > 0 && <section className="u-panel"><p className="eyebrow">Вторая летопись</p><h2>Записи Соляных топей</h2><div className="u-history">{marshStory.history.slice(0, 8).map((entry, index) => <p key={`${entry}-${index}`}>{entry}</p>)}</div></section>}
  </div>
}

export default function App() {
  const [account, setAccount] = useState<OnlineSnapshot | null>(null)
  const [character, setCharacter] = useState<SurvivalCharacter | null>(null)
  const [story, setStory] = useState<ServerStory | null>(null)
  const [marshStory, setMarshStory] = useState<MarshStory | null>(null)
  const [rotation, setRotation] = useState<ContractRotation>(EMPTY_ROTATION)
  const [boss, setBoss] = useState<RegionalBoss | null>(null)
  const [view, setView] = useState<View>('journey')
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  const refreshAll = useCallback(async () => {
    try {
      const nextAccount = await fetchOnlineSnapshot()
      const [game, available, marsh, bossSnapshot] = await Promise.all([
        getServerStory(), getServerContracts(), getMarshStory(), getRegionalBosses(),
      ])
      setAccount(nextAccount)
      setCharacter(game.character as SurvivalCharacter | null)
      setStory(game.story)
      setRotation(available)
      setMarshStory(marsh.marshStory)
      setBoss(bossSnapshot.bosses[0] ?? null)
    } catch (error) {
      if ((error instanceof OnlineError || error instanceof PlayerApiError) && error.status === 401) {
        setAccount(null); setCharacter(null); setStory(null); setMarshStory(null); setRotation(EMPTY_ROTATION); setBoss(null)
      } else setNotice(describeError(error))
    } finally { setReady(true) }
  }, [])

  useEffect(() => { void refreshAll() }, [refreshAll])
  useEffect(() => {
    const sync = async () => {
      const completed = (await flushPlayerActionQueue()) + (await flushStoryActionQueue()) + (await flushMarshStoryActionQueue())
      if (completed > 0) { setNotice(`Синхронизировано действий: ${completed}.`); await refreshAll() }
    }
    window.addEventListener('online', sync)
    void sync()
    return () => window.removeEventListener('online', sync)
  }, [refreshAll])

  const applyGame = async (operation: () => Promise<{ character: unknown }>) => {
    setBusy(true); setNotice('')
    try { const result = await operation(); setCharacter(result.character as SurvivalCharacter); await refreshAll() }
    catch (error) { setNotice(describeError(error)) }
    finally { setBusy(false) }
  }

  const chooseFirstChapter = async (choiceId: string) => {
    setBusy(true); setNotice('')
    try { const result = await chooseServerStory(choiceId); setCharacter(result.character as SurvivalCharacter | null); setStory(result.story); await refreshAll() }
    catch (error) { setNotice(describeError(error)) }
    finally { setBusy(false) }
  }

  const chooseSecondChapter = async (choiceId: string) => {
    setBusy(true); setNotice('')
    try { const result = await chooseMarshStory(choiceId); setCharacter(result.character); setMarshStory(result.marshStory); await refreshAll() }
    catch (error) { setNotice(describeError(error)) }
    finally { setBusy(false) }
  }

  const title = useMemo(() => {
    if (view === 'journey') return character?.activeExpedition?.regionName ?? (marshStory?.started ? marshStory.scene?.region : story?.scene.region) ?? 'Северный рубеж'
    if (view === 'character') return character?.name ?? 'Герой'
    if (view === 'crafting') return 'Мастерская'
    if (view === 'market') return 'Торговая площадь'
    if (view === 'guild') return account?.guild?.name ?? 'Гильдия'
    if (view === 'chat') return 'Общий костёр'
    return 'Аккаунт'
  }, [view, story, marshStory, character, account])

  if (!ready) return <main className="u-loading"><h1>Пепел Княжеств</h1><p>Поднимаем серверную летопись…</p></main>
  if (!account) return <GuestPortal onAuthenticated={refreshAll} />

  const nav: Array<[View, string]> = [
    ['journey', 'Путь'], ['character', 'Герой'], ['crafting', 'Мастерская'], ['market', 'Рынок'],
    ['guild', 'Гильдия'], ['chat', 'Чаты'], ['account', 'Аккаунт'],
  ]

  return <div className="u-shell">
    <header className="u-topbar">
      <div className="u-brand"><span>ПК</span><div><strong>Пепел Княжеств</strong><small>{title}</small></div></div>
      <div><span>{character ? `${character.name} · ${professionNames[character.profession]}` : account.user.displayName}</span><strong>{character ? `Ур. ${character.level} · ${character.coins} монет` : `@${account.user.username}`}</strong></div>
      <div><span>{navigator.onLine ? 'Серверная связь' : 'Офлайн'}</span><strong>{account.guild ? `[${account.guild.tag}]` : 'Без гильдии'}</strong></div>
    </header>
    <aside className="u-sidebar">
      <nav>{nav.map(([id, label]) => <button className={view === id ? 'active' : ''} key={id} onClick={() => setView(id)} type="button">{label}</button>)}</nav>
      {character && <div className="u-side-stats"><Meter label="Здоровье" value={character.health} max={character.maxHealth} /><Meter label="Силы" value={character.stamina} max={character.maxStamina} /><div><span>Основная рука</span><strong>{character.equipment?.mainHand?.name ?? character.equippedItem?.name ?? 'нет'}</strong></div><div><span>Броня</span><strong>{character.armorRating ?? 0}</strong><small>{character.equipment?.body?.name ?? 'нет доспеха'}</small></div>{character.injuries.length > 0 && <div className="danger"><span>Травмы</span><strong>{character.injuries.length}</strong></div>}</div>}
    </aside>
    <main className="u-main">
      {notice && <p className="u-notice">{notice}</p>}
      {view === 'journey' && <UnifiedJourney
        boss={boss}
        busy={busy}
        character={character}
        marshStory={marshStory}
        onChoice={(id) => void chooseFirstChapter(id)}
        onCombat={(action: CombatAction, targetId?: string) => { const run = character?.activeExpedition; if (run) void applyGame(() => actInServerExpedition(run.id, action, targetId)) }}
        onCreate={(name, profession) => void applyGame(() => createServerCharacter(name, profession))}
        onHeir={(name, profession) => void applyGame(() => createServerHeir(name, profession))}
        onMarshChoice={(id) => void chooseSecondChapter(id)}
        onStart={(id) => void applyGame(() => startServerExpedition(id))}
        onStartBoss={() => void applyGame(() => startSaltBellWarden())}
        onTactic={(tactic: ExpeditionTactic) => { const run = character?.activeExpedition; if (run) void applyGame(() => useExpeditionTactic(run.id, tactic)) }}
        rotation={rotation}
        story={story}
      />}
      {view === 'character' && (character
        ? <CharacterView busy={busy} character={character} marshStory={marshStory} onEquip={(id) => void applyGame(() => equipServerItem(id))} onRepair={(id) => void applyGame(() => repairServerItem(id))} onTreat={(id) => void applyGame(() => treatServerInjury(id))} story={story} />
        : <section className="u-panel"><h2>Герой ещё не создан</h2><p>Перейди в раздел «Путь» и впиши первое имя рода.</p></section>)}
      {view === 'crafting' && <UnifiedCrafting character={character} onCharacter={setCharacter} />}
      {view === 'market' && <UnifiedMarket character={character} onCharacter={setCharacter} />}
      {view === 'guild' && <UnifiedGuild character={character} onCharacter={setCharacter} onRefresh={refreshAll} snapshot={account} />}
      {view === 'chat' && <UnifiedChat author={account.user.displayName} guildId={account.guild?.id ?? null} />}
      {view === 'account' && <section className="u-panel"><p className="eyebrow">Серверная личность</p><h2>{account.user.displayName}</h2><p>@{account.user.username}</p><div className="u-account-facts"><span>Создан: {new Date(account.user.createdAt).toLocaleDateString('ru-RU')}</span><span>{account.guild ? `Гильдия: [${account.guild.tag}] ${account.guild.name}` : 'Гильдии нет'}</span><span>{character ? `Поколение героя: ${character.generation}` : 'Герой ещё не создан'}</span><span>{boss ? `Побед над Глухобором: ${boss.victories}` : 'Босс ещё не открыт'}</span></div><button className="u-danger-button" onClick={() => void logoutOnline().then(() => { setAccount(null); setCharacter(null); setStory(null); setMarshStory(null); setRotation(EMPTY_ROTATION); setBoss(null); setView('journey') })} type="button">Выйти из аккаунта</button></section>}
    </main>
    <footer className="u-mobile-nav">{nav.map(([id, label]) => <button className={view === id ? 'active' : ''} key={id} onClick={() => setView(id)} type="button">{label}</button>)}</footer>
  </div>
}
