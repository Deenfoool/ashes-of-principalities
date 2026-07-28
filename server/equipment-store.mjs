import { randomUUID } from 'node:crypto'
import { StoreError } from './store.mjs'

const QUALITY_BONUS = { worn: 0, common: 0, good: 1, masterwork: 2 }

export const equipmentBlueprints = [
  {
    id: 'reed-lamellar', profession: 'blacksmith', minLevel: 3,
    title: 'Тростниковый ламелляр', description: 'Бронзовые пластины на гибком тростниковом основании.',
    templateId: 'reed-lamellar', name: 'Тростниковый ламелляр', type: 'armor', slot: 'body',
    quality: 'good', durability: 78, coins: 16,
    ingredients: { 'drowned-brass': 2, 'black-reed': 3, 'scrap-iron': 3 },
  },
  {
    id: 'salt-hide-coat', profession: 'hunter', minLevel: 3,
    title: 'Куртка соляного ловчего', description: 'Кожаная защита, не цепляющаяся за тростник и чужие копья.',
    templateId: 'salt-hide-coat', name: 'Куртка соляного ловчего', type: 'armor', slot: 'body',
    quality: 'good', durability: 70, coins: 13,
    ingredients: { 'burnt-hide': 3, 'salt-moss': 2, cloth: 2 },
  },
  {
    id: 'brine-apron', profession: 'herbalist', minLevel: 3,
    title: 'Рассольный передник', description: 'Плотный передник с моховой подкладкой для ядовитой воды и горячей соли.',
    templateId: 'brine-apron', name: 'Рассольный передник', type: 'armor', slot: 'body',
    quality: 'good', durability: 64, coins: 11,
    ingredients: { 'salt-moss': 4, cloth: 3, 'brine-crystal': 1 },
  },
  {
    id: 'bell-ward', profession: 'scribe', minLevel: 3,
    title: 'Оберег глухого колокола', description: 'Бронзовый знак, глушащий порчу и дальний звон.',
    templateId: 'bell-ward', name: 'Оберег глухого колокола', type: 'tool', slot: 'charm',
    quality: 'good', durability: 55, coins: 14,
    ingredients: { 'drowned-brass': 2, 'brine-crystal': 2, charcoal: 2 },
  },
  {
    id: 'road-knot', profession: 'carter', minLevel: 3,
    title: 'Узел старой гати', description: 'Связка бронзы и верёвки, помогающая вырваться из окружения.',
    templateId: 'road-knot', name: 'Узел старой гати', type: 'tool', slot: 'charm',
    quality: 'good', durability: 58, coins: 12,
    ingredients: { 'black-reed': 2, 'drowned-brass': 1, 'burnt-hide': 2 },
  },
  {
    id: 'high-path-token', profession: 'wanderer', minLevel: 3,
    title: 'Знак высокого пути', description: 'Костяная метка для тех, кто ищет сухую высоту посреди топи.',
    templateId: 'high-path-token', name: 'Знак высокого пути', type: 'tool', slot: 'charm',
    quality: 'good', durability: 52, coins: 11,
    ingredients: { 'river-bone': 2, 'black-reed': 2, 'brine-crystal': 1 },
  },
]

const blueprintById = Object.fromEntries(equipmentBlueprints.map((recipe) => [recipe.id, recipe]))

const statsByTemplate = {
  'reed-lamellar': { armor: 3, zoneResistance: 1 },
  'salt-hide-coat': { armor: 2, zoneResistance: 2 },
  'brine-apron': { armor: 1, injuryResistance: 2 },
  'bell-ward': { hexResistance: 2 },
  'road-knot': { zoneResistance: 2, movementDiscount: 1 },
  'high-path-token': { elevationBonus: 1, movementDiscount: 1 },
  'white-bell-cuirass': { armor: 4, zoneResistance: 2, hexResistance: 1 },
}

const ingredientNames = {
  'drowned-brass': 'Утопленная бронза',
  'black-reed': 'Чёрный тростник',
  'scrap-iron': 'Лом железа',
  'burnt-hide': 'Обожжённая шкура',
  'salt-moss': 'Соляной мох',
  cloth: 'Грубая ткань',
  'brine-crystal': 'Рассольный кристалл',
  charcoal: 'Древесный уголь',
  'river-bone': 'Речная кость',
}

function recipeView(recipe, reason) {
  return {
    id: recipe.id,
    title: recipe.title,
    description: recipe.description,
    professions: [recipe.profession],
    minLevel: recipe.minLevel,
    ingredients: Object.entries(recipe.ingredients).map(([id, quantity]) => ({ id, name: ingredientNames[id] ?? id, quantity })),
    coins: recipe.coins,
    result: `${recipe.name} · слот «${recipe.slot === 'body' ? 'броня' : 'оберег'}»`,
    available: !reason,
    reason,
  }
}

export class EquipmentStore {
  constructor(gameStore, players, survival, artifacts, crafting) {
    this.gameStore = gameStore
    this.players = players
    this.survival = survival
    this.artifacts = artifacts
    this.crafting = crafting
    this.db = gameStore.db
    this.patchArtifacts()
    this.patchSurvival()
    this.patchCrafting()
  }

  statsFor(row) {
    const base = statsByTemplate[row?.template_id] ?? {}
    const quality = QUALITY_BONUS[row?.quality] ?? 0
    return {
      armor: Number(base.armor ?? 0) + (Number(base.armor ?? 0) > 0 ? quality : 0),
      zoneResistance: Number(base.zoneResistance ?? 0),
      movementDiscount: Number(base.movementDiscount ?? 0),
      hexResistance: Number(base.hexResistance ?? 0),
      elevationBonus: Number(base.elevationBonus ?? 0),
      injuryResistance: Number(base.injuryResistance ?? 0),
    }
  }

  decorateItems(userId, items) {
    const rows = new Map(this.db.prepare(`
      SELECT id, template_id, equipment_slot, durability, max_durability, quality
      FROM unique_items WHERE owner_user_id = ?
    `).all(userId).map((row) => [row.id, row]))
    return items.map((item) => {
      const row = rows.get(item.id)
      if (!row) return item
      const stats = this.statsFor(row)
      return {
        ...item,
        equipmentSlot: row.equipment_slot,
        armor: stats.armor,
        zoneResistance: stats.zoneResistance,
        movementDiscount: stats.movementDiscount,
        hexResistance: stats.hexResistance,
        elevationBonus: stats.elevationBonus,
      }
    })
  }

  equippedRows(userId) {
    return this.db.prepare(`
      SELECT * FROM unique_items
      WHERE owner_user_id = ? AND equipped = 1
      ORDER BY CASE equipment_slot WHEN 'main-hand' THEN 0 WHEN 'body' THEN 1 ELSE 2 END
    `).all(userId)
  }

  profile(userId) {
    const rows = this.equippedRows(userId).filter((row) => Number(row.durability) > 0)
    const total = { armor: 0, zoneResistance: 0, movementDiscount: 0, hexResistance: 0, elevationBonus: 0, injuryResistance: 0 }
    for (const row of rows) {
      const stats = this.statsFor(row)
      for (const key of Object.keys(total)) total[key] += Number(stats[key] ?? 0)
    }
    return total
  }

  patchArtifacts() {
    const originalOwnedItems = this.artifacts.ownedItems.bind(this.artifacts)
    this.artifacts.ownedItems = (userId) => this.decorateItems(userId, originalOwnedItems(userId))
    this.artifacts.equippedRow = (userId) => this.db.prepare(`
      SELECT * FROM unique_items
      WHERE owner_user_id = ? AND equipped = 1 AND equipment_slot = 'main-hand'
      LIMIT 1
    `).get(userId)

    this.artifacts.equipItem = (userId, itemIdValue, input) => {
      const itemId = String(itemIdValue ?? '').trim().slice(0, 96)
      return this.players.withReceipt(userId, input.requestId, `equip:${itemId}`, () => {
        if (this.players.getActiveRun(userId)) throw new StoreError('expedition-active', 'Нельзя менять снаряжение во время боя.', 409)
        const item = this.db.prepare(`
          SELECT id, equipment_slot FROM unique_items WHERE id = ? AND owner_user_id = ?
        `).get(itemId, userId)
        if (!item) throw new StoreError('item-not-equippable', 'Этот уникальный предмет не принадлежит герою.', 409)
        const now = Date.now()
        this.db.prepare(`
          UPDATE unique_items SET equipped = 0, updated_at = ?
          WHERE owner_user_id = ? AND equipment_slot = ?
        `).run(now, userId, item.equipment_slot)
        this.db.prepare('UPDATE unique_items SET equipped = 1, updated_at = ? WHERE id = ?').run(now, itemId)
        this.artifacts.history(itemId, 'equipped', userId, userId, userId, { slot: item.equipment_slot })
        return { character: this.players.getCharacter(userId) }
      })
    }
  }

  patchSurvival() {
    const originalDecorate = this.survival.decorateCharacter.bind(this.survival)
    this.survival.decorateCharacter = (character) => {
      const base = originalDecorate(character)
      if (!base) return null
      const inventory = this.decorateItems(base.userId, base.inventory ?? [])
      const equipment = {
        mainHand: inventory.find((item) => item.unique && item.equipped && item.equipmentSlot === 'main-hand') ?? null,
        body: inventory.find((item) => item.unique && item.equipped && item.equipmentSlot === 'body') ?? null,
        charm: inventory.find((item) => item.unique && item.equipped && item.equipmentSlot === 'charm') ?? null,
      }
      const profile = this.profile(base.userId)
      return {
        ...base,
        inventory,
        equippedItem: equipment.mainHand,
        equipment,
        armorRating: profile.armor,
        combatModifiers: {
          ...base.combatModifiers,
          armorReduction: profile.armor,
          zoneResistance: profile.zoneResistance,
          movementDiscount: profile.movementDiscount,
          hexResistance: profile.hexResistance,
          elevationBonus: profile.elevationBonus,
          injuryResistance: profile.injuryResistance,
        },
      }
    }
  }

  recipeReason(userId, recipe, character) {
    if (!character?.alive) return 'Изготовить снаряжение может только живой герой.'
    const safe = this.crafting.safeWorkshopReason(userId)
    if (safe) return safe
    if (character.profession !== recipe.profession) return 'Чертёж требует другое ремесло.'
    if (Number(character.level) < recipe.minLevel) return `Нужен ${recipe.minLevel}-й уровень.`
    if (Number(character.coins) < recipe.coins) return `Нужно монет: ${recipe.coins}.`
    const inventory = this.crafting.inventoryMap(userId)
    for (const [id, quantity] of Object.entries(recipe.ingredients)) {
      if ((inventory.get(id) ?? 0) < quantity) return `Не хватает: ${ingredientNames[id] ?? id} ×${quantity}.`
    }
    return null
  }

  patchCrafting() {
    const originalWorkshop = this.crafting.workshop.bind(this.crafting)
    const originalCraft = this.crafting.craft.bind(this.crafting)

    this.crafting.workshop = (userId) => {
      const base = originalWorkshop(userId)
      return {
        ...base,
        recipes: [
          ...base.recipes,
          ...equipmentBlueprints.map((recipe) => recipeView(recipe, this.recipeReason(userId, recipe, base.character))),
        ],
      }
    }

    this.crafting.craft = (userId, recipeIdValue, input) => {
      const recipeId = String(recipeIdValue ?? '')
      const recipe = blueprintById[recipeId]
      if (!recipe) return originalCraft(userId, recipeIdValue, input)
      return this.players.withReceipt(userId, input.requestId, `craft:${recipeId}`, () => {
        const character = this.players.getCharacter(userId)
        const reason = this.recipeReason(userId, recipe, character)
        if (reason) throw new StoreError('recipe-unavailable', reason, 409)
        this.crafting.consume(userId, recipe.ingredients)
        const now = Date.now()
        this.db.prepare(`
          UPDATE player_characters SET coins = coins - ?, reputation = reputation + 2, updated_at = ?
          WHERE user_id = ?
        `).run(recipe.coins, now, userId)
        const row = this.artifacts.createItem({
          ownerUserId: userId,
          makerUserId: userId,
          templateId: recipe.templateId,
          name: recipe.name,
          type: recipe.type,
          quality: recipe.quality,
          durability: recipe.durability,
          originType: 'crafted-equipment',
          originDetail: recipe.id,
          tradable: true,
        })
        this.db.prepare('UPDATE unique_items SET equipment_slot = ? WHERE id = ?').run(recipe.slot, row.id)
        const serial = `ПК-${String(row.serial_number).padStart(6, '0')}`
        const resultText = `${recipe.name} · ${serial}`
        this.db.prepare(`
          INSERT INTO player_crafting_history(id, user_id, recipe_id, result_text, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(randomUUID(), userId, recipe.id, resultText, now)
        return { ...this.crafting.workshop(userId), crafted: resultText }
      })
    }
  }

  damageSlot(userId, slot, amount = 1) {
    const row = this.db.prepare(`
      SELECT id, durability FROM unique_items
      WHERE owner_user_id = ? AND equipment_slot = ? AND equipped = 1
    `).get(userId, slot)
    if (!row || Number(row.durability) <= 0) return false
    this.db.prepare(`
      UPDATE unique_items SET durability = MAX(0, durability - ?), updated_at = ? WHERE id = ?
    `).run(Math.max(1, Number(amount)), Date.now(), row.id)
    return true
  }

  grantBossArmor(userId) {
    const existing = this.db.prepare(`
      SELECT id FROM unique_items
      WHERE lineage_user_id = ? AND origin_type = 'boss-reward' AND origin_detail = 'salt-bell-warden:first-victory'
    `).get(userId)
    if (existing) return this.artifacts.ownedItems(userId).find((item) => item.id === existing.id) ?? null
    const row = this.artifacts.createItem({
      ownerUserId: userId,
      templateId: 'white-bell-cuirass',
      name: 'Белопанцирь Глухобора',
      type: 'armor',
      quality: 'masterwork',
      durability: 96,
      originType: 'boss-reward',
      originDetail: 'salt-bell-warden:first-victory',
      tradable: false,
    })
    this.db.prepare("UPDATE unique_items SET equipment_slot = 'body' WHERE id = ?").run(row.id)
    return this.artifacts.ownedItems(userId).find((item) => item.id === row.id) ?? null
  }
}
