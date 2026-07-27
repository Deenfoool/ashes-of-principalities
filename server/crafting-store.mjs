import { randomUUID } from 'node:crypto'
import { StoreError } from './store.mjs'

const PROFESSIONS = new Set(['blacksmith', 'herbalist', 'hunter', 'scribe', 'carter', 'wanderer'])

export const materialDefinitions = {
  'scrap-iron': { name: 'Лом железа', description: 'Куски пригодного металла с разбойничьего снаряжения.' },
  charcoal: { name: 'Древесный уголь', description: 'Топливо для горна, чернил и дорожных смесей.' },
  'burnt-hide': { name: 'Обожжённая шкура', description: 'Плотная кожа зверя, пережившего пепельный пожар.' },
  cloth: { name: 'Грубая ткань', description: 'Лоскуты, пригодные для повязок и дорожной оснастки.' },
  'river-bone': { name: 'Речная кость', description: 'Холодная кость, долго пролежавшая в проточной воде.' },
  'bitter-herb': { name: 'Горькая трава', description: 'Лечебная трава с сильным запахом и терпким соком.' },
}

const recipes = [
  {
    id: 'field-repair-kit',
    title: 'Полевой ремкомплект',
    description: 'Скобы, заклёпки и угольная паста для срочного ремонта снаряжения.',
    professions: null,
    minLevel: 1,
    ingredients: { 'scrap-iron': 2, charcoal: 1 },
    coins: 0,
    kind: 'stack',
    output: { id: 'repair-kit', name: 'Полевой ремкомплект', type: 'consumable', quantity: 1 },
    professionBonus: { blacksmith: 1 },
  },
  {
    id: 'healing-poultice',
    title: 'Лечебная припарка',
    description: 'Повязка с горькой травой для лечения лёгких и средних травм.',
    professions: ['herbalist'],
    minLevel: 1,
    ingredients: { 'bitter-herb': 2, cloth: 1 },
    coins: 0,
    kind: 'stack',
    output: { id: 'healing-poultice', name: 'Лечебная припарка', type: 'consumable', quantity: 2 },
  },
  {
    id: 'leather-bindings',
    title: 'Кожаные накладки',
    description: 'Накладки из плотной шкуры, укрепляющие рукоять и тетиву.',
    professions: ['hunter'],
    minLevel: 1,
    ingredients: { 'burnt-hide': 2, 'river-bone': 1 },
    coins: 0,
    kind: 'stack',
    output: { id: 'leather-bindings', name: 'Кожаные накладки', type: 'consumable', quantity: 1 },
  },
  {
    id: 'warded-ink',
    title: 'Обережные чернила',
    description: 'Густые чернила для знака, который принимает первый удар пути.',
    professions: ['scribe'],
    minLevel: 1,
    ingredients: { charcoal: 2, 'river-bone': 1, cloth: 1 },
    coins: 0,
    kind: 'stack',
    output: { id: 'warded-ink', name: 'Обережные чернила', type: 'consumable', quantity: 1 },
  },
  {
    id: 'cargo-brace',
    title: 'Дорожная скоба',
    description: 'Металлическая скоба для укрепления инструмента и дорожной оснастки.',
    professions: ['carter'],
    minLevel: 1,
    ingredients: { 'scrap-iron': 2, 'burnt-hide': 1 },
    coins: 0,
    kind: 'stack',
    output: { id: 'cargo-brace', name: 'Дорожная скоба', type: 'consumable', quantity: 1 },
  },
  {
    id: 'traveler-kit',
    title: 'Походный набор',
    description: 'Простая смесь ткани, угля и трав, возвращающая силы в дороге.',
    professions: ['wanderer'],
    minLevel: 1,
    ingredients: { cloth: 1, charcoal: 1, 'bitter-herb': 1 },
    coins: 0,
    kind: 'stack',
    output: { id: 'traveler-kit', name: 'Походный набор', type: 'consumable', quantity: 1 },
  },
  {
    id: 'use-repair-kit',
    title: 'Починить ремкомплектом',
    description: 'Восстановить до 20 прочности экипированного инструмента без платы мастеру.',
    professions: null,
    minLevel: 1,
    ingredients: { 'repair-kit': 1 },
    coins: 0,
    kind: 'repair-kit',
  },
  {
    id: 'apply-poultice',
    title: 'Наложить припарку',
    description: 'Убрать самую тяжёлую травму до второй степени или восстановить здоровье.',
    professions: ['herbalist'],
    minLevel: 1,
    ingredients: { 'healing-poultice': 1 },
    coins: 0,
    kind: 'remedy',
  },
  {
    id: 'reinforce-tool-hunter',
    title: 'Укрепить кожаными накладками',
    description: 'Увеличить максимальную прочность экипированного инструмента на 10.',
    professions: ['hunter'],
    minLevel: 2,
    ingredients: { 'leather-bindings': 1 },
    coins: 2,
    kind: 'reinforce',
  },
  {
    id: 'reinforce-tool-carter',
    title: 'Укрепить дорожной скобой',
    description: 'Увеличить максимальную прочность экипированного инструмента на 10.',
    professions: ['carter'],
    minLevel: 2,
    ingredients: { 'cargo-brace': 1 },
    coins: 2,
    kind: 'reinforce',
  },
  {
    id: 'inscribe-ward',
    title: 'Начертать оберег пути',
    description: 'Следующий поход начнётся с трёх единиц защиты. Можно хранить до трёх оберегов.',
    professions: ['scribe'],
    minLevel: 2,
    ingredients: { 'warded-ink': 1 },
    coins: 2,
    kind: 'ward',
  },
  {
    id: 'consume-traveler-kit',
    title: 'Подготовиться к дороге',
    description: 'Восстановить 4 силы и 1 здоровье перед следующим выходом.',
    professions: ['wanderer'],
    minLevel: 1,
    ingredients: { 'traveler-kit': 1 },
    coins: 0,
    kind: 'restore',
  },
  {
    id: 'reforge-good',
    title: 'Перековать в добротное качество',
    description: 'Кузнец улучшает обычный инструмент, полностью восстанавливая его прочность.',
    professions: ['blacksmith'],
    minLevel: 2,
    ingredients: { 'scrap-iron': 4, charcoal: 2 },
    coins: 6,
    kind: 'reforge-good',
  },
  {
    id: 'reforge-masterwork',
    title: 'Создать мастерскую работу',
    description: 'Трудная перековка добротного инструмента в мастерское качество.',
    professions: ['blacksmith'],
    minLevel: 5,
    ingredients: { 'scrap-iron': 8, charcoal: 4, 'river-bone': 2 },
    coins: 18,
    kind: 'reforge-masterwork',
  },
]

const recipeById = Object.fromEntries(recipes.map((recipe) => [recipe.id, recipe]))

const expeditionMaterials = {
  'ash-wolf': [
    { id: 'burnt-hide', quantity: 2 },
    { id: 'charcoal', quantity: 1 },
  ],
  'toll-robber': [
    { id: 'scrap-iron', quantity: 2 },
    { id: 'cloth', quantity: 1 },
  ],
  'drowned-dead': [
    { id: 'river-bone', quantity: 2 },
    { id: 'bitter-herb', quantity: 2 },
  ],
}

function ingredientName(id) {
  return materialDefinitions[id]?.name ?? {
    'repair-kit': 'Полевой ремкомплект',
    'healing-poultice': 'Лечебная припарка',
    'leather-bindings': 'Кожаные накладки',
    'warded-ink': 'Обережные чернила',
    'cargo-brace': 'Дорожная скоба',
    'traveler-kit': 'Походный набор',
  }[id] ?? id
}

function publicRecipe(recipe, reason) {
  return {
    id: recipe.id,
    title: recipe.title,
    description: recipe.description,
    professions: recipe.professions,
    minLevel: recipe.minLevel,
    ingredients: Object.entries(recipe.ingredients).map(([id, quantity]) => ({ id, name: ingredientName(id), quantity })),
    coins: recipe.coins,
    result: recipe.output
      ? `${recipe.output.name} ×${recipe.output.quantity}`
      : recipe.kind === 'reforge-good'
        ? 'Добротное качество и +20 прочности'
        : recipe.kind === 'reforge-masterwork'
          ? 'Мастерское качество и +25 прочности'
          : recipe.kind === 'reinforce'
            ? '+10 максимальной прочности'
            : recipe.kind === 'ward'
              ? 'Оберег на следующий поход'
              : recipe.kind === 'remedy'
                ? 'Лечение травмы или здоровья'
                : recipe.kind === 'restore'
                  ? '+4 силы и +1 здоровье'
                  : 'Восстановление 20 прочности',
    available: !reason,
    reason,
  }
}

export class CraftingStore {
  constructor(gameStore, players, survival) {
    this.gameStore = gameStore
    this.players = players
    this.survival = survival
    this.db = gameStore.db
    this.createSchema()
    this.claimExistingExpeditions()
    this.installPlayerHooks()
  }

  createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS player_material_claims (
        expedition_id TEXT NOT NULL REFERENCES player_expeditions(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        quantity INTEGER NOT NULL,
        claimed_at INTEGER NOT NULL,
        PRIMARY KEY(expedition_id, item_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS player_crafting_history (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        recipe_id TEXT NOT NULL,
        result_text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS player_effects (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        effect_id TEXT NOT NULL,
        charges INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, effect_id)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_crafting_history_user_time
        ON player_crafting_history(user_id, created_at DESC);

      CREATE TRIGGER IF NOT EXISTS trg_crafting_apply_path_ward
      AFTER INSERT ON player_expeditions
      WHEN EXISTS (
        SELECT 1 FROM player_effects
        WHERE user_id = NEW.user_id AND effect_id = 'path-ward' AND charges > 0
      )
      BEGIN
        UPDATE player_expeditions SET guard = guard + 3
        WHERE id = NEW.id;
        UPDATE player_effects SET charges = charges - 1, updated_at = unixepoch('subsec') * 1000
        WHERE user_id = NEW.user_id AND effect_id = 'path-ward';
        DELETE FROM player_effects
        WHERE user_id = NEW.user_id AND effect_id = 'path-ward' AND charges <= 0;
      END;
    `)
  }

  installPlayerHooks() {
    if (this.players.__craftingInstalled) return
    this.players.__craftingInstalled = true
    const originalActExpedition = this.players.actExpedition.bind(this.players)
    this.players.actExpedition = (userId, input) => {
      const result = originalActExpedition(userId, input)
      this.claimExpeditionMaterials(userId, String(input.expeditionId ?? ''))
      return { ...result, character: this.players.getCharacter(userId) }
    }
  }

  addStack(userId, itemId, name, quantity, type = 'material', quality = 'common') {
    this.db.prepare(`
      INSERT INTO player_inventory(
        user_id, item_id, item_name, quantity, item_type, quality,
        durability, max_durability, equipped, repair_count
      ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0)
      ON CONFLICT(user_id, item_id) DO UPDATE SET quantity = quantity + excluded.quantity
    `).run(userId, itemId, name, quantity, type, quality)
  }

  claimExistingExpeditions() {
    const rows = this.db.prepare(`
      SELECT id, user_id FROM player_expeditions WHERE status = 'won' ORDER BY updated_at
    `).all()
    for (const row of rows) this.claimExpeditionMaterials(row.user_id, row.id)
  }

  claimExpeditionMaterials(userId, expeditionId) {
    const expedition = this.db.prepare(`
      SELECT id, user_id, contract_id, status FROM player_expeditions
      WHERE id = ? AND user_id = ?
    `).get(expeditionId, userId)
    if (!expedition || expedition.status !== 'won') return []
    const drops = expeditionMaterials[expedition.contract_id] ?? []
    if (drops.length === 0) return []
    const guild = this.gameStore.getGuildForUser(userId)
    const foragingBonus = Math.floor((Number(guild?.branches?.foraging ?? 0) + 1) / 2)
    const awarded = []

    this.gameStore.transaction(() => {
      for (const [index, drop] of drops.entries()) {
        const quantity = drop.quantity + (index === 0 ? foragingBonus : 0)
        const result = this.db.prepare(`
          INSERT OR IGNORE INTO player_material_claims(expedition_id, item_id, user_id, quantity, claimed_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(expedition.id, drop.id, userId, quantity, Date.now())
        if (Number(result.changes) < 1) continue
        const definition = materialDefinitions[drop.id]
        this.addStack(userId, drop.id, definition.name, quantity, 'material')
        awarded.push({ id: drop.id, name: definition.name, quantity })
      }
    })
    return awarded
  }

  inventoryMap(userId) {
    return new Map(this.db.prepare(`
      SELECT item_id, quantity FROM player_inventory WHERE user_id = ?
    `).all(userId).map((row) => [row.item_id, Number(row.quantity)]))
  }

  safeWorkshopReason(userId) {
    if (this.players.getActiveRun(userId)) return 'Мастерская недоступна во время боя.'
    const story = this.db.prepare('SELECT scene_id, chapter_complete FROM player_story_state WHERE user_id = ?').get(userId)
    if (!story || (!Number(story.chapter_complete) && story.scene_id !== 'tavern')) {
      return 'Работать можно в трактире или после завершения первой главы.'
    }
    return null
  }

  equippedTool(userId) {
    return this.db.prepare(`
      SELECT * FROM player_inventory
      WHERE user_id = ? AND equipped = 1 AND max_durability > 0
      LIMIT 1
    `).get(userId)
  }

  recipeReason(userId, recipe, character, inventory) {
    if (!character) return 'Сначала создай героя.'
    if (!character.alive) return 'Погибший герой не может работать в мастерской.'
    const safeReason = this.safeWorkshopReason(userId)
    if (safeReason) return safeReason
    if (recipe.professions && !recipe.professions.includes(character.profession)) return 'Рецепт недоступен этому ремеслу.'
    if (!PROFESSIONS.has(character.profession)) return 'Неизвестное ремесло героя.'
    if (character.level < recipe.minLevel) return `Нужен ${recipe.minLevel}-й уровень.`
    if (character.coins < recipe.coins) return `Нужно монет: ${recipe.coins}.`
    for (const [id, quantity] of Object.entries(recipe.ingredients)) {
      if ((inventory.get(id) ?? 0) < quantity) return `Не хватает: ${ingredientName(id)} ×${quantity}.`
    }

    const tool = this.equippedTool(userId)
    if (['repair-kit', 'reinforce', 'reforge-good', 'reforge-masterwork'].includes(recipe.kind) && !tool) {
      return 'Сначала экипируй ремонтируемый инструмент.'
    }
    if (recipe.kind === 'repair-kit' && Number(tool.durability) >= Number(tool.max_durability)) return 'Инструмент не повреждён.'
    if (recipe.kind === 'reinforce' && Number(tool.max_durability) >= 100) return 'Инструмент уже укреплён до предела.'
    if (recipe.kind === 'reforge-good' && !['worn', 'common'].includes(tool.quality)) return 'Для этой перековки нужен обычный или изношенный инструмент.'
    if (recipe.kind === 'reforge-masterwork' && tool.quality !== 'good') return 'Мастерскую работу можно создать только из добротного инструмента.'
    if (recipe.kind === 'remedy') {
      const injury = this.db.prepare(`
        SELECT id FROM player_injuries WHERE user_id = ? AND status = 'active' AND severity <= 2 LIMIT 1
      `).get(userId)
      if (!injury && character.health >= character.maxHealth) return 'Нет травмы или потерянного здоровья, требующего припарки.'
    }
    if (recipe.kind === 'restore' && character.health >= character.maxHealth && character.stamina >= character.maxStamina) {
      return 'Герой уже полностью готов к дороге.'
    }
    if (recipe.kind === 'ward') {
      const effect = this.db.prepare("SELECT charges FROM player_effects WHERE user_id = ? AND effect_id = 'path-ward'").get(userId)
      if (Number(effect?.charges ?? 0) >= 3) return 'У героя уже накоплено три оберега.'
    }
    return null
  }

  workshop(userId) {
    const character = this.players.getCharacter(userId)
    if (!character) throw new StoreError('character-required', 'Сначала создай серверного героя.', 404)
    const inventory = this.inventoryMap(userId)
    const supplies = this.db.prepare(`
      SELECT item_id AS id, item_name AS name, quantity, item_type AS type
      FROM player_inventory
      WHERE user_id = ? AND item_type IN ('material', 'consumable') AND quantity > 0
      ORDER BY item_type, item_name
    `).all(userId).map((row) => ({ ...row, quantity: Number(row.quantity) }))
    const history = this.db.prepare(`
      SELECT id, recipe_id AS recipeId, result_text AS result, created_at AS createdAt
      FROM player_crafting_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 20
    `).all(userId).map((row) => ({ ...row, createdAt: Number(row.createdAt) }))
    const effects = this.db.prepare(`
      SELECT effect_id AS id, charges FROM player_effects WHERE user_id = ? ORDER BY effect_id
    `).all(userId).map((row) => ({ id: row.id, charges: Number(row.charges) }))
    return {
      character,
      supplies,
      recipes: recipes.map((recipe) => publicRecipe(recipe, this.recipeReason(userId, recipe, character, inventory))),
      history,
      effects,
      safe: !this.safeWorkshopReason(userId),
    }
  }

  consume(userId, ingredients) {
    for (const [itemId, quantity] of Object.entries(ingredients)) {
      const row = this.db.prepare('SELECT quantity FROM player_inventory WHERE user_id = ? AND item_id = ?').get(userId, itemId)
      if (!row || Number(row.quantity) < quantity) throw new StoreError('ingredients-changed', 'Запасы изменились. Обнови мастерскую.', 409)
      if (Number(row.quantity) === quantity) {
        this.db.prepare('DELETE FROM player_inventory WHERE user_id = ? AND item_id = ?').run(userId, itemId)
      } else {
        this.db.prepare('UPDATE player_inventory SET quantity = quantity - ? WHERE user_id = ? AND item_id = ?').run(quantity, userId, itemId)
      }
    }
  }

  craft(userId, recipeIdValue, input) {
    const recipeId = String(recipeIdValue ?? '').slice(0, 80)
    const recipe = recipeById[recipeId]
    if (!recipe) throw new StoreError('recipe-not-found', 'Неизвестный рецепт.', 404)
    return this.players.withReceipt(userId, input.requestId, `craft:${recipeId}`, () => {
      const character = this.players.getCharacter(userId)
      const inventory = this.inventoryMap(userId)
      const reason = this.recipeReason(userId, recipe, character, inventory)
      if (reason) throw new StoreError('recipe-unavailable', reason, 409)

      this.consume(userId, recipe.ingredients)
      if (recipe.coins > 0) {
        this.db.prepare('UPDATE player_characters SET coins = coins - ?, updated_at = ? WHERE user_id = ?')
          .run(recipe.coins, Date.now(), userId)
      }

      let resultText = recipe.title
      if (recipe.kind === 'stack') {
        const bonus = Number(recipe.professionBonus?.[character.profession] ?? 0)
        const quantity = recipe.output.quantity + bonus
        this.addStack(userId, recipe.output.id, recipe.output.name, quantity, recipe.output.type)
        resultText = `${recipe.output.name} ×${quantity}`
      } else if (recipe.kind === 'repair-kit') {
        const tool = this.equippedTool(userId)
        const restored = Math.min(20, Number(tool.max_durability) - Number(tool.durability))
        this.db.prepare('UPDATE player_inventory SET durability = MIN(max_durability, durability + 20) WHERE user_id = ? AND item_id = ?')
          .run(userId, tool.item_id)
        resultText = `${tool.item_name}: восстановлено ${restored} прочности`
      } else if (recipe.kind === 'reinforce') {
        const tool = this.equippedTool(userId)
        const increase = Math.min(10, 100 - Number(tool.max_durability))
        this.db.prepare(`
          UPDATE player_inventory SET max_durability = max_durability + ?, durability = MIN(max_durability + ?, durability + ?)
          WHERE user_id = ? AND item_id = ?
        `).run(increase, increase, increase, userId, tool.item_id)
        resultText = `${tool.item_name}: максимальная прочность +${increase}`
      } else if (recipe.kind === 'reforge-good' || recipe.kind === 'reforge-masterwork') {
        const tool = this.equippedTool(userId)
        const quality = recipe.kind === 'reforge-good' ? 'good' : 'masterwork'
        const increase = recipe.kind === 'reforge-good' ? 20 : 25
        this.db.prepare(`
          UPDATE player_inventory SET quality = ?, max_durability = MIN(120, max_durability + ?),
            durability = MIN(120, max_durability + ?), repair_count = repair_count + 1
          WHERE user_id = ? AND item_id = ?
        `).run(quality, increase, increase, userId, tool.item_id)
        resultText = `${tool.item_name}: качество «${quality === 'good' ? 'добротное' : 'мастерское'}»`
      } else if (recipe.kind === 'remedy') {
        const injury = this.db.prepare(`
          SELECT * FROM player_injuries WHERE user_id = ? AND status = 'active' AND severity <= 2
          ORDER BY severity DESC, created_at LIMIT 1
        `).get(userId)
        if (injury) {
          this.db.prepare("UPDATE player_injuries SET status = 'treated', treated_at = ? WHERE id = ?").run(Date.now(), injury.id)
          resultText = `Вылечена травма: ${injury.title}`
        } else {
          const before = character.health
          this.db.prepare('UPDATE player_characters SET health = MIN(max_health, health + 4), updated_at = ? WHERE user_id = ?')
            .run(Date.now(), userId)
          const after = this.players.getCharacter(userId).health
          resultText = `Восстановлено здоровья: ${after - before}`
        }
      } else if (recipe.kind === 'ward') {
        this.db.prepare(`
          INSERT INTO player_effects(user_id, effect_id, charges, updated_at) VALUES (?, 'path-ward', 1, ?)
          ON CONFLICT(user_id, effect_id) DO UPDATE SET charges = MIN(3, charges + 1), updated_at = excluded.updated_at
        `).run(userId, Date.now())
        resultText = 'Оберег пути готов: следующий поход начнётся с защитой'
      } else if (recipe.kind === 'restore') {
        this.db.prepare(`
          UPDATE player_characters SET stamina = MIN(max_stamina, stamina + 4),
            health = MIN(max_health, health + 1), updated_at = ? WHERE user_id = ?
        `).run(Date.now(), userId)
        resultText = 'Подготовка завершена: силы +4, здоровье +1'
      }

      this.db.prepare(`
        INSERT INTO player_crafting_history(id, user_id, recipe_id, result_text, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(randomUUID(), userId, recipe.id, resultText, Date.now())

      return { ...this.workshop(userId), crafted: { recipeId: recipe.id, result: resultText } }
    })
  }
}
