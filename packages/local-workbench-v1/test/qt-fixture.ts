/** Disposable native-chrome stand-ins, shared by Qt and real Quickshell IPC
 * tests. Never import installed shell/config. Only the focused Qt unit harness
 * stubs the wake leaf; the Quickshell integration uses the packaged leaf/client. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WORKBENCH_RELEASE } from '../companion/releases.ts'

export function prepareQtFixture(scratch: string, stubWake = false): void {
  const put = (path: string, text: string) => writeFileSync(join(scratch, path), text)
  for (const path of ['view', 'imports/qs/Commons', 'imports/qs/Ui', 'home', 'runtime', 'cache', 'config'])
    mkdirSync(join(scratch, path), { recursive: true, mode: 0o700 })
  for (const [name, bytes] of Object.entries(WORKBENCH_RELEASE.assets)) put(`view/${name}`, bytes)
  const consoleQml = WORKBENCH_RELEASE.assets['WorkbenchConsole.qml']
    .replace(/^import Quickshell(?:\.Wayland)?\n/gm, '')
    .replace('PanelWindow {', 'Window {')
    .replace(/        anchors \{[\s\S]*?^        }\n/m, '')
    .replace(/        implicitWidth:/, '        width:')
    .replace(/        implicitHeight:/, '        height:')
    .replace(/^        (?:WlrLayershell\.[^\n]+|exclusionMode:[^\n]+|mask:[^\n]+)\n/gm, '')
  put('view/WorkbenchConsole.qml', consoleQml)
  if (stubWake) put('view/WorkbenchWake.qml', 'import QtQuick\nItem { property var lastSession: null; property string lastSocket: ""; function notify(path, session) { lastSocket = path; lastSession = session } function reset() { lastSession = null } }\n')
  put('imports/qs/Commons/qmldir', 'module qs.Commons\nsingleton Style 1.0 Style.qml\nsingleton Color 1.0 Color.qml\nsingleton Border 1.0 Border.qml\n')
  put('imports/qs/Commons/Style.qml', `pragma Singleton
import QtQuick
QtObject {
  property int cornerRadius: 4
  property QtObject font: QtObject { property string family: "monospace"; property int body: 12; property int caption: 10; property int title: 14; property int heading: 16 }
  property QtObject spacing: QtObject { property int hairline: 1 }
  function space(value) { return value }
}`)
  put('imports/qs/Commons/Color.qml', `pragma Singleton
import QtQuick
QtObject {
  property color urgent: "#ff7070"; property color accent: "#80c0ff"
  property QtObject popups: QtObject { property color text: "#eeeeee"; property color background: "#202020"; property color border: "#808080" }
}`)
  put('imports/qs/Commons/Border.qml', 'pragma Singleton\nimport QtQuick\nQtObject { function flat(color, width) { return {} } function surfaceSpec(a,b,c,d) { return {} } }\n')
  put('imports/qs/Ui/qmldir', 'module qs.Ui\nBorderSurface 1.0 BorderSurface.qml\nCursorSurface 1.0 CursorSurface.qml\n')
  put('imports/qs/Ui/CursorSurface.qml', `import QtQuick
Rectangle {
  property color foreground: "#eeeeee"
  property color accent: "#80c0ff"
  property bool hasCursor: false
  property bool current: false
  color: hasCursor ? "#404040" : current ? "#303840" : "transparent"
}`)
  put('imports/qs/Ui/BorderSurface.qml', 'import QtQuick\nRectangle { property var borderSpec: ({}) }\n')
}
