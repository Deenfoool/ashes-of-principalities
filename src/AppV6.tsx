import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import AppV3 from './AppV3'
import UnifiedChat from './UnifiedChat'
import UnifiedGuild from './UnifiedGuild'
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
} from './online-player'
import type { CombatAction, OnlineProfession, ServerContract } from './online-player'
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
import type { SurvivalCharacter, SurvivalItem } from './online-survival'

type View = 'journey' | 'character' | 'guild' | 'chat' | 'account'

const professionNames: Record<OnlineProfession, string> = {
  blacksmith: 'Кузнец',
  herbalist: 'Травник',
  hunter: 'Охотник',
  scribe: 'Писарь',
  carter: 'Возчик',
  wanderer: 'Странник',
}
const intentNames: Record<string, string> = { attack: 'обычная атака', heavy: 'тяжёлый удар', guard: 'защита', hex: 'проклятие' }
const actionLabels: Record<CombatAction, string> = { attack: 'Атаковать', guard: 'Защищаться', prepare: 'Подготовиться', profession: 'Приём ремесла', flee: 'Отступить' }
const qualityNames: Record<string, string> = { worn: 'изношенное', common: 'обычное', good: 'добротное', masterwork: 'мастерское' }

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
    <section className="u-gate-copy"><p className="eyebrow">Онлайн PWA RPG-рогалик</p><h1>Пепел Княжеств</h1><p>Один серверный герой, одна экономика и решения, которые переживают закрытие браузера.</p><div className="u-gate-facts"><span>16 авторских сцен</span><span>6 ремёсел</span><span>Гильдии до 20 игроков</span><span>Смерть и наследники</span></div><button className="u-secondary" onClick={() => setDemo(true)} type="button">Открыть гостевое демо</button></section>
    <section className="u-auth-card"><div className="u-tabs"><button className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')} type="button">Вход</button><button className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')} type="button">Регистрация</button></div><form onSubmit={(event: FormEvent<HTMLFormElement>) => {
      event.preventDefault(); setBusy(true); setError('')
      const operation = mode === 'register' ? registerOnline({ username, password, displayName }) : loginOnline({ username, password })
      void operation.then(onAuthenticated).catch((caught) => setError(describeError(caught))).finally(() => setBusy(false))
    }}>
      {mode === 'register' && <label>Имя в игре<input maxLength={24} onChange={(event) => setDisplayName(event.target.value)} value={displayName} /></label>}
      <label>Логин<input autoCapitalize="none" maxLength={20} onChange={(event) => setUsername(event.target.value)} value={username} /></label>
      <label>Пароль<input minLength={8} maxLength={128} onChange={(event) => setPassword(event.target.value)} type="password" value={password} /></label>
      <button disabled={busy || username.trim().length < 3 || password.length < 8 || (mode === 'register' && displayName.trim().length < 2)} type="submit">{busy ? 'Подключение…' : mode === 'register' ? 'Создать аккаунт' : 'Войти'}</button>
    </form>{error && <p className="u-notice error">{error}</p>}</section>
  </main>
}

function CharacterCreation({ busy, heir, onCreate }: { busy: boolean; heir: boolean; onCreate: (name: string, profession: OnlineProfession) => void }) {
  const [name, setName] = useState('')
  const [profession, setProfession] = useState<OnlineProfession>('hunter')
  return <form className="u-panel u-create" onSubmit={(event) => { event.preventDefault(); onCreate(name, profession) }}><p className="eyebrow">{heir ? 'Род не заканчивается одной смертью' : 'Первое имя в летописи'}</p><h2>{heir ? 'Создать наследника' : 'Создать героя'}</h2><label>Имя<input maxLength={24} minLength={2} onChange={(event) => setName(event.target.value)} required value={name} /></label><label>Ремесло<select onChange={(event) => setProfession(event.target.value as OnlineProfession)} value={profession}>{(Object.keys(professionNames) as OnlineProfession[]).map((id) => <option key={id} value={id}>{professionNames[id]}</option>)}</select></label><button disabled={busy || name.trim().length < 2} type="submit">{heir ? 'Продолжить род' : 'Выйти на дорогу'}</button></form>
}

function JourneyView({ character, story, contracts, busy, onChoice, onCombat, onStart, onCreate, onHeir }: {
  character: SurvivalCharacter | null
  story: ServerStory | null
  contracts: ServerContract[]
  busy: boolean
  onChoice: (choiceId: string) => void
  onCombat: (action: CombatAction) => void
  onStart: (contractId: string) => void
  onCreate: (name: string, profession: OnlineProfession) => void
  onHeir: (name: string, profession: OnlineProfession) => void
}) {
  if (!character) return <CharacterCreation busy={busy} heir={false} onCreate={onCreate} />
  if (!character.alive) return <CharacterCreation busy={busy} heir onCreate={onHeir} />
  const active = character.activeExpedition
  if (active) return <section className="u-panel u-combat"><header className="u-section-head"><div><p className="eyebrow">Ход {active.turn}{story?.pendingEncounter ? ' · сюжет' : ''}</p><h2>{active.enemyName}</h2></div><span>Намерение: {intentNames[active.enemyIntent] ?? active.enemyIntent}</span></header><Meter label="Враг" value={active.enemyHealth} max={active.enemyMaxHealth} /><div className="u-combat-flags">{active.guard > 0 && <span>Защита {active.guard}</span>}{active.prepared && <span>Удар подготовлен</span>}{character.equippedItem?.broken && <span className="danger">Инструмент сломан</span>}{character.injuries.map((injury) => <span className="danger" key={injury.id}>{injury.title}</span>)}</div><div className="u-combat-log">{active.lastLog.map((entry, index) => <p key={`${entry}-${index}`}>{entry}</p>)}</div><div className="u-action-grid">{(Object.keys(actionLabels) as CombatAction[]).map((action) => <button disabled={busy || (action === 'profession' && Boolean(character.equippedItem?.broken))} key={action} onClick={() => onCombat(action)} type="button">{actionLabels[action]}</button>)}</div></section>
  if (!story) return <section className="u-panel"><h2>Летопись ещё не создана</h2><p>Обнови страницу или повтори подключение.</p></section>
  const complete = story.quests.filter((quest) => quest.status === 'completed').length
  return <div className="u-stack"><section className="u-panel"><header className="u-section-head"><div><p className="eyebrow">{story.scene.region}</p><h2>{story.scene.title}</h2></div><span>{complete}/3 контрактов · {story.decisionCount} решений</span></header><p className="u-story-text">{story.scene.text}</p><div className="u-choice-list">{story.scene.choices.map((choice) => <button disabled={busy || !choice.available} key={choice.id} onClick={() => onChoice(choice.id)} type="button"><span>{choice.label}</span>{choice.requirement && <small>{choice.requirement}</small>}</button>)}</div></section><section className="u-panel"><p className="eyebrow">След решений</p><h2>Контракты главы</h2><div className="u-quest-grid">{story.quests.map((quest) => <article className={quest.status} key={quest.id}><strong>{quest.title}</strong><p>{quest.summary}</p><small>{quest.status === 'completed' ? `Итог: ${quest.outcome}` : quest.status === 'active' ? 'Активен' : 'Доступен'}</small></article>)}</div></section>{story.chapterComplete && <section className="u-panel"><p className="eyebrow">Между главами</p><h2>Вольные контракты</h2><div className="u-contract-grid">{contracts.map((contract) => <article key={contract.id}><div><strong>{contract.title}</strong><span>Опасность {contract.difficulty}</span></div><p>{contract.description}</p><small>{contract.rewardCoins} монет · {contract.rewardExperience} опыта</small><button disabled={busy || character.stamina < 2} onClick={() => onStart(contract.id)} type="button">Взять контракт</button></article>)}</div></section>}</div>
}

function ItemCard({ item, busy, onRepair, onEquip }: { item: SurvivalItem; busy: boolean; onRepair: () => void; onEquip: () => void }) {
  return <article className={`u-item ${item.equipped ? 'equipped' : ''} ${item.broken ? 'broken' : ''}`}><div><strong>{item.name}</strong><span>{qualityNames[item.quality] ?? item.quality}{item.quantity > 1 ? ` · ${item.quantity} шт.` : ''}</span></div>{item.maxDurability > 0 ? <><Meter label="Прочность" value={item.durability} max={item.maxDurability} /><div className="u-item-actions"><button disabled={busy || item.equipped} onClick={onEquip} type="button">{item.equipped ? 'Экипировано' : 'Экипировать'}</button><button disabled={busy || item.durability >= item.maxDurability} onClick={onRepair} type="button">Ремонт</button></div></> : <small>{item.type === 'quest' ? 'Сюжетный предмет' : item.type === 'relic' ? 'Реликвия рода' : 'Материал или трофей'}</small>}</article>
}

function CharacterView({ character, story, busy, onRepair, onEquip, onTreat }: { character: SurvivalCharacter; story: ServerStory | null; busy: boolean; onRepair: (id: string) => void; onEquip: (id: string) => void; onTreat: (id: string) => void }) {
  return <div className="u-stack"><section className="u-panel"><header className="u-section-head"><div><p className="eyebrow">Поколение {character.generation}</p><h2>{character.name}</h2><span>{professionNames[character.profession]} · уровень {character.level}</span></div><span className={character.alive ? 'u-alive' : 'u-dead'}>{character.alive ? 'Жив' : 'Погиб'}</span></header><div className="u-stat-grid"><Meter label="Здоровье" value={character.health} max={character.maxHealth} /><Meter label="Силы" value={character.stamina} max={character.maxStamina} /><Meter label="Опыт" value={character.experience} max={character.experienceToNext} /><article><span>Монеты</span><strong>{character.coins}</strong></article><article><span>Чутьё</span><strong>{character.insight}</strong></article><article><span>Репутация</span><strong>{character.reputation}</strong></article><article><span>Слава рода</span><strong>{character.legacyGlory}</strong></article><article><span>Погибших</span><strong>{character.deaths}</strong></article></div></section><section className="u-panel"><p className="eyebrow">Последствия не исчезают после боя</p><h2>Травмы</h2>{character.injuries.length === 0 ? <p className="u-empty">Активных травм нет.</p> : <div className="u-injury-list">{character.injuries.map((injury) => <article key={injury.id}><div><strong>{injury.title}</strong><span>Тяжесть {injury.severity} · {injury.source}</span><small>{injury.kind === 'wounded-arm' ? `Боевые удары требуют ещё ${injury.severity} силы.` : `Отступление требует ещё ${injury.severity} силы.`}</small></div><button disabled={busy || Boolean(character.activeExpedition)} onClick={() => onTreat(injury.id)} type="button">Лечить</button></article>)}</div>}</section><section className="u-panel"><p className="eyebrow">Качество определяет цену содержания</p><h2>Снаряжение и трофеи</h2><div className="u-item-grid">{character.inventory.map((item) => <ItemCard busy={busy} item={item} key={item.id} onEquip={() => onEquip(item.id)} onRepair={() => onRepair(item.id)} />)}</div></section>{story && <section className="u-panel"><p className="eyebrow">Последние записи</p><h2>Летопись</h2><div className="u-history">{story.history.slice(0, 12).map((entry, index) => <p key={`${entry}-${index}`}>{entry}</p>)}</div></section>}</div>
}

export default function AppV6() {
  const [account, setAccount] = useState<OnlineSnapshot | null>(null)
  const [character, setCharacter] = useState<SurvivalCharacter | null>(null)
  const [story, setStory] = useState<ServerStory | null>(null)
  const [contracts, setContracts] = useState<ServerContract[]>([])
  const [view, setView] = useState<View>('journey')
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  const refreshAll = useCallback(async () => {
    try {
      const nextAccount = await fetchOnlineSnapshot()
      const [game, available] = await Promise.all([getServerStory(), getServerContracts()])
      setAccount(nextAccount)
      setCharacter(game.character as SurvivalCharacter | null)
      setStory(game.story)
      setContracts(available.contracts)
    } catch (error) {
      if ((error instanceof OnlineError || error instanceof PlayerApiError) && error.status === 401) {
        setAccount(null); setCharacter(null); setStory(null); setContracts([])
      } else setNotice(describeError(error))
    } finally { setReady(true) }
  }, [])

  useEffect(() => { void refreshAll() }, [refreshAll])
  useEffect(() => {
    const sync = async () => {
      const completed = (await flushPlayerActionQueue()) + (await flushStoryActionQueue())
      if (completed > 0) { setNotice(`Синхронизировано действий: ${completed}.`); await refreshAll() }
    }
    window.addEventListener('online', sync)
    void sync()
    return () => window.removeEventListener('online', sync)
  }, [refreshAll])

  const applyGame = async (operation: () => Promise<{ character: unknown }>) => {
    setBusy(true); setNotice('')
    try {
      const result = await operation()
      setCharacter(result.character as SurvivalCharacter)
      const next = await getServerStory()
      setCharacter(next.character as SurvivalCharacter | null)
      setStory(next.story)
    } catch (error) { setNotice(describeError(error)) } finally { setBusy(false) }
  }
  const choose = async (choiceId: string) => {
    setBusy(true); setNotice('')
    try {
      const result = await chooseServerStory(choiceId)
      setCharacter(result.character as SurvivalCharacter | null); setStory(result.story)
      await refreshAll()
    } catch (error) { setNotice(describeError(error)) } finally { setBusy(false) }
  }

  const title = useMemo(() => view === 'journey' ? story?.scene.region ?? 'Северный рубеж' : view === 'character' ? character?.name ?? 'Герой' : view === 'guild' ? account?.guild?.name ?? 'Гильдия' : view === 'chat' ? 'Общий костёр' : 'Аккаунт', [view, story, character, account])
  if (!ready) return <main className="u-loading"><h1>Пепел Княжеств</h1><p>Поднимаем серверную летопись…</p></main>
  if (!account) return <GuestPortal onAuthenticated={refreshAll} />

  const nav: Array<[View, string]> = [['journey', 'Путь'], ['character', 'Герой'], ['guild', 'Гильдия'], ['chat', 'Чаты'], ['account', 'Аккаунт']]
  return <div className="u-shell"><header className="u-topbar"><div className="u-brand"><span>ПК</span><div><strong>Пепел Княжеств</strong><small>{title}</small></div></div><div><span>{character ? `${character.name} · ${professionNames[character.profession]}` : account.user.displayName}</span><strong>{character ? `Ур. ${character.level} · ${character.coins} монет` : `@${account.user.username}`}</strong></div><div><span>{navigator.onLine ? 'Серверная связь' : 'Офлайн'}</span><strong>{account.guild ? `[${account.guild.tag}]` : 'Без гильдии'}</strong></div></header><aside className="u-sidebar"><nav>{nav.map(([id, label]) => <button className={view === id ? 'active' : ''} key={id} onClick={() => setView(id)} type="button">{label}</button>)}</nav>{character && <div className="u-side-stats"><Meter label="Здоровье" value={character.health} max={character.maxHealth} /><Meter label="Силы" value={character.stamina} max={character.maxStamina} /><div><span>Инструмент</span><strong>{character.equippedItem?.name ?? 'нет'}</strong><small>{character.equippedItem?.maxDurability ? `${character.equippedItem.durability}/${character.equippedItem.maxDurability}` : ''}</small></div>{character.injuries.length > 0 && <div className="danger"><span>Травмы</span><strong>{character.injuries.length}</strong></div>}</div>}</aside><main className="u-main">{notice && <p className="u-notice">{notice}</p>}{view === 'journey' && <JourneyView busy={busy} character={character} contracts={contracts} onChoice={(id) => void choose(id)} onCombat={(action) => { const run = character?.activeExpedition; if (run) void applyGame(() => actInServerExpedition(run.id, action)) }} onCreate={(name, profession) => void applyGame(() => createServerCharacter(name, profession))} onHeir={(name, profession) => void applyGame(() => createServerHeir(name, profession))} onStart={(id) => void applyGame(() => startServerExpedition(id))} story={story} />}{view === 'character' && (character ? <CharacterView busy={busy} character={character} onEquip={(id) => void applyGame(() => equipServerItem(id))} onRepair={(id) => void applyGame(() => repairServerItem(id))} onTreat={(id) => void applyGame(() => treatServerInjury(id))} story={story} /> : <CharacterCreation busy={busy} heir={false} onCreate={(name, profession) => void applyGame(() => createServerCharacter(name, profession))} />)}{view === 'guild' && <UnifiedGuild character={character} onCharacter={setCharacter} onRefresh={refreshAll} snapshot={account} />}{view === 'chat' && <UnifiedChat author={account.user.displayName} guildId={account.guild?.id ?? null} />}{view === 'account' && <section className="u-panel"><p className="eyebrow">Серверная личность</p><h2>{account.user.displayName}</h2><p>@{account.user.username}</p><div className="u-account-facts"><span>Создан: {new Date(account.user.createdAt).toLocaleDateString('ru-RU')}</span><span>{account.guild ? `Гильдия: [${account.guild.tag}] ${account.guild.name}` : 'Гильдии нет'}</span><span>{character ? `Поколение героя: ${character.generation}` : 'Герой ещё не создан'}</span></div><button className="u-danger-button" onClick={() => void logoutOnline().then(() => { setAccount(null); setCharacter(null); setStory(null); setView('journey') })} type="button">Выйти из аккаунта</button></section>}</main><footer className="u-mobile-nav">{nav.map(([id, label]) => <button className={view === id ? 'active' : ''} key={id} onClick={() => setView(id)} type="button">{label}</button>)}</footer></div>
}