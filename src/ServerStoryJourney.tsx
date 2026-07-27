import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  actInServerExpedition,
  createServerCharacter,
  createServerHeir,
  donateServerCoins,
  flushPlayerActionQueue,
  getServerContracts,
  PlayerApiError,
  QueuedPlayerAction,
  startServerExpedition,
} from './online-player'
import type {
  CombatAction,
  OnlineProfession,
  ServerCharacter,
  ServerContract,
} from './online-player'
import {
  chooseServerStory,
  flushStoryActionQueue,
  getServerStory,
} from './online-story'
import type { ServerStory } from './online-story'

const professionNames: Record<OnlineProfession, string> = {
  blacksmith: 'Кузнец',
  herbalist: 'Травник',
  hunter: 'Охотник',
  scribe: 'Писарь',
  carter: 'Возчик',
  wanderer: 'Странник',
}

const intentNames: Record<string, string> = {
  attack: 'обычная атака',
  heavy: 'тяжёлый удар',
  guard: 'защита',
  hex: 'проклятие',
}

const actionLabels: Record<CombatAction, string> = {
  attack: 'Атаковать',
  guard: 'Защищаться',
  prepare: 'Подготовиться',
  profession: 'Приём ремесла',
  flee: 'Отступить',
}

function Meter({ label, value, max }: { label: string; value: number; max: number }) {
  const width = `${Math.max(0, Math.min(100, max > 0 ? value / max * 100 : 0))}%`
  return <div className="server-meter"><div><span>{label}</span><strong>{value}/{max}</strong></div><div className="server-meter-track"><span style={{ width }} /></div></div>
}

function describeError(error: unknown) {
  if (error instanceof PlayerApiError || error instanceof QueuedPlayerAction) return error.message
  return 'Не удалось связаться с сервером.'
}

export default function ServerStoryJourney() {
  const [open, setOpen] = useState(false)
  const [authenticated, setAuthenticated] = useState<boolean | null>(null)
  const [character, setCharacter] = useState<ServerCharacter | null>(null)
  const [story, setStory] = useState<ServerStory | null>(null)
  const [contracts, setContracts] = useState<ServerContract[]>([])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [name, setName] = useState('')
  const [profession, setProfession] = useState<OnlineProfession>('hunter')
  const [donation, setDonation] = useState('5')
  const autoOpened = useRef(false)

  const refresh = useCallback(async (allowAutoOpen = false) => {
    setBusy(true)
    try {
      const [snapshot, available] = await Promise.all([getServerStory(), getServerContracts()])
      setCharacter(snapshot.character)
      setStory(snapshot.story)
      setContracts(available.contracts)
      setAuthenticated(true)
      if (allowAutoOpen && snapshot.character && !autoOpened.current) {
        autoOpened.current = true
        setOpen(true)
      }
    } catch (error) {
      if (error instanceof PlayerApiError && error.status === 401) {
        setAuthenticated(false)
        setCharacter(null)
        setStory(null)
      } else {
        setNotice(describeError(error))
      }
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => { void refresh(true) }, [refresh])

  useEffect(() => {
    const synchronize = async () => {
      const [playerActions, storyActions] = await Promise.all([
        flushPlayerActionQueue(),
        flushStoryActionQueue(),
      ])
      const completed = playerActions + storyActions
      if (completed > 0) {
        setNotice(`Синхронизировано действий: ${completed}.`)
        await refresh()
      }
    }
    window.addEventListener('online', synchronize)
    void synchronize()
    return () => window.removeEventListener('online', synchronize)
  }, [refresh])

  const applySnapshot = (snapshot: { character: ServerCharacter | null; story: ServerStory | null }) => {
    setCharacter(snapshot.character)
    setStory(snapshot.story)
  }

  const performPlayer = async (operation: () => Promise<{ character: ServerCharacter }>) => {
    setBusy(true)
    setNotice('')
    try {
      const result = await operation()
      setCharacter(result.character)
      const snapshot = await getServerStory()
      applySnapshot(snapshot)
    } catch (error) {
      setNotice(describeError(error))
    } finally {
      setBusy(false)
    }
  }

  const performChoice = async (choiceId: string) => {
    setBusy(true)
    setNotice('')
    try {
      applySnapshot(await chooseServerStory(choiceId))
    } catch (error) {
      setNotice(describeError(error))
    } finally {
      setBusy(false)
    }
  }

  const active = character?.activeExpedition
  const completedQuests = story?.quests.filter((quest) => quest.status === 'completed').length ?? 0
  const professionLabel = character ? professionNames[character.profession] : ''
  const experiencePercent = useMemo(() => {
    if (!character || character.experienceToNext <= 0) return 0
    return Math.round(character.experience / character.experienceToNext * 100)
  }, [character])

  return (
    <>
      <button className={`server-journey-toggle ${active ? 'active-run' : ''}`} onClick={() => setOpen((value) => !value)} type="button">
        {active ? 'Идёт бой' : story?.chapterComplete ? 'Серверный мир' : 'Первая глава'}
      </button>

      {open && <div className="server-journey-backdrop" role="presentation" onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false)
      }}>
        <section className="server-journey-panel server-story-panel" role="dialog" aria-modal="true" aria-label="Серверная глава">
          <header className="server-journey-header">
            <div><p className="eyebrow">Единая серверная летопись</p><h2>Пепел Княжеств</h2></div>
            <div className="server-panel-actions"><button disabled={busy} onClick={() => void refresh()} type="button">Обновить</button><button onClick={() => setOpen(false)} type="button">Социальные разделы</button></div>
          </header>

          {notice && <p className="server-notice">{notice}</p>}
          {busy && <p className="server-loading">Сервер записывает последствия…</p>}

          {authenticated === false && <div className="server-empty"><h3>Нужен аккаунт</h3><p>Гостевой пролог остаётся доступен под этим окном. Для единого героя, серверного сюжета, гильдии и общей экономики войди через раздел «Аккаунт».</p></div>}

          {authenticated && !character && <form className="server-character-create" onSubmit={(event) => {
            event.preventDefault()
            void performPlayer(() => createServerCharacter(name, profession))
          }}>
            <h3>Записать первого героя рода</h3>
            <label>Имя героя<input maxLength={24} minLength={2} onChange={(event) => setName(event.target.value)} required value={name} /></label>
            <label>Ремесло<select onChange={(event) => setProfession(event.target.value as OnlineProfession)} value={profession}>{(Object.keys(professionNames) as OnlineProfession[]).map((id) => <option key={id} value={id}>{professionNames[id]}</option>)}</select></label>
            <button className="primary-action" disabled={busy} type="submit">Выйти на северную дорогу</button>
          </form>}

          {authenticated && character && <div className="server-character">
            <div className="server-character-title">
              <div><p className="eyebrow">Поколение {character.generation}</p><h3>{character.name}</h3><span>{professionLabel}, уровень {character.level}</span></div>
              <div className={`server-life ${character.alive ? 'alive' : 'dead'}`}>{character.alive ? 'Жив' : 'Погиб'}</div>
            </div>

            <div className="server-stat-grid">
              <Meter label="Здоровье" value={character.health} max={character.maxHealth} />
              <Meter label="Силы" value={character.stamina} max={character.maxStamina} />
              <Meter label="Опыт" value={character.experience} max={character.experienceToNext} />
              <div className="server-plain-stat"><span>Монеты</span><strong>{character.coins}</strong></div>
              <div className="server-plain-stat"><span>Чутьё</span><strong>{character.insight}</strong></div>
              <div className="server-plain-stat"><span>Репутация</span><strong>{character.reputation}</strong></div>
            </div>
            <p className="server-xp-caption">До следующего уровня: {Math.max(0, 100 - experiencePercent)}% пути. Слава рода: {character.legacyGlory}.</p>

            {!character.alive && <form className="server-heir" onSubmit={(event) => {
              event.preventDefault()
              void performPlayer(() => createServerHeir(name, profession))
            }}>
              <h3>Продолжить род</h3><p>Наследник начнёт первую главу заново, сохранив славу рода и часть наследства.</p>
              <label>Имя наследника<input maxLength={24} minLength={2} onChange={(event) => setName(event.target.value)} required value={name} /></label>
              <label>Ремесло<select onChange={(event) => setProfession(event.target.value as OnlineProfession)} value={profession}>{(Object.keys(professionNames) as OnlineProfession[]).map((id) => <option key={id} value={id}>{professionNames[id]}</option>)}</select></label>
              <button className="primary-action" disabled={busy} type="submit">Создать наследника</button>
            </form>}

            {character.alive && active && <section className="server-expedition">
              <header><div><p className="eyebrow">Ход {active.turn}{story?.pendingEncounter ? ' · сюжетное столкновение' : ''}</p><h3>{active.enemyName}</h3></div><span>Намерение: {intentNames[active.enemyIntent] ?? active.enemyIntent}</span></header>
              <Meter label="Враг" value={active.enemyHealth} max={active.enemyMaxHealth} />
              <div className="server-combat-flags">{active.guard > 0 && <span>Защита: {active.guard}</span>}{active.prepared && <span>Удар подготовлен</span>}</div>
              <div className="server-combat-log">{active.lastLog.map((entry, index) => <p key={`${entry}-${index}`}>{entry}</p>)}</div>
              <div className="server-combat-actions">{(Object.keys(actionLabels) as CombatAction[]).map((action) => <button disabled={busy} key={action} onClick={() => void performPlayer(() => actInServerExpedition(active.id, action))} type="button">{actionLabels[action]}</button>)}</div>
            </section>}

            {character.alive && !active && story && <>
              <section className="server-story-quests">
                <div className="server-section-title"><div><p className="eyebrow">Вересково</p><h3>Первая глава · {completedQuests}/3</h3></div><span>{story.decisionCount} решений</span></div>
                <div className="server-quest-strip">{story.quests.map((quest) => <article className={quest.status} key={quest.id}><strong>{quest.title}</strong><small>{quest.status === 'completed' ? 'Завершён' : quest.status === 'active' ? 'Активен' : 'Доступен'}</small>{quest.outcome && <span>{quest.outcome}</span>}</article>)}</div>
              </section>

              <section className="server-story-scene">
                <p className="eyebrow">{story.scene.region}</p>
                <h3>{story.scene.title}</h3>
                <p className="server-story-text">{story.scene.text}</p>
                <div className="server-story-choices">{story.scene.choices.map((choice) => <button disabled={busy || !choice.available} key={choice.id} onClick={() => void performChoice(choice.id)} type="button"><span>{choice.label}</span>{choice.requirement && <small>{choice.requirement}</small>}</button>)}</div>
              </section>

              {story.chapterComplete && <section className="server-chapter-complete"><p className="eyebrow">Первая зола сохранена</p><h3>Глава завершена</h3><p>Все решения, исходы контрактов и состояние героя находятся в общей базе. Теперь доступны вольные контракты между сюжетными главами.</p></section>}

              {story.chapterComplete && <section className="server-contracts">
                <div className="server-section-title"><div><p className="eyebrow">После главы</p><h3>Вольные контракты</h3></div></div>
                <div className="server-contract-grid">{contracts.map((contract) => <article key={contract.id}><div><strong>{contract.title}</strong><span>Опасность {contract.difficulty}</span></div><p>{contract.description}</p><small>{contract.rewardCoins} монет, {contract.rewardExperience} опыта</small><button disabled={busy || character.stamina < 2} onClick={() => void performPlayer(() => startServerExpedition(contract.id))} type="button">Взять контракт</button></article>)}</div>
              </section>}
            </>}

            {character.alive && <section className="server-donation"><div><p className="eyebrow">Общая казна</p><h3>Внести серверные монеты</h3><p>Монеты списываются у этого героя в одной транзакции с пополнением казны.</p></div><form onSubmit={(event) => { event.preventDefault(); void performPlayer(() => donateServerCoins(Number(donation))) }}><input min="1" onChange={(event) => setDonation(event.target.value)} type="number" value={donation} /><button disabled={busy || Number(donation) < 1} type="submit">Внести</button></form></section>}

            <section className="server-inventory"><h3>Снаряжение и трофеи</h3><div>{character.inventory.length ? character.inventory.map((item) => <span key={item.id}>{item.name}{item.quantity > 1 ? ` ×${item.quantity}` : ''}</span>) : <p>Пусто</p>}</div></section>

            {story && <section className="server-story-history"><h3>Последние последствия</h3>{story.history.slice(0, 8).map((entry, index) => <p key={`${entry}-${index}`}>{entry}</p>)}</section>}
          </div>}
        </section>
      </div>}
    </>
  )
}
