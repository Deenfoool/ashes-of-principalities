import { useCallback, useEffect, useMemo, useState } from 'react'
import { craftServerRecipe, getCraftingWorkshop } from './online-crafting'
import type { CraftingRecipe, CraftingWorkshop } from './online-crafting'
import type { SurvivalCharacter } from './online-survival'

const professionLabels: Record<string, string> = {
  blacksmith: 'Кузнец',
  herbalist: 'Травник',
  hunter: 'Охотник',
  scribe: 'Писарь',
  carter: 'Возчик',
  wanderer: 'Странник',
}

function RecipeCard({ recipe, busy, onCraft }: { recipe: CraftingRecipe; busy: boolean; onCraft: () => void }) {
  return <article className={`craft-recipe ${recipe.available ? 'available' : 'locked'}`}>
    <header>
      <div><strong>{recipe.title}</strong><span>{recipe.result}</span></div>
      <small>Уровень {recipe.minLevel}{recipe.professions ? ` · ${recipe.professions.map((id) => professionLabels[id] ?? id).join(', ')}` : ' · любое ремесло'}</small>
    </header>
    <p>{recipe.description}</p>
    <div className="craft-costs">
      {recipe.ingredients.map((ingredient) => <span key={ingredient.id}>{ingredient.name} ×{ingredient.quantity}</span>)}
      {recipe.coins > 0 && <span>{recipe.coins} монет</span>}
    </div>
    <button disabled={busy || !recipe.available} onClick={onCraft} type="button">
      {recipe.available ? 'Изготовить' : recipe.reason ?? 'Недоступно'}
    </button>
  </article>
}

export default function UnifiedCrafting({
  character,
  onCharacter,
}: {
  character: SurvivalCharacter | null
  onCharacter: (character: SurvivalCharacter) => void
}) {
  const [workshop, setWorkshop] = useState<CraftingWorkshop | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [filter, setFilter] = useState<'profession' | 'available' | 'all'>('profession')

  const refresh = useCallback(async () => {
    if (!character) return
    setBusy(true)
    try {
      const next = await getCraftingWorkshop()
      setWorkshop(next)
      onCharacter(next.character)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Мастерская не ответила.')
    } finally {
      setBusy(false)
    }
  }, [character?.userId, onCharacter])

  useEffect(() => { void refresh() }, [refresh, character?.updatedAt])

  const visibleRecipes = useMemo(() => {
    if (!workshop || !character) return []
    if (filter === 'available') return workshop.recipes.filter((recipe) => recipe.available)
    if (filter === 'profession') {
      return workshop.recipes.filter((recipe) => !recipe.professions || recipe.professions.includes(character.profession))
    }
    return workshop.recipes
  }, [workshop, character, filter])

  const craft = async (recipeId: string) => {
    setBusy(true)
    setMessage('')
    try {
      const next = await craftServerRecipe(recipeId)
      setWorkshop(next)
      onCharacter(next.character)
      setMessage(next.crafted?.result ?? 'Работа завершена.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Не удалось завершить работу.')
    } finally {
      setBusy(false)
    }
  }

  if (!character) return <section className="u-panel"><h2>Сначала создай героя</h2><p>Мастерская использует ремесло, уровень и серверный инвентарь героя.</p></section>
  if (!workshop) return <section className="u-panel"><h2>Открываем мастерскую</h2><p>{busy ? 'Сверяем инструменты и запасы…' : message || 'Данные ещё не получены.'}</p><button onClick={() => void refresh()} type="button">Повторить</button></section>

  const ward = workshop.effects.find((effect) => effect.id === 'path-ward')
  return <div className="u-stack crafting-shell">
    <section className="u-panel crafting-overview">
      <header className="u-section-head">
        <div><p className="eyebrow">Ремесло меняет доступные действия</p><h2>Мастерская: {professionLabels[character.profession]}</h2></div>
        <button disabled={busy} onClick={() => void refresh()} type="button">Обновить</button>
      </header>
      {!workshop.safe && <p className="u-notice error">Работа разрешена только в трактире или после завершения первой главы.</p>}
      {message && <p className="u-notice">{message}</p>}
      <div className="craft-summary">
        <article><span>Монеты</span><strong>{character.coins}</strong></article>
        <article><span>Запасы</span><strong>{workshop.supplies.reduce((sum, item) => sum + item.quantity, 0)}</strong></article>
        <article><span>Изготовлено</span><strong>{workshop.history.length}</strong></article>
        <article><span>Обереги пути</span><strong>{ward?.charges ?? 0}/3</strong></article>
      </div>
    </section>

    <section className="u-panel">
      <p className="eyebrow">Подтверждённая добыча</p><h2>Материалы и заготовки</h2>
      {workshop.supplies.length === 0 ? <p className="u-empty">Материалов пока нет. Побеждай в серверных контрактах: разные противники дают разное сырьё.</p> : <div className="craft-supplies">{workshop.supplies.map((item) => <article key={item.id}><span>{item.type === 'material' ? 'Материал' : 'Заготовка'}</span><strong>{item.name}</strong><b>×{item.quantity}</b></article>)}</div>}
    </section>

    <section className="u-panel">
      <header className="u-section-head">
        <div><p className="eyebrow">Сервер проверяет каждый расход</p><h2>Рецепты</h2></div>
        <div className="craft-filters">
          <button className={filter === 'profession' ? 'active' : ''} onClick={() => setFilter('profession')} type="button">Моё ремесло</button>
          <button className={filter === 'available' ? 'active' : ''} onClick={() => setFilter('available')} type="button">Доступные</button>
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')} type="button">Все</button>
        </div>
      </header>
      <div className="craft-recipes">{visibleRecipes.map((recipe) => <RecipeCard busy={busy} key={recipe.id} onCraft={() => void craft(recipe.id)} recipe={recipe} />)}</div>
    </section>

    <section className="u-panel">
      <p className="eyebrow">Последние двадцать работ</p><h2>Журнал мастерской</h2>
      {workshop.history.length === 0 ? <p className="u-empty">Записей пока нет.</p> : <div className="craft-history">{workshop.history.map((entry) => <p key={entry.id}><span>{entry.result}</span><time>{new Date(entry.createdAt).toLocaleString('ru-RU')}</time></p>)}</div>}
    </section>
  </div>
}
