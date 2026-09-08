/** PROTOTYPE — NOT PRODUCTION. Disposable filesystem fixtures only. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { AdoptionOwnedDatabase, AdoptionRuntimeOwnership } from '../adoption-owned-database.ts'

test('exclusive gateway ownership survives state transactions and permits exact recovery only after owner exit', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'adoption-owner-'))
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}))
  const file = path.join(dir,'adoption.sqlite')
  const original = new AdoptionRuntimeOwnership(file)
  const manifest = original.manifest()
  assert.throws(() => new AdoptionRuntimeOwnership(file,manifest), /locked/)
  original.close()
  const recovered = new AdoptionRuntimeOwnership(file,manifest)
  assert.equal(recovered.manifest(),manifest)
  recovered.remove()
  assert.equal(fs.existsSync(file),false)
  assert.equal(fs.existsSync(file+'.owner'),false)
})

for (const scenario of ['exact','replacement','symlink','sidecar','existing'] as const) {
  test(`creation-time SQLite cleanup: ${scenario}`, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'adoption-owned-'))
    t.after(() => fs.rmSync(dir,{recursive:true,force:true}))
    const file = path.join(dir,'adoption.sqlite')
    if (scenario === 'existing') {
      fs.writeFileSync(file,'foreign')
      assert.throws(() => new AdoptionOwnedDatabase(file), /EEXIST/)
      assert.equal(fs.readFileSync(file,'utf8'),'foreign')
      return
    }
    const owner = new AdoptionOwnedDatabase(file)
    assert.equal(fs.statSync(file).mode & 0o777,0o600)
    if (scenario === 'exact') {
      owner.remove(); owner.remove()
      assert.equal(fs.existsSync(file),false)
    } else if (scenario === 'sidecar') {
      fs.writeFileSync(file+'-wal','foreign')
      assert.throws(() => owner.remove(), /sidecar/)
      assert.equal(fs.readFileSync(file+'-wal','utf8'),'foreign')
    } else {
      fs.renameSync(file,file+'.original')
      if (scenario === 'replacement') fs.writeFileSync(file,'foreign')
      else fs.symlinkSync(file+'.original',file)
      assert.throws(() => owner.remove(), /identity changed/)
      assert.equal(fs.existsSync(file),true)
    }
  })
}
