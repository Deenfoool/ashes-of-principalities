import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  actInServerExpedition,
  createServerCharacter,
  createServerHeir,
  donateServerCoins,
  flushPlayerActionQueue,
  getServerCharacter,
  getServerContracts,
  PlayerApiError,
  QueuedPlayerAction,
  restServerCharacter,
  startServerExpedition,
} from './online-player'
import type {
  CombatAction,
  OnlineProfession,
  ServerCharacter,
  ServerContract,
} from './online-player'

const professionNames: Record<OnlineProfession, string> = {
  blacksmith: 'Кузнец',
  herbalist: 'Травник',
  hunter: 'Охотник',
  scribe: 'Писарь',
  carter: 'Возчик',
  wanderer: 'Странник',
}

const intentNames: Record<string, string> = {
  attack: 'Обычная атака',
  heavy: 'Тяжёлый удар',
  guard: 'Защита',
  hex: 'Проклятие',
}

const actionLabels: Record<CombatAction, string> = {
  attack: 'Атаковать',
  guard: 'Защищаться',
  prepare: 'Подготовиться',
  profession: 'Приём ремесла',
  flee: 'Отступить',
}

function Meter({ label, value, max }: { label: string; value: number; max: number }) {
  const width = `${Math.max(0, Math.min(100, max > 0 ? (value / max) * 100 : 0))}%`
  return (
    <div className="server-meter">
      <div><span>{label}</span><strong>{value}/{max}</strong></div>
      <div className="server-meter-track"><span style={{ width }} /></div>
    </div>
  )
}

function describeError(error: unknown) {
  if (error instanceof PlayerApiError || error instanceof QueuedPlayerAction) return error.message
  return 'Не удалось связаться с сервером.'
}

export default function OnlineJourney() {
  const [open, setOpen] = useState(false)
  const [character, setCharacter] = useState<ServerCharacter | null>(null)
  const [contracts, setContracts] = useState<ServerContract[]>([])
  const [authenticated, setAuthenticated] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [name, setName] = useState('')
  const [profession, setProfession] = useState<OnlineProfession>('hunter')
  const [donation, setDonation] = useState('5')

  const refresh = useCallback(async () => {
    setBusy(true)
    try {
      const [player, available] = await Promise.all([
        getServerCharacter(),
        getServerContracts(),
      ])
      setCharacter(player.character)
      setContracts(available.contracts)
      setAuthenticated(true)
    } catch (error) {
      if (error instanceof PlayerApiError && error.status === 401) {
        setAuthenticated(false)
        setCharacter(null)
      } else {
        setNotice(describeError(error))
      }
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  useEffect(() => {
    const synchronize = async () => {
      const completed = await flushPlayerActionQueue()
      if (completed > 0) {
        setNotice(`Синхронизировано действий: ${completed}.`)
        if (open) await refresh()
      }
    }
    window.addEventListener('online', synchronize)
    void synchronize()
    return () => window.removeEventListener('online', synchronize)
  }, [open, refresh])

  const perform = async (operation: () => Promise<{ character: ServerCharacter }>) => {
    setBusy(true)
    setNotice('')
    try {
      const result = await operation()
      setCharacter(result.character)
    } catch (error) {
      setNotice(describeError(error))
      if (error instanceof QueuedPlayerAction) {
        window.setTimeout(() => void refresh(), 1500)
      }
    } finally {
      setBusy(false)
    }
  }

  const active = character?.activeExpedition
  const professionLabel = character ? professionNames[character.profession] : ''
  const canRest = Boolean(character?.alive && !active && character.coins >= 2)
  const experiencePercent = useMemo(() => {
    if (!character || character.experienceToNext <= 0) return 0
    return Math.round((character.experience / character.experienceToNext) * 100)
  }, [character])

  return (
    <>
      <button
        className={`server-journey-toggle ${character?.activeExpedition ? 'active-run' : ''}`}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        {character?.activeExpedition ? 'Поход идёт' : 'Серверный герой'}
      </button>

      {open && (
        <div className="server-journey-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setOpen(false)
        }}>
          <section className="server-journey-panel" role="dialog" aria-modal="true" aria-label="Серверный герой">
            <header className="server-journey-header">
              <div>
                <p className="eyebrow">Серверная летопись</p>
                <h2>Герой аккаунта</h2>
              </div>
              <div className="server-panel-actions">
                <button disabled={busy} onClick={() => void refresh()} type="button">Обновить</button>
                <button onClick={() => setOpen(false)} type="button">Закрыть</button>
              </div>
            </header>

            {notice && <p className="server-notice">{notice}</p>}
            {busy && <p className="server-loading">Сверяем летопись с сервером…</p>}

            {authenticated === false && (
              <div className="server-empty">
                <h3>Нужен аккаунт</h3>
                <p>Одиночная глава доступна без входа, но серверный герой и общая экономика требуют авторизации.</p>
                <p>Открой раздел аккаунта в основной игре, зарегистрируйся или войди, затем нажми «Обновить».</p>
              </div>
            )}

            {authenticated && !character && (
              <form className="server-character-create" onSubmit={(event) => {
                event.preventDefault()
                void perform(() => createServerCharacter(name, profession))
              }}>
                <h3>Записать первого героя рода</h3>
                <label>
                  Имя героя
                  <input
                    maxLength={24}
                    minLength={2}
                    onChange={(event) => setName(event.target.value)}
                    required
                    value={name}
                  />
                </label>
                <label>
                  Ремесло
                  <select onChange={(event) => setProfession(event.target.value as OnlineProfession)} value={profession}>
                    {(Object.keys(professionNames) as OnlineProfession[]).map((id) => (
                      <option key={id} value={id}>{professionNames[id]}</option>
                    ))}
                  </select>
                </label>
                <button className="primary-action" disabled={busy} type="submit">Создать героя</button>
              </form>
            )}

            {authenticated && character && (
              <div className="server-character">
                <div className="server-character-title">
                  <div>
                    <p className="eyebrow">Поколение {character.generation}</p>
                    <h3>{character.name}</h3>
                    <span>{professionLabel}, уровень {character.level}</span>
                  </div>
                  <div className={`server-life ${character.alive ? 'alive' : 'dead'}`}>
                    {character.alive ? 'Жив' : 'Погиб'}
                  </div>
                </div>

                <div className="server-stat-grid">
                  <Meter label="Здоровье" value={character.health} max={character.maxHealth} />
                  <Meter label="Силы" value={character.stamina} max={character.maxStamina} />
                  <Meter label="Опыт" value={character.experience} max={character.experienceToNext} />
                  <div className="server-plain-stat"><span>Монеты</span><strong>{character.coins}</strong></div>
                  <div className="server-plain-stat"><span>Чутьё</span><strong>{character.insight}</strong></div>
                  <div className="server-plain-stat"><span>Слава рода</span><strong>{character.legacyGlory}</strong></div>
                </div>
                <p className="server-xp-caption">До следующего уровня: {100 - experiencePercent}% пути.</p>

                {!character.alive && (
                  <form className="server-heir" onSubmit={(event) => {
                    event.preventDefault()
                    void perform(() => createServerHeir(name, profession))
                  }}>
                    <h3>Продолжить род</h3>
                    <p>Погибших: {character.deaths}. Часть славы превратится в начальное наследство.</p>
                    <label>
                      Имя наследника
                      <input
                        maxLength={24}
                        minLength={2}
                        onChange={(event) => setName(event.target.value)}
                        required
                        value={name}
                      />
                    </label>
                    <label>
                      Новое ремесло
                      <select onChange={(event) => setProfession(event.target.value as OnlineProfession)} value={profession}>
                        {(Object.keys(professionNames) as OnlineProfession[]).map((id) => (
                          <option key={id} value={id}>{professionNames[id]}</option>
                        ))}
                      </select>
                    </label>
                    <button className="primary-action" disabled={busy} type="submit">Создать наследника</button>
                  </form>
                )}

                {character.alive && active && (
                  <section className="server-expedition">
                    <header>
                      <div>
                        <p className="eyebrow">Ход {active.turn}</p>
                        <h3>{active.enemyName}</h3>
                      </div>
                      <span>Намерение: {intentNames[active.enemyIntent] ?? active.enemyIntent}</span>
                    </header>
                    <Meter label="Враг" value={active.enemyHealth} max={active.enemyMaxHealth} />
                    <div className="server-combat-flags">
                      {active.guard > 0 && <span>Защита: {active.guard}</span>}
                      {active.prepared && <span>Удар подготовлен</span>}
                    </div>
                    <div className="server-combat-log">
                      {active.lastLog.map((entry, index) => <p key={`${entry}-${index}`}>{entry}</p>)}
                    </div>
                    <div className="server-combat-actions">
                      {(Object.keys(actionLabels) as CombatAction[]).map((action) => (
                        <button
                          disabled={busy}
                          key={action}
                          onClick={() => void perform(() => actInServerExpedition(active.id, action))}
                          type="button"
                        >
                          {actionLabels[action]}
                        </button>
                      ))}
                    </div>
                  </section>
                )}

                {character.alive && !active && (
                  <>
                    <section className="server-contracts">
                      <div className="server-section-title">
                        <div><p className="eyebrow">Контракты</p><h3>Выбрать поход</h3></div>
                        <button disabled={!canRest || busy} onClick={() => void perform(restServerCharacter)} type="button">
                          Ночлег за 2 монеты
                        </button>
                      </div>
                      <div className="server-contract-grid">
                        {contracts.map((contract) => (
                          <article key={contract.id}>
                            <div><strong>{contract.title}</strong><span>Опасность {contract.difficulty}</span></div>
                            <p>{contract.description}</p>
                            <small>{contract.rewardCoins} монет, {contract.rewardExperience} опыта</small>
                            <button
                              disabled={busy || character.stamina < 2}
                              onClick={() => void perform(() => startServerExpedition(contract.id))}
                              type="button"
                            >
                              Взять контракт
                            </button>
                          </article>
                        ))}
                      </div>
                    </section>

                    <section className="server-donation">
                      <div>
                        <p className="eyebrow">Общая казна</p>
                        <h3>Внести свои монеты</h3>
                        <p>Сервер сначала списывает монеты героя и только затем увеличивает казну. Повтор запроса не удвоит взнос.</p>
                      </div>
                      <form onSubmit={(event) => {
                        event.preventDefault()
                        const amount = Number(donation)
                        void perform(() => donateServerCoins(amount))
                      }}>
                        <input
                          min={1}
                          onChange={(event) => setDonation(event.target.value)}
                          step={1}
                          type="number"
                          value={donation}
                        />
                        <button disabled={busy || Number(donation) <= 0} type="submit">Внести</button>
                      </form>
                    </section>
                  </>
                )}

                <section className="server-inventory">
                  <h3>Серверный инвентарь</h3>
                  {character.inventory.length === 0 ? <p>Пусто.</p> : (
                    <div>
                      {character.inventory.map((item) => (
                        <span key={item.id}>{item.name}{item.quantity > 1 ? ` ×${item.quantity}` : ''}</span>
                      ))}
                    </div>
                  )}
                </section>
              </div>
            )}
          </section>
        </div>
      )}
    </>
  )
}
