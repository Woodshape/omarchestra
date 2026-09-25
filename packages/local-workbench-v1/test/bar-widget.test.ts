import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const QT_RUNNER = process.env.QT_BIN || '/usr/lib/qt6/bin/qmltestrunner'

test('offscreen native bar click calls only the installed one-shot launcher', () => {
  const root = mkdtempSync(join(tmpdir(), 'omarchestra-bar-qml-'))
  try {
    for (const part of ['view', 'imports/qs/Commons', 'imports/qs/Ui', 'home', 'runtime']) mkdirSync(join(root, part), { recursive: true })
    copyFileSync(new URL('../console/plugin/WorkbenchBarWidget.qml', import.meta.url), join(root, 'view/WorkbenchBarWidget.qml'))
    writeFileSync(join(root, 'imports/qs/Commons/qmldir'), 'module qs.Commons\n')
    writeFileSync(join(root, 'imports/qs/Ui/qmldir'), 'module qs.Ui\nBarWidget 1.0 BarWidget.qml\nBarIconButton 1.0 BarIconButton.qml\n')
    writeFileSync(join(root, 'imports/qs/Ui/BarWidget.qml'), 'import QtQuick\nItem { property string moduleName: ""; property var bar: null }\n')
    writeFileSync(join(root, 'imports/qs/Ui/BarIconButton.qml'), 'import QtQuick\nItem { property var bar: null; property string text: ""; property string tooltipText: ""; implicitWidth: 26; implicitHeight: 26; signal pressed(int buttonCode) }\n')
    writeFileSync(join(root, 'tst_bar.qml'), `import QtQuick
import QtTest
import "view"
Item {
  id: host
  width: 120; height: 50
  property var calls: []
  QtObject { id: fakeBar; function run(command) { host.calls = host.calls.concat([command]) } }
  WorkbenchBarWidget { id: widget; bar: fakeBar }
  TestCase {
    name: "WorkbenchBar"; when: windowShown
    function test_exactBarActivation() {
      var button = widget.children[0]
      verify(button !== null)
      button.pressed(Qt.RightButton)
      compare(host.calls.length, 0)
      button.pressed(Qt.LeftButton)
      compare(host.calls.length, 1)
      compare(host.calls[0], "gtk-launch omarchestra-workbench")
    }
  }
}
`)
    const result = spawnSync(QT_RUNNER, ['-input', join(root, 'tst_bar.qml'), '-import', join(root, 'imports')], {
      env: { PATH: '/usr/lib/qt6/bin:/usr/bin:/bin', HOME: join(root, 'home'), XDG_RUNTIME_DIR: join(root, 'runtime'),
        QT_QPA_PLATFORM: 'offscreen', QSG_RHI_BACKEND: 'software', QT_QUICK_BACKEND: 'software' },
      encoding: 'utf8', timeout: 12000, maxBuffer: 1024 * 1024,
    })
    assert.equal(result.status, 0, `${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /WorkbenchBar::test_exactBarActivation\(\)/)
    assert.match(result.stdout, /Totals: 3 passed, 0 failed/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
