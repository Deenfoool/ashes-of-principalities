import test from 'node:test'
import assert from 'node:assert/strict'
import { GuildExpansionStore } from './guild-expansion-store.mjs'
import { installGuildExpansionFixes } from './guild-expansion-fixes.mjs'
import { installGuildV014Migrations } from './guild-v014-migrations.mjs'
import { PlayerStore } from './player-store.mjs'
import { GameStore } from './store.mjs'

const REQUIREMENTS = {
  'scrap-iron': 12,
  'black-reed': 10,
  'drowned-brass': 6,
  'salt-moss': 8,
  'brine-crystal': 4,
  'white-bell-heart': 1,
}

function createUser(game, players, suffix, profession = 'blacksmith') {
  const account = game.register({
    username: `guild_v014_${suffix}`,
    password: '12345678',
    displayName: `Игрок ${suffix}`,
  })
  players.createCharacter(account.user.id, {
    requestId: `create-v014-${suffix}-0001`,
    name: `Герой ${suffix}`,
    profession,
  })
  return account.user
}

function setup({ members = 2 } = {}) {
  const game = new GameStore(':memory:')
  const players = new PlayerStore(game)
  installGuildV014Migrations(game.db)
  const expansion = new GuildExpansionStore(game, players)
  installGuildExpansionFixes(expansion)
  const leader = createUser(game, players, 'leader', 'blacksmith')
  const guild = game.createGuild(leader.id, { name: 'Пепельный союз', tag: 'ПС' })
  const users = [leader]
  if (members > 1) {
    const member = createUser(game, players, 'member', 'hunter')
    const invite = game.inviteToGuild(leader.id, member.username)
    game.acceptInvite(member.id, invite.id)
    users.push(member)
  }
  return { game, players, expansion, guildId: guild.id, leader, member: users[1] ?? null, close: () => game.close() }
}

function giveRaidResources(players, userId) {
  for (const [itemId, quantity] of Object.entries(REQUIREMENTS)) {
    players.addInventory(userId, itemId, itemId, quantity)
  }
}

function depositRaidResources(expansion, userId) {
  let index = 0
  for (const [itemId, quantity] of Object.entries(REQUIREMENTS)) {
    expansion.depositResource(userId, {
      itemId,
      quantity,
      requestId: `deposit-raid-${String(index).padStart(2, '0')}-v014`,
    })
    index += 1
  }
}

test('resource deposits and withdrawals are idempotent and use real inventory', () => {
  const fixture = setup({ members: 1 })
  try {
    fixture.players.addInventory(fixture.leader.id, 'scrap-iron', 'Лом железа', 5)
    const input = { itemId: 'scrap-iron', quantity: 3, requestId: 'resource-deposit-v014-0001' }
    const first = fixture.expansion.depositResource(fixture.leader.id, input)
    const repeated = fixture.expansion.depositResource(fixture.leader.id, input)
    assert.deepEqual(repeated, first)
    assert.equal(fixture.game.db.prepare("SELECT quantity FROM player_inventory WHERE user_id = ? AND item_id = 'scrap-iron'").get(fixture.leader.id).quantity, 2)
    assert.equal(fixture.game.db.prepare("SELECT quantity FROM guild_resource_stock WHERE guild_id = ? AND item_id = 'scrap-iron'").get(fixture.guildId).quantity, 3)

    const withdraw = { itemId: 'scrap-iron', quantity: 1, requestId: 'resource-withdraw-v014-0001' }
    const withdrawn = fixture.expansion.withdrawResource(fixture.leader.id, withdraw)
    const withdrawnAgain = fixture.expansion.withdrawResource(fixture.leader.id, withdraw)
    assert.deepEqual(withdrawnAgain, withdrawn)
    assert.equal(fixture.game.db.prepare("SELECT quantity FROM player_inventory WHERE user_id = ? AND item_id = 'scrap-iron'").get(fixture.leader.id).quantity, 3)
    assert.equal(fixture.game.db.prepare("SELECT quantity FROM guild_resource_stock WHERE guild_id = ? AND item_id = 'scrap-iron'").get(fixture.guildId).quantity, 2)
  } finally { fixture.close() }
})

test('prepared raid can be cancelled with resource and stamina restoration', () => {
  const fixture = setup({ members: 1 })
  try {
    fixture.game.db.prepare('UPDATE player_characters SET level = 5, max_stamina = 20, stamina = 20 WHERE user_id = ?').run(fixture.leader.id)
    giveRaidResources(fixture.players, fixture.leader.id)
    depositRaidResources(fixture.expansion, fixture.leader.id)
    fixture.expansion.prepareRaid(fixture.leader.id, { requestId: 'raid-prepare-cancel-v014' })
    fixture.expansion.joinRaid(fixture.leader.id, { requestId: 'raid-join-cancel-v014' })
    assert.equal(fixture.game.db.prepare('SELECT stamina FROM player_characters WHERE user_id = ?').get(fixture.leader.id).stamina, 17)
    assert.throws(
      () => fixture.expansion.joinRaid(fixture.leader.id, { requestId: 'raid-join-again-v014' }),
      (error) => error.code === 'raid-already-joined' && error.status === 409,
    )
    assert.equal(fixture.game.db.prepare('SELECT stamina FROM player_characters WHERE user_id = ?').get(fixture.leader.id).stamina, 17)

    const cancelled = fixture.expansion.cancelRaid(fixture.leader.id, { requestId: 'raid-cancel-v014-0001' })
    assert.equal(cancelled.raid.boss.status, 'preparing')
    assert.equal(fixture.game.db.prepare('SELECT stamina FROM player_characters WHERE user_id = ?').get(fixture.leader.id).stamina, 20)
    assert.equal(fixture.game.db.prepare('SELECT COUNT(*) AS count FROM guild_raid_participants').get().count, 0)
    for (const [itemId, quantity] of Object.entries(REQUIREMENTS)) {
      const row = fixture.game.db.prepare('SELECT quantity, reserved FROM guild_resource_stock WHERE guild_id = ? AND item_id = ?').get(fixture.guildId, itemId)
      assert.equal(Number(row.quantity), quantity)
      assert.equal(Number(row.reserved), 0)
    }
  } finally { fixture.close() }
})

test('leadership transfers voluntarily and automatically after inactivity', () => {
  const fixture = setup()
  try {
    fixture.expansion.transferLeadership(fixture.leader.id, {
      targetUserId: fixture.member.id,
      requestId: 'leadership-voluntary-v014',
    })
    assert.equal(fixture.game.db.prepare('SELECT leader_id FROM guilds WHERE id = ?').get(fixture.guildId).leader_id, fixture.member.id)
    const roles = fixture.game.db.prepare(`
      SELECT gm.user_id, gr.position FROM guild_members gm JOIN guild_roles gr ON gr.id = gm.role_id
      WHERE gm.guild_id = ?
    `).all(fixture.guildId)
    assert.equal(Number(roles.find((row) => row.user_id === fixture.member.id).position), 100)
    assert.equal(Number(roles.find((row) => row.user_id === fixture.leader.id).position), 80)

    const now = Date.now()
    fixture.game.db.prepare('UPDATE guild_members SET last_active_at = ? WHERE user_id = ?').run(now - 15 * 24 * 60 * 60 * 1000, fixture.member.id)
    fixture.game.db.prepare('UPDATE guild_members SET last_active_at = ? WHERE user_id = ?').run(now - 60_000, fixture.leader.id)
    const successor = fixture.expansion.checkAutomaticTransfer(fixture.guildId, now)
    assert.equal(successor, fixture.leader.id)
    assert.equal(fixture.game.db.prepare('SELECT leader_id FROM guilds WHERE id = ?').get(fixture.guildId).leader_id, fixture.leader.id)
    const history = fixture.game.db.prepare('SELECT reason FROM guild_leadership_log WHERE guild_id = ? ORDER BY created_at').all(fixture.guildId)
    assert.deepEqual(history.map((row) => row.reason).sort(), ['inactivity', 'voluntary'])
  } finally { fixture.close() }
})

test('two members defeat the shared boss and final reward cannot duplicate', () => {
  const fixture = setup()
  try {
    fixture.game.db.prepare('UPDATE guilds SET warband = 5, workshops = 5 WHERE id = ?').run(fixture.guildId)
    fixture.game.db.prepare('UPDATE player_characters SET level = 10, max_stamina = 20, stamina = 20 WHERE user_id IN (?, ?)').run(fixture.leader.id, fixture.member.id)
    giveRaidResources(fixture.players, fixture.leader.id)
    depositRaidResources(fixture.expansion, fixture.leader.id)
    fixture.expansion.prepareRaid(fixture.leader.id, { requestId: 'raid-prepare-win-v014' })
    fixture.expansion.joinRaid(fixture.leader.id, { requestId: 'raid-join-leader-v014' })
    fixture.expansion.joinRaid(fixture.member.id, { requestId: 'raid-join-member-v014' })
    fixture.expansion.startRaid(fixture.leader.id, { requestId: 'raid-start-win-v014' })

    let result = fixture.expansion.raidSnapshot(fixture.leader.id)
    let final = null
    for (let index = 0; index < 20 && result.boss.status === 'active'; index += 1) {
      const actor = index % 2 === 0 ? fixture.leader : fixture.member
      const action = index % 3 === 1 ? 'guard' : 'profession'
      const requestId = `raid-action-v014-${String(index).padStart(3, '0')}`
      const actionResult = fixture.expansion.actRaid(actor.id, { action, requestId })
      result = actionResult.raid
      final = { actor, action, requestId, response: actionResult }
    }
    assert.equal(result.boss.status, 'won')
    const before = fixture.game.db.prepare('SELECT coins FROM player_characters WHERE user_id = ?').get(final.actor.id).coins
    const repeated = fixture.expansion.actRaid(final.actor.id, { action: final.action, requestId: final.requestId })
    const after = fixture.game.db.prepare('SELECT coins FROM player_characters WHERE user_id = ?').get(final.actor.id).coins
    assert.deepEqual(repeated, final.response)
    assert.equal(after, before)
    assert.equal(fixture.game.db.prepare("SELECT victories FROM guild_raid_projects WHERE guild_id = ? AND boss_id = 'ash-crowned-devourer'").get(fixture.guildId).victories, 1)
    assert.equal(fixture.game.db.prepare('SELECT treasury_coins FROM guilds WHERE id = ?').get(fixture.guildId).treasury_coins, 120)
    assert.equal(fixture.game.db.prepare("SELECT quantity FROM guild_resource_stock WHERE guild_id = ? AND item_id = 'ash-crown-fragment'").get(fixture.guildId).quantity, 3)
    for (const user of [fixture.leader, fixture.member]) {
      assert.equal(fixture.game.db.prepare("SELECT quantity FROM player_inventory WHERE user_id = ? AND item_id = 'ash-crown-scale'").get(user.id).quantity, 1)
    }
  } finally { fixture.close() }
})

test('idle participant receives no personal raid reward', () => {
  const fixture = setup()
  try {
    fixture.game.db.prepare('UPDATE guilds SET warband = 5, workshops = 5 WHERE id = ?').run(fixture.guildId)
    fixture.game.db.prepare('UPDATE player_characters SET level = 10, max_stamina = 20, stamina = 20 WHERE user_id IN (?, ?)').run(fixture.leader.id, fixture.member.id)
    giveRaidResources(fixture.players, fixture.leader.id)
    depositRaidResources(fixture.expansion, fixture.leader.id)
    fixture.expansion.prepareRaid(fixture.leader.id, { requestId: 'raid-prepare-idle-v014' })
    fixture.expansion.joinRaid(fixture.leader.id, { requestId: 'raid-join-active-v014' })
    fixture.expansion.joinRaid(fixture.member.id, { requestId: 'raid-join-idle-v014' })
    fixture.expansion.startRaid(fixture.leader.id, { requestId: 'raid-start-idle-v014' })

    let raid = fixture.expansion.raidSnapshot(fixture.leader.id)
    for (let index = 0; index < 12 && raid.boss.status === 'active'; index += 1) {
      raid = fixture.expansion.actRaid(fixture.leader.id, {
        action: 'profession',
        requestId: `raid-solo-action-v014-${String(index).padStart(2, '0')}`,
      }).raid
    }
    assert.equal(raid.boss.status, 'won')
    assert.equal(fixture.game.db.prepare("SELECT quantity FROM player_inventory WHERE user_id = ? AND item_id = 'ash-crown-scale'").get(fixture.leader.id).quantity, 1)
    assert.equal(fixture.game.db.prepare("SELECT quantity FROM player_inventory WHERE user_id = ? AND item_id = 'ash-crown-scale'").get(fixture.member.id), undefined)
    assert.equal(fixture.game.db.prepare("SELECT COUNT(*) AS count FROM guild_raid_participants WHERE guild_id = ? AND boss_id = 'ash-crowned-devourer' AND user_id = ?").get(fixture.guildId, fixture.member.id).count, 0)
  } finally { fixture.close() }
})
