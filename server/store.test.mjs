import test from 'node:test'
import assert from 'node:assert/strict'
import { GameStore, StoreError } from './store.mjs'

function freshStore() {
  return new GameStore(':memory:')
}

test('register, authenticate, logout and login', () => {
  const store = freshStore()
  const registration = store.register({ username: 'Miroslav_1', password: 'длинный-пароль', displayName: 'Мирослав' })
  assert.equal(registration.user.username, 'miroslav_1')
  assert.equal(store.authenticate(registration.token).displayName, 'Мирослав')
  store.logout(registration.token)
  assert.equal(store.authenticate(registration.token), null)
  const login = store.login({ username: 'MIROSLAV_1', password: 'длинный-пароль' })
  assert.equal(login.user.id, registration.user.id)
  store.close()
})

test('duplicate usernames are rejected case-insensitively', () => {
  const store = freshStore()
  store.register({ username: 'volk', password: '12345678', displayName: 'Волк' })
  assert.throws(
    () => store.register({ username: 'VOLK', password: 'abcdefgh', displayName: 'Другой' }),
    (error) => error instanceof StoreError && error.code === 'username-taken',
  )
  store.close()
})

test('guild creation creates roles and one membership', () => {
  const store = freshStore()
  const founder = store.register({ username: 'founder', password: '12345678', displayName: 'Основатель' })
  const guild = store.createGuild(founder.user.id, { name: 'Серые вороны', tag: 'СВ' })
  assert.equal(guild.name, 'Серые вороны')
  assert.equal(guild.memberCount, 1)
  assert.equal(guild.role.permissions.roles, true)
  assert.equal(guild.tasks.length, 3)
  assert.equal(store.getRoles(founder.user.id).length, 3)
  store.close()
})

test('invite is private and can be accepted once', () => {
  const store = freshStore()
  const founder = store.register({ username: 'founder', password: '12345678', displayName: 'Основатель' })
  const recruit = store.register({ username: 'recruit', password: 'abcdefgh', displayName: 'Новобранец' })
  store.createGuild(founder.user.id, { name: 'Серые вороны', tag: 'СВ' })
  const invite = store.inviteToGuild(founder.user.id, 'recruit')
  assert.equal(store.getInvites(recruit.user.id).length, 1)
  const guild = store.acceptInvite(recruit.user.id, invite.id)
  assert.equal(guild.memberCount, 2)
  assert.equal(store.getInvites(recruit.user.id).length, 0)
  assert.throws(() => store.acceptInvite(recruit.user.id, invite.id))
  store.close()
})

test('treasury deposit is logged and tree permissions are enforced', () => {
  const store = freshStore()
  const founder = store.register({ username: 'founder', password: '12345678', displayName: 'Основатель' })
  const recruit = store.register({ username: 'recruit', password: 'abcdefgh', displayName: 'Новобранец' })
  store.createGuild(founder.user.id, { name: 'Серые вороны', tag: 'СВ' })
  const invite = store.inviteToGuild(founder.user.id, 'recruit')
  store.acceptInvite(recruit.user.id, invite.id)
  const guildAfterDeposit = store.depositCoins(recruit.user.id, 15)
  assert.equal(guildAfterDeposit.treasuryCoins, 15)
  assert.equal(store.getTreasuryLog(founder.user.id)[0].amount, 15)
  assert.equal(guildAfterDeposit.tasks.find((task) => task.id === 'donations').current, 15)
  assert.throws(
    () => store.upgradeBranch(recruit.user.id, 'warband'),
    (error) => error instanceof StoreError && error.code === 'forbidden',
  )
  const upgraded = store.upgradeBranch(founder.user.id, 'warband')
  assert.equal(upgraded.branches.warband, 1)
  assert.equal(upgraded.treePoints, 0)
  store.close()
})

test('leader can create custom permission roles', () => {
  const store = freshStore()
  const founder = store.register({ username: 'founder', password: '12345678', displayName: 'Основатель' })
  store.createGuild(founder.user.id, { name: 'Серые вороны', tag: 'СВ' })
  const roles = store.createRole(founder.user.id, {
    name: 'Казначей',
    permissions: { treasury: true, invite: false, kick: false, tree: false },
  })
  const treasurer = roles.find((role) => role.name === 'Казначей')
  assert.equal(treasurer.canUseTreasury, true)
  assert.equal(treasurer.canManageRoles, false)
  store.close()
})

test('leader assigns custom roles and protected hierarchy prevents abuse', () => {
  const store = freshStore()
  const founder = store.register({ username: 'founder2', password: '12345678', displayName: 'Основатель' })
  const recruit = store.register({ username: 'recruit2', password: 'abcdefgh', displayName: 'Новобранец' })
  store.createGuild(founder.user.id, { name: 'Полуночная стража', tag: 'ПС' })
  const invite = store.inviteToGuild(founder.user.id, 'recruit2')
  store.acceptInvite(recruit.user.id, invite.id)
  const roles = store.createRole(founder.user.id, { name: 'Казначей', permissions: { treasury: true } })
  const treasurer = roles.find((role) => role.name === 'Казначей')
  const members = store.assignMemberRole(founder.user.id, recruit.user.id, treasurer.id)
  assert.equal(members.find((member) => member.id === recruit.user.id).roleName, 'Казначей')
  assert.throws(() => store.assignMemberRole(founder.user.id, founder.user.id, treasurer.id))
  const afterKick = store.kickMember(founder.user.id, recruit.user.id)
  assert.equal(afterKick.length, 1)
  store.close()
})
