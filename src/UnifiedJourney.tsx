import { useEffect, useMemo, useState } from 'react'
import type { CombatAction, ContractRotation, ExpeditionTactic, OnlineProfession, ServerContract, ServerEnemy } from './online-player'
import type { MarshStory } from './online-marsh-story'
import type { ServerStory } from './online-story'
import type { SurvivalCharacter } from './online-survival'
import type { RegionalBoss } from './online-v013'

const professionNames: Record<OnlineProfession, string> = {
  blacksmith: 'Кузнец', herbalist: 'Травник', hunter: 'Охотник',
  scribe: 'Писарь', carter: 'Возчик', wanderer: 'Странник',
}

const intentNames: Record<string, string> = {
  attack: 'обычная атака', heavy: 'тяжёлый удар', guard: 'защита', hex: 'проклятие',
}

const roleNames: Record<string, string> = {
  brute: 'громила', controller: 'контроль прохода', ranged: 'дальний бой',
  skirmisher: 'маневренный', boss: 'региональный босс',
}

const actionLabels: Record<CombatAction, string> = {
  attack: 'Атаковать', guard: 'Защищаться', prepare: 'Подготовиться', profession: 'Приём ремесла',
  flee: 'Покинуть бой', advance: 'Сблизиться', retreat: 'Отойти', climb: 'Подняться', descend: 'Спуститься',
}

const distanceName = (distance = 0) => distance <= 0 ? 'вплотную' : distance === 1 ? 'средняя' : distance === 2 ? 'дальняя' : 'предельная'
const elevationName = (value = 0) => value <= 0 ? 'низина' : value === 1 ? 'возвышение' : 'верхний ярус'

function Meter({ label, value, max }: { label: string; value: number; max: number }) {
  const width = `${Math.max(0, Math.min(100, max > 0 ? value / max * 100 : 0))}%`
  return <div className="u-meter"><div><span>{label}</span><strong>{value}/{max}</strong></div><div><span style={{ width }} /></div></div>
}

function CharacterCreation({ busy, heir, onCreate }: {
  busy: boolean
  heir: boolean
  onCreate: (name: string, profession: OnlineProfession) => void
}) {
  const [name, setName] = useState('')
  const [profession, setProfession] = useState<OnlineProfession>('hunter')
  return <form className="u-panel u-create" onSubmit={(event) => { event.preventDefault(); onCreate(name, profession) }}>
    <p className="eyebrow">{heir ? 'Род не заканчивается одной смертью' : 'Первое имя в летописи'}</p>
    <h2>{heir ? 'Создать наследника' : 'Создать героя'}</h2>
    <label>Имя<input maxLength={24} minLength={2} onChange={(event) => setName(event.target.value)} required value={name} /></label>
    <label>Ремесло<select onChange={(event) => setProfession(event.target.value as OnlineProfession)} value={profession}>{(Object.keys(professionNames) as OnlineProfession[]).map((id) => <option key={id} value={id}>{professionNames[id]}</option>)}</select></label>
    <button disabled={busy || name.trim().length < 2} type="submit">{heir ? 'Продолжить род' : 'Выйти на дорогу'}</button>
  </form>
}

function EnemyCard({ enemy, selected, busy, onSelect }: {
  enemy: ServerEnemy
  selected: boolean
  busy: boolean
  onSelect: () => void
}) {
  return <button className={`v13-enemy ${selected ? 'selected' : ''} ${enemy.defeated ? 'defeated' : ''}`} disabled={busy || enemy.defeated} onClick={onSelect} type="button">
    <div><strong>{enemy.name}</strong><span>{roleNames[enemy.role] ?? enemy.role}</span></div>
    <Meter label="Здоровье" value={enemy.health} max={enemy.maxHealth} />
    <small>{distanceName(enemy.distance)} · {elevationName(enemy.elevation)} · {intentNames[enemy.intent] ?? enemy.intent}</small>
    {enemy.zonePower > 0 && <small>Зона контроля: {enemy.zonePower}</small>}
  </button>
}

function CombatView({ character, story, marshStory, busy, onCombat, onTactic }: {
  character: SurvivalCharacter
  story: ServerStory | null
  marshStory: MarshStory | null
  busy: boolean
  onCombat: (action: CombatAction, targetId?: string) => void
  onTactic: (tactic: ExpeditionTactic) => void
}) {
  const active = character.activeExpedition!
  const living = (active.enemies ?? []).filter((enemy) => !enemy.defeated)
  const [targetId, setTargetId] = useState(active.targetEnemyId ?? living[0]?.id ?? '')
  useEffect(() => {
    if (!living.some((enemy) => enemy.id === targetId)) setTargetId(active.targetEnemyId ?? living[0]?.id ?? '')
  }, [active.targetEnemyId, living, targetId])

  const positionalActions: CombatAction[] = active.positional
    ? ['attack', 'guard', 'prepare', 'profession', 'advance', 'retreat', 'climb', 'descend', 'flee']
    : ['attack', 'guard', 'prepare', 'profession', 'flee']
  const distance = Number(active.distance ?? 0)
  const maxDistance = Number(active.maxDistance ?? 0)
  const elevation = Number(active.heroElevation ?? 0)
  const maxElevation = Number(active.maxElevation ?? 0)
  const storyEncounter = Boolean(story?.pendingEncounter || marshStory?.pendingEncounter)
  const grouped = active.encounterType === 'group' || active.encounterType === 'boss'

  return <section className="u-panel u-combat marsh-combat v13-combat">
    <header className="u-section-head">
      <div><p className="eyebrow">Ход {active.turn}{storyEncounter ? ' · сюжет' : ''}{active.bossPhase ? ` · фаза ${active.bossPhase}` : ''}</p><h2>{active.enemyName}</h2></div>
      <span>{grouped ? `${living.length} активных целей` : `Намерение: ${intentNames[active.enemyIntent] ?? active.enemyIntent}`}</span>
    </header>
    <Meter label={grouped ? 'Сила отряда' : 'Враг'} value={active.enemyHealth} max={active.enemyMaxHealth} />

    {grouped && <div className="v13-enemy-grid">{(active.enemies ?? []).map((enemy) => <EnemyCard busy={busy} enemy={enemy} key={enemy.id} onSelect={() => setTargetId(enemy.id)} selected={enemy.id === targetId} />)}</div>}

    {active.positional && <div className="marsh-position v13-position">
      <div><span>Регион</span><strong>{active.regionName ?? active.regionId}</strong></div>
      <div><span>Местность</span><strong>{active.terrainName ?? active.terrainId}</strong></div>
      <div><span>{grouped ? 'Ближайшая цель' : 'Дистанция'}</span><strong>{distanceName(distance)}</strong></div>
      <div><span>Высота героя</span><strong>{elevationName(elevation)}</strong></div>
      <div><span>Зона контроля</span><strong>{active.zoneControl ?? 0}</strong></div>
      <div className="marsh-distance-track" aria-label={`Дистанция: ${distanceName(distance)}`}>{Array.from({ length: maxDistance + 1 }, (_, index) => <span className={index === distance ? 'active' : ''} key={index}>{index}</span>)}</div>
      <div className="v13-height-track" aria-label={`Высота: ${elevationName(elevation)}`}>{Array.from({ length: maxElevation + 1 }, (_, index) => <span className={index === elevation ? 'active' : ''} key={index}>{index}</span>)}</div>
    </div>}

    <div className="u-combat-flags">
      {active.guard > 0 && <span>Защита {active.guard}</span>}
      {active.prepared && <span>Удар подготовлен</span>}
      {active.complication && <span>{active.complication}</span>}
      {(character.armorRating ?? 0) > 0 && <span>Броня {character.armorRating}</span>}
      {character.equippedItem?.broken && <span className="danger">Оружие или инструмент сломан</span>}
      {character.injuries.map((injury) => <span className="danger" key={injury.id}>{injury.title}</span>)}
    </div>
    <div className="u-combat-log">{active.lastLog.map((entry, index) => <p key={`${entry}-${index}`}>{entry}</p>)}</div>
    <div className="u-action-grid">{positionalActions.map((action) => {
      const blockedByHeight = action === 'climb' && elevation >= maxElevation || action === 'descend' && elevation <= 0
      const broken = action === 'profession' && Boolean(character.equippedItem?.broken)
      const needsTarget = grouped && ['attack', 'profession'].includes(action) && !targetId
      return <button disabled={busy || blockedByHeight || broken || needsTarget} key={action} onClick={() => onCombat(action, grouped ? targetId : undefined)} type="button">{actionLabels[action]}</button>
    })}</div>
    {active.tactics && active.tactics.length > 0 && <div className="marsh-tactics">
      <div><p className="eyebrow">Полевая подготовка</p><h3>Укрытия и ловушки</h3></div>
      {active.tactics.map((tactic) => <button disabled={busy || !tactic.available} key={tactic.id} onClick={() => onTactic(tactic.id)} title={tactic.reason} type="button"><strong>{tactic.label}</strong><small>{tactic.reason}</small></button>)}
    </div>}
  </section>
}

function FirstChapter({ story, busy, onChoice }: { story: ServerStory; busy: boolean; onChoice: (id: string) => void }) {
  const complete = story.quests.filter((quest) => quest.status === 'completed').length
  return <div className="u-stack"><section className="u-panel"><header className="u-section-head"><div><p className="eyebrow">{story.scene.region}</p><h2>{story.scene.title}</h2></div><span>{complete}/3 контрактов · {story.decisionCount} решений</span></header><p className="u-story-text">{story.scene.text}</p><div className="u-choice-list">{story.scene.choices.map((choice) => <button disabled={busy || !choice.available} key={choice.id} onClick={() => onChoice(choice.id)} type="button"><span>{choice.label}</span>{choice.requirement && <small>{choice.requirement}</small>}</button>)}</div></section><section className="u-panel"><p className="eyebrow">След решений</p><h2>Контракты первой главы</h2><div className="u-quest-grid">{story.quests.map((quest) => <article className={quest.status} key={quest.id}><strong>{quest.title}</strong><p>{quest.summary}</p><small>{quest.status === 'completed' ? `Итог: ${quest.outcome}` : quest.status === 'active' ? 'Активен' : 'Доступен'}</small></article>)}</div></section></div>
}

function MarshChapter({ marshStory, busy, onChoice }: { marshStory: MarshStory; busy: boolean; onChoice: (id: string) => void }) {
  if (!marshStory.available || !marshStory.scene) return null
  const quests = marshStory.quests ?? []
  const complete = quests.filter((quest) => quest.status === 'completed').length
  return <div className="u-stack marsh-chapter"><section className="u-panel marsh-story-panel"><header className="u-section-head"><div><p className="eyebrow">Вторая глава · {marshStory.scene.region}</p><h2>{marshStory.scene.title}</h2></div><span>{complete}/3 расследований · {marshStory.decisionCount ?? 0} решений</span></header><p className="u-story-text">{marshStory.scene.text}</p><div className="u-choice-list">{marshStory.scene.choices.map((choice) => <button disabled={busy || !choice.available} key={choice.id} onClick={() => onChoice(choice.id)} type="button"><span>{choice.label}</span>{choice.requirement && <small>{choice.requirement}</small>}</button>)}</div>{marshStory.chapterComplete && <p className="marsh-ending">Итог главы: {marshStory.ending ?? 'решение принято'}</p>}</section>{marshStory.started && <section className="u-panel"><p className="eyebrow">Долги белой воды</p><h2>Расследования Соляных топей</h2><div className="u-quest-grid">{quests.map((quest) => <article className={quest.status} key={quest.id}><strong>{quest.title}</strong><p>{quest.summary}</p><small>{quest.status === 'completed' ? `Итог: ${quest.outcome}` : quest.status === 'active' ? 'Активно' : 'Доступно'}</small></article>)}</div></section>}</div>
}

function BossPanel({ boss, character, busy, onStart }: { boss: RegionalBoss | null; character: SurvivalCharacter; busy: boolean; onStart: () => void }) {
  if (!boss) return null
  return <section className="u-panel v13-boss-panel">
    <header className="u-section-head"><div><p className="eyebrow">Первый региональный босс</p><h2>{boss.title}</h2></div><span>Опасность {boss.difficulty}</span></header>
    <p>{boss.description}</p>
    <div className="v13-boss-facts"><span>Рекомендуемый уровень: {boss.recommendedLevel}</span><span>Попыток: {boss.attempts}</span><span>Побед: {boss.victories}</span><span>Первая награда: {boss.firstReward}</span></div>
    {boss.cooldownEndsAt && boss.cooldownEndsAt > Date.now() && <small>Следующий вызов: {new Date(boss.cooldownEndsAt).toLocaleString('ru-RU')}</small>}
    <button disabled={busy || !boss.available || character.stamina < 4} onClick={onStart} title={boss.requirement ?? ''} type="button">{boss.victories > 0 ? 'Снова войти в колокольню' : 'Вызвать Глухобора'}</button>
    {!boss.available && boss.requirement && <p className="u-empty">{boss.requirement}</p>}
  </section>
}

function RegionContracts({ rotation, character, contracts, busy, onStart }: { rotation: ContractRotation; character: SurvivalCharacter; contracts: ServerContract[]; busy: boolean; onStart: (id: string) => void }) {
  const grouped = useMemo(() => rotation.regions.map((region) => ({ region, contracts: contracts.filter((contract) => contract.regionId === region.id) })), [rotation.regions, contracts])
  return <div className="u-stack"><section className="u-panel marsh-map-panel"><header className="u-section-head"><div><p className="eyebrow">Карта свободных дорог</p><h2>Области</h2></div>{rotation.rotationEndsAt && <span>Новая ротация: {new Date(rotation.rotationEndsAt).toLocaleString('ru-RU')}</span>}</header><div className="marsh-region-grid">{grouped.map(({ region }) => <article className={region.unlocked ? 'unlocked' : 'locked'} key={region.id}><div><strong>{region.name}</strong><span>{region.unlocked ? `Побед: ${region.victories}` : 'Закрыто'}</span></div><p>{region.description}</p><small>{region.unlocked ? region.unlock : region.requirement}</small></article>)}</div></section>{grouped.filter(({ region }) => region.unlocked).map(({ region, contracts: offers }) => <section className="u-panel" key={region.id}><p className="eyebrow">{region.name}</p><h2>Суточные контракты</h2>{offers.length === 0 ? <p className="u-empty">Действующих предложений нет.</p> : <div className="u-contract-grid">{offers.map((contract) => <article key={contract.id}><div><strong>{contract.title}</strong><span>Опасность {contract.difficulty}</span></div><p>{contract.description}</p><small>{contract.terrainName} · старт: {distanceName(contract.initialDistance)} · {contract.rewardCoins} монет · {contract.rewardExperience} опыта</small><button disabled={busy || character.stamina < 2} onClick={() => onStart(contract.id)} type="button">Взять контракт</button></article>)}</div>}</section>)}</div>
}

export default function UnifiedJourney({
  character, story, marshStory, rotation, boss, busy,
  onChoice, onMarshChoice, onCombat, onTactic, onStart, onStartBoss, onCreate, onHeir,
}: {
  character: SurvivalCharacter | null
  story: ServerStory | null
  marshStory: MarshStory | null
  rotation: ContractRotation
  boss: RegionalBoss | null
  busy: boolean
  onChoice: (choiceId: string) => void
  onMarshChoice: (choiceId: string) => void
  onCombat: (action: CombatAction, targetId?: string) => void
  onTactic: (tactic: ExpeditionTactic) => void
  onStart: (contractId: string) => void
  onStartBoss: () => void
  onCreate: (name: string, profession: OnlineProfession) => void
  onHeir: (name: string, profession: OnlineProfession) => void
}) {
  if (!character) return <CharacterCreation busy={busy} heir={false} onCreate={onCreate} />
  if (!character.alive) return <CharacterCreation busy={busy} heir onCreate={onHeir} />
  if (character.activeExpedition) return <CombatView busy={busy} character={character} marshStory={marshStory} onCombat={onCombat} onTactic={onTactic} story={story} />
  if (!story) return <section className="u-panel"><h2>Летопись ещё не создана</h2><p>Обнови страницу или повтори подключение.</p></section>
  if (!story.chapterComplete) return <FirstChapter busy={busy} onChoice={onChoice} story={story} />
  return <div className="u-stack">
    {marshStory && <MarshChapter busy={busy} marshStory={marshStory} onChoice={onMarshChoice} />}
    {marshStory?.chapterComplete && <BossPanel boss={boss} busy={busy} character={character} onStart={onStartBoss} />}
    <RegionContracts busy={busy} character={character} contracts={rotation.contracts} onStart={onStart} rotation={rotation} />
  </div>
}
