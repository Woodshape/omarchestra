// Keyed presentation model. Only removal/replacement of an exact row destroys
// its delegate; field updates and reorder preserve focus/disclosure state.
import QtQuick

ListModel {
    id: root
    property var rows: []
    property string keyField: ""
    property string scope: ""
    onRowsChanged: syncRows()
    onScopeChanged: { clear(); syncRows() }
    onKeyFieldChanged: syncRows()
    function syncRows() {
        if (!keyField) return
        var seen = {}
        for (var k = 0; k < rows.length; k++) {
            var key = rows[k][keyField]
            if (typeof key !== "string" || !key || seen["$" + key]) { clear(); return }
            seen["$" + key] = true
        }
        for (var i = count - 1; i >= 0; i--) if (!seen["$" + get(i).rowKey]) remove(i)
        for (var j = 0; j < rows.length; j++) {
            var id = rows[j][keyField], encoded = JSON.stringify(rows[j]), at = j
            while (at < count && get(at).rowKey !== id) at++
            if (at === count) insert(j, { rowKey: id, rowJson: encoded })
            else {
                if (at !== j) move(at, j, 1)
                if (get(j).rowJson !== encoded) setProperty(j, "rowJson", encoded)
            }
        }
    }
}
