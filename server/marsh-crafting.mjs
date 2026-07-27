import { StoreError } from './store.mjs'

export const marshMaterialDefinitions = {
  'salt-moss': { name: 'Соляной мох', description: 'Мягкий мох, вытягивающий соль и жар из повреждённой кожи.' },
  'black-reed': { name: 'Чёрный тростник', description: 'Жёсткий стебель для ловушек, экранов и болотной оснастки.' },
  'brine-crystal': { name: 'Рассольный кристалл', description: 'Хрупкая соль, напитанная холодом мёртвой воды.' },
  'drowned-brass': { name: 'Утопленная бронза', description: 'Зелёная бронза со звонниц и лодочных оберегов.' },
}

const regionalDrops = {
  'cinder-hound': [
    { id: 'burnt-hide', name: 'Обожжённая шкура', quantity: 2 },
    { id: 'charcoal', name: 'Древесный уголь', quantity: 1 },
  ],
  'road-cutthroat': [
    { id: 'scrap-iron', name: 'Лом железа', quantity: 2 },
    { id: 'cloth', name: 'Грубая ткань', quantity: 1 },
  ],
  'grave-crow': [
    { id: 'cloth', name: 'Грубая ткань', quantity: 1 },
    { id: 'charcoal', name: 'Древесный уголь', quantity: 2 },
  ],
  'brine-wight': [
    { id: 'brine-crystal', name: 'Рассольный кристалл', quantity: 2 },
    { id: 'salt-moss', name: 'Соляной мох', quantity: 1 },
  ],
  'reed-stalker': [
    { id: 'black-reed', name: 'Чёрный тростник', quantity: 2 },
    { id: 'salt-moss', name: 'Соляной мох', quantity: 1 },
  ],
  'bell-drowner': [
    { id: 'drowned-brass', name: 'Утопленная бронза', quantity: 1 },
    { id: 'brine-crystal', name: 'Рассольный кристалл', quantity: 2 },
  ],
}

const recipes = [
  {
    id: 'salt-poultice', title: 'Соляная припарка',
    description: 'Мох и ткань вытягивают рассол, жар и болотную грязь из раны.',
    professions: ['herbalist'], minLevel: 2,
    ingredients: { 'salt-moss': 2, cloth: 1 }, coins: 0,
    kind: 'stack', output: { id: 'salt-poultice', name: 'Соляная припарка', quantity: 2 },
  },
  {
    id: 'apply-salt-poultice', title: 'Обработать болотную травму',
    description: 'Уменьшает тяжесть соляного ожога, лихорадки или глубокого пореза.',
    professions: null, minLevel: 1,
    ingredients: { 'salt-poultice': 1 }, coins: 0, kind: 'marsh-remedy',
  },
  {
    id: 'reed-snare', title: 'Тростниковая петля',
    description: 'Лёгкая ловушка, которую можно поставить прямо во время позиционного боя.',
    professions: ['hunter'], minLevel: 2,
    ingredients: { 'black-reed': 2, 'scrap-iron': 1 }, coins: 1,
    kind: 'stack', output: { id: 'reed-snare', name: 'Тростниковая петля', quantity: 1 },
  },
  {
    id: 'reed-screen', title: 'Складной тростниковый экран',
    description: 'Переносное укрытие для открытой гати и соляного поля.',
    professions: ['carter'], minLevel: 2,
    ingredients: { 'black-reed': 3, cloth: 1 }, coins: 1,
    kind: 'stack', output: { id: 'reed-screen', name: 'Тростниковый экран', quantity: 1 },
  },
  {
    id: 'marsh-sigil', title: 'Знак тихой воды',
    description: 'Следующий поход в топи начинается с двух единиц защиты.',
    professions: ['scribe'], minLevel: 3,
    ingredients: { 'drowned-brass': 1, charcoal: 2 }, coins: 2,
    kind: 'stack', output: { id: 'marsh-sigil', name: 'Знак тихой воды', quantity: 1 },
  },
  {
    id: 'marsh-cordage', title: 'Болотная верёвка',
    description: 'Первое движение в топях возвращает одну потраченную силу.',
    professions: ['wanderer'], minLevel: 2,
    ingredients: { 'black-reed': 2, 'burnt-hide': 1 }, coins: 0,
    kind: 'stack', output: { id: 'marsh-cordage', name: 'Болотная верёвка', quantity: 2 },
  },
  {
    id: 'brine-spikes', title: 'Закалённые рассолом шипы',
    description: 'Усиливают тростниковую ловушку и удерживают тяжёлого противника.',
    professions: ['blacksmith'], minLevel: 3,
    ingredients: { 'brine-crystal': 2, 'scrap-iron': 2 }, coins: 2,
    kind: 'stack', output: { id: 'brine-spikes', name: 'Рассольные шипы', quantity: 1 },
  },
]

const recipeById = Object.fromEntries(recipes.map((recipe) => [recipe.id, recipe]))

const ingredientNames = {
  ...Object.fromEntries(Object.entries(marshMaterialDefinitions).map(([id, item]) => [id, item.name])),
  cloth: 'Грубая ткань',
  charcoal: 'Древесный уголь',
  'scrap-iron': 'Лом железа',
  'burnt-hide': 'Обожжённая шкура',
  'salt-poultice': 'Соляная припарка',
}

function publicRecipe(recipe, reason) {
  return {
    id: recipe.id,
    title: recipe.title,
    description: recipe.description,
    professions: recipe.professions,
    minLevel: recipe.minLevel,
    ingredients: Object.entries(recipe.ingredients).map(([id, quantity]) => ({
      id, name: ingredientNames[id] ?? id, quantity,
    })),
    coins: recipe.coins,
    result: recipe.output
      ? `${recipe.output.name} ×${recipe.output.quantity}`
      : 'Тяжесть болотной травмы −1',
    available: !reason,
    reason,
  }
}

export function installMarshCrafting(gameStore, players, crafting) {
  const db = gameStore.db
  if (crafting.__marshCraftingInstalled) return
  crafting.__marshCraftingInstalled = true

  const claimRegionalMaterials = (userId, expeditionId) => {
    const expedition = db.prepare(`
      SELECT id, user_id, enemy_id, region_id, status FROM player_expeditions
      WHERE id = ? AND user_id = ?
    `).get(expeditionId, userId)
    if (!expedition || expedition.status !== 'won' || !expedition.region_id) return []
    const drops = regionalDrops[expedition.enemy_id] ?? []
    if (drops.length === 0) return []
    const guild = gameStore.getGuildForUser(userId)
    const foragingBonus = Math.floor((Number(guild?.branches?.foraging ?? 0) + 1) / 2)
    const awarded = []
    gameStore.transaction(() => {
      drops.forEach((drop, index) => {
        const quantity = drop.quantity + (index === 0 ? foragingBonus : 0)
        const claimId = `${drop.id}:region`
        const result = db.prepare(`
          INSERT OR IGNORE INTO player_material_claims(expedition_id, item_id, user_id, quantity, claimed_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(expedition.id, claimId, userId, quantity, Date.now())
        if (Number(result.changes) < 1) return
        crafting.addStack(userId, drop.id, drop.name, quantity, 'material')
        awarded.push({ id: drop.id, name: drop.name, quantity })
      })
    })
    return awarded
  }

  const originalAct = players.actExpedition.bind(players)
  players.actExpedition = (userId, input) => {
    const result = originalAct(userId, input)
    claimRegionalMaterials(userId, String(input.expeditionId ?? ''))
    return { ...result, character: players.getCharacter(userId) }
  }

  const originalWorkshop = crafting.workshop.bind(crafting)
  const originalCraft = crafting.craft.bind(crafting)

  const reasonFor = (userId, recipe, character, inventory) => {
    if (!character) return 'Сначала создай героя.'
    if (!character.alive) return 'Погибший герой не может работать.'
    const safe = crafting.safeWorkshopReason(userId)
    if (safe) return safe
    if (recipe.professions && !recipe.professions.includes(character.profession)) return 'Рецепт требует другое ремесло.'
    if (Number(character.level) < recipe.minLevel) return `Нужен ${recipe.minLevel}-й уровень.`
    if (Number(character.coins) < recipe.coins) return `Нужно монет: ${recipe.coins}.`
    for (const [id, quantity] of Object.entries(recipe.ingredients)) {
      if ((inventory.get(id) ?? 0) < quantity) return `Не хватает: ${ingredientNames[id] ?? id} ×${quantity}.`
    }
    if (recipe.kind === 'marsh-remedy') {
      const injury = db.prepare(`
        SELECT 1 FROM player_injuries
        WHERE user_id = ? AND status = 'active' AND kind IN ('salt-burn', 'marsh-fever', 'deep-cut')
      `).get(userId)
      if (!injury) return 'Нет болотной травмы, требующей обработки.'
    }
    return null
  }

  crafting.workshop = (userId) => {
    const base = originalWorkshop(userId)
    const inventory = crafting.inventoryMap(userId)
    return {
      ...base,
      recipes: [
        ...base.recipes,
        ...recipes.map((recipe) => publicRecipe(recipe, reasonFor(userId, recipe, base.character, inventory))),
      ],
    }
  }

  crafting.craft = (userId, recipeIdValue, input) => {
    const recipeId = String(recipeIdValue ?? '')
    const recipe = recipeById[recipeId]
    if (!recipe) return originalCraft(userId, recipeIdValue, input)
    return players.withReceipt(userId, input.requestId, `craft:${recipeId}`, () => {
      const character = players.getCharacter(userId)
      const inventory = crafting.inventoryMap(userId)
      const reason = reasonFor(userId, recipe, character, inventory)
      if (reason) throw new StoreError('recipe-unavailable', reason, 409)
      crafting.consume(userId, recipe.ingredients)
      if (recipe.coins > 0) {
        db.prepare('UPDATE player_characters SET coins = coins - ?, updated_at = ? WHERE user_id = ?')
          .run(recipe.coins, Date.now(), userId)
      }

      let resultText = recipe.title
      if (recipe.kind === 'stack') {
        crafting.addStack(userId, recipe.output.id, recipe.output.name, recipe.output.quantity, 'consumable')
        resultText = `${recipe.output.name} ×${recipe.output.quantity}`
      } else {
        const injury = db.prepare(`
          SELECT * FROM player_injuries
          WHERE user_id = ? AND status = 'active' AND kind IN ('salt-burn', 'marsh-fever', 'deep-cut')
          ORDER BY severity DESC, created_at LIMIT 1
        `).get(userId)
        if (!injury) throw new StoreError('injury-not-found', 'Болотная травма уже прошла.', 409)
        if (Number(injury.severity) <= 1) {
          db.prepare("UPDATE player_injuries SET status = 'treated', treated_at = ? WHERE id = ?")
            .run(Date.now(), injury.id)
          resultText = `Вылечена травма: ${injury.title}`
        } else {
          db.prepare(`
            UPDATE player_injuries SET severity = severity - 1,
              natural_heal_at = ?, recovery_note = 'Припарка ускорила естественное заживление.'
            WHERE id = ?
          `).run(Date.now() + Math.max(60 * 60 * 1000, Math.floor(Number(injury.recovery_interval) / 2)), injury.id)
          resultText = `${injury.title}: тяжесть уменьшена до ${Number(injury.severity) - 1}`
        }
      }

      db.prepare(`
        INSERT INTO player_crafting_history(id, user_id, recipe_id, result_text, created_at)
        VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?)
      `).run(userId, recipe.id, resultText, Date.now())
      return { ...crafting.workshop(userId), crafted: resultText }
    })
  }

  return { claimRegionalMaterials }
}
